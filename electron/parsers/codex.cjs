// Codex (OpenAI codex CLI) session parsing. Sits next to `parsers/claude.cjs`
// — the structural mirror image, so a future third AI source (Gemini, etc.)
// plugs in by adding a `parsers/<source>.cjs` alongside.
//
// Codex sessions live under `~/.codex/sessions/<YYYY>/<MM>/<DD>/` and use a
// completely different on-disk shape from Claude: per-line `type` field is
// one of `session_meta`, `turn_context`, `response_item`, `event_msg`, etc.
// instead of Anthropic's `user`/`assistant` rows. We parse those JSONL
// shapes into the same MessageItem + SessionMeta surface the renderer uses
// so the UI doesn't need to special-case the source.
//
// Stateful pieces are injected via `createParser({ fileMetaCache, userdata })`
// just like the Claude parser.

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const { CODEX_SESSIONS_DIR } = require('../lib/paths.cjs');
const { forEachJsonlLine, MAX_SESSION_FILE_SIZE } = require('../lib/jsonl.cjs');
const { mapPool } = require('../lib/concurrency.cjs');
const {
  walkForImages,
  stripImagePlaceholders,
  capSessionImages,
} = require('../lib/images.cjs');
const { compositeKey } = require('./shared.cjs');

// ===========================================================================
// Leaf helpers
// ===========================================================================

// Codex sessions usually open with one or more system-injected user
// "messages" — AGENTS.md content, repository overview, file tree dump.
// We don't want the very first user message to count as the human's first
// question, so we detect those and skip past them.
const CODEX_PRELUDE_MARKERS = [
  '# AGENTS.md',
  '## AGENTS.md',
  '<environment_details>',
  '<repository_overview>',
  'You are operating in a codex session',
];

function looksLikeCodexAgentPrelude(text) {
  if (!text || text.length < 40) return false;
  const head = text.slice(0, 400);
  if (CODEX_PRELUDE_MARKERS.some(m => head.includes(m))) return true;
  // Long file-tree-ish dumps with many `/` and few sentences.
  const slashes = (head.match(/\//g) || []).length;
  const dots = (head.match(/\./g) || []).length;
  if (slashes >= 8 && dots / Math.max(slashes, 1) > 0.6) return true;
  return false;
}

// ===========================================================================
// Parser factory
// ===========================================================================

function createParser({ fileMetaCache, userdata }) {
  const { isFavorite, isExcluded, getAlias } = userdata;

  async function readCodexSessionMetadata(filePath) {
    const stat = await fsp.stat(filePath);
    const cached = fileMetaCache.get(filePath);
    if (cached && cached.mtime === stat.mtimeMs) {
      // Re-parse on the "file shrunk back under cap" transition the same
      // way the Claude parser does — a previously-tooLarge meta becomes
      // stale once the file is parseable again.
      if (!(cached.meta?.tooLarge && stat.size <= MAX_SESSION_FILE_SIZE)) {
        return cached.meta;
      }
    }

    // No size cap on Codex metadata, mirroring the Claude metadata path
    // (parsers/claude.cjs:184). forEachJsonlLine streams line-by-line so
    // peak memory stays bounded by MAX_JSONL_LINE_LEN regardless of file
    // size. The detail-view path still consults size before loading the
    // full messages array into the renderer.

    let id = '', cwd = '', model = '', version = '';
    let firstUser = '', summary = '';
    let firstTs = null, lastTs = null;
    let userMsgs = 0, assistantMsgs = 0;
    let tokensIn = 0, tokensOut = 0, tokensCacheRead = 0, tokensCacheCreate = 0;
    const tokenEvents = [];
    let lastPlanType = null;

    await forEachJsonlLine(filePath, (obj) => {
      if (obj.timestamp) {
        if (!firstTs) firstTs = obj.timestamp;
        lastTs = obj.timestamp;
      }

      const t = obj.type;
      const p = obj.payload || {};

      if (t === 'session_meta') {
        id = p.id || id;
        cwd = p.cwd || cwd;
        // session_meta only carries `model_provider` ("openai") — the real
        // model name comes later in `turn_context`. Skip model_provider as
        // a fallback so Usage's by-model breakdown never shows "openai" as
        // if it were a model; missing values land in an "unknown" bucket
        // via usageSummary, which is honest.
        if (!model && p.model) model = p.model;
        version = p.cli_version || version;
        return;
      }

      if (t === 'turn_context' && p.model) {
        // Real model name lives here: "gpt-5.5", "gpt-5-codex", etc.
        model = p.model;
        return;
      }

      if (t === 'response_item' && p.type === 'message') {
        const role = p.role;
        const text = Array.isArray(p.content)
          ? p.content.filter(c => c && (c.type === 'input_text' || c.type === 'output_text')).map(c => c.text || '').join('\n').trim()
          : '';
        if (role === 'user') {
          userMsgs++;
          if (!firstUser && text && !looksLikeCodexAgentPrelude(text)) {
            firstUser = text;
          }
        } else if (role === 'assistant') {
          assistantMsgs++;
        }
        return;
      }

      if (t === 'event_msg' && p.type === 'token_count') {
        // Real Codex shape: payload.info.last_token_usage = { input_tokens,
        // cached_input_tokens, output_tokens, reasoning_output_tokens,
        // total_tokens }. `total_token_usage` is the running cumulative
        // count — summing it would double-count, so we sum
        // `last_token_usage` (per-turn delta) instead. Fallback to flat
        // payload fields for forward-compat with older shapes.
        const last = (p.info && p.info.last_token_usage) || p;
        const inT = last.input_tokens || last.prompt_tokens || 0;
        const outT = (last.output_tokens || last.completion_tokens || 0)
          + (last.reasoning_output_tokens || 0);
        const cacheR = last.cached_input_tokens || last.cache_read_input_tokens || 0;
        const cacheC = last.cache_creation_input_tokens || 0;
        tokensIn += inT;
        tokensOut += outT;
        tokensCacheRead += cacheR;
        tokensCacheCreate += cacheC;
        if (obj.timestamp) {
          const ts = new Date(obj.timestamp).getTime();
          if (!isNaN(ts) && (inT || outT || cacheR || cacheC)) {
            tokenEvents.push({ ts, i: inT, o: outT, cr: cacheR, cc: cacheC });
          }
        }
        // Latest codex rate_limits also carries the user's plan_type
        // ("pro" / "plus" / etc) — stash so getCodexAuth can surface it
        // without re-walking every session.
        if (p.rate_limits && p.rate_limits.plan_type) {
          lastPlanType = p.rate_limits.plan_type;
        }
      }
    });

    const meta = {
      summary, firstUser, firstTs, lastTs,
      userMsgs, assistantMsgs,
      cwd, gitBranch: '', model, version,
      tokensIn, tokensOut, tokensCacheRead, tokensCacheCreate,
      tokenEvents,
      fileSize: stat.size, mtime: stat.mtimeMs,
      codexId: id || null,
      planType: lastPlanType,
    };
    fileMetaCache.set(filePath, { mtime: stat.mtimeMs, meta });
    return meta;
  }

  // Walk yyyy/mm/dd/*.jsonl. Don't recurse the whole ~/.codex (lots of
  // caches). Use lstat at each level and skip symlinks so a stray link
  // can't redirect the scanner outside ~/.codex/sessions.
  async function statAllCodexJsonl() {
    const isPlainDir = async (p) => {
      try { const st = await fsp.lstat(p); return st.isDirectory() && !st.isSymbolicLink(); }
      catch { return false; }
    };
    const allFiles = [];
    let years;
    try { years = await fsp.readdir(CODEX_SESSIONS_DIR); } catch { return []; }
    for (const y of years) {
      if (!/^\d{4}$/.test(y)) continue;
      const yp = path.join(CODEX_SESSIONS_DIR, y);
      if (!(await isPlainDir(yp))) continue;
      let months;
      try { months = await fsp.readdir(yp); } catch { continue; }
      for (const m of months) {
        if (!/^\d{2}$/.test(m)) continue;
        const mp = path.join(yp, m);
        if (!(await isPlainDir(mp))) continue;
        let days;
        try { days = await fsp.readdir(mp); } catch { continue; }
        for (const d of days) {
          if (!/^\d{2}$/.test(d)) continue;
          const dayPath = path.join(mp, d);
          if (!(await isPlainDir(dayPath))) continue;
          let entries;
          try { entries = await fsp.readdir(dayPath); } catch { continue; }
          for (const entry of entries) {
            if (!entry.endsWith('.jsonl')) continue;
            const filePath = path.join(dayPath, entry);
            let lst;
            try { lst = await fsp.lstat(filePath); } catch { continue; }
            if (lst.isSymbolicLink() || !lst.isFile()) continue;
            allFiles.push({ filePath, entry });
          }
        }
      }
    }
    return mapPool(allFiles, 32, async (f) => {
      try { const st = await fsp.stat(f.filePath); return { ...f, mtime: st.mtimeMs }; }
      catch { return { ...f, mtime: 0 }; }
    });
  }

  async function buildCodexSession({ filePath, entry }) {
    // The filename matches: rollout-<ISO-ts>-<uuid>.jsonl. Extract the
    // trailing uuid as session id (used for `codex resume <id>`).
    const m = entry.match(/^rollout-.*?-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i);
    const sessionId = m ? m[1] : entry.replace(/\.jsonl$/, '');
    try {
      const meta = await readCodexSessionMetadata(filePath);
      // Use the in-file id if present (more authoritative) but fall back to
      // filename-derived id for the favorite/exclude/alias map keys.
      const id = meta.codexId || sessionId;
      const k = compositeKey('codex', id);
      const projectCwd = meta.cwd || '';
      // Normalize both POSIX (`/Users/me/proj`) and Windows
      // (`C:\Users\me\proj`) separators so projectDir is consistent.
      const projectDir = projectCwd ? projectCwd.replace(/[\/\\]+/g, '-').replace(/^-/, '-') : '';
      return {
        source: 'codex',
        id,
        projectDir,
        decodedCwd: projectCwd,
        projectCwd,
        lastCwd: projectCwd,
        filePath,
        favorite: isFavorite(k),
        excluded: isExcluded(k),
        alias: getAlias(k),
        ...meta,
        codexId: undefined,
        cwd: undefined,
      };
    } catch (e) {
      const k = compositeKey('codex', sessionId);
      return {
        source: 'codex',
        id: sessionId,
        projectDir: '',
        decodedCwd: '',
        projectCwd: '',
        lastCwd: '',
        filePath,
        favorite: isFavorite(k),
        excluded: isExcluded(k),
        alias: getAlias(k),
        error: String(e),
      };
    }
  }

  async function getCodexSessionMessages(filePath) {
    // Codex JSONL: response_item with payload.type='message' carries
    // user/assistant turns; payload.content is an array of
    // { type: 'input_text'|'output_text', text }.
    // function_call + reasoning items show up too — render those as tool turns.
    const stat = await fsp.stat(filePath);
    if (stat.size > MAX_SESSION_FILE_SIZE) {
      throw new Error(`Session file is ${(stat.size / 1024 / 1024).toFixed(1)} MB; refusing to load (cap: ${MAX_SESSION_FILE_SIZE / 1024 / 1024} MB)`);
    }
    const messages = [];
    await forEachJsonlLine(filePath, (obj) => {
      const t = obj.type;
      const p = obj.payload || {};
      if (t !== 'response_item') return;

      if (p.type === 'message') {
        const role = p.role === 'assistant' ? 'assistant' : p.role === 'user' ? 'user' : null;
        if (!role) return;
        const rawText = Array.isArray(p.content)
          ? p.content
              .filter(c => c && (c.type === 'input_text' || c.type === 'output_text'))
              .map(c => c.text || '')
              .join('\n')
              .trim()
          : '';
        // Both vendor shapes (input_image, image, nested tool_result) flow
        // through the same walker so Codex sessions render images the same
        // way Claude sessions do.
        const images = [];
        walkForImages(p.content, images);
        // Codex injects `<image name=[Image #1] path="..."> [Image #1]` blobs
        // as adjacent text describing each attached image. Strip them so
        // the rendered text doesn't sit next to a literal path next to the
        // image.
        const text = stripImagePlaceholders(rawText);
        messages.push({
          kind: role,
          text,
          isToolResult: false,
          isToolUse: false,
          timestamp: obj.timestamp || null,
          model: null,
          usage: null,
          images: images.length > 0 ? images : undefined,
        });
        return;
      }

      if (p.type === 'function_call') {
        // Surface tool invocations as assistant tool_use turns so the
        // existing detail-view rendering can collapse them under "Tools
        // shown". Length-cap + strip control/bidi so a pathological tool
        // name from a hostile JSONL can't make the message text either
        // tens of KB long or visually masquerade as something else.
        const rawName = p.name || p.function?.name || 'tool';
        const name = String(rawName)
          .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
          // eslint-disable-next-line no-control-regex
          .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g, '')
          .replace(/[‪-‮⁦-⁩]/g, '')
          .slice(0, 200);
        // Cap tool-call arguments — a renderer that's just going to
        // collapse them under "tools shown" shouldn't receive several MB
        // of JSON for one line. 64 KB covers every realistic agent
        // prompt; past that, append a marker so the user knows the rest
        // is on disk.
        const ARG_TEXT_CAP = 64 * 1024;
        let argsText = typeof p.arguments === 'string' ? p.arguments : JSON.stringify(p.arguments || {}, null, 2);
        if (argsText.length > ARG_TEXT_CAP) {
          argsText = argsText.slice(0, ARG_TEXT_CAP) + `\n…[truncated, ${argsText.length} bytes total]`;
        }
        messages.push({
          kind: 'assistant',
          text: `🔧 ${name}\n${argsText}`,
          isToolResult: false,
          isToolUse: true,
          timestamp: obj.timestamp || null,
          model: null,
          usage: null,
        });
        return;
      }

      if (p.type === 'reasoning' && p.text) {
        messages.push({
          kind: 'assistant',
          text: '🧠 ' + p.text,
          isToolResult: false,
          isToolUse: false,
          timestamp: obj.timestamp || null,
          model: null,
          usage: null,
        });
      }
    });
    return capSessionImages(messages);
  }

  return {
    readCodexSessionMetadata,
    statAllCodexJsonl,
    buildCodexSession,
    getCodexSessionMessages,
  };
}

module.exports = {
  CODEX_PRELUDE_MARKERS,
  looksLikeCodexAgentPrelude,
  createParser,
};
