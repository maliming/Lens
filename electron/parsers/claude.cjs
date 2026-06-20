// Claude Code session parsing. This module owns everything that's specific
// to the Anthropic JSONL shape and the on-disk layout of
// `~/.claude/projects/`. Cross-source helpers live in `parsers/shared.cjs`;
// generic image walkers / hygiene utilities live in `lib/images.cjs`.
//
// Stateful pieces (the per-file metadata cache, the userdata lookups) are
// injected via `createParser({ fileMetaCache, userdata })` so this module
// stays pure (no Electron import, no module-level mutable state) and the
// main process keeps single ownership of the cache + favorites/excludes/
// aliases sets.

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const { CLAUDE_IMAGE_CACHE_ROOT, PROJECTS_DIR } = require('../lib/paths.cjs');
const { isInsideBase } = require('../lib/fs-safety.cjs');
const { forEachJsonlLine, MAX_SESSION_FILE_SIZE } = require('../lib/jsonl.cjs');
const { mapPool } = require('../lib/concurrency.cjs');
const {
  MAX_INLINE_IMAGE_B64,
  MAX_IMAGES_PER_MESSAGE,
  MAX_SESSION_IMAGE_TOTAL_B64,
  extractMessageImages,
  stripImagePlaceholders,
  capSessionImages,
} = require('../lib/images.cjs');
const { isSyntheticModel, compositeKey } = require('./shared.cjs');

// ===========================================================================
// Leaf helpers — pure, no injected state. Re-exported so other modules can
// pick them up without going through createParser().
// ===========================================================================

// Claude Code encodes absolute paths by replacing `/` with `-` for the
// `~/.claude/projects/<encoded>/` dir layout. Codex's session files live
// under `~/.codex/sessions/<YYYY>/<MM>/<DD>/<rollout-…>.jsonl` and never
// go through this encoding, so the helper is Claude-only.
function decodeProjectDir(name) {
  if (name.startsWith('-')) return '/' + name.slice(1).replace(/-/g, '/');
  return name;
}

// Pull the textual content out of an Anthropic `message` object — flatten
// the typed parts array into a single string. Image blocks contribute
// nothing here (they ride the parallel `images` array), so they're
// silently dropped instead of being stringified. Codex's `response_item`
// uses a different shape (`input_text` / `output_text`) handled in
// `parsers/codex.cjs`.
function extractMessageText(message) {
  if (!message) return '';
  const c = message.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return c.map(p => {
      if (!p || typeof p !== 'object') return '';
      if (p.type === 'text' && typeof p.text === 'string') return p.text;
      if (p.type === 'thinking' && typeof p.text === 'string') return p.text;
      if (p.type === 'tool_use' && p.input) {
        try { return `[Tool: ${p.name || 'unknown'}]\n` + JSON.stringify(p.input, null, 2); } catch { return ''; }
      }
      if (p.type === 'tool_result') {
        if (typeof p.content === 'string') return p.content;
        if (Array.isArray(p.content)) return p.content.map(x => x?.text || '').join(' ');
      }
      return '';
    }).join('\n').trim();
  }
  return '';
}

// Patterns Claude Code itself injects into the JSONL as `user` rows even
// though no human typed them — slash commands, command output captures,
// system reminders, async-task notifications, system caveats. Any user
// content matching this list is skipped for both firstUser derivation
// AND from the rendered message stream.
const SYSTEM_INJECTION_PREFIXES = [
  '<command-name>',
  '<command-message>',
  '<command-args>',
  '<local-command-stdout>',
  '<local-command-stderr>',
  '<system-reminder>',
  '<task-notification>',
  '<user-prompt-submit-hook>',
  '<bash-input>',
  '<bash-stdout>',
  '<bash-stderr>',
  'Caveat:',
];
function isSystemInjectedUserText(text) {
  if (typeof text !== 'string') return false;
  const t = text.trim();
  if (!t) return true; // empty user line is also noise — strip it
  for (const p of SYSTEM_INJECTION_PREFIXES) {
    if (t.startsWith(p)) return true;
  }
  return false;
}

function isHumanUserLine(obj) {
  if (!obj || obj.type !== 'user') return false;
  if (!obj.message) return false;
  if (typeof obj.message.content !== 'string') return false;
  return !isSystemInjectedUserText(obj.message.content);
}

// Newer Claude Code doesn't inline image bytes in JSONL — it writes the
// bytes to `~/.claude/image-cache/<sessionId>/<n>.png` and embeds a literal
// text marker. Resolve those markers against the realpath-resolved cache
// root, returning base64 image entries.
const IMAGE_CACHE_MARKER = /\[Image:\s*source:\s*([^\]]+)\]/g;
const PATH_EXT_TO_MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
};
// Per-file cap on images pulled from ~/.claude/image-cache/. Roomy enough
// for any genuine pasted screenshot (browsers cap at ~10 MB even for full-
// page PNGs); below the per-message inline-image cap so the budget is
// still meaningfully tracked across multiple images.
const MAX_IMAGE_CACHE_FILE_SIZE = 12 * 1024 * 1024;
async function loadClaudeImageCacheImages(text, budget) {
  if (!text) return [];
  const out = [];
  const seen = new Set();
  let realRoot;
  try { realRoot = await fsp.realpath(CLAUDE_IMAGE_CACHE_ROOT); } catch { return []; }
  for (const m of text.matchAll(IMAGE_CACHE_MARKER)) {
    if (budget && budget.usedB64 >= MAX_SESSION_IMAGE_TOTAL_B64) {
      budget.truncated = true;
      break;
    }
    if (out.length >= MAX_IMAGES_PER_MESSAGE) break;
    const rawPath = m[1].trim();
    if (seen.has(rawPath)) continue;
    seen.add(rawPath);
    try {
      const real = await fsp.realpath(path.resolve(rawPath));
      if (!isInsideBase(real, realRoot)) continue;
      const ext = path.extname(real).toLowerCase();
      const mime = PATH_EXT_TO_MIME[ext];
      if (!mime) continue;
      const stat = await fsp.stat(real);
      if (stat.size > MAX_IMAGE_CACHE_FILE_SIZE) continue;
      const buf = await fsp.readFile(real);
      const data = buf.toString('base64');
      if (data.length > MAX_INLINE_IMAGE_B64) continue;
      if (budget && budget.usedB64 + data.length > MAX_SESSION_IMAGE_TOTAL_B64) {
        budget.truncated = true;
        break;
      }
      out.push({ mediaType: mime, data });
      if (budget) budget.usedB64 += data.length;
    } catch {}
  }
  return out;
}

// ===========================================================================
// Parser factory. main.cjs creates one instance, passing in the per-file
// metadata cache (Phase 4 will move that to lib/sessions-cache.cjs) and
// the userdata getters (favorites / excludes / aliases — fresh-read via
// callbacks so toggle()s from IPC take effect immediately).
// ===========================================================================

function createParser({ fileMetaCache, userdata }) {
  const { isFavorite, isExcluded, getAlias } = userdata;

  // Cache wrapper. `tooLarge` entries get re-checked against the current
  // MAX_SESSION_FILE_SIZE so a bumped cap can rehabilitate the entry
  // without a manual cache wipe.
  async function readSessionMetadata(filePath) {
    const stat = await fsp.stat(filePath);
    const cached = fileMetaCache.get(filePath);
    if (cached && cached.mtime === stat.mtimeMs) {
      if (!(cached.meta?.tooLarge && stat.size <= MAX_SESSION_FILE_SIZE)) {
        return cached.meta;
      }
    }
    const meta = await readSessionMetadataFromDisk(filePath, stat);
    fileMetaCache.set(filePath, { mtime: stat.mtimeMs, meta });
    return meta;
  }

  async function readSessionMetadataFromDisk(filePath, stat) {
    // No size cap on metadata. Earlier versions refused anything above
    // MAX_SESSION_FILE_SIZE (200MB) — that gated subagent-heavy sessions
    // (e.g. the 263MB conversation that spawned ~140 sidechain agents
    // over months) right out of every aggregate. Metadata extraction is
    // streamed line-by-line through `forEachJsonlLine`, so peak memory
    // stays bounded by MAX_JSONL_LINE_LEN regardless of file size. The
    // detail-view path (`getSessionMessages`) still warns the renderer
    // before loading huge files because *that* path builds an in-memory
    // messages array the renderer holds onto.
    let firstUser = '', summary = '';
    let firstTs = null, lastTs = null;
    let userMsgs = 0, assistantMsgs = 0;
    let cwd = '', gitBranch = '', model = '', version = '';
    let tokensIn = 0, tokensOut = 0, tokensCacheRead = 0, tokensCacheCreate = 0;
    const tokenEvents = [];

    await forEachJsonlLine(filePath, (obj) => {
      if (obj.type === 'summary' && typeof obj.summary === 'string' && !summary) summary = obj.summary;
      if (obj.cwd) cwd = obj.cwd;
      if (obj.gitBranch) gitBranch = obj.gitBranch;
      if (obj.version) version = obj.version;

      // Queued prompts (user typed while the model was mid-tool) ride in on
      // `attachment.type: 'queued_command'`. Some are real input; others
      // are the CLI re-queueing a `<task-notification>` block back to
      // itself when a background task settles. Same noise filter the
      // message stream uses keeps the count + first-user honest.
      if (obj.type === 'attachment'
          && obj.attachment?.type === 'queued_command'
          && typeof obj.attachment.prompt === 'string'
          && obj.attachment.prompt.trim()
          && !isSystemInjectedUserText(obj.attachment.prompt)) {
        userMsgs++;
        if (obj.timestamp) {
          if (!firstTs) firstTs = obj.timestamp;
          lastTs = obj.timestamp;
        }
        if (!firstUser) firstUser = obj.attachment.prompt.trim();
        return;
      }

      if (obj.type === 'user' || obj.type === 'assistant') {
        if (obj.type === 'user' && typeof obj.message?.content === 'string'
            && !isSystemInjectedUserText(obj.message.content)) {
          userMsgs++;
        }
        else if (obj.type === 'assistant') {
          // Skip pure tool_use turns. Token/model extraction below runs
          // regardless so usage stays accurate.
          const content = obj.message?.content;
          const hasText = typeof content === 'string'
            ? content.length > 0
            : Array.isArray(content) && content.some(p => p?.type === 'text' && typeof p.text === 'string' && p.text.trim());
          if (hasText) assistantMsgs++;
          if (obj.message?.model && !isSyntheticModel(obj.message.model)) model = obj.message.model;
          const u = obj.message?.usage;
          if (u) {
            const evIn = u.input_tokens || 0;
            const evOut = u.output_tokens || 0;
            const evCr = u.cache_read_input_tokens || 0;
            const evCc = u.cache_creation_input_tokens || 0;
            tokensIn += evIn;
            tokensOut += evOut;
            tokensCacheRead += evCr;
            tokensCacheCreate += evCc;
            if (obj.timestamp) {
              const ts = new Date(obj.timestamp).getTime();
              if (!isNaN(ts)) tokenEvents.push({ ts, i: evIn, o: evOut, cr: evCr, cc: evCc });
            }
          }
        }
        if (obj.timestamp) {
          if (!firstTs) firstTs = obj.timestamp;
          lastTs = obj.timestamp;
        }
        if (!firstUser && isHumanUserLine(obj)) firstUser = obj.message.content.trim();
      }
    });

    return {
      summary, firstUser, firstTs, lastTs,
      userMsgs, assistantMsgs,
      cwd, gitBranch, model, version,
      tokensIn, tokensOut, tokensCacheRead, tokensCacheCreate,
      tokenEvents,
      fileSize: stat.size, mtime: stat.mtimeMs,
    };
  }

  // Cheap scan: walk projects/<encoded>/*.jsonl, return {file, mtime}
  // tuples. lstat (not stat) at each level refuses to follow symlinks so
  // a stray link can't redirect the scanner outside ~/.claude/projects.
  //
  // Subagent JSONLs live at projects/<encoded>/<sessionId>/subagents/*.jsonl
  // and reuse the parent's sessionId. They carry their own user/assistant
  // turns (tokens, timestamps) but are not standalone sessions — Claude
  // Code's `/stats` rolls them into the same conversation. We collect them
  // alongside the top-level entry so buildSession() can fold their token
  // events + first/last timestamps into the parent's totals. Without this
  // step, Usage/Heatmap would silently drop every project whose token
  // activity happened in a subagent (a meaningful chunk under Claude Code
  // 2.0+ where many tools delegate to sidechain agents).
  async function statAllJsonl() {
    let projectDirs;
    try { projectDirs = await fsp.readdir(PROJECTS_DIR); } catch { return []; }
    const allFiles = [];
    for (const projectDir of projectDirs) {
      const projectPath = path.join(PROJECTS_DIR, projectDir);
      let stat;
      try { stat = await fsp.lstat(projectPath); } catch { continue; }
      if (stat.isSymbolicLink()) continue;
      if (!stat.isDirectory()) continue;
      let entries;
      try { entries = await fsp.readdir(projectPath); } catch { continue; }
      // First pass: top-level *.jsonl AND record session-id directories that
      // may hold subagents. Keep a Set of known session-ids so the second
      // pass only walks dirs that have a matching parent file.
      const topLevel = [];
      const sessionDirs = [];
      for (const entry of entries) {
        const filePath = path.join(projectPath, entry);
        let lst;
        try { lst = await fsp.lstat(filePath); } catch { continue; }
        if (lst.isSymbolicLink()) continue;
        if (lst.isFile() && entry.endsWith('.jsonl')) {
          topLevel.push({ projectDir, entry, filePath });
        } else if (lst.isDirectory()) {
          // Directory whose name matches a sessionId pattern (UUID-ish).
          // Conservative regex — letters/digits/hyphens, ≥ 8 chars — so
          // unrelated sub-directories never get walked into.
          if (/^[A-Za-z0-9_-]{8,}$/.test(entry)) sessionDirs.push(entry);
        }
      }
      // Second pass: collect <sessionId>/subagents/*.jsonl per known session.
      const subagentsBySessionId = new Map(); // sessionId → [{filePath}]
      for (const sid of sessionDirs) {
        const subDir = path.join(projectPath, sid, 'subagents');
        let sub;
        try { sub = await fsp.lstat(subDir); } catch { continue; }
        if (sub.isSymbolicLink() || !sub.isDirectory()) continue;
        let subEntries;
        try { subEntries = await fsp.readdir(subDir); } catch { continue; }
        const list = [];
        for (const sf of subEntries) {
          if (!sf.endsWith('.jsonl')) continue;
          const fp = path.join(subDir, sf);
          let lst;
          try { lst = await fsp.lstat(fp); } catch { continue; }
          if (lst.isSymbolicLink() || !lst.isFile()) continue;
          list.push({ filePath: fp });
        }
        if (list.length) subagentsBySessionId.set(sid, list);
      }
      for (const f of topLevel) {
        const sid = f.entry.replace(/\.jsonl$/, '');
        const sa = subagentsBySessionId.get(sid);
        if (sa) f.subagents = sa;
        allFiles.push(f);
      }
    }
    // Stat both the parent file and any subagents in one concurrent pass so
    // the SWR push has accurate mtimes for cache invalidation.
    return mapPool(allFiles, 32, async (f) => {
      let mtime = 0;
      try { mtime = (await fsp.stat(f.filePath)).mtimeMs; } catch {}
      let subagents;
      if (f.subagents && f.subagents.length) {
        subagents = await Promise.all(f.subagents.map(async (s) => {
          try { return { ...s, mtime: (await fsp.stat(s.filePath)).mtimeMs }; }
          catch { return { ...s, mtime: 0 }; }
        }));
      }
      return subagents ? { ...f, mtime, subagents } : { ...f, mtime };
    });
  }

  // Subagent metadata: just the bits buildSession folds into the parent
  // (tokens + first/last timestamps + token-event series for usage rolling
  // windows). Skip everything else — summary, firstUser, cwd, git branch,
  // version belong to the parent session. Cached identically to the parent
  // metadata so a re-scan of an unchanged subagent file is free.
  async function readSubagentMetadata(filePath) {
    const stat = await fsp.stat(filePath);
    const cached = fileMetaCache.get(filePath);
    if (cached && cached.mtime === stat.mtimeMs && cached.meta?.__subagent) {
      return cached.meta;
    }
    // No size cap on subagent metadata either, same rationale as
    // readSessionMetadataFromDisk above — streaming keeps memory bounded.
    let tokensIn = 0, tokensOut = 0, tokensCacheRead = 0, tokensCacheCreate = 0;
    let firstTs = null, lastTs = null;
    const tokenEvents = [];
    await forEachJsonlLine(filePath, (obj) => {
      if (obj.type === 'assistant') {
        const u = obj.message?.usage;
        if (u) {
          const evIn = u.input_tokens || 0;
          const evOut = u.output_tokens || 0;
          const evCr = u.cache_read_input_tokens || 0;
          const evCc = u.cache_creation_input_tokens || 0;
          tokensIn += evIn;
          tokensOut += evOut;
          tokensCacheRead += evCr;
          tokensCacheCreate += evCc;
          if (obj.timestamp) {
            const ts = new Date(obj.timestamp).getTime();
            if (!isNaN(ts)) tokenEvents.push({ ts, i: evIn, o: evOut, cr: evCr, cc: evCc });
          }
        }
      }
      if (obj.timestamp && (obj.type === 'user' || obj.type === 'assistant')) {
        if (!firstTs) firstTs = obj.timestamp;
        lastTs = obj.timestamp;
      }
    });
    const meta = { __subagent: true, tokensIn, tokensOut, tokensCacheRead, tokensCacheCreate, firstTs, lastTs, tokenEvents };
    fileMetaCache.set(filePath, { mtime: stat.mtimeMs, meta });
    return meta;
  }

  // Combine the parser meta + userdata lookups into a session view.
  // Errors during metadata read are swallowed and replaced with a
  // placeholder entry so a single corrupt JSONL doesn't break the list.
  //
  // If the entry carries `subagents`, fold their tokens + timestamps + token
  // events into the parent's totals. Subagent activity is part of the same
  // conversation but lives in `<sessionId>/subagents/*.jsonl` — without this
  // merge, Usage/Heatmap silently drop every project that delegated to a
  // sidechain agent (the common case under Claude Code 2.0+).
  async function buildSession({ projectDir, entry, filePath, subagents }) {
    const sessionId = entry.replace(/\.jsonl$/, '');
    const k = compositeKey('claude', sessionId);
    try {
      const meta = await readSessionMetadata(filePath);
      const projectCwd = decodeProjectDir(projectDir);
      // Seed numeric fields so subagent-merge `+= ` lands on a number
      // even when the parent meta is incomplete (e.g. an older `tooLarge`
      // cache entry that pre-dates the no-cap parser). Without these
      // defaults the merge produces NaN and the by-model / total token
      // displays silently break.
      const merged = {
        tokensIn: 0, tokensOut: 0, tokensCacheRead: 0, tokensCacheCreate: 0,
        userMsgs: 0, assistantMsgs: 0,
        tokenEvents: [],
        ...meta,
      };
      if (subagents && subagents.length) {
        // mapPool concurrency bound at 8 because each subagent JSONL is
        // streamed in full, and a project can have dozens — opening all at
        // once would spike fd usage on a cold scan.
        const subMetas = await mapPool(subagents, 8, async (s) => {
          try { return await readSubagentMetadata(s.filePath); }
          catch { return null; }
        });
        for (const sm of subMetas) {
          if (!sm) continue;
          merged.tokensIn += sm.tokensIn;
          merged.tokensOut += sm.tokensOut;
          merged.tokensCacheRead += sm.tokensCacheRead;
          merged.tokensCacheCreate += sm.tokensCacheCreate;
          if (sm.tokenEvents.length) {
            merged.tokenEvents = (merged.tokenEvents || []).concat(sm.tokenEvents);
          }
          // Widen firstTs/lastTs to cover the subagent's window so the
          // session's calendar-day key in usageSummary lands on the right
          // bucket. Compare via Date.parse so ISO strings compare as
          // monotonic — string compare happens to work for ISO 8601 but
          // is fragile if the timezone format ever drifts.
          if (sm.firstTs && (!merged.firstTs || new Date(sm.firstTs) < new Date(merged.firstTs))) {
            merged.firstTs = sm.firstTs;
          }
          if (sm.lastTs && (!merged.lastTs || new Date(sm.lastTs) > new Date(merged.lastTs))) {
            merged.lastTs = sm.lastTs;
          }
        }
      }
      return {
        source: 'claude',
        id: sessionId, projectDir,
        decodedCwd: projectCwd,
        projectCwd,
        lastCwd: merged.cwd || projectCwd,
        filePath,
        favorite: isFavorite(k),
        excluded: isExcluded(k),
        alias: getAlias(k),
        ...merged,
        cwd: undefined,
      };
    } catch (e) {
      return {
        source: 'claude',
        id: sessionId, projectDir,
        decodedCwd: decodeProjectDir(projectDir),
        projectCwd: decodeProjectDir(projectDir),
        lastCwd: decodeProjectDir(projectDir),
        filePath,
        favorite: isFavorite(k),
        excluded: isExcluded(k),
        alias: getAlias(k),
        error: String(e),
      };
    }
  }

  async function getSessionMessages(filePath) {
    const stat = await fsp.stat(filePath);
    if (stat.size > MAX_SESSION_FILE_SIZE) {
      throw new Error(`Session file is ${(stat.size / 1024 / 1024).toFixed(1)} MB; refusing to load (cap: ${MAX_SESSION_FILE_SIZE / 1024 / 1024} MB)`);
    }
    const messages = [];
    // Session-level image budget threaded through inline + image-cache so
    // we stop READING new cache files once the cap is exhausted (instead
    // of reading them all and truncating in capSessionImages).
    const imageBudget = { usedB64: 0, truncated: false };
    await forEachJsonlLine(filePath, async (obj) => {
      if (obj.type === 'summary' && typeof obj.summary === 'string') {
        messages.push({ kind: 'summary', text: obj.summary, timestamp: obj.timestamp || null });
        return;
      }
      // Queued prompts. When the user types while the model is mid-tool,
      // the CLI stores the input as a `queue-operation: enqueue` event
      // AND, once the queue delivers it, a `type: 'attachment'` row with
      // `attachment.type: 'queued_command'`. Use the attachment as the
      // single delivery signal (cancelled queue entries never get one).
      if (obj.type === 'attachment' && obj.attachment?.type === 'queued_command' && typeof obj.attachment.prompt === 'string') {
        const text = obj.attachment.prompt.trim();
        if (text && !isSystemInjectedUserText(text)) {
          messages.push({
            kind: 'user',
            text,
            isToolResult: false,
            isToolUse: false,
            timestamp: obj.timestamp || null,
            model: null,
            usage: null,
          });
        }
        return;
      }
      if (obj.type !== 'user' && obj.type !== 'assistant') return;

      // Skip Claude Code's own injected user lines (slash commands,
      // system reminders, async task notifications, caveats, bash
      // stdin/stdout capture, etc).
      if (obj.type === 'user' && isSystemInjectedUserText(obj.message?.content)) return;

      const role = obj.type;
      const rawText = extractMessageText(obj.message);
      const inlineImages = extractMessageImages(obj.message);
      for (const img of inlineImages) {
        if (typeof img.data === 'string') imageBudget.usedB64 += img.data.length;
      }
      const cacheImages = await loadClaudeImageCacheImages(rawText, imageBudget);
      const images = [...inlineImages, ...cacheImages];
      const text = stripImagePlaceholders(rawText);

      const isToolResult = role === 'user' && Array.isArray(obj.message?.content) &&
        obj.message.content.some(p => p?.type === 'tool_result');
      const isToolUse = role === 'assistant' && Array.isArray(obj.message?.content) &&
        obj.message.content.some(p => p?.type === 'tool_use');
      messages.push({
        kind: role, text, isToolResult, isToolUse,
        timestamp: obj.timestamp || null,
        model: obj.message?.model || null,
        usage: obj.message?.usage || null,
        images: images.length > 0 ? images : undefined,
      });
    });
    return capSessionImages(messages);
  }

  return {
    readSessionMetadata,
    readSessionMetadataFromDisk,
    statAllJsonl,
    buildSession,
    getSessionMessages,
  };
}

module.exports = {
  // Leaf helpers (no createParser needed).
  decodeProjectDir,
  extractMessageText,
  SYSTEM_INJECTION_PREFIXES,
  isSystemInjectedUserText,
  isHumanUserLine,
  IMAGE_CACHE_MARKER,
  PATH_EXT_TO_MIME,
  loadClaudeImageCacheImages,
  // Factory.
  createParser,
};
