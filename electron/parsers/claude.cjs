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
const { readJsonFileSafe } = require('../lib/json-io.cjs');
const { listClaudeSubagentTranscriptFiles } = require('../lib/claude-subagents.cjs');
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

// The text of a single tool_result block (one user turn can answer several
// parallel tool calls, each its own block). Used to read a Workflow result's
// embedded run id per-block, so parallel Workflow calls don't get cross-linked.
function toolResultPartText(p) {
  if (typeof p.content === 'string') return p.content;
  if (Array.isArray(p.content)) return p.content.map(x => (x && typeof x.text === 'string') ? x.text : '').join(' ');
  return '';
}
// The Workflow launch tool_result embeds "Run ID: wf_…" in its text.
const WF_RUNID_RE = /Run ID:\s*(wf_[A-Za-z0-9_-]+)/;

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
// Subagent / workflow transcript index. Powers the detail view's inline
// "open subagent" feature: a session can spawn Task/Agent subagents and
// Workflow-tool agents, each writing a full transcript next to the parent.
// We surface a lightweight index (one entry per agent + per workflow run) so
// the renderer can wire each transcript to the originating tool call and load
// it lazily. Whitelisted fields only — the raw `wf_<runId>.json` carries the
// workflow's script source, full logs, and result, none of which the renderer
// needs (and which we don't want to ship into it wholesale).
// ===========================================================================

// Cap on the preview strings we pass to the renderer (descriptions, prompt /
// result previews). The run record already truncates these, but a hand-edited
// or older record could carry more — keep the IPC payload bounded.
const SUBAGENT_PREVIEW_MAX = 1000;
function capPreview(s) {
  if (typeof s !== 'string') return undefined;
  return s.length > SUBAGENT_PREVIEW_MAX ? s.slice(0, SUBAGENT_PREVIEW_MAX) + '…' : s;
}

// Workflow run records inline the script source, full logs, and result, so the
// 16 MB default userdata cap can drop a long run wholesale. Allow more for the
// record specifically (still bounded — it's JSON.parsed into memory). Agent
// `.meta.json` stays on the default cap (it's tiny).
const MAX_WORKFLOW_RECORD_SIZE = 64 * 1024 * 1024;

// readJsonFileSafe returns the raw UTF-8 string (or null) — callers parse it
// themselves. Wrap it so a corrupt record degrades to null instead of throwing.
async function readJsonParsed(filePath, maxBytes) {
  const raw = await readJsonFileSafe(filePath, maxBytes);
  if (raw == null) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

// lstat a path and return its stats only when it's a real (non-symlink) entry
// of the requested kind. `~/.claude/projects` is tool-owned; a symlink inside
// the subagent tree is either misconfiguration or an attempt to redirect the
// reader outside the base, so we reject it at every level we descend.
async function realStat(p, kind /* 'file' | 'dir' */) {
  let st;
  try { st = await fsp.lstat(p); } catch { return null; }
  if (st.isSymbolicLink()) return null;
  if (kind === 'dir' && !st.isDirectory()) return null;
  if (kind === 'file' && !st.isFile()) return null;
  return st;
}

// Top-level Task/Agent subagents: `<sessionId>/subagents/agent-<id>.jsonl`
// (+ `.meta.json`). The `workflows/` subdir and `journal.jsonl` belong to the
// workflow path and are skipped here.
async function scanTaskAgents(subagentsDir) {
  if (!(await realStat(subagentsDir, 'dir'))) return [];
  let entries;
  try { entries = await fsp.readdir(subagentsDir); } catch { return []; }
  const out = [];
  // Drive off the transcript file (`agent-<id>.jsonl`), not the meta — an agent
  // that wrote its transcript but no `.meta.json` (e.g. crashed mid-write) still
  // surfaces, just without agentType/description/toolUseId. `journal.jsonl` and
  // the `workflows/` subdir don't match `agent-*.jsonl`, so they're skipped.
  for (const name of entries) {
    if (!name.startsWith('agent-') || !name.endsWith('.jsonl')) continue;
    const agentId = name.slice('agent-'.length, -'.jsonl'.length);
    if (!agentId) continue;
    const jsonlPath = path.join(subagentsDir, name);
    const st = await realStat(jsonlPath, 'file');
    if (!st) continue;
    let meta = await readJsonParsed(path.join(subagentsDir, `agent-${agentId}.meta.json`));
    if (!meta || typeof meta !== 'object') meta = {};
    out.push({
      agentId,
      agentType: typeof meta.agentType === 'string' ? meta.agentType : null,
      description: capPreview(meta.description),
      toolUseId: typeof meta.toolUseId === 'string' ? meta.toolUseId : null,
      filePath: jsonlPath,
      fileSize: st.size,
      mtime: st.mtimeMs,
    });
  }
  return out;
}

// Workflow runs. Run records live at `<sessionId>/workflows/<runId>.json`;
// the matching agent transcripts at `<sessionId>/subagents/workflows/<runId>/
// agent-<agentId>.jsonl`. Driven by the run records (they carry the rich
// per-agent metadata); each progress entry is resolved to its transcript file
// when present. A half-written run (record but no transcript, or vice versa)
// degrades gracefully — the agent just gets `filePath: null`.
async function scanWorkflowRuns(sessionDir, subagentsDir) {
  const workflowsDir = path.join(sessionDir, 'workflows');
  const wfAgentsRoot = path.join(subagentsDir, 'workflows');
  const out = [];
  // Pass 1: run records (rich metadata) — only if the records dir exists. The
  // orphan pass below runs regardless, so a session that has transcript dirs
  // but never wrote any `workflows/<runId>.json` still surfaces.
  let entries = [];
  if (await realStat(workflowsDir, 'dir')) {
    try { entries = await fsp.readdir(workflowsDir); } catch { entries = []; }
  }
  for (const name of entries) {
    if (!name.endsWith('.json')) continue; // skip the `scripts/` subdir
    const recPath = path.join(workflowsDir, name);
    if (!(await realStat(recPath, 'file'))) continue;
    const rec = await readJsonParsed(recPath, MAX_WORKFLOW_RECORD_SIZE);
    if (!rec || typeof rec !== 'object' || typeof rec.runId !== 'string') continue;
    const runId = rec.runId;
    const agentDir = path.join(wfAgentsRoot, runId);
    const hasAgentDir = !!(await realStat(agentDir, 'dir'));
    const progress = Array.isArray(rec.workflowProgress) ? rec.workflowProgress : [];
    const agents = [];
    for (const p of progress) {
      // workflowProgress mixes `workflow_phase` markers with `workflow_agent`
      // rows; only the latter are agents.
      if (!p || typeof p !== 'object' || p.type !== 'workflow_agent') continue;
      const agentId = typeof p.agentId === 'string' ? p.agentId : null;
      let filePath = null, fileSize = 0, mtime = 0;
      if (agentId && hasAgentDir) {
        const fp = path.join(agentDir, `agent-${agentId}.jsonl`);
        const st = await realStat(fp, 'file');
        if (st) { filePath = fp; fileSize = st.size; mtime = st.mtimeMs; }
      }
      agents.push({
        agentId,
        label: typeof p.label === 'string' ? p.label : null,
        phaseIndex: typeof p.phaseIndex === 'number' ? p.phaseIndex : null,
        phaseTitle: typeof p.phaseTitle === 'string' ? p.phaseTitle : null,
        model: typeof p.model === 'string' ? p.model : null,
        state: typeof p.state === 'string' ? p.state : null,
        tokens: typeof p.tokens === 'number' ? p.tokens : 0,
        toolCalls: typeof p.toolCalls === 'number' ? p.toolCalls : 0,
        durationMs: typeof p.durationMs === 'number' ? p.durationMs : 0,
        promptPreview: capPreview(p.promptPreview),
        resultPreview: capPreview(p.resultPreview),
        filePath, fileSize, mtime,
      });
    }
    out.push({
      runId,
      taskId: typeof rec.taskId === 'string' ? rec.taskId : null,
      name: typeof rec.workflowName === 'string' ? rec.workflowName : null,
      summary: capPreview(rec.summary),
      status: typeof rec.status === 'string' ? rec.status : null,
      durationMs: typeof rec.durationMs === 'number' ? rec.durationMs : 0,
      totalTokens: typeof rec.totalTokens === 'number' ? rec.totalTokens : 0,
      defaultModel: typeof rec.defaultModel === 'string' ? rec.defaultModel : null,
      startTime: typeof rec.startTime === 'number' ? rec.startTime : 0,
      phases: Array.isArray(rec.phases)
        ? rec.phases.map(ph => ({ title: ph && typeof ph.title === 'string' ? ph.title : '' }))
        : [],
      agents,
    });
  }
  // Orphan transcript dirs: `subagents/workflows/<runId>/` has agent files but
  // no `workflows/<runId>.json` run record (the run crashed before writing it).
  // Synthesize a bare run so the transcripts aren't silently dropped — no rich
  // metadata, just the agent files keyed by their filename id.
  const covered = new Set(out.map(r => r.runId));
  if (await realStat(wfAgentsRoot, 'dir')) {
    let runDirs = [];
    try { runDirs = await fsp.readdir(wfAgentsRoot); } catch { runDirs = []; }
    for (const runId of runDirs) {
      if (covered.has(runId)) continue;
      const agentDir = path.join(wfAgentsRoot, runId);
      const dirSt = await realStat(agentDir, 'dir');
      if (!dirSt) continue;
      let files = [];
      try { files = await fsp.readdir(agentDir); } catch { files = []; }
      const agents = [];
      for (const f of files) {
        if (!f.startsWith('agent-') || !f.endsWith('.jsonl')) continue;
        const agentId = f.slice('agent-'.length, -'.jsonl'.length);
        const fp = path.join(agentDir, f);
        const st = await realStat(fp, 'file');
        if (!st) continue;
        let meta = await readJsonParsed(path.join(agentDir, `agent-${agentId}.meta.json`));
        if (!meta || typeof meta !== 'object') meta = {};
        agents.push({
          agentId,
          label: typeof meta.label === 'string' ? meta.label : null,
          phaseIndex: null, phaseTitle: null,
          model: null, state: null, tokens: 0, toolCalls: 0, durationMs: 0,
          promptPreview: undefined, resultPreview: undefined,
          filePath: fp, fileSize: st.size, mtime: st.mtimeMs,
        });
      }
      if (!agents.length) continue;
      out.push({
        runId, taskId: null, name: null, summary: undefined,
        status: null, durationMs: 0, totalTokens: 0, defaultModel: null,
        // `synthetic`: no run record, so we have no real ordering signal. The
        // linker excludes these from the order-based fallback (they can only
        // link via an exact runId match) so a dir mtime never mis-attributes a
        // transcript to the wrong Workflow card.
        startTime: dirSt.mtimeMs, synthetic: true, phases: [], agents,
      });
    }
  }
  // Chronological so the renderer's order-based fallback (Nth Workflow call ↔
  // Nth run) lines up when the result-text link can't be resolved.
  out.sort((a, b) => a.startTime - b.startTime);
  return out;
}

// Index every subagent / workflow transcript belonging to one parent session.
// `parentFilePath` must already be containment-checked + realpath-resolved by
// the caller (the IPC gate). Best-effort throughout: a missing dir or a single
// corrupt record is skipped locally so the index never fails the IPC.
async function scanSessionSubagents(parentFilePath) {
  const empty = { taskAgents: [], workflowRuns: [] };
  if (typeof parentFilePath !== 'string' || !parentFilePath.endsWith('.jsonl')) return empty;
  const dir = path.dirname(parentFilePath);
  const sessionId = path.basename(parentFilePath, '.jsonl');
  const sessionDir = path.join(dir, sessionId);
  if (!(await realStat(sessionDir, 'dir'))) return empty;
  const subagentsDir = path.join(sessionDir, 'subagents');
  const [taskAgents, workflowRuns] = await Promise.all([
    scanTaskAgents(subagentsDir),
    scanWorkflowRuns(sessionDir, subagentsDir),
  ]);
  return { taskAgents, workflowRuns };
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
      // Second pass: collect each session's subagent transcripts — Task agents
      // AND Workflow-tool agents (subagents/workflows/<runId>/) — via the shared
      // enumerator so Usage/Heatmap rolls in workflow tokens too, and the rule
      // stays in sync with deep search.
      const subagentsBySessionId = new Map(); // sessionId → [{filePath}]
      for (const sid of sessionDirs) {
        const sessionDir = path.join(projectPath, sid);
        const subFiles = await listClaudeSubagentTranscriptFiles(sessionDir);
        if (subFiles.length) subagentsBySessionId.set(sid, subFiles.map(s => ({ filePath: s.filePath })));
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

      const parts = Array.isArray(obj.message?.content) ? obj.message.content : null;
      const isToolResult = role === 'user' && !!parts && parts.some(p => p?.type === 'tool_result');
      const isToolUse = role === 'assistant' && !!parts && parts.some(p => p?.type === 'tool_use');
      // Surface tool-call identity so the renderer can wire subagent / workflow
      // transcripts to the exact Agent/Workflow call. A single assistant turn
      // can carry several tool_use blocks (parallel tools), so this is a list,
      // not one field. tool_result rows carry the id(s) they answer so the
      // renderer can walk back from a Workflow result (whose text holds the run
      // id) to the originating Workflow call.
      let toolCalls, toolResults;
      if (isToolUse) {
        toolCalls = parts
          .filter(p => p?.type === 'tool_use' && typeof p.id === 'string')
          .map(p => ({ toolName: typeof p.name === 'string' ? p.name : '', toolUseId: p.id }));
        if (!toolCalls.length) toolCalls = undefined;
      }
      if (isToolResult) {
        // Per-block so a Workflow result's run id stays attached to the exact
        // tool_use it answers (parallel Workflow calls land in one user turn).
        toolResults = parts
          .filter(p => p?.type === 'tool_result' && typeof p.tool_use_id === 'string')
          .map(p => {
            const m = toolResultPartText(p).match(WF_RUNID_RE);
            return m ? { toolUseId: p.tool_use_id, workflowRunId: m[1] } : { toolUseId: p.tool_use_id };
          });
        if (!toolResults.length) toolResults = undefined;
      }
      messages.push({
        kind: role, text, isToolResult, isToolUse,
        timestamp: obj.timestamp || null,
        model: obj.message?.model || null,
        usage: obj.message?.usage || null,
        images: images.length > 0 ? images : undefined,
        toolCalls, toolResults,
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
    getSubagents: scanSessionSubagents,
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
  scanSessionSubagents,
  // Factory.
  createParser,
};
