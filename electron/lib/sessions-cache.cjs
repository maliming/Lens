// Sessions cache + per-file metadata cache.
//
// Two layers, single lifecycle (per codex round-2's option C):
//
//   1. `cachedSessions` — the full session list as last persisted to
//      `<userData>/sessions-cache.json`. Returned instantly by
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
const { readJsonFileSafe, atomicWriteJson } = require('./json-io.cjs');

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
const SESSIONS_CACHE_VERSION = 12;

// Bumped any time the cached schema changes (new field, dropped field,
// changed type, renamed field). Older caches are dropped on load so a
// downgrade-then-upgrade can't feed mismatched objects to the renderer.
function getSessionsCacheVersion() { return SESSIONS_CACHE_VERSION; }

function createSessionsCache({ userDataDir }) {
  const sessionsCachePath = path.join(userDataDir, 'sessions-cache.json');
  const fileMetaCache = new Map(); // filePath → { mtime, meta }
  let cachedSessions = null;

  async function load() {
    try {
      // The sessions cache can legitimately reach a few MB (one entry per
      // session, with token-event arrays). Allow a bigger budget than the
      // generic userdata cap so we don't refuse a cache that's been
      // growing with the user's session count.
      const raw = await readJsonFileSafe(sessionsCachePath, 64 * 1024 * 1024);
      if (raw == null) return;
      const obj = JSON.parse(raw);
      if (obj && obj.version === SESSIONS_CACHE_VERSION && Array.isArray(obj.sessions)) {
        cachedSessions = obj.sessions;
        // Seed the per-file mtime cache so the background rescan can skip
        // files that haven't changed since they were last persisted.
        for (const s of obj.sessions) {
          if (s.filePath && typeof s.mtime === 'number') {
            fileMetaCache.set(s.filePath, { mtime: s.mtime, meta: extractMetaFromSession(s) });
          }
        }
      }
    } catch {}
  }

  async function save(sessions) {
    try {
      // Persist tokenEvents alongside the rest of the session metadata.
      // Earlier versions stripped them on the theory that cold start would
      // re-read from JSONL anyway — but that left `usageSummary` blind on
      // the very first IPC call (before the background scan finishes),
      // since byDay scatters per-event timestamps and there were no
      // events to scatter. The heatmap and "active days" stats fell back
      // to lastTs-only attribution, which lumps multi-day sessions
      // (especially anything with subagents from prior weeks) onto the
      // session-end day. Keeping events on disk means usage is accurate
      // immediately on relaunch.
      //
      // Size impact: ~50–100 events × ~50 bytes per typical session,
      // times a few hundred sessions, lands the file in the single-digit
      // megabyte range — well under the 64 MB load cap.
      await atomicWriteJson(sessionsCachePath, {
        version: SESSIONS_CACHE_VERSION,
        savedAt: Date.now(),
        sessions,
      });
    } catch {}
  }

  function getCachedSessions() { return cachedSessions; }
  function setCachedSessions(v) { cachedSessions = v; }
  function getFileMetaCache() { return fileMetaCache; }

  return {
    sessionsCachePath,
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
    tooLarge: s.tooLarge || false,
    fileSize: s.fileSize || 0, mtime: s.mtime || 0,
    codexId: s.codexId ?? null,
    planType: s.planType ?? null,
  };
}

module.exports = {
  SESSIONS_CACHE_VERSION,
  getSessionsCacheVersion,
  createSessionsCache,
  extractMetaFromSession,
};
