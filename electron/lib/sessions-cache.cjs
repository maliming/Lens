// Sessions cache + per-file metadata cache.
//
// Two layers with one lifecycle:
//
//   1. `cachedSessions` — the merged session list last persisted to compact
//      `<userData>/sessions-cache-{claude,codex}.json` files. Returned instantly by
//      `sessions:list` on cold start so the UI doesn't have to wait for a
//      fresh deep scan.
//
//   2. `fileMetaCache` — Map<absPath, { mtime, meta }>. Both parsers
//      consult it before re-reading a session JSONL; the persisted
//      `cachedSessions` seeds it on boot so an inactive session (the
//      vast majority) never reparses across launches.
//
// Both parsers reach for the cache via `getFileMetaCache()`; main.cjs
// wires it into `createParser({ fileMetaCache })`.

const path = require('path');
const fsp = require('fs/promises');
const { readJsonFileSafe, atomicWriteJson } = require('./json-io.cjs');
const { normalizeSessionForCache, cacheRevision } = require('./session-data.cjs');

// v7: subagent JSONLs folded into parent token totals.
// v8: tokenEvents now persisted on disk (previously stripped). Without
//     them, the first usage:summary IPC after relaunch fell back to
//     lastTs-only byDay attribution, so the heatmap missed every active
//     day except the session-end one — visibly broken once subagents
//     widened firstTs into older months.
// v9: dropped the 200MB per-session size cap on metadata extraction.
//     v8 caches stored 263MB-class sessions as `tooLarge: true` and the
//     fileMetaCache would happily reuse that stub on subsequent launches,
//     keeping the huge session out of every aggregate even after the
//     parser was fixed. Bumping the version forces a full re-parse so
//     those entries get rebuilt with real token + timestamp data.
//     v10 reads `ai-title` lines as the session title and derives firstUser
//     from array-content user turns (pasted text + image), so sessions that
//     opened with such a turn re-parse with a real title / first message.
// v11: projectCwd now comes from the JSONL's first recorded cwd, not from
//     decoding the project-folder name (which splits literal hyphens in a
//     path segment into separators, e.g. `taskever-desktop` →
//     `taskever/desktop`). v10 caches stored the wrong decoded path, so
//     Resume/Copy `cd`'d into a non-existent dir; a re-parse fixes them.
// v12: userMsgs now counts image-only user turns (a paste with no text), which
//     the detail view already renders as a message — v11 caches undercounted
//     the row's "N msgs" by one per such session, so a re-parse realigns them.
// v13: firstUser now strips pasted-image placeholders (`<image name=[Image #1]
//     path="...">`, bare `[Image #1]`). Both Claude (inlined into the human
//     text block) and Codex (emitted as input_text) leaked them into the
//     title, so v12 caches show rows titled `[Image #1] [Image #2]`; a
//     re-parse rebuilds those titles from the real text.
// v14: Codex rollout files sharing a root id now collapse to one list row, so a
//     session that spawned subagents no longer shows one row per spawned agent.
// v15: that collapse now groups on codex's explicit `session_id` (root thread)
//     and records `isSubagent`, so the kept representative is the real root
//     rather than whichever fork happened to be longest — a subagent file is
//     `parent-prefix + task` and can outsize the root. Re-parse to populate
//     isSubagent and the session_id-based id.
// v16: bounds firstUser, compacts events older than 30 days into daily usage,
//     and migrates the monolithic pretty-printed cache into compact per-source
//     files. Claude rows record the folded subagent signature so warm scans do
//     not add the same token totals again. Renderer IPC uses a separate
//     whitelist and never receives these usage-only fields.
// v17: large per-source caches use an atomic two-generation shard manifest so
//     the writer can never create a file that the next launch refuses to read.
const SESSIONS_CACHE_VERSION = 17;
const LEGACY_SOURCE_CACHE_VERSION = 16;
const LEGACY_CACHE_VERSION = 15;
const SESSION_SOURCES = ['claude', 'codex'];
const MAX_SOURCE_CACHE_SIZE = 64 * 1024 * 1024;
const MAX_LEGACY_CACHE_SIZE = 128 * 1024 * 1024;
const MAX_SOURCE_MIGRATION_SIZE = 256 * 1024 * 1024;
const TARGET_SHARD_SIZE = 16 * 1024 * 1024;
const MAX_CACHE_SHARDS = 2048;

// Bumped any time the cached schema changes (new field, dropped field,
// changed type, renamed field). Explicit v15/v16 migrations normalize known
// shapes; every other version is ignored so downgrade-then-upgrade cannot feed
// mismatched objects to the renderer.
function getSessionsCacheVersion() { return SESSIONS_CACHE_VERSION; }

function createSessionsCache({ userDataDir }) {
  const sessionsCachePath = path.join(userDataDir, 'sessions-cache.json');
  const sessionsCachePaths = Object.fromEntries(SESSION_SOURCES.map(source => [
    source,
    path.join(userDataDir, `sessions-cache-${source}.json`),
  ]));
  const fileMetaCache = new Map(); // filePath → { mtime, meta }
  const savedRevisions = new Map();
  const savedGenerations = new Map();
  const savedShardNames = new Map();
  const writeBlockedSources = new Set();
  const saveQueues = new Map();
  let cachedSessions = null;

  async function loadSourceRows(source) {
    const cachePath = sessionsCachePaths[source];
    try {
      await fsp.lstat(cachePath);
    } catch (error) {
      return {
        status: error?.code === 'ENOENT' ? 'missing' : 'failed',
        generation: null,
      };
    }
    const raw = await readJsonFileSafe(cachePath, MAX_SOURCE_MIGRATION_SIZE);
    if (raw == null) return { status: 'failed', generation: null };
    const rawBytes = Buffer.byteLength(raw);
    let obj;
    try { obj = JSON.parse(raw); }
    catch { return { status: 'failed', generation: null }; }

    if (obj?.version === LEGACY_SOURCE_CACHE_VERSION && Array.isArray(obj.sessions)) {
      return {
        status: 'loaded',
        persistedRows: obj.sessions,
        needsMigration: true,
        generation: null,
        shardNames: [],
      };
    }
    if (obj?.version !== SESSIONS_CACHE_VERSION) {
      return { status: 'incompatible', generation: null };
    }
    if (obj.source !== source) {
      return { status: 'failed', generation: null };
    }
    if (Array.isArray(obj.sessions)) {
      if (rawBytes > MAX_SOURCE_CACHE_SIZE) return { status: 'failed', generation: null };
      return {
        status: 'loaded',
        persistedRows: obj.sessions,
        needsMigration: false,
        generation: null,
        shardNames: [],
      };
    }
    const generation = obj.generation === 'a' || obj.generation === 'b' ? obj.generation : null;
    if (!Array.isArray(obj.shards) || obj.shards.length < 1 || obj.shards.length > MAX_CACHE_SHARDS) {
      return { status: 'failed', generation };
    }
    if (!generation) return { status: 'failed', generation: null };

    const expected = new RegExp(`^sessions-cache-${source}-${generation}-(\\d+)\\.json$`);
    const persistedRows = [];
    for (let index = 0; index < obj.shards.length; index++) {
      const fileName = obj.shards[index];
      const match = typeof fileName === 'string' ? fileName.match(expected) : null;
      if (!match || Number(match[1]) !== index) return { status: 'failed', generation };
      const shardRaw = await readJsonFileSafe(path.join(userDataDir, fileName), MAX_SOURCE_CACHE_SIZE);
      if (shardRaw == null) return { status: 'failed', generation };
      let shard;
      try { shard = JSON.parse(shardRaw); }
      catch { return { status: 'failed', generation }; }
      if (shard?.version !== SESSIONS_CACHE_VERSION
          || shard.source !== source
          || shard.generation !== generation
          || shard.index !== index
          || !Array.isArray(shard.sessions)) return { status: 'failed', generation };
      persistedRows.push(...shard.sessions);
    }
    return {
      status: 'loaded',
      persistedRows,
      needsMigration: false,
      generation,
      shardNames: [...obj.shards],
    };
  }

  function jsonByteLength(value) {
    return Buffer.byteLength(JSON.stringify(value));
  }

  function partitionRows(rows, savedAt, source, generation) {
    const chunks = [];
    let current = [];
    let currentBytes = 256;
    for (const row of rows) {
      const rowBytes = jsonByteLength(row) + 1;
      if (current.length > 0 && currentBytes + rowBytes > TARGET_SHARD_SIZE) {
        chunks.push(current);
        current = [];
        currentBytes = 256;
      }
      current.push(row);
      currentBytes += rowBytes;
    }
    if (current.length > 0) chunks.push(current);
    if (chunks.length < 1 || chunks.length > MAX_CACHE_SHARDS) throw new Error('Session cache shard count out of range');
    return chunks.map((sessions, index) => ({
      version: SESSIONS_CACHE_VERSION,
      savedAt,
      source,
      generation,
      index,
      sessions,
    }));
  }

  async function cleanupSourceShards(source, keepNames = new Set()) {
    let entries;
    try { entries = await fsp.readdir(userDataDir); }
    catch (error) {
      if (error?.code !== 'ENOENT') console.warn('Failed to list session cache shards', source, error);
      return;
    }
    const pattern = new RegExp(`^sessions-cache-${source}-[ab]-(\\d+)\\.json$`);
    await Promise.all(entries.map(async (fileName) => {
      if (!pattern.test(fileName) || keepNames.has(fileName)) return;
      try { await fsp.unlink(path.join(userDataDir, fileName)); }
      catch (error) {
        if (error?.code !== 'ENOENT') console.warn('Failed to remove stale session cache shard', fileName, error);
      }
    }));
  }

  async function cleanupSessionCacheTemps() {
    let entries;
    try { entries = await fsp.readdir(userDataDir); }
    catch (error) {
      if (error?.code !== 'ENOENT') console.warn('Failed to list session cache temp files', error);
      return;
    }
    const pattern = /^sessions-cache-(?:claude|codex)(?:-[ab]-\d+)?\.json\.tmp-\d+-\d+$/;
    await Promise.all(entries.map(async (fileName) => {
      if (!pattern.test(fileName)) return;
      try { await fsp.unlink(path.join(userDataDir, fileName)); }
      catch (error) {
        if (error?.code !== 'ENOENT') console.warn('Failed to remove stale session cache temp file', fileName, error);
      }
    }));
  }

  async function writeSourceRows(source, rows, savedAt) {
    const direct = {
      version: SESSIONS_CACHE_VERSION,
      savedAt,
      source,
      sessions: rows,
    };
    if (jsonByteLength(direct) <= MAX_SOURCE_CACHE_SIZE) {
      await atomicWriteJson(sessionsCachePaths[source], direct, { pretty: false });
      savedGenerations.delete(source);
      savedShardNames.set(source, new Set());
      await cleanupSourceShards(source);
      return;
    }

    const generation = savedGenerations.get(source) === 'a' ? 'b' : 'a';
    const shards = partitionRows(rows, savedAt, source, generation);
    const shardNames = shards.map((_, index) => `sessions-cache-${source}-${generation}-${index}.json`);
    await Promise.all(shards.map((shard, index) => {
      if (jsonByteLength(shard) > MAX_SOURCE_CACHE_SIZE) throw new Error('Session cache shard exceeds read limit');
      return atomicWriteJson(path.join(userDataDir, shardNames[index]), shard, { pretty: false });
    }));
    await atomicWriteJson(sessionsCachePaths[source], {
      version: SESSIONS_CACHE_VERSION,
      savedAt,
      source,
      generation,
      shards: shardNames,
    }, { pretty: false });
    savedGenerations.set(source, generation);
    const keepNames = new Set(shardNames);
    savedShardNames.set(source, keepNames);
    await cleanupSourceShards(source, keepNames);
  }

  async function load() {
    // The app holds a single-instance lock before loading persistence, so any
    // matching atomic-write temp belongs to a process that can no longer
    // finish its rename. Removing only this exact cache-owned pattern keeps a
    // crash during parallel shard writes from leaking large files forever.
    await cleanupSessionCacheTemps();
    const bySource = new Map();
    const unavailableSources = new Map();
    const sourcesNeedingRewrite = new Set();

    for (const source of SESSION_SOURCES) {
      try {
        const loaded = await loadSourceRows(source);
        if (loaded.generation) savedGenerations.set(source, loaded.generation);
        if (loaded.status !== 'loaded') {
          unavailableSources.set(source, loaded.status);
          if (loaded.status === 'incompatible') writeBlockedSources.add(source);
          continue;
        }
        const keepNames = new Set(loaded.shardNames || []);
        savedShardNames.set(source, keepNames);
        await cleanupSourceShards(source, keepNames);
        const persistedRows = loaded.persistedRows.filter(session => session?.source === source);
        const rows = persistedRows.map(session => normalizeSessionForCache(session));
        bySource.set(source, rows);
        // If normalization rolled an event across the retention boundary,
        // leave the revision unset so the next save compacts the disk file too.
        const normalizedUnchanged = persistedRows.every(row => typeof row?.usageRevision === 'string')
          && cacheRevision(persistedRows) === cacheRevision(rows);
        if (!loaded.needsMigration && normalizedUnchanged) {
          savedRevisions.set(source, cacheRevision(rows));
        } else {
          sourcesNeedingRewrite.add(source);
        }
      } catch {
        unavailableSources.set(source, 'failed');
      }
    }

    // v15 stored both sources in one pretty-printed file. Read it only as a
    // migration source; the file is left untouched and all future writes go to
    // compact per-source files so one provider cannot invalidate the other.
    if (unavailableSources.size > 0) {
      try {
        const raw = await readJsonFileSafe(sessionsCachePath, MAX_LEGACY_CACHE_SIZE);
        if (raw != null) {
          const obj = JSON.parse(raw);
          if ((obj?.version === LEGACY_CACHE_VERSION
              || obj?.version === LEGACY_SOURCE_CACHE_VERSION
              || obj?.version === SESSIONS_CACHE_VERSION)
              && Array.isArray(obj.sessions)) {
            for (const [source, status] of unavailableSources) {
              if (status === 'incompatible') continue;
              const rows = obj.sessions
                .filter(session => session?.source === source)
                .map(session => normalizeSessionForCache(session));
              // An older monolithic cache with no rows for a source is not a
              // safe replacement for a newer per-source file that merely
              // failed to read. Treat an empty fallback as authoritative only
              // when the per-source file genuinely did not exist.
              if (rows.length === 0 && status === 'failed') continue;
              bySource.set(source, rows);
              sourcesNeedingRewrite.add(source);
            }
          }
        }
      } catch {}
    }

    cachedSessions = SESSION_SOURCES.flatMap(source => bySource.get(source) || [])
      .sort((a, b) => (b.mtime || 0) - (a.mtime || 0));

    // Seed the per-file mtime cache so the background rescan can skip files
    // that have not changed since they were last persisted.
    for (const session of cachedSessions) {
      if (session.filePath && typeof session.mtime === 'number') {
        fileMetaCache.set(session.filePath, { mtime: session.mtime, meta: extractMetaFromSession(session) });
      }
    }

    // Finish an in-place migration eagerly. This bounds the next launch even
    // if the app exits before the background scanner completes.
    for (const source of sourcesNeedingRewrite) {
      await save(cachedSessions, source);
    }
  }

  async function save(sessions, onlySource = null) {
    const sources = onlySource && SESSION_SOURCES.includes(onlySource) ? [onlySource] : SESSION_SOURCES;
    await Promise.all(sources.map(async source => {
      if (writeBlockedSources.has(source)) return;
      const previous = saveQueues.get(source) || Promise.resolve();
      const next = previous.catch(() => {}).then(async () => {
        const now = Date.now();
        const rows = sessions
          .filter(session => session?.source === source)
          .map(session => normalizeSessionForCache(session, now));
        const revision = cacheRevision(rows);
        if (savedRevisions.get(source) === revision) {
          await cleanupSourceShards(source, savedShardNames.get(source) || new Set());
          return;
        }
        await writeSourceRows(source, rows, now);
        savedRevisions.set(source, revision);
      });
      saveQueues.set(source, next);
      try { await next; }
      catch (error) { console.error('Failed to save session cache', source, error); }
      finally {
        if (saveQueues.get(source) === next) saveQueues.delete(source);
      }
    }));
  }

  function getCachedSessions() { return cachedSessions; }
  function setCachedSessions(v) { cachedSessions = v; }
  function getFileMetaCache() { return fileMetaCache; }

  return {
    sessionsCachePath,
    sessionsCachePaths,
    SESSIONS_CACHE_VERSION,
    load,
    save,
    getCachedSessions, setCachedSessions,
    getFileMetaCache,
  };
}

// Re-shape a previously-persisted session entry back into the slim meta
// object the parser would have emitted, so seeding `fileMetaCache` from
// the on-disk cache survives a future re-parse that compares mtime.
//
// Codex carries two source-specific fields the cache must round-trip:
//   • `codexId`  — the `session_meta.id` value; the parser uses this as the
//                  session's true id when present, falling back to the
//                  filename only when missing. Dropping it here meant warm
//                  launches would silently reassign Codex sessions to their
//                  filename-derived id, breaking favorite / alias /
//                  exclude lookups that key on the real id.
//   • `planType` — last seen plan tier; the Sidebar quota card displays it.
// Both are Codex-only; cached Claude sessions never populate them, so
// `s.codexId === undefined` and `planType === undefined` round-trip as
// `null` which the parser treats as "no info" without any branching.
function extractMetaFromSession(s) {
  return {
    summary: s.summary || '', firstUser: s.firstUser || '',
    firstTs: s.firstTs || null, lastTs: s.lastTs || null,
    userMsgs: s.userMsgs || 0, assistantMsgs: s.assistantMsgs || 0,
    cwd: s.lastCwd || s.projectCwd || '', firstCwd: s.projectCwd || '', gitBranch: s.gitBranch || '',
    model: s.model || '', version: s.version || '',
    tokensIn: s.tokensIn || 0, tokensOut: s.tokensOut || 0,
    tokensCacheRead: s.tokensCacheRead || 0, tokensCacheCreate: s.tokensCacheCreate || 0,
    tokenEvents: s.tokenEvents || [],
    tokenDays: s.tokenDays || [],
    usageRevision: s.usageRevision || null,
    tooLarge: s.tooLarge || false,
    fileSize: s.fileSize || 0, mtime: s.mtime || 0,
    codexId: s.codexId ?? null,
    isSubagent: s.isSubagent ?? false,
    subagentsFolded: s.subagentsFolded ?? false,
    subagentSignature: s.subagentSignature ?? null,
    planType: s.planType ?? null,
  };
}

module.exports = {
  SESSIONS_CACHE_VERSION,
  getSessionsCacheVersion,
  createSessionsCache,
  extractMetaFromSession,
};
