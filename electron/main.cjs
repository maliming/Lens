const { app, BrowserWindow, ipcMain, clipboard, shell, Tray, Menu, nativeImage, net } = require('electron');

// Last-ditch handlers so a stray promise rejection or unexpected sync throw
// doesn't take the whole app down with SIGABRT. We log everything and let the
// renderer keep going — the alternative is a hard crash with no recovery.
// File logger — writes to <userData>/logs/main.log (which is what Electron's
// app.getPath('logs') points to). Console output also goes to the file. Rotation
// is "truncate when bigger than ~2 MB" — keeps the file useful, never grows.
let _logFilePath = null;
function _logFile() {
  if (_logFilePath) return _logFilePath;
  try {
    const dir = app.getPath('logs');
    fs.mkdirSync(dir, { recursive: true });
    _logFilePath = path.join(dir, 'main.log');
    // Truncate if it's grown beyond ~2 MB so the log stays trim.
    try {
      const st = fs.statSync(_logFilePath);
      if (st.size > 2 * 1024 * 1024) fs.writeFileSync(_logFilePath, '');
    } catch {}
    return _logFilePath;
  } catch {
    _logFilePath = null;
    return null;
  }
}
function logToFile(level, parts) {
  const p = _logFile();
  if (!p) return;
  try {
    const ts = new Date().toISOString();
    const text = parts.map(x => x instanceof Error ? (x.stack || String(x)) : (typeof x === 'object' ? JSON.stringify(x) : String(x))).join(' ');
    fs.appendFileSync(p, `${ts} [${level}] ${text}\n`);
  } catch {}
}
const _origConsoleError = console.error.bind(console);
const _origConsoleLog = console.log.bind(console);
console.error = (...args) => { _origConsoleError(...args); logToFile('error', args); };
console.log = (...args) => { _origConsoleLog(...args); logToFile('info', args); };

// Crash handlers. uncaughtException is a sync-stack failure — main state is
// definitionally unknown, so log and exit rather than serve potentially
// torn IPC results. unhandledRejection is more often a transient (cancelled
// fetch, slow subprocess teardown) so we log but don't terminate; if the
// rejection actually corrupted shared state, a subsequent throw will catch
// it on the uncaughtException path.
process.on('uncaughtException', (err) => {
  console.error('[main] uncaughtException:', err?.stack || err);
  setTimeout(() => process.exit(1), 50);
});
process.on('unhandledRejection', (reason) => {
  console.error('[main] unhandledRejection:', reason);
});
const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const { execFile, execFileSync } = require('node:child_process');
const os = require('node:os');
const HOME = os.homedir();
const CLAUDE_DIR = path.join(HOME, '.claude');
const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');
const CODEX_DIR = path.join(HOME, '.codex');
const CODEX_SESSIONS_DIR = path.join(CODEX_DIR, 'sessions');

// Claude Code stamps assistant turns it generated locally (auto-summary,
// session restore, internal error messages) with a placeholder model name —
// usually "<synthetic>" or "synthetic". These turns don't consume Anthropic
// API tokens, so attributing the rest of the session's tokens to them in
// Usage's by-model breakdown is misleading. Skip them when tracking `model`
// so the field reflects the last REAL model invoked.
const SYNTHETIC_MODEL_RE = /^<?synthetic>?$/i;
function isSyntheticModel(m) { return typeof m === 'string' && SYNTHETIC_MODEL_RE.test(m); }

// Provider-name leak filter: older Lens cached sessions where Codex's
// turn_context never appeared sometimes stored just the provider string
// ("openai", "anthropic") in s.model instead of a real model name. Treat
// those as unknown in Usage so the by-model breakdown isn't misleading.
const PROVIDER_NAMES = new Set(['openai', 'anthropic', 'azure', 'bedrock']);
function looksLikeProvider(m) { return typeof m === 'string' && PROVIDER_NAMES.has(m.toLowerCase()); }
function isUsableModel(m) { return typeof m === 'string' && m.length > 0 && !isSyntheticModel(m) && !looksLikeProvider(m); }

// Cap for userData JSON files (favorites/excludes/aliases/appPrefs/sessions-cache)
// and auth/credentials reads. These never exceed a few hundred KB in normal
// use; capping at 16 MB protects against a corrupted file or a tampered
// userData dir from OOMing the main process at startup.
const MAX_USERDATA_FILE_SIZE = 16 * 1024 * 1024;
async function readJsonFileSafe(filePath, maxBytes = MAX_USERDATA_FILE_SIZE) {
  try {
    const st = await fsp.lstat(filePath);
    if (st.isSymbolicLink()) return null;
    if (st.size > maxBytes) {
      console.warn(`readJsonFileSafe: refusing ${filePath} (${st.size} > ${maxBytes})`);
      return null;
    }
    return await fsp.readFile(filePath, 'utf8');
  } catch { return null; }
}

// Cap how much we'll readFile into a single string when parsing a session.
// Real long-running sessions hit 50–150 MB once tool outputs and pasted logs
// accumulate; 200 MB still keeps the main process well under any modern RAM
// ceiling while blocking the truly pathological cases (corrupted JSONL,
// accidental log dump) that would otherwise OOM.
const MAX_SESSION_FILE_SIZE = 200 * 1024 * 1024;

// macOS/Linux GUI launches (Finder, Spotlight, .desktop) inherit a minimal PATH
// from launchctl/systemd and don't see ~/.local/bin, /opt/homebrew/bin, NVM shims,
// etc. Without this, `claude auth status` and similar spawns fail in packaged
// builds even though they work fine under `npm run dev` (which inherits the
// terminal's PATH). We resolve the user's real PATH by running their login
// shell once at startup, then prepend a few well-known fallbacks defensively.
function fixPath() {
  if (process.platform === 'win32') return;
  const userShell = process.env.SHELL || '/bin/zsh';
  try {
    const out = execFileSync(userShell, ['-ilc', 'printf __CLP__=%s "$PATH"'], {
      encoding: 'utf8',
      timeout: 4000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const m = out.match(/__CLP__=([^\n]+)/);
    if (m && m[1]) process.env.PATH = m[1];
  } catch {
    // Shell failed (no zshrc, weird env) — fall through to extras.
  }
  const extras = [
    path.join(HOME, '.local/bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
  ];
  const seen = new Set((process.env.PATH || '').split(path.delimiter).filter(Boolean));
  const merged = [...seen];
  for (const p of extras) if (!seen.has(p)) merged.push(p);
  process.env.PATH = merged.join(path.delimiter);
}
fixPath();

let favoritesPath = '';
let excludesPath = '';
let aliasesPath = '';
let favoriteSet = new Set();
let excludeSet = new Set();
let aliasMap = {};  // { [sessionId]: alias }
let mainWindow = null;
let tray = null;
let isQuitting = false;

// Composite key = "<source>:<sessionId>" so favorites / excludes / aliases
// can't collide across providers.
const VALID_SOURCES = new Set(['claude', 'codex']);
function compositeKey(source, id) {
  if (!source || !VALID_SOURCES.has(source)) source = 'claude';
  if (typeof id !== 'string') throw new Error('id must be string');
  return `${source}:${id}`;
}

async function loadJsonSet(filePath) {
  try {
    const raw = await readJsonFileSafe(filePath);
    if (raw == null) return new Set();
    const obj = JSON.parse(raw);
    const ids = Array.isArray(obj?.ids) ? obj.ids : [];
    return new Set(ids.filter((x) => typeof x === 'string'));
  } catch { return new Set(); }
}

// Serialized + atomic JSON writer. Two problems it solves:
//   1. Concurrency: fast successive toggle()s can otherwise interleave so the
//      newer write completes before the older one and gets overwritten by it.
//      A per-file promise queue forces serial execution.
//   2. Crash-safety: writeFile to a .tmp + rename means a power loss can
//      leave either the old file intact or the new one — never half-written
//      JSON the next launch can't parse.
const _writeQueues = new Map();
async function atomicWriteJson(filePath, value) {
  const prev = _writeQueues.get(filePath) || Promise.resolve();
  const next = prev.catch(() => {}).then(async () => {
    const dir = path.dirname(filePath);
    await fsp.mkdir(dir, { recursive: true });
    const tmp = filePath + '.tmp-' + process.pid + '-' + (++_writeQueues.tmpSeq || (_writeQueues.tmpSeq = 1));
    // Open with a handle so we can fsync the data before renaming — without
    // it a power loss after `writeFile` but before the disk cache flush could
    // leave us with an empty / partial file on next boot. fsync on the
    // directory (Linux/macOS) makes the rename itself durable.
    const fh = await fsp.open(tmp, 'w');
    try {
      await fh.writeFile(JSON.stringify(value, null, 2), 'utf8');
      try { await fh.sync(); } catch {}
    } finally {
      await fh.close();
    }
    await fsp.rename(tmp, filePath);
    if (process.platform !== 'win32') {
      try {
        const dirFh = await fsp.open(dir, 'r');
        try { await dirFh.sync(); } catch {}
        await dirFh.close();
      } catch {}
    }
  });
  _writeQueues.set(filePath, next);
  try { await next; } finally {
    if (_writeQueues.get(filePath) === next) _writeQueues.delete(filePath);
  }
}

async function saveJsonSet(filePath, set) {
  try {
    await atomicWriteJson(filePath, { ids: [...set] });
  } catch (e) {
    console.error('saveJsonSet failed', filePath, e);
  }
}

async function loadPersistedSets() {
  favoritesPath = path.join(app.getPath('userData'), 'favorites.json');
  excludesPath = path.join(app.getPath('userData'), 'excludes.json');
  aliasesPath = path.join(app.getPath('userData'), 'aliases.json');
  sessionsCachePath = path.join(app.getPath('userData'), 'sessions-cache.json');
  appPrefsPath = path.join(app.getPath('userData'), 'app-prefs.json');
  favoriteSet = await loadJsonSet(favoritesPath);
  excludeSet = await loadJsonSet(excludesPath);
  try {
    const raw = await readJsonFileSafe(aliasesPath);
    if (raw == null) { aliasMap = {}; }
    else {
      const obj = JSON.parse(raw);
      aliasMap = (obj && typeof obj === 'object' && obj.aliases && typeof obj.aliases === 'object') ? obj.aliases : {};
    }
  } catch { aliasMap = {}; }
  await loadAppPrefs();
  // Stale sessions from last run — populates cachedSessions + per-file mtime
  // map so the first listSessions() call returns instantly.
  await loadSessionsCache();
}

// ----- App preferences (showTrayIcon / closeBehavior / launchAtLogin) -----
let appPrefsPath = null;
const APP_PREFS_DEFAULTS = {
  showTrayIcon: true,
  // macOS users expect close=hide (app keeps running in menu bar). Win/Linux
  // users expect close=quit. We default per platform on first launch.
  closeBehavior: process.platform === 'darwin' ? 'hide' : 'quit',
  launchAtLogin: false,
  // Persisted between launches. null = first launch, use defaults.
  windowBounds: null,
  // Whether the user has consented to letting the main process probe
  // Anthropic for live rate limits (Claude only). 'pending' = haven't asked.
  // Codex bypasses this — its limits come from a local app-server subprocess.
  // Persisted in main rather than localStorage so the choice survives the
  // first launch's renderer init. Note this is a UI / usability gate, NOT a
  // hard security boundary: a compromised renderer can call
  // setRateLimitsConsent('granted') exactly like the user does. If you need
  // a true confirmation step, gate the probe behind a main-side native dialog.
  rateLimitsConsent: 'pending',
};
let appPrefs = { ...APP_PREFS_DEFAULTS };

async function loadAppPrefs() {
  try {
    const raw = await readJsonFileSafe(appPrefsPath);
    if (raw == null) return;
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== 'object') return;
    // Per-field validation: a corrupted prefs file (manual edit, version
    // mismatch, partial write that survived without atomic guarantees on
    // older builds) shouldn't be able to put non-booleans into boolean
    // flags. Mirrors the renderer's displayPrefs parser.
    const next = { ...APP_PREFS_DEFAULTS };
    if (typeof obj.showTrayIcon === 'boolean') next.showTrayIcon = obj.showTrayIcon;
    if (obj.closeBehavior === 'hide' || obj.closeBehavior === 'quit') next.closeBehavior = obj.closeBehavior;
    if (typeof obj.launchAtLogin === 'boolean') next.launchAtLogin = obj.launchAtLogin;
    if (obj.rateLimitsConsent === 'pending' || obj.rateLimitsConsent === 'granted' || obj.rateLimitsConsent === 'denied') {
      next.rateLimitsConsent = obj.rateLimitsConsent;
    }
    if (obj.windowBounds && typeof obj.windowBounds === 'object') {
      const b = obj.windowBounds;
      if (['x','y','width','height'].every(k => typeof b[k] === 'number' && Number.isFinite(b[k]))) {
        next.windowBounds = { x: b.x, y: b.y, width: b.width, height: b.height };
      }
    }
    appPrefs = next;
    // Reflect persisted launchAtLogin to the OS in case it drifted.
    applyLaunchAtLogin(appPrefs.launchAtLogin);
  } catch { appPrefs = { ...APP_PREFS_DEFAULTS }; }
}

async function saveAppPrefs() {
  try { await atomicWriteJson(appPrefsPath, appPrefs); }
  catch {}
}

function applyLaunchAtLogin(on) {
  try { app.setLoginItemSettings({ openAtLogin: !!on }); } catch {}
}

async function saveAliases() {
  try {
    await atomicWriteJson(aliasesPath, { aliases: aliasMap });
  } catch (e) {
    console.error('saveAliases failed', aliasesPath, e);
  }
}

function decodeProjectDir(name) {
  if (name.startsWith('-')) return '/' + name.slice(1).replace(/-/g, '/');
  return name;
}

function safeJson(line) {
  try { return JSON.parse(line); } catch { return null; }
}

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

// Extract embedded images from a message content array. Claude Code stores
// pasted/attached images in two flavours, both surface here:
//   { type: 'image', source: { type: 'base64', media_type, data } }
//   { type: 'image', file: { base64, mimeType } }       // newer Claude Code shape
// Returns an array of { mediaType, data } where data is the bare base64
// payload (no data: prefix). Empty array if the message has no images.
//
// Defence in depth — entries with non-image mimeTypes, non-base64 payloads, or
// non-http(s) URLs are dropped at parse time so a corrupted JSONL can't smuggle
// `javascript:` / `data:text/html` into the renderer's clickable image href.
const ALLOWED_IMAGE_MIME = /^image\/(png|jpe?g|gif|webp|bmp)$/i;
const BASE64_PAYLOAD = /^[A-Za-z0-9+/]+={0,2}$/;
// Per-image cap for inline base64 payloads. Anything beyond this is
// pathological — a normal screenshot in a JSONL is well under 5 MB. Larger
// payloads inflate the IPC message size and the data: URL the renderer mounts
// in memory; cap to keep both bounded.
const MAX_INLINE_IMAGE_B64 = 8 * 1024 * 1024;  // ~6 MB of binary
// Per-message + per-extraction caps. Stops a single corrupt JSONL line from
// pushing thousands of images into one message render or pinning hundreds of
// MB of payload into the IPC reply.
const MAX_IMAGES_PER_MESSAGE = 32;
// Per-session total cap on inline image payload that gets shipped over IPC.
// Even with the per-image / per-message caps above, a long session with many
// screenshots could otherwise hand the renderer hundreds of MB at once.
const MAX_SESSION_IMAGE_TOTAL_B64 = 64 * 1024 * 1024;  // ~48 MB of binary
function capSessionImages(messages) {
  let total = 0;
  let truncated = false;
  for (const m of messages) {
    if (!m.images) continue;
    if (truncated) {
      // Already over budget — strip the rest. (Was previously a `break` on
      // the outer loop, which left subsequent messages' images intact and
      // shipped them through IPC anyway.)
      m.images = undefined;
      continue;
    }
    const kept = [];
    for (const img of m.images) {
      const size = typeof img.data === 'string' ? img.data.length : 0;
      if (total + size > MAX_SESSION_IMAGE_TOTAL_B64) { truncated = true; break; }
      kept.push(img);
      total += size;
    }
    m.images = kept.length ? kept : undefined;
  }
  if (truncated) {
    // Flag every message so the UI can surface a banner regardless of which
    // one the user is currently looking at.
    for (const m of messages) m.imagesTruncated = true;
  }
  return messages;
}
function pushSafeImage(out, mediaType, data) {
  if (out.length >= MAX_IMAGES_PER_MESSAGE) return;
  if (mediaType === 'url') {
    // Match the production CSP (`img-src ... https:`) — http URLs would load
    // in dev but be silently dropped by Chromium in prod, leading to "works
    // for me" inconsistencies. Refuse them at the parser layer.
    if (typeof data === 'string' && /^https:\/\//i.test(data)) out.push({ mediaType, data });
    return;
  }
  if (typeof data !== 'string') return;
  if (!ALLOWED_IMAGE_MIME.test(mediaType || '')) return;
  if (!BASE64_PAYLOAD.test(data)) return;
  if (data.length > MAX_INLINE_IMAGE_B64) return;
  out.push({ mediaType, data });
}
function extractMessageImages(message) {
  const out = [];
  if (!message) return out;
  walkForImages(message.content, out);
  return out;
}

// Newer Claude Code doesn't inline image bytes in JSONL — it writes the bytes
// to `~/.claude/image-cache/<sessionId>/<n>.png` and embeds a literal text
// marker `[Image: source: /Users/.../image-cache/.../1.png]`. Pull the path
// out, read the file, return a base64 image entry. Returns null on any
// failure (path outside cache root, file missing, wrong size).
const CLAUDE_IMAGE_CACHE_ROOT = path.join(CLAUDE_DIR, 'image-cache');
const IMAGE_CACHE_MARKER = /\[Image:\s*source:\s*([^\]]+)\]/g;
const PATH_EXT_TO_MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp' };
// `budget` (optional) is the in-progress byte allowance for the current
// session — callers pass it in so we stop READING (not just stop pushing)
// once the session-level cap is exhausted. Saves disk IO + main RSS for
// sessions with many `[Image: source: ...]` markers.
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
      if (stat.size > 12 * 1024 * 1024) continue; // 12 MB cap — bigger than any pasted screenshot
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

// Strip image-attachment placeholder text that gets injected next to the real
// image content. Without this the renderer prints raw `<image name=...>` /
// `[Image #1]` / `[Image: source: /path/...]` next to the actual rendered
// screenshot, which looks broken.
function stripImagePlaceholders(text) {
  if (!text) return text;
  return text
    .replace(/<image\s+name=[^>]*?>/g, '')
    .replace(/\[Image:\s*source:\s*[^\]]+\]/g, '')
    .replace(/^\s*\[Image\s*#\d+\]\s*$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Recurse into the content tree picking up image blocks wherever they sit.
// Real-world JSONL nests them under `tool_result.content` (Claude Code's Read
// tool returning a screenshot) or as direct siblings of text blocks (Codex
// puts an `input_image` next to an `input_text` describing the upload). The
// walker handles both vendor shapes:
//   Claude  → { type: 'image',       source: { type:'base64', data, media_type } }
//             { type: 'image',       file:   { base64, mimeType } }
//             { type: 'image',       image_url: 'http(s)://...' }
//   Codex   → { type: 'input_image', image_url: 'data:image/png;base64,...' }
//             { type: 'input_image', image_url: { url: 'data:...' } }
// Without this walk, screenshotted tool results show up as text-only and the
// image vanishes.
function walkForImages(node, out, depth = 0) {
  if (depth > 6) return; // belt-and-suspenders: don't recurse into pathological structures
  if (!node) return;
  if (Array.isArray(node)) {
    for (const x of node) walkForImages(x, out, depth + 1);
    return;
  }
  if (typeof node !== 'object') return;

  if (node.type === 'image') {
    if (node.source && node.source.type === 'base64' && typeof node.source.data === 'string') {
      pushSafeImage(out, node.source.media_type || node.source.mediaType || 'image/png', node.source.data);
    } else if (node.file && typeof node.file.base64 === 'string') {
      pushSafeImage(out, node.file.mimeType || node.file.media_type || 'image/png', node.file.base64);
    } else if (typeof node.image_url === 'string') {
      pushImageFromUrl(out, node.image_url);
    }
    return;
  }

  if (node.type === 'input_image') {
    const url = typeof node.image_url === 'string'
      ? node.image_url
      : (node.image_url && typeof node.image_url.url === 'string' ? node.image_url.url : null);
    if (url) pushImageFromUrl(out, url);
    return;
  }

  // tool_result / attachment / similar wrappers hold images inside .content
  if (node.content) walkForImages(node.content, out, depth + 1);
}

// Inline base64 data: URLs get split into (mime, payload); plain http(s) URLs
// are pushed through as-is so the renderer can <img src=...> them directly.
function pushImageFromUrl(out, url) {
  const dataUrlMatch = url.match(/^data:([^;]+);base64,(.+)$/);
  if (dataUrlMatch) pushSafeImage(out, dataUrlMatch[1], dataUrlMatch[2]);
  else pushSafeImage(out, 'url', url);
}

function isHumanUserLine(obj) {
  if (!obj || obj.type !== 'user') return false;
  if (!obj.message) return false;
  if (typeof obj.message.content !== 'string') return false;
  const t = obj.message.content.trim();
  if (!t) return false;
  if (t.startsWith('<command-name>')) return false;
  if (t.startsWith('<local-command-stdout>')) return false;
  if (t.startsWith('Caveat:')) return false;
  return true;
}

// Per-file metadata cache keyed by absolute path. Invalidates when the file's
// mtime changes. Massive win on reload: inactive sessions (the vast majority)
// don't re-read at all after the first scan — only a cheap fs.stat.
const fileMetaCache = new Map(); // filePath → { mtime, meta }

async function readSessionMetadata(filePath) {
  const stat = await fsp.stat(filePath);
  const cached = fileMetaCache.get(filePath);
  if (cached && cached.mtime === stat.mtimeMs) {
    // Previously refused for size — re-check against the current cap so a
    // bumped MAX_SESSION_FILE_SIZE can rehabilitate the entry without a
    // manual cache wipe.
    if (!(cached.meta?.tooLarge && stat.size <= MAX_SESSION_FILE_SIZE)) {
      return cached.meta;
    }
  }
  const meta = await readSessionMetadataFromDisk(filePath, stat);
  fileMetaCache.set(filePath, { mtime: stat.mtimeMs, meta });
  return meta;
}

// Stream a JSONL file line by line, parsing each row and invoking `onLine`
// for every successfully-parsed object. Avoids the readFile + split('\n')
// pattern that keeps the whole file plus a parallel lines array in memory —
// critical when N session scanners run concurrently against 100-200MB JSONLs.
// onLine may be async; we await it so callers that need to do per-line I/O
// (image-cache lookup, etc.) work correctly without buffering everything.
// Single-line size cap. The file may be 200MB, but if any individual line
// approaches that size (one pathological tool result with a huge JSON dump),
// JSON.parse + the per-line scan stalls the main process for seconds. Skip
// such lines rather than blocking.
const MAX_JSONL_LINE_LEN = 16 * 1024 * 1024;  // 16 MB of UTF-8
async function forEachJsonlLine(filePath, onLine) {
  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const rl = require('node:readline').createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (!line) continue;
      if (line.length > MAX_JSONL_LINE_LEN) continue;
      const obj = safeJson(line);
      if (obj) await onLine(obj);
    }
  } finally {
    try { rl.close(); } catch {}
    try { stream.destroy(); } catch {}
  }
}

async function readSessionMetadataFromDisk(filePath, stat) {
  if (stat.size > MAX_SESSION_FILE_SIZE) {
    // Skip parsing — still surface the session so the user sees it in the list,
    // just with empty metadata. Detail view will refuse to load it.
    return { tooLarge: true, fileSize: stat.size, mtime: stat.mtimeMs };
  }

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

    if (obj.type === 'user' || obj.type === 'assistant') {
      if (obj.type === 'user' && typeof obj.message?.content === 'string') userMsgs++;
      else if (obj.type === 'assistant') {
        assistantMsgs++;
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

// SWR (stale-while-revalidate) — pattern used by Linear / VS Code / SWR /
// React-Query. Disk-persisted last result is returned instantly; a fresh scan
// runs in the background; renderer gets pushed the updated list via an event.
let cachedSessions = null;
let backgroundScanInflight = null;
const SESSIONS_CACHE_VERSION = 1;
let sessionsCachePath = null; // resolved after app.whenReady → userData

async function loadSessionsCache() {
  if (!sessionsCachePath) return;
  try {
    // The sessions cache can legitimately reach a few MB (one entry per
    // session, with token-event arrays). Allow a bigger budget than the
    // generic userdata cap so we don't refuse a cache that's been growing
    // with the user's session count.
    const raw = await readJsonFileSafe(sessionsCachePath, 64 * 1024 * 1024);
    if (raw == null) return;
    const obj = JSON.parse(raw);
    if (obj && obj.version === SESSIONS_CACHE_VERSION && Array.isArray(obj.sessions)) {
      cachedSessions = obj.sessions;
      // Seed the per-file mtime cache so the background rescan can skip files
      // that haven't changed since they were last persisted.
      for (const s of obj.sessions) {
        if (s.filePath && typeof s.mtime === 'number') {
          fileMetaCache.set(s.filePath, { mtime: s.mtime, meta: extractMetaFromSession(s) });
        }
      }
    }
  } catch {}
}

async function saveSessionsCache(sessions) {
  if (!sessionsCachePath) return;
  try {
    // Strip `tokenEvents` before persisting — usage aggregates use them in
    // memory but they're the largest field per session (one entry per
    // assistant turn). Caching them onto disk grows the cache linearly with
    // heavy use; cold start re-reads token events from the JSONL anyway, so
    // dropping them here keeps the cache lean (under the 64MB load cap).
    const slim = sessions.map(({ tokenEvents, ...rest }) => rest);
    await atomicWriteJson(sessionsCachePath, {
      version: SESSIONS_CACHE_VERSION,
      savedAt: Date.now(),
      sessions: slim,
    });
  } catch {}
}

function extractMetaFromSession(s) {
  return {
    summary: s.summary || '', firstUser: s.firstUser || '',
    firstTs: s.firstTs || null, lastTs: s.lastTs || null,
    userMsgs: s.userMsgs || 0, assistantMsgs: s.assistantMsgs || 0,
    cwd: s.lastCwd || s.projectCwd || '', gitBranch: s.gitBranch || '',
    model: s.model || '', version: s.version || '',
    tokensIn: s.tokensIn || 0, tokensOut: s.tokensOut || 0,
    tokensCacheRead: s.tokensCacheRead || 0, tokensCacheCreate: s.tokensCacheCreate || 0,
    tokenEvents: s.tokenEvents || [],
    tooLarge: s.tooLarge || false,
    fileSize: s.fileSize || 0, mtime: s.mtime || 0,
  };
}

// Parallel map with concurrency cap — cheap pool, no library needed.
async function mapPool(items, concurrency, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  }
  const workers = [];
  for (let i = 0; i < Math.min(concurrency, items.length); i++) workers.push(worker());
  await Promise.all(workers);
  return out;
}

// Two-phase scan:
//   1. Cheap pass — readdir + stat every .jsonl. ~50ms for 600+ files.
//   2. Sort by mtime desc → deep-read TOP_N first, push that. UI shows the
//      newest sessions in ~500ms regardless of total count.
//   3. Background-read the rest, push the full list when done.
const TOP_BATCH = 30;
let firstBatchResolver = null;
let firstBatchPromise = null;

async function statAllJsonl() {
  let projectDirs;
  try { projectDirs = await fsp.readdir(PROJECTS_DIR); } catch { return []; }
  const allFiles = [];
  for (const projectDir of projectDirs) {
    const projectPath = path.join(PROJECTS_DIR, projectDir);
    // lstat (not stat) so we can refuse to follow symlinks pointing outside
    // ~/.claude/projects. A malicious or careless symlink would otherwise let
    // the scanner read arbitrary user files.
    let stat;
    try { stat = await fsp.lstat(projectPath); } catch { continue; }
    if (stat.isSymbolicLink()) continue;
    if (!stat.isDirectory()) continue;
    let entries;
    try { entries = await fsp.readdir(projectPath); } catch { continue; }
    for (const entry of entries) {
      if (!entry.endsWith('.jsonl')) continue;
      const filePath = path.join(projectPath, entry);
      let lst;
      try { lst = await fsp.lstat(filePath); } catch { continue; }
      if (lst.isSymbolicLink()) continue;
      if (!lst.isFile()) continue;
      allFiles.push({ projectDir, entry, filePath });
    }
  }
  return mapPool(allFiles, 32, async (f) => {
    try { const st = await fsp.stat(f.filePath); return { ...f, mtime: st.mtimeMs }; }
    catch { return { ...f, mtime: 0 }; }
  });
}

async function buildSession({ projectDir, entry, filePath }) {
  const sessionId = entry.replace(/\.jsonl$/, '');
  const k = compositeKey('claude', sessionId);
  try {
    const meta = await readSessionMetadata(filePath);
    const projectCwd = decodeProjectDir(projectDir);
    return {
      source: 'claude',
      id: sessionId, projectDir,
      decodedCwd: projectCwd,
      projectCwd,
      lastCwd: meta.cwd || projectCwd,
      filePath,
      favorite: favoriteSet.has(k),
      excluded: excludeSet.has(k),
      alias: aliasMap[k] || null,
      ...meta,
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
      favorite: favoriteSet.has(k),
      excluded: excludeSet.has(k),
      alias: aliasMap[k] || null,
      error: String(e),
    };
  }
}

// ============================ Codex scanner ============================
// Codex stores sessions at ~/.codex/sessions/<year>/<month>/<day>/rollout-...jsonl
// Line 1 is `session_meta` (id, cwd, originator, cli_version, model_provider).
// Subsequent lines are `event_msg` (token_count etc.) and `response_item`
// (messages with role=user/assistant and content arrays, function_calls, reasoning).

// Codex sessions usually start with one or more system-injected user
// "messages" that aren't from the human — typically the AGENTS.md content,
// repo file listings, or environment context. Skip past those so the
// session-list title shows the human's real first question.
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

async function readCodexSessionMetadata(filePath) {
  const stat = await fsp.stat(filePath);
  const cached = fileMetaCache.get(filePath);
  if (cached && cached.mtime === stat.mtimeMs) return cached.meta;

  if (stat.size > MAX_SESSION_FILE_SIZE) {
    const meta = { tooLarge: true, fileSize: stat.size, mtime: stat.mtimeMs };
    fileMetaCache.set(filePath, { mtime: stat.mtimeMs, meta });
    return meta;
  }

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
      // session_meta only carries `model_provider` ("openai"), not the actual
      // model name. The real model comes later in `turn_context`. We used to
      // fall back to model_provider for sessions where turn_context never
      // appeared, but that surfaces "openai" as if it were a model in Usage's
      // by-model breakdown. Leave model empty instead — usageSummary groups
      // empty/unknown into a single "unknown" bucket, which is honest.
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
        // The first user "message" in a codex session is usually the agent
        // bootstrap (AGENTS.md, repo context, file tree) — not the human's
        // actual prompt. Skip past those and grab the first one that doesn't
        // look like injected context.
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
      // cached_input_tokens, output_tokens, reasoning_output_tokens, total_tokens }.
      // `total_token_usage` is the running cumulative count — summing it would
      // double-count, so we sum `last_token_usage` (per-turn delta) instead.
      // Fallback to flat payload fields for forward-compat with older shapes.
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
      // Latest codex rate_limits also carries the user's plan_type ("pro" /
      // "plus" / etc) — stash so getCodexAuth can surface it without re-walking
      // every session.
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

async function statAllCodexJsonl() {
  // Walk yyyy/mm/dd/*.jsonl. Don't recurse the whole ~/.codex (lots of caches).
  // Use lstat at each level and skip symlinks so a stray link can't redirect
  // the scanner outside ~/.codex/sessions.
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
  // The filename matches: rollout-<ISO-ts>-<uuid>.jsonl
  // Extract the trailing uuid as session id (used for `codex resume <id>`).
  const m = entry.match(/^rollout-.*?-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i);
  const sessionId = m ? m[1] : entry.replace(/\.jsonl$/, '');
  try {
    const meta = await readCodexSessionMetadata(filePath);
    // Use the in-file id if present (more authoritative) but fall back to
    // filename-derived id for the favorite/exclude/alias map keys.
    const id = meta.codexId || sessionId;
    const k = compositeKey('codex', id);
    const projectCwd = meta.cwd || '';
    // Normalize both POSIX (`/Users/me/proj`) and Windows (`C:\Users\me\proj`)
    // separators so the projectDir key looks consistent across platforms.
    const projectDir = projectCwd ? projectCwd.replace(/[\/\\]+/g, '-').replace(/^-/, '-') : '';
    return {
      source: 'codex',
      id,
      projectDir,
      decodedCwd: projectCwd,
      projectCwd,
      lastCwd: projectCwd,
      filePath,
      favorite: favoriteSet.has(k),
      excluded: excludeSet.has(k),
      alias: aliasMap[k] || null,
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
      favorite: favoriteSet.has(k),
      excluded: excludeSet.has(k),
      alias: aliasMap[k] || null,
      error: String(e),
    };
  }
}

// Coalesce rapid pushSessions calls (Phase B emits one per FLUSH_EVERY batch).
// Leading-edge + 220ms trailing-edge throttle so renderers don't thrash the
// virtualizer with overlapping setSessions during a large scan.
let _pushTimer = null;
let _pendingPushPayload = null;
let _lastPushAt = 0;
const PUSH_THROTTLE_MS = 220;
function pushSessions(sessions) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  _pendingPushPayload = sessions;
  const sinceLast = Date.now() - _lastPushAt;
  if (sinceLast >= PUSH_THROTTLE_MS) { flushPushSessionsNow(); return; }
  if (_pushTimer) return;
  _pushTimer = setTimeout(flushPushSessionsNow, PUSH_THROTTLE_MS - sinceLast);
}
function flushPushSessionsNow() {
  if (_pushTimer) { clearTimeout(_pushTimer); _pushTimer = null; }
  if (!_pendingPushPayload || !mainWindow || mainWindow.isDestroyed()) return;
  try { mainWindow.webContents.send('sessions:updated', _pendingPushPayload); } catch {}
  _lastPushAt = Date.now();
  _pendingPushPayload = null;
}

async function refreshSessionsInBackground() {
  if (backgroundScanInflight) return backgroundScanInflight;
  // First-batch barrier so first-boot callers can await something
  // meaningful without blocking on the full scan.
  firstBatchPromise = new Promise((r) => { firstBatchResolver = r; });
  backgroundScanInflight = (async () => {
    try {
      // Stat both source roots in parallel so the merged list reflects each
      // tool's most recent files in one pass.
      const [claudeStats, codexStats] = await Promise.all([statAllJsonl(), statAllCodexJsonl()]);
      const taggedClaude = claudeStats.map(f => ({ ...f, kind: 'claude' }));
      const taggedCodex = codexStats.map(f => ({ ...f, kind: 'codex' }));
      const statted = [...taggedClaude, ...taggedCodex].sort((a, b) => (b.mtime || 0) - (a.mtime || 0));

      const buildOne = async (f) => f.kind === 'codex' ? buildCodexSession(f) : buildSession(f);

      // Whether this is a cold scan (no prior cache) or a refresh of an existing
      // cache. Cold path uses progressive pushes so users see the list fill in
      // instead of staring at an empty pane. Refresh path holds the existing
      // cached list visible and only swaps once the full rescan is done — that
      // way the sidebar History count doesn't dip from 543 → 30 → 180 → ...
      // → 543 every time the window regains focus.
      const isCold = !cachedSessions || cachedSessions.length === 0;

      // Phase A — deep-read the most recent TOP_BATCH.
      const topFiles = statted.slice(0, TOP_BATCH);
      const top = await mapPool(topFiles, 16, buildOne);
      if (isCold) {
        cachedSessions = top.slice();
        pushSessions(cachedSessions);
      }
      if (firstBatchResolver) { firstBatchResolver(); firstBatchResolver = null; }

      // Phase B — read the rest. mtime cache makes most of these instant.
      // On cold boot we push periodically (list grows progressively). On a
      // refresh we collect quietly and push once at the end.
      const restFiles = statted.slice(TOP_BATCH);
      const FLUSH_EVERY = 150;
      const collected = [];
      let lastFlushIdx = 0;
      await mapPool(restFiles, 16, async (f) => {
        const s = await buildOne(f);
        collected.push(s);
        if (isCold && collected.length - lastFlushIdx >= FLUSH_EVERY) {
          lastFlushIdx = collected.length;
          const merged = [...cachedSessions, ...collected].sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
          cachedSessions = merged;
          pushSessions(cachedSessions);
        }
      });

      // Final flush + sort + persist. This is the only push on a refresh, so
      // the renderer sees one atomic swap from old-cache → fresh-list, no count
      // wobble in between.
      const all = [...top, ...collected].sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
      cachedSessions = all;
      pushSessions(cachedSessions);
      saveSessionsCache(cachedSessions).catch(() => {});
      return cachedSessions;
    } finally {
      backgroundScanInflight = null;
      // Make sure the barrier resolves even on error paths.
      if (firstBatchResolver) { firstBatchResolver(); firstBatchResolver = null; }
    }
  })();
  return backgroundScanInflight;
}

async function listSessions({ force = false, noRefresh = false } = {}) {
  // Force or cached → return what we have RIGHT NOW; background fills in via push.
  if (cachedSessions || force) {
    if (!noRefresh && !backgroundScanInflight) refreshSessionsInBackground().catch(() => {});
    return cachedSessions || [];
  }
  // First boot, no cache → wait only for the TOP_BATCH push, not the full scan.
  if (!noRefresh) refreshSessionsInBackground().catch(() => {});
  if (firstBatchPromise) await firstBatchPromise;
  return cachedSessions || [];
}

async function getSessionMessages(filePath) {
  const stat = await fsp.stat(filePath);
  if (stat.size > MAX_SESSION_FILE_SIZE) {
    throw new Error(`Session file is ${(stat.size / 1024 / 1024).toFixed(1)} MB; refusing to load (cap: ${MAX_SESSION_FILE_SIZE / 1024 / 1024} MB)`);
  }
  const messages = [];
  // Session-level image budget threaded through both inline and image-cache
  // paths so we stop READING new image-cache files once the cap is exhausted,
  // instead of reading them all and then truncating in capSessionImages.
  const imageBudget = { usedB64: 0, truncated: false };
  await forEachJsonlLine(filePath, async (obj) => {
    if (obj.type === 'summary' && typeof obj.summary === 'string') {
      messages.push({ kind: 'summary', text: obj.summary, timestamp: obj.timestamp || null });
      return;
    }
    if (obj.type !== 'user' && obj.type !== 'assistant') return;

    const role = obj.type;
    const rawText = extractMessageText(obj.message);
    const inlineImages = extractMessageImages(obj.message);
    for (const img of inlineImages) {
      if (typeof img.data === 'string') imageBudget.usedB64 += img.data.length;
    }
    // Claude Code 2.x stores pasted screenshots as files in image-cache and
    // leaves a `[Image: source: ...]` text marker. Resolve those to real
    // images, then strip the markers out of the visible text so the renderer
    // doesn't print the file path next to the rendered screenshot.
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

async function getCodexSessionMessages(filePath) {
  // Codex JSONL: response_item with payload.type='message' carries user/assistant
  // turns; payload.content is an array of { type: 'input_text'|'output_text', text }.
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
      // through the same walker so Codex sessions render images the same way
      // Claude sessions do.
      const images = [];
      walkForImages(p.content, images);
      // Codex injects `<image name=[Image #1] path="..."> [Image #1]` blobs as
      // adjacent text describing each attached image. Strip them so the
      // rendered text doesn't sit next to a literal path next to the image.
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
      // Surface tool invocations as assistant tool_use turns so the existing
      // detail-view rendering can collapse them under "Tools shown".
      // Length-cap + strip control/bidi so a pathological tool name from a
      // hostile JSONL can't make the message text either tens of KB long or
      // visually masquerade as something else.
      const rawName = p.name || p.function?.name || 'tool';
      const name = String(rawName)
        .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
        // eslint-disable-next-line no-control-regex
        .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g, '')
        .replace(/[‪-‮⁦-⁩]/g, '')
        .slice(0, 200);
      // Cap tool-call arguments — a renderer that's just going to collapse
      // them under "tools shown" shouldn't receive several MB of JSON for one
      // line. 64 KB covers every realistic agent prompt; past that, append a
      // marker so the user knows the rest is on disk.
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

// Per-file size cap for deep search. Matches the session parser cap
// (MAX_SESSION_FILE_SIZE) so any session that appears in History — meaning
// metadata could parse — is also reachable from search. Now that deep search
// streams the file line-by-line instead of slurping it into memory, the
// previous 10MB cap was strictly stricter than necessary and silently dropped
// real long-running sessions from results.
const DEEP_SEARCH_FILE_SIZE_CAP = MAX_SESSION_FILE_SIZE;

// Per-level lstat helper — refuse to follow symlinks so a stray link inside
// ~/.claude or ~/.codex can't redirect the scanner outside those roots.
async function isPlainDir(p) {
  try { const st = await fsp.lstat(p); return st.isDirectory() && !st.isSymbolicLink(); }
  catch { return false; }
}
async function isPlainFile(p) {
  try { const st = await fsp.lstat(p); return st.isFile() && !st.isSymbolicLink(); }
  catch { return false; }
}

async function listSearchTargets(source) {
  // Returns [{ filePath, projectDir }] for every JSONL the deepSearch should
  // consider. Per-source layout: Claude is one level deep
  // (~/.claude/projects/<dir>/<id>.jsonl); Codex is three (year/month/day).
  const targets = [];
  if (source === 'codex') {
    let years;
    try { years = await fsp.readdir(CODEX_SESSIONS_DIR); } catch { return []; }
    for (const y of years) {
      const yp = path.join(CODEX_SESSIONS_DIR, y);
      if (!(await isPlainDir(yp))) continue;
      let months;
      try { months = await fsp.readdir(yp); } catch { continue; }
      for (const m of months) {
        const mp = path.join(yp, m);
        if (!(await isPlainDir(mp))) continue;
        let days;
        try { days = await fsp.readdir(mp); } catch { continue; }
        for (const d of days) {
          const dayPath = path.join(mp, d);
          if (!(await isPlainDir(dayPath))) continue;
          let files;
          try { files = await fsp.readdir(dayPath); } catch { continue; }
          for (const f of files) {
            if (!f.endsWith('.jsonl')) continue;
            const fp = path.join(dayPath, f);
            if (!(await isPlainFile(fp))) continue;
            targets.push({ filePath: fp, projectDir: `${y}-${m}-${d}` });
          }
        }
      }
    }
    return targets;
  }
  // Claude (default)
  let projectDirs;
  try { projectDirs = await fsp.readdir(PROJECTS_DIR); } catch { return []; }
  for (const projectDir of projectDirs) {
    const projectPath = path.join(PROJECTS_DIR, projectDir);
    if (!(await isPlainDir(projectPath))) continue;
    let entries;
    try { entries = await fsp.readdir(projectPath); } catch { continue; }
    for (const entry of entries) {
      if (!entry.endsWith('.jsonl')) continue;
      const fp = path.join(projectPath, entry);
      if (!(await isPlainFile(fp))) continue;
      targets.push({ filePath: fp, projectDir });
    }
  }
  return targets;
}

async function deepSearch(query, source) {
  if (!query || query.length < 2) return [];
  // Split on whitespace → OR semantics. "jwt refresh token" matches any session
  // containing jwt, refresh, OR token; ranked by total count + keyword coverage.
  // Quoted "phrase like this" stays glued. Tokens shorter than 2 chars dropped.
  const terms = tokenizeQuery(query);
  if (terms.length === 0) return [];

  const targets = await listSearchTargets(source === 'codex' ? 'codex' : 'claude');
  const hits = [];

  for (const { filePath, projectDir } of targets) {
    {
      const entry = path.basename(filePath);
      // Stat first so a giant log file can't kill the main loop before we even
      // look at content. Files past the cap are skipped (not errored).
      try {
        const st = await fsp.stat(filePath);
        if (st.size > DEEP_SEARCH_FILE_SIZE_CAP) continue;
      } catch { continue; }
      // Streaming pass: walk lines, count per-term hits, find first hit line,
      // and classify by message role — all without holding the full file or
      // a lowercased copy in memory. The old `readFile + toLowerCase + split`
      // created up to 3 copies of every byte; streaming keeps it at ~1.
      const perTerm = Object.create(null);
      for (const t of terms) perTerm[t] = 0;
      let totalCount = 0;
      let coverage = 0;
      let firstHitTerm = null;
      let firstHitLine = null;       // raw text of the first matched line
      let firstHitLineIdx = -1;       // 0-based line number
      let codexMetaId = null;
      const sources = { user: 0, assistant: 0, summary: 0, tool: 0 };
      let lineIdx = -1;
      let aborted = false;
      try {
        await forEachJsonlLine(filePath, (obj) => {
          if (aborted) return;
          lineIdx++;
          // Codex session_meta carries the id we need; capture on the first
          // line so we don't have to re-read the file later.
          if (source === 'codex' && codexMetaId == null && obj?.type === 'session_meta' && obj?.payload?.id) {
            codexMetaId = String(obj.payload.id);
          }
          // Walk the line text once. JSON.stringify gives us a single string
          // representation we can lowercase in-place; cheaper than walking
          // every leaf field.
          let lineLower;
          try { lineLower = JSON.stringify(obj).toLowerCase(); } catch { return; }
          let anyHitThisLine = false;
          for (let i = 0; i < terms.length; i++) {
            const t = terms[i];
            const before = perTerm[t];
            let pos = 0, count = 0;
            while ((pos = lineLower.indexOf(t, pos)) !== -1) { count++; pos += t.length; if (count > 999) break; }
            if (count > 0) {
              perTerm[t] = before + count;
              totalCount += count;
              if (before === 0) coverage++;
              if (!anyHitThisLine) {
                anyHitThisLine = true;
                if (firstHitLineIdx < 0) {
                  firstHitLineIdx = lineIdx;
                  firstHitLine = obj;
                  firstHitTerm = t;
                }
              }
            }
          }
          if (anyHitThisLine) {
            const role = obj?.message?.role;
            const type = obj?.type;
            if (role === 'user' || type === 'user') sources.user++;
            else if (role === 'assistant' || type === 'assistant') sources.assistant++;
            else if (type === 'summary') sources.summary++;
            else if (type === 'tool_use' || type === 'tool_result') sources.tool++;
          }
        });
      } catch { continue; }
      if (totalCount === 0) continue;

      const term = firstHitTerm || terms[0];
      // Pull a human-readable snippet from the hit line: Claude
      // `message.content` (string or part array), summary, or Codex
      // `payload.content`. Falls back to the JSON text if nothing recognisable.
      let humanText = '';
      const obj = firstHitLine;
      if (obj) {
        const c = obj.message?.content;
        if (typeof c === 'string') humanText = c;
        else if (Array.isArray(c)) {
          humanText = c.map(p => (typeof p === 'string' ? p : (p?.text || p?.content || ''))).join('\n');
        } else if (typeof obj.summary === 'string') humanText = obj.summary;
        else if (Array.isArray(obj.payload?.content)) {
          humanText = obj.payload.content
            .filter(p => p && (p.type === 'input_text' || p.type === 'output_text'))
            .map(p => p.text || '').join('\n');
        }
        if (!humanText) {
          try { humanText = JSON.stringify(obj); } catch {}
        }
      }
      let snippet;
      if (humanText) {
        const lowerHuman = humanText.toLowerCase();
        const hitIdx = lowerHuman.indexOf(term);
        const start = Math.max(0, (hitIdx >= 0 ? hitIdx : 0) - 80);
        const end = Math.min(humanText.length, (hitIdx >= 0 ? hitIdx : 0) + term.length + 200);
        snippet = humanText.slice(start, end).replace(/\s+/g, ' ').trim();
        if (start > 0) snippet = '… ' + snippet;
        if (end < humanText.length) snippet = snippet + ' …';
      } else {
        snippet = '';
      }

      // Extract session id per source convention.
      let id;
      if (source === 'codex') {
        if (codexMetaId) {
          id = codexMetaId;
        } else {
          const m = entry.match(/^rollout-.*?-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i);
          if (!m) continue;
          id = m[1];
        }
      } else {
        id = entry.replace(/\.jsonl$/, '');
      }
      hits.push({
        id,
        source: source === 'codex' ? 'codex' : 'claude',
        projectDir,
        filePath,
        snippet,
        matchCount: totalCount,
        coverage,         // how many of N terms hit — strong relevance signal
        termCount: terms.length,
        sources,
      });
    }
  }
  // Coverage dominates (a session matching all 3 terms beats one matching 1 term
  // even if the latter has more hits of that single term). Then total count.
  hits.sort((a, b) => (b.coverage - a.coverage) || (b.matchCount - a.matchCount));
  return hits;
}

// Tokenize a query into OR terms. Honors "quoted phrases" so users can pin a
// multi-word expression. Drops single-char tokens (noise). All lowercased.
function tokenizeQuery(query) {
  const out = [];
  const re = /"([^"]+)"|(\S+)/g;
  let m;
  while ((m = re.exec(query)) !== null) {
    const t = (m[1] || m[2] || '').toLowerCase().trim();
    if (t.length >= 2 && !out.includes(t)) out.push(t);
  }
  return out;
}

/* ---------- Config viewer ---------- */

function parseFrontmatter(md) {
  if (!md.startsWith('---')) return { fm: {}, body: md };
  const end = md.indexOf('\n---', 4);
  if (end < 0) return { fm: {}, body: md };
  const fmRaw = md.slice(4, end);
  const body = md.slice(end + 4).replace(/^\n/, '');
  const fm = {};
  const lines = fmRaw.split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const m = line.match(/^([a-zA-Z0-9_-]+):\s*(.*)$/);
    if (!m) { i++; continue; }
    const key = m[1];
    let val = m[2].trim();
    if (val === '|' || val === '>' || val === '|-' || val === '>-' || val === '|+' || val === '>+') {
      // YAML block scalar: collect subsequent indented continuation lines until next key or end.
      const fold = val.startsWith('>');
      const collected = [];
      i++;
      let indent = null;
      while (i < lines.length) {
        const next = lines[i];
        const stripped = next.replace(/^\s+/, '');
        if (stripped && next.match(/^[a-zA-Z0-9_-]+:\s/)) break; // next top-level key
        if (next.trim() === '') { collected.push(''); i++; continue; }
        if (indent === null) {
          const lead = next.match(/^(\s+)/);
          indent = lead ? lead[1] : '';
        }
        collected.push(next.startsWith(indent) ? next.slice(indent.length) : next);
        i++;
      }
      val = fold ? collected.join(' ').replace(/\s+/g, ' ').trim() : collected.join('\n').trim();
    } else {
      // Strip surrounding quotes if present
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      i++;
    }
    fm[key] = val;
  }
  return { fm, body };
}

async function listDirSafe(p) {
  try { return await fsp.readdir(p, { withFileTypes: true }); } catch { return []; }
}

// Config files (CLAUDE.md, AGENTS.md, settings.json, individual skill/command/hook
// bodies) — same OOM concern as session JSONL. 5 MB easily covers any real config;
// past that, refuse and let the workspace view show an empty entry rather than
// blowing main-process memory.
const MAX_CONFIG_FILE_SIZE = 5 * 1024 * 1024;
async function readFileSafe(p) {
  try {
    const st = await fsp.lstat(p);
    if (st.isSymbolicLink()) return null;
    if (st.size > MAX_CONFIG_FILE_SIZE) return null;
    return await fsp.readFile(p, 'utf8');
  } catch { return null; }
}

async function readClaudeConfig() {
  const result = {
    paths: { home: HOME, claudeDir: CLAUDE_DIR },
    claudeMd: null,
    skills: [],
    commands: [],
    hooks: [],
    plugins: [],
    settings: null,
  };

  // v10 — workspace detail view shows "last modified" per resource, so attach mtime.
  // Stat failures are silent; mtime is optional in the renderer.
  const safeMtime = async (p) => { try { return (await fsp.stat(p)).mtimeMs; } catch { return undefined; } };

  const claudeMdPath = path.join(CLAUDE_DIR, 'CLAUDE.md');
  const claudeMd = await readFileSafe(claudeMdPath);
  if (claudeMd != null) result.claudeMd = { path: claudeMdPath, content: claudeMd, mtime: await safeMtime(claudeMdPath) };

  const skillsDir = path.join(CLAUDE_DIR, 'skills');
  for (const e of await listDirSafe(skillsDir)) {
    if (!e.isDirectory()) continue;
    const skillMd = path.join(skillsDir, e.name, 'SKILL.md');
    const content = await readFileSafe(skillMd);
    if (content == null) continue;
    const { fm, body } = parseFrontmatter(content);
    result.skills.push({
      name: e.name, path: skillMd,
      title: fm.name || e.name,
      description: fm.description || '',
      content: body,
      mtime: await safeMtime(skillMd),
    });
  }
  result.skills.sort((a, b) => a.name.localeCompare(b.name));

  const cmdDir = path.join(CLAUDE_DIR, 'commands');
  for (const e of await listDirSafe(cmdDir)) {
    if (!e.isFile() || !e.name.endsWith('.md')) continue;
    const p = path.join(cmdDir, e.name);
    const content = await readFileSafe(p);
    if (content == null) continue;
    const { fm, body } = parseFrontmatter(content);
    result.commands.push({
      name: '/' + e.name.replace(/\.md$/, ''),
      path: p,
      description: fm.description || '',
      content: body,
      mtime: await safeMtime(p),
    });
  }
  result.commands.sort((a, b) => a.name.localeCompare(b.name));

  const hooksDir = path.join(CLAUDE_DIR, 'hooks');
  for (const e of await listDirSafe(hooksDir)) {
    if (!e.isFile()) continue;
    const p = path.join(hooksDir, e.name);
    const content = await readFileSafe(p);
    result.hooks.push({ name: e.name, path: p, content: content || '', mtime: await safeMtime(p) });
  }
  result.hooks.sort((a, b) => a.name.localeCompare(b.name));

  const pluginsDir = path.join(CLAUDE_DIR, 'plugins');
  for (const e of await listDirSafe(pluginsDir)) {
    if (!e.isDirectory()) continue;
    const pluginPath = path.join(pluginsDir, e.name);
    const subEntries = await listDirSafe(pluginPath);
    const sub = subEntries.filter(x => x.isDirectory() || x.isFile()).map(x => x.name);
    result.plugins.push({ name: e.name, path: pluginPath, entries: sub, mtime: await safeMtime(pluginPath) });
  }
  result.plugins.sort((a, b) => a.name.localeCompare(b.name));

  const settingsPath = path.join(CLAUDE_DIR, 'settings.json');
  const settings = await readFileSafe(settingsPath);
  if (settings != null) result.settings = { path: settingsPath, content: settings, mtime: await safeMtime(settingsPath) };

  return result;
}

// Codex workspace reader. Mirrors the Claude shape so the renderer can use the
// same ConfigView with the same kind buckets:
//   AGENTS.md  → claudeMd (Global instructions)
//   skills/    → skills
//   commands/  → commands (codex doesn't expose these yet — empty)
//   hooks/     → hooks  (same — empty)
//   rules/*.rules → mapped into hooks bucket as security rules
//   plugins/   → plugins (rare; folder usually only holds caches)
//   config.toml → settings
async function readCodexConfig() {
  const result = {
    paths: { home: HOME, claudeDir: CODEX_DIR },
    claudeMd: null,
    skills: [],
    commands: [],
    hooks: [],
    plugins: [],
    settings: null,
  };
  const safeMtime = async (p) => { try { return (await fsp.stat(p)).mtimeMs; } catch { return undefined; } };

  const agentsPath = path.join(CODEX_DIR, 'AGENTS.md');
  const agents = await readFileSafe(agentsPath);
  if (agents != null) {
    result.claudeMd = { path: agentsPath, content: agents, mtime: await safeMtime(agentsPath) };
  }

  const skillsDir = path.join(CODEX_DIR, 'skills');
  for (const e of await listDirSafe(skillsDir)) {
    if (!e.isDirectory()) continue;
    if (e.name.startsWith('.')) continue; // skip .system etc.
    const skillMd = path.join(skillsDir, e.name, 'SKILL.md');
    const content = await readFileSafe(skillMd);
    if (content == null) continue;
    const { fm, body } = parseFrontmatter(content);
    result.skills.push({
      name: e.name, path: skillMd,
      title: fm.name || e.name,
      description: fm.description || '',
      content: body,
      mtime: await safeMtime(skillMd),
    });
  }
  result.skills.sort((a, b) => a.name.localeCompare(b.name));

  // Codex security rules (~/.codex/rules/*.rules) → hooks bucket — they're
  // automation policies that fire on tool invocation, similar to Claude hooks.
  const rulesDir = path.join(CODEX_DIR, 'rules');
  for (const e of await listDirSafe(rulesDir)) {
    if (!e.isFile() || !e.name.endsWith('.rules')) continue;
    const p = path.join(rulesDir, e.name);
    const content = await readFileSafe(p);
    result.hooks.push({ name: e.name, path: p, content: content || '', mtime: await safeMtime(p) });
  }

  const pluginsDir = path.join(CODEX_DIR, 'plugins');
  for (const e of await listDirSafe(pluginsDir)) {
    if (!e.isDirectory()) continue;
    if (e.name === 'cache') continue;
    const pluginPath = path.join(pluginsDir, e.name);
    const subEntries = await listDirSafe(pluginPath);
    const sub = subEntries.filter(x => x.isDirectory() || x.isFile()).map(x => x.name);
    result.plugins.push({ name: e.name, path: pluginPath, entries: sub, mtime: await safeMtime(pluginPath) });
  }
  result.plugins.sort((a, b) => a.name.localeCompare(b.name));

  const cfgPath = path.join(CODEX_DIR, 'config.toml');
  const cfg = await readFileSafe(cfgPath);
  if (cfg != null) result.settings = { path: cfgPath, content: cfg, mtime: await safeMtime(cfgPath) };

  return result;
}

/* ---------- Usage summary ---------- */

async function usageSummary(source) {
  // Pass noRefresh: a fresh sessions push will trigger the renderer to call
  // getUsage again. If usageSummary itself starts another scan, that scan
  // pushes again, the renderer reacts again — sustained loop that hammers
  // disk and grows memory until OOM. Just read the latest cached snapshot.
  const all = await listSessions({ noRefresh: true });
  // Filter by AI source so Usage shows just the current tool's stats.
  const sessions = source ? all.filter(s => s.source === source) : all;
  const now = Date.now();
  const HOUR = 3600 * 1000;
  const DAY = 86400 * 1000;

  const buckets = {
    total: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, sessions: 0, msgs: 0 },
    last1d: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, sessions: 0 },
    last7d: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, sessions: 0 },
    last30d: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, sessions: 0 },
    thisMonth: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, sessions: 0 },
  };

  // Per-message rolling windows (accurate via tokenEvents).
  // `today` is calendar-aligned (since local midnight); the rest are rolling N hours/days.
  const tnow = new Date();
  const todayStartTs = new Date(tnow.getFullYear(), tnow.getMonth(), tnow.getDate()).getTime();
  const mkBucket = () => ({ input: 0, output: 0, cacheRead: 0, cacheCreate: 0, msgs: 0, sessions: new Set(), oldestTs: null });
  const rolling = {
    last5h: mkBucket(),
    today: mkBucket(),
    last24h: mkBucket(),
    last3d: mkBucket(),
    last7d: mkBucket(),
  };
  const cutoff5h = now - 5 * HOUR;
  const cutoff24h = now - 24 * HOUR;
  const cutoff3d = now - 3 * DAY;
  const cutoff7d = now - 7 * DAY;

  const add = (b, ev, sid) => {
    b.input += ev.i; b.output += ev.o; b.cacheRead += ev.cr; b.cacheCreate += ev.cc;
    b.msgs++; b.sessions.add(sid);
    if (!b.oldestTs || ev.ts < b.oldestTs) b.oldestTs = ev.ts;
  };

  for (const s of sessions) {
    for (const ev of (s.tokenEvents || [])) {
      // Same clock-skew clamp as `lastTs` below: never let a future ts land
      // in a recent bucket; just treat it as "now" instead.
      const ts = Math.min(ev.ts, now);
      if (ts > cutoff7d) {
        const evc = ts === ev.ts ? ev : { ...ev, ts };
        // Composite key so a future all-sources Usage view can't accidentally
        // merge Claude / Codex sessions that share a UUID. usageSummary is
        // currently per-source but defending here keeps the invariant intact.
        const sid = `${s.source}:${s.id}`;
        add(rolling.last7d, evc, sid);
        if (ts > cutoff3d) add(rolling.last3d, evc, sid);
        if (ts > cutoff24h) add(rolling.last24h, evc, sid);
        if (ts >= todayStartTs) add(rolling.today, evc, sid);
        if (ts > cutoff5h) add(rolling.last5h, evc, sid);
      }
    }
  }
  const flatten = (b) => ({ ...b, sessions: b.sessions.size });
  const currentWindows = {
    last5h: flatten(rolling.last5h),
    today: flatten(rolling.today),
    last24h: flatten(rolling.last24h),
    last3d: flatten(rolling.last3d),
    last7d: flatten(rolling.last7d),
  };

  const byModel = new Map();
  const byProject = new Map();
  const byDay = new Map();

  const tm = new Date();
  const monthStart = new Date(tm.getFullYear(), tm.getMonth(), 1).getTime();

  for (const s of sessions) {
    // Pick a usable timestamp: lastTs preferred, mtime fallback, future-clamped
    // to now. Mirrors the renderer's sessionTimestamp() helper so server-side
    // aggregates and client-side filters agree on what counts as recent.
    let lastTs = 0;
    if (s.lastTs) {
      const t = new Date(s.lastTs).getTime();
      if (Number.isFinite(t) && t > 0) lastTs = t;
    }
    if (!lastTs && s.mtime && Number.isFinite(s.mtime)) lastTs = s.mtime;
    if (lastTs > now) lastTs = now;
    const inT = s.tokensIn || 0;
    const outT = s.tokensOut || 0;
    const cr = s.tokensCacheRead || 0;
    const cc = s.tokensCacheCreate || 0;
    const total = inT + outT + cr + cc;

    buckets.total.input += inT;
    buckets.total.output += outT;
    buckets.total.cacheRead += cr;
    buckets.total.cacheCreate += cc;
    buckets.total.sessions++;
    buckets.total.msgs += (s.userMsgs || 0) + (s.assistantMsgs || 0);

    const ago = now - lastTs;
    if (ago <= DAY) { buckets.last1d.input += inT; buckets.last1d.output += outT; buckets.last1d.cacheRead += cr; buckets.last1d.cacheCreate += cc; buckets.last1d.sessions++; }
    if (ago <= DAY * 7) { buckets.last7d.input += inT; buckets.last7d.output += outT; buckets.last7d.cacheRead += cr; buckets.last7d.cacheCreate += cc; buckets.last7d.sessions++; }
    if (ago <= DAY * 30) { buckets.last30d.input += inT; buckets.last30d.output += outT; buckets.last30d.cacheRead += cr; buckets.last30d.cacheCreate += cc; buckets.last30d.sessions++; }
    if (lastTs >= monthStart) { buckets.thisMonth.input += inT; buckets.thisMonth.output += outT; buckets.thisMonth.cacheRead += cr; buckets.thisMonth.cacheCreate += cc; buckets.thisMonth.sessions++; }

    // Cached sessions from before the parser cleanup may still carry
    // "synthetic" / "<synthetic>" (Claude) or just a provider name like
    // "openai" (Codex pre-turn_context). Coerce both to "unknown" so the
    // by-model breakdown isn't polluted until the next fresh re-parse.
    const model = isUsableModel(s.model) ? s.model : 'unknown';
    const cur = byModel.get(model) || { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, sessions: 0 };
    cur.input += inT; cur.output += outT; cur.cacheRead += cr; cur.cacheCreate += cc; cur.sessions++;
    byModel.set(model, cur);

    const proj = s.decodedCwd || s.projectDir;
    const pcur = byProject.get(proj) || { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, sessions: 0 };
    pcur.input += inT; pcur.output += outT; pcur.cacheRead += cr; pcur.cacheCreate += cc; pcur.sessions++;
    byProject.set(proj, pcur);

    if (lastTs) {
      const d = new Date(lastTs);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      const dcur = byDay.get(key) || { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, sessions: 0 };
      dcur.input += inT; dcur.output += outT; dcur.cacheRead += cr; dcur.cacheCreate += cc; dcur.sessions++;
      byDay.set(key, dcur);
    }
  }

  // Build a sorted full byDay list (newest first) so we can derive streaks +
  // activity stats from it without re-walking sessions.
  const byDayAll = [...byDay.entries()]
    .map(([k, v]) => ({ day: k, ...v }))
    .sort((a, b) => b.day.localeCompare(a.day));

  const stats = computeStats(sessions, byDayAll, byModel);

  return {
    buckets,
    currentWindows,
    byModel: [...byModel.entries()].map(([k, v]) => ({ model: k, ...v })).sort((a, b) => (b.input + b.output) - (a.input + a.output)),
    byProject: [...byProject.entries()].map(([k, v]) => ({ project: k, ...v })).sort((a, b) => (b.input + b.output + b.cacheRead) - (a.input + a.output + a.cacheRead)).slice(0, 20),
    // Newest first; keep up to 400 days so the heatmap can show ~52 weeks.
    byDay: byDayAll.slice(0, 400),
    stats,
  };
}

// Derived activity stats: streaks, active days, longest session, favorite model.
// All cheap to compute since we already have byDay + sessions in memory.
function computeStats(sessions, byDayAll, byModel) {
  const DAY = 86400 * 1000;
  // Active days = number of distinct days with any session activity.
  const activeDays = byDayAll.length;
  const firstDay = byDayAll.length ? byDayAll[byDayAll.length - 1].day : null;
  const lastDay = byDayAll.length ? byDayAll[0].day : null;
  // Total days = span from first activity to today, inclusive.
  let totalDays = 0;
  if (firstDay) {
    const ms = Date.now() - parseLocalDay(firstDay).getTime();
    totalDays = Math.max(1, Math.floor(ms / DAY) + 1);
  }
  // Streaks: walk the days ascending. Need a Set of active days for quick lookup.
  const daySet = new Set(byDayAll.map(d => d.day));
  let longestStreak = 0, currentStreak = 0;
  if (firstDay) {
    let streak = 0;
    // Walk day-by-day from firstDay to today.
    const start = parseLocalDay(firstDay).getTime();
    const todayKey = dayKey(new Date());
    for (let t = start; t <= Date.now(); t += DAY) {
      const k = dayKey(new Date(t));
      if (daySet.has(k)) {
        streak++;
        if (streak > longestStreak) longestStreak = streak;
      } else {
        streak = 0;
      }
      if (k === todayKey) currentStreak = streak;
    }
  }
  // Most active day (by total tokens).
  let mostActive = null;
  let mostActiveTokens = -1;
  for (const d of byDayAll) {
    const total = d.input + d.output + d.cacheRead + d.cacheCreate;
    if (total > mostActiveTokens) { mostActiveTokens = total; mostActive = d.day; }
  }
  // Longest single session: max(lastTs - firstTs).
  let longestSessionMs = 0;
  for (const s of sessions) {
    if (!s.firstTs || !s.lastTs) continue;
    const span = new Date(s.lastTs).getTime() - new Date(s.firstTs).getTime();
    if (span > longestSessionMs) longestSessionMs = span;
  }
  // Favorite model (by total tokens, excluding 'unknown').
  let favoriteModel = null;
  let favTokens = 0;
  for (const [model, v] of byModel.entries()) {
    if (model === 'unknown') continue;
    const t = v.input + v.output + v.cacheRead + v.cacheCreate;
    if (t > favTokens) { favTokens = t; favoriteModel = model; }
  }
  return {
    activeDays, totalDays,
    longestStreak, currentStreak,
    mostActiveDay: mostActive,
    longestSessionMs,
    favoriteModel,
    firstDay, lastDay,
  };
}

function dayKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function parseLocalDay(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

/* ---------- Tray + window mgmt ---------- */

// Tray icon. Per-platform because Win32/Linux have no template-image mechanism
// — feeding them the black-on-transparent macOS template PNG renders as a
// solid black blob on a dark taskbar.
//   macOS: trayTemplate.png (18x18) + @2x (36x36), setTemplateImage(true)
//          so Cocoa auto-inverts for light/dark menu bars.
//   Windows: icon.ico (multi-size; Win tray picks the right DPI).
//   Linux: icon.png (256x256 colored app icon).
// All assets generated by `npm run build:icon`. electron-builder puts build/
// inside resources/ at runtime via extraResources; in dev they sit next to
// main.cjs in the repo's build/ dir.
function makeTrayIcon() {
  const resolveAsset = (...rel) => {
    const candidates = [
      path.join(__dirname, '..', ...rel),
      path.join(process.resourcesPath || '', ...rel),
    ];
    for (const p of candidates) {
      try {
        if (p && fs.existsSync(p)) return p;
      } catch {}
    }
    return null;
  };

  try {
    if (process.platform === 'darwin') {
      const p = resolveAsset('build', 'trayTemplate.png');
      if (p) {
        const img = nativeImage.createFromPath(p);
        if (!img.isEmpty()) {
          img.setTemplateImage(true);
          return img;
        }
      }
    } else if (process.platform === 'win32') {
      const p = resolveAsset('build', 'icon.ico');
      if (p) {
        const img = nativeImage.createFromPath(p);
        if (!img.isEmpty()) return img;
      }
    } else {
      const p = resolveAsset('build', 'icon.png');
      if (p) {
        const img = nativeImage.createFromPath(p);
        if (!img.isEmpty()) return img;
      }
    }
  } catch {}
  return nativeImage.createEmpty();
}

function showOrCreateWindow() {
  if (process.platform === 'darwin' && app.dock) {
    try { app.dock.show(); } catch {}
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  } else {
    createWindow();
  }
}

function buildTrayMenu() {
  return Menu.buildFromTemplate([
    { label: 'Show Lens', click: showOrCreateWindow },
    { type: 'separator' },
    { label: 'Quit', click: () => { isQuitting = true; app.quit(); } },
  ]);
}

function createTray() {
  if (tray) return;
  if (!appPrefs.showTrayIcon) return;
  tray = new Tray(makeTrayIcon());
  tray.setToolTip('Lens — Search, resume, and understand your AI coding sessions');
  const menu = buildTrayMenu();
  if (process.platform === 'darwin') {
    // macOS: left click opens the window; right click pops the menu. Using
    // setContextMenu attaches the menu to BOTH clicks, which made the menu
    // flash open and immediately re-close when the 'click' handler then ran
    // showOrCreateWindow. popUpContextMenu only fires on the right-click
    // event, so left click is clean.
    tray.on('click', () => showOrCreateWindow());
    tray.on('right-click', () => { try { tray.popUpContextMenu(menu); } catch {} });
  } else {
    // Windows/Linux: keep the platform-standard click-shows-menu behavior.
    tray.setContextMenu(menu);
    tray.on('click', () => showOrCreateWindow());
  }
}

function destroyTray() {
  if (!tray) return;
  try { tray.destroy(); } catch {}
  tray = null;
}

// Window-chrome colors per theme. Used both as the initial titleBarOverlay
// values on Windows and re-applied at runtime when the renderer switches theme.
// Must match the renderer's `--bg` HSL exactly (styles.css):
//   light = hsl(240 10% 95%) → #f1f1f4
//   dark  = hsl(240 8% 8%)   → #131316
const TITLEBAR_COLORS = {
  light: { color: '#f1f1f4', symbolColor: '#1f1f24' },
  dark:  { color: '#131316', symbolColor: '#e5e5ea' },
};

function createWindow() {
  const isMac = process.platform === 'darwin';
  const isWin = process.platform === 'win32';
  // Detect initial theme from the renderer's persisted choice if we can read it;
  // otherwise default to light. The renderer also calls `win:setTitleBarTheme`
  // on mount so any mismatch corrects within a few ms.
  const initialTitleBar = TITLEBAR_COLORS.light;
  // Restore last window geometry across launches. screen.getPrimaryDisplay
  // gives us workArea so we can fall back when the persisted bounds reference
  // a monitor that's no longer attached. Dev mode (Vite) intentionally skips
  // restore so every `npm run dev` lands on the fresh-install default — what
  // a first-time end user actually sees.
  const isDev = !!process.env.VITE_DEV_SERVER_URL;
  const { screen } = require('electron');
  const wa = screen.getPrimaryDisplay().workArea;
  const saved = !isDev ? appPrefs.windowBounds : null;
  const onScreen = saved
    && Number.isFinite(saved.width) && Number.isFinite(saved.height)
    && saved.width >= 1380 && saved.height >= 720
    && Number.isFinite(saved.x) && Number.isFinite(saved.y)
    && saved.x >= wa.x - 50 && saved.y >= wa.y - 50
    && saved.x + saved.width <= wa.x + wa.width + 50
    && saved.y + saved.height <= wa.y + wa.height + 50;
  const initialBounds = onScreen
    ? { x: saved.x, y: saved.y, width: saved.width, height: saved.height }
    : { width: 1400, height: 900 };
  mainWindow = new BrowserWindow({
    title: 'Lens',
    ...initialBounds,
    // 1380 covers sidebar (220) + list-max (480) + detail-min (~640) + chrome
    // gaps so the toolbar inside the session header stays single-line no matter
    // how wide the user grows the middle list pane.
    minWidth: 1380, minHeight: 720,
    // Unified hidden-titlebar across both platforms — macOS keeps the traffic
    // lights inset; Windows uses the system overlay so we still get native
    // min/max/close behavior without the chunky default title bar.
    titleBarStyle: isMac ? 'hiddenInset' : 'hidden',
    titleBarOverlay: isWin ? {
      color: initialTitleBar.color,
      symbolColor: initialTitleBar.symbolColor,
      height: 36,
    } : undefined,
    backgroundColor: '#f1f1f4',
    show: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  // Belt-and-suspenders on macOS hiddenInset: the constructor `minWidth` /
  // `minHeight` are occasionally ignored when the user drags fast or after a
  // window restore. setMinimumSize re-applies the constraint and survives
  // those edge cases.
  try { mainWindow.setMinimumSize(1380, 720); } catch {}

  // CSP injected as a response header — covers both dev (vite served HTML)
  // and prod (file:// loaded HTML) without needing a meta tag. Dev policy
  // permits Vite HMR (ws + eval + dev server origin); prod is strict (no
  // eval, no remote scripts; only Anthropic's API for the rate-limits probe
  // is connect-src allowed). Dev origin is derived from VITE_DEV_SERVER_URL
  // so a custom port/host the user picked still loads HMR cleanly.
  const PROD_CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; connect-src 'self' https://api.anthropic.com; font-src 'self' data:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'none';";
  let devOrigin = 'http://localhost:5173';
  if (isDev && process.env.VITE_DEV_SERVER_URL) {
    try { devOrigin = new URL(process.env.VITE_DEV_SERVER_URL).origin; } catch {}
  }
  const DEV_CSP = `default-src 'self' ws: ${devOrigin}; script-src 'self' 'unsafe-eval' 'unsafe-inline' ${devOrigin}; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https: http:; connect-src 'self' ws: wss: ${devOrigin} https:; font-src 'self' data: ${devOrigin}; object-src 'none'; base-uri 'self';`;
  mainWindow.webContents.session.webRequest.onHeadersReceived((details, cb) => {
    cb({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [isDev ? DEV_CSP : PROD_CSP],
      },
    });
  });

  // Refuse to navigate the main BrowserWindow away from the loaded origin.
  // A successful XSS would otherwise try to swap the window to an attacker
  // page; this keeps the renderer pinned to our own bundle.
  mainWindow.webContents.on('will-navigate', (e, url) => {
    const current = mainWindow.webContents.getURL();
    try {
      const dest = new URL(url);
      const cur = new URL(current);
      if (dest.origin === cur.origin) return;
    } catch {}
    e.preventDefault();
  });
  // Never open new BrowserWindows. All link clicks that would open new
  // windows go to the OS default browser via shell.openExternal — the same
  // policy as our app:openExternal IPC.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const u = new URL(url);
      if (u.protocol === 'http:' || u.protocol === 'https:' || u.protocol === 'mailto:') {
        shell.openExternal(u.href);
      }
    } catch {}
    return { action: 'deny' };
  });

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) {
    mainWindow.loadURL(devUrl);
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }

  // Killing the menu strips the default F12 / Ctrl+Shift+I accelerators, so
  // register them at the webContents level. Dev only — packaged builds
  // shouldn't expose internal app state, IPC surface, or rate-limit debug
  // body to any local user with access to the keyboard. Set
  // LENS_ENABLE_DEVTOOLS=1 if you genuinely need it on a release build.
  if (isDev || process.env.LENS_ENABLE_DEVTOOLS === '1') {
    mainWindow.webContents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown') return;
      const key = (input.key || '').toLowerCase();
      const toggle = key === 'f12'
        || ((input.control || input.meta) && input.shift && key === 'i')
        || ((input.alt && key === 'i'));
      if (toggle) {
        mainWindow.webContents.toggleDevTools();
        event.preventDefault();
      }
    });
  }
  mainWindow.on('close', (e) => {
    // Persist size+position BEFORE hide/quit so the next launch lands on the
    // last layout the user actually had. Dev mode skips persistence so we can
    // always start from the fresh-install default for testing.
    // On the quit path (canHide=false or isQuitting=true) we use a synchronous
    // write — the async pipeline can't finish before Electron tears the
    // process down, and a sudden quit would otherwise drop the last layout.
    if (!isDev) {
      try {
        const b = mainWindow.getNormalBounds();
        appPrefs.windowBounds = { x: b.x, y: b.y, width: b.width, height: b.height };
        const canHide = appPrefs.closeBehavior === 'hide' && appPrefs.showTrayIcon;
        if (isQuitting || !canHide) {
          // Synchronous atomic + fsynced write. We're about to be killed by
          // the OS — without fsyncSync the OS page cache might not flush in
          // time and the just-recorded bounds get lost on a crash/poweroff
          // immediately after quit. Mirror the async path's durability.
          try {
            const tmp = appPrefsPath + '.tmp-' + process.pid + '-quit';
            const fd = fs.openSync(tmp, 'w');
            try {
              fs.writeFileSync(fd, JSON.stringify(appPrefs, null, 2), 'utf8');
              try { fs.fsyncSync(fd); } catch {}
            } finally {
              fs.closeSync(fd);
            }
            fs.renameSync(tmp, appPrefsPath);
            if (process.platform !== 'win32') {
              try {
                const dfd = fs.openSync(path.dirname(appPrefsPath), 'r');
                try { fs.fsyncSync(dfd); } catch {}
                fs.closeSync(dfd);
              } catch {}
            }
          } catch {}
        } else {
          saveAppPrefs();
        }
      } catch {}
    }
    if (isQuitting) return;
    // Hide-on-close requires a way for the user to bring the window back.
    // If they have BOTH closeBehavior='hide' AND showTrayIcon=false, the
    // window would be unreachable — fall through to quit in that case.
    const canHide = appPrefs.closeBehavior === 'hide' && appPrefs.showTrayIcon;
    if (canHide) {
      e.preventDefault();
      mainWindow.hide();
      if (process.platform === 'darwin' && app.dock) {
        try { app.dock.hide(); } catch {}
      }
      return;
    }
    // closeBehavior='quit' on macOS: without help, Electron's default macOS
    // behavior is "close window, app keeps running" (no `window-all-closed`
    // quit there). The user explicitly asked for quit-on-close — fire it.
    if (process.platform === 'darwin') {
      isQuitting = true;
      app.quit();
    }
  });
  // Debounced save on user resize/move so a hard quit (Cmd+Q during a crash,
  // power loss) still preserves something close to the user's last layout.
  if (!isDev) {
    let boundsSaveTimer = null;
    const scheduleBoundsSave = () => {
      clearTimeout(boundsSaveTimer);
      boundsSaveTimer = setTimeout(() => {
        try {
          if (!mainWindow || mainWindow.isDestroyed()) return;
          const b = mainWindow.getNormalBounds();
          appPrefs.windowBounds = { x: b.x, y: b.y, width: b.width, height: b.height };
          saveAppPrefs();
        } catch {}
      }, 800);
    };
    mainWindow.on('resize', scheduleBoundsSave);
    mainWindow.on('move', scheduleBoundsSave);
  }
}

/* ---------- IPC ---------- */

// Windows and macOS use case-insensitive filesystems by default, so the
// containment check has to be case-insensitive there. Linux is case-sensitive,
// keep the exact comparison. NTFS / APFS realpath() preserves original case,
// so identical-but-different-cased paths still fail string equality without
// this normalisation.
const PATH_CASE_INSENSITIVE = process.platform === 'win32' || process.platform === 'darwin';
function pathEq(a, b) {
  return PATH_CASE_INSENSITIVE ? a.toLowerCase() === b.toLowerCase() : a === b;
}
function pathStartsWith(child, parent) {
  return PATH_CASE_INSENSITIVE
    ? child.toLowerCase().startsWith(parent.toLowerCase())
    : child.startsWith(parent);
}

// Containment check: `path.relative(realBase, real)` returns "" when equal,
// a non-`..`-prefixed string when inside, or a `..`-prefixed string when
// outside. This is correct on case-insensitive AND case-sensitive volumes —
// realpath() already normalises casing on case-insensitive FS, so the same
// strict comparison handles both correctly. The previous lowercase-startsWith
// approach would conflate `~/.Claude/...` and `~/.claude/...` on a
// case-sensitive APFS volume.
function isInsideBase(real, realBase) {
  if (real === realBase) return true;
  const rel = path.relative(realBase, real);
  if (!rel) return true;
  if (rel.startsWith('..')) return false;
  if (path.isAbsolute(rel)) return false;
  return true;
}

async function ensureInside(baseDir, p) {
  if (typeof p !== 'string') throw new Error('Invalid path');
  const realBase = await fsp.realpath(baseDir);
  const real = await fsp.realpath(path.resolve(p));
  if (!isInsideBase(real, realBase)) {
    throw new Error('Path outside ' + baseDir);
  }
  return real;
}

async function ensureInsideAny(baseDirs, p) {
  if (typeof p !== 'string') throw new Error('Invalid path');
  const real = await fsp.realpath(path.resolve(p));
  for (const base of baseDirs) {
    try {
      const realBase = await fsp.realpath(base);
      if (isInsideBase(real, realBase)) return real;
    } catch {}
  }
  throw new Error('Path outside allowed roots');
}

ipcMain.handle('sessions:list', async (_e, opts) => {
  const sessions = await listSessions(opts || {});
  // Strip large tokenEvents arrays — only used server-side for usageSummary().
  return sessions.map(({ tokenEvents, ...rest }) => rest);
});

ipcMain.handle('sessions:get', async (_e, filePath) => {
  // Allow both source roots; dispatch to the right parser based on which
  // realpath base the file falls inside. Comparing against the
  // *realpath-resolved* base means a `~/.codex/sessions` symlinked to
  // somewhere else still routes correctly — the old prefix compare used the
  // unresolved literal CODEX_SESSIONS_DIR and would mis-route under that
  // setup.
  const real = await ensureInsideAny([PROJECTS_DIR, CODEX_SESSIONS_DIR], filePath);
  if (!real.endsWith('.jsonl')) throw new Error('Not a session file');
  let realCodexBase = CODEX_SESSIONS_DIR;
  try { realCodexBase = await fsp.realpath(CODEX_SESSIONS_DIR); } catch {}
  if (isInsideBase(real, realCodexBase)) {
    return await getCodexSessionMessages(real);
  }
  return await getSessionMessages(real);
});

// Deep search input caps. Keeps a misbehaving / hostile renderer from forcing
// a many-second whole-corpus scan; a sane human query maxes out far below
// these numbers.
const DEEP_SEARCH_QUERY_MAX_LEN = 512;
const DEEP_SEARCH_QUERY_MAX_TERMS = 32;
let _deepSearchInflight = null;
ipcMain.handle('sessions:deepSearch', async (_e, payload) => {
  const query = payload?.query;
  if (typeof query !== 'string') return [];
  if (query.length === 0 || query.length > DEEP_SEARCH_QUERY_MAX_LEN) return [];
  if ((query.match(/\S+/g) || []).length > DEEP_SEARCH_QUERY_MAX_TERMS) return [];
  // Mutual exclusion: a new search supersedes the in-flight one. We can't
  // truly cancel mid-scan (parser is sync per file) but we can refuse to
  // queue a fresh whole-corpus walk while one is already running — caller
  // gets a quick empty result rather than piling on disk IO.
  if (_deepSearchInflight) {
    try { await _deepSearchInflight; } catch {}
  }
  const p = deepSearch(query, payload?.source);
  _deepSearchInflight = p;
  try { return await p; }
  finally { if (_deepSearchInflight === p) _deepSearchInflight = null; }
});

ipcMain.handle('sessions:copyResumeCommand', async (_e, payload) => {
  const { cwd, id, filePath, source } = payload || {};
  if (!isValidSessionId(id)) throw new Error('Invalid session id');
  // Prefer the explicit source; fall back to a realpath-aware containment check
  // so a symlinked CODEX_DIR still routes Codex sessions correctly. Old
  // callers that pass only `filePath` benefit from the realpath form.
  let isCodex = source === 'codex';
  if (!isCodex && typeof filePath === 'string') {
    try {
      const realFile = await fsp.realpath(filePath);
      const realCodexBase = await fsp.realpath(CODEX_DIR);
      isCodex = isInsideBase(realFile, realCodexBase);
    } catch {
      isCodex = pathStartsWith(filePath, CODEX_DIR + path.sep);
    }
  }
  const cmd = isCodex
    ? `cd ${shellQuote(cwd || '~')} && codex resume ${shellQuote(id)}`
    : `cd ${shellQuote(cwd || '~')} && claude --resume ${shellQuote(id)}`;
  clipboard.writeText(cmd);
  return cmd;
});

ipcMain.handle('sessions:revealInFinder', async (_e, filePath) => {
  const real = await ensureInsideAny([PROJECTS_DIR, CLAUDE_DIR, CODEX_DIR], filePath);
  shell.showItemInFolder(real);
});

// Open the active AI tool's data root in Finder. Avoids the renderer needing
// to know absolute home paths; main.cjs owns CLAUDE_DIR / CODEX_DIR already.
ipcMain.handle('app:revealSourceDir', async (_e, source) => {
  // Match the pathHint the UI advertises (Sidebar / Settings show
  // `~/.codex/sessions` for Codex, `~/.claude` for Claude). Opening the
  // parent CODEX_DIR confused users — the button label said one thing and
  // the OS opened the level above.
  const target = source === 'codex' ? CODEX_SESSIONS_DIR : CLAUDE_DIR;
  shell.openPath(target);
});

ipcMain.handle('sessions:openInVSCode', async (_e, cwd) => {
  // Validate platform-appropriate absolute-path shape so a Windows user with
  // C:\Users\foo\repo gets a working call instead of "Invalid path".
  // Cross-platform: POSIX absolute = leading "/"; Windows absolute = drive
  // letter + colon + separator (C:\... or C:/...). Reject UNC paths and any
  // form of path traversal. fs.realpath through `fsp.realpath` would also be
  // ideal but cwd may be a project that doesn't exist locally; we only
  // require well-formed absolute, not on-disk existence.
  if (typeof cwd !== 'string' || cwd.length === 0 || cwd.length > 4096) {
    throw new Error('Invalid path');
  }
  if (cwd.includes('\0')) throw new Error('Invalid path');
  const isPosixAbs = cwd.startsWith('/');
  const isWindowsAbs = /^[A-Za-z]:[\\/]/.test(cwd);
  if (!isPosixAbs && !isWindowsAbs) throw new Error('Invalid path');
  // Defense in depth: require the path to actually exist on disk as a
  // non-symlink directory. A renderer compromised by a malicious JSONL could
  // otherwise ask us to vscode://file/etc/shadow — well-formed but pointing
  // at sensitive content. Real project cwds always survive this check.
  try {
    const st = await fsp.lstat(cwd);
    if (st.isSymbolicLink() || !st.isDirectory()) throw new Error('Not a directory');
  } catch {
    throw new Error('Path is not an accessible directory');
  }
  // Build a real `vscode://file/<absolute>` URL — encode path segments so
  // spaces and unicode survive intact. On Windows the drive letter colon
  // must NOT be percent-encoded (vscode://file/C%3A/Users/... breaks the
  // URI handler); keep `C:` verbatim and only encode the parts after it.
  let url;
  if (isWindowsAbs) {
    const m = cwd.match(/^([A-Za-z]:)[\\/](.*)$/) || cwd.match(/^([A-Za-z]:)$/);
    const drive = m ? m[1] : cwd.slice(0, 2);
    const rest = (m && m[2]) ? m[2] : '';
    const restPart = rest
      ? '/' + rest.replace(/\\/g, '/').split('/').map(encodeURIComponent).join('/')
      : '';
    url = `vscode://file/${drive}${restPart}`;
  } else {
    url = 'vscode://file' + cwd.split('/').map(encodeURIComponent).join('/');
  }
  await shell.openExternal(url);
});

function isValidSessionId(id) {
  // Allowed alphabet: letters, digits, _ and -.
  // Reject leading `-` because such an id would be interpreted as a CLI flag
  // when passed to `claude --resume <id>` or `codex resume <id>`. Even though
  // we don't shell out raw, treating user-controlled value as a positional arg
  // that *could* look like a flag is a smuggling vector — better to refuse.
  if (typeof id !== 'string') return false;
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) return false;
  if (id.startsWith('-')) return false;
  return true;
}
function runOsascript(script) {
  return new Promise((resolve, reject) => {
    execFile('osascript', ['-e', script], (err) => { if (err) reject(err); else resolve(true); });
  });
}

// Detect which terminals are actually installed so the renderer can hide
// options that wouldn't work. Synchronous + cached at startup — file/PATH lookups
// only, no spawn beyond `where.exe`.
let cachedTerminals = null;
function detectTerminals() {
  if (cachedTerminals) return cachedTerminals;
  const t = { terminal: false, iterm: false, wt: false, powershell: false, cmd: false };
  if (process.platform === 'darwin') {
    // Terminal.app is part of the OS — always present.
    t.terminal = true;
    try { t.iterm = fs.existsSync('/Applications/iTerm.app'); } catch {}
  } else if (process.platform === 'win32') {
    t.cmd = true; // cmd.exe ships with Windows
    const which = (exe) => {
      try { execFileSync('where.exe', [exe], { stdio: ['ignore', 'pipe', 'ignore'], timeout: 1500 }); return true; }
      catch { return false; }
    };
    t.wt = which('wt.exe');
    t.powershell = which('pwsh.exe') || which('powershell.exe');
  }
  cachedTerminals = t;
  return t;
}

// Detect which AI CLIs the user has on this machine. We check both the binary
// (in PATH) and the storage directory — either signal is enough since users
// may have history without a current install or vice versa.
let cachedAiTools = null;
function detectAiTools() {
  if (cachedAiTools) return cachedAiTools;
  const home = os.homedir();
  const which = (exe) => {
    try {
      const cmd = process.platform === 'win32' ? 'where.exe' : 'which';
      execFileSync(cmd, [exe], { stdio: ['ignore', 'pipe', 'ignore'], timeout: 1500 });
      return true;
    } catch { return false; }
  };
  const claudeDir = fs.existsSync(path.join(home, '.claude'));
  const claudeBin = which('claude');
  const codexDir = fs.existsSync(path.join(home, '.codex'));
  const codexBin = which('codex');
  cachedAiTools = {
    claude: { installed: claudeDir || claudeBin, hasHistory: claudeDir, hasBinary: claudeBin },
    codex:  { installed: codexDir || codexBin,   hasHistory: codexDir,   hasBinary: codexBin  },
  };
  return cachedAiTools;
}

ipcMain.handle('system:capabilities', async () => ({
  platform: process.platform,
  terminals: detectTerminals(),
  aiTools: detectAiTools(),
}));

ipcMain.handle('app:openExternal', async (_e, url) => {
  // Whitelist URL schemes. Anything else (file:, javascript:, custom protocols)
  // is rejected so a tampered JSONL / config markdown can't trick the user
  // into launching local apps when they think they're opening a web link.
  try {
    if (typeof url !== 'string') throw new Error('invalid url');
    const trimmed = url.trim();
    if (!trimmed || trimmed.length > 4096) throw new Error('invalid url');
    const u = new URL(trimmed);
    if (!['http:', 'https:', 'mailto:'].includes(u.protocol)) {
      throw new Error('unsupported scheme: ' + u.protocol);
    }
    // Hand `u.href` (the normalised URL) to shell, not the raw input — this
    // strips whitespace, defends against ambiguous parsing, and ensures the
    // value matches what the allowlist actually checked.
    await shell.openExternal(u.href);
  } catch (e) {
    throw new Error('openExternal rejected: ' + e.message);
  }
});

ipcMain.handle('app:openLogsFolder', async () => {
  try {
    const dir = app.getPath('logs');
    fs.mkdirSync(dir, { recursive: true });
    await shell.openPath(dir);
    return dir;
  } catch (e) {
    throw new Error('Failed to open logs folder: ' + e.message);
  }
});

ipcMain.handle('appPrefs:get', async () => ({ ...appPrefs }));

// Dedicated consent setter. Kept narrow so the IPC surface stays auditable —
// a future tightening (e.g. require a confirm dialog before granting) only
// has to touch this one handler. Reject unknown values rather than silently
// coercing.
ipcMain.handle('rateLimits:setConsent', async (_e, value) => {
  if (value !== 'pending' && value !== 'granted' && value !== 'denied') {
    throw new Error('Invalid rate-limits consent value');
  }
  appPrefs.rateLimitsConsent = value;
  await saveAppPrefs();
  return value;
});

ipcMain.handle('appPrefs:set', async (_e, patch) => {
  if (!patch || typeof patch !== 'object') return { ...appPrefs };
  const prev = { ...appPrefs };
  // Only accept known keys; ignore stray fields.
  // rateLimitsConsent intentionally lives in a dedicated handler
  // (rateLimits:setConsent) — not as a security boundary against XSS (a
  // compromised renderer can call that handler too) but to keep the consent
  // surface auditable, and so a future hardening (e.g. main-side native
  // dialog) only has to touch one IPC.
  if (typeof patch.showTrayIcon === 'boolean') appPrefs.showTrayIcon = patch.showTrayIcon;
  if (patch.closeBehavior === 'quit' || patch.closeBehavior === 'hide') appPrefs.closeBehavior = patch.closeBehavior;
  if (typeof patch.launchAtLogin === 'boolean') appPrefs.launchAtLogin = patch.launchAtLogin;
  await saveAppPrefs();
  // Apply side-effects immediately.
  if (prev.showTrayIcon !== appPrefs.showTrayIcon) {
    if (appPrefs.showTrayIcon) createTray(); else destroyTray();
  }
  if (prev.launchAtLogin !== appPrefs.launchAtLogin) {
    applyLaunchAtLogin(appPrefs.launchAtLogin);
  }
  return { ...appPrefs };
});

// Renderer tells us when the user-selected theme changes so the Windows native
// caption-button overlay can be repainted to match. No-op on macOS / Linux —
// they don't render an overlay.
ipcMain.handle('win:setTitleBarTheme', async (_e, theme) => {
  if (process.platform !== 'win32' || !mainWindow || mainWindow.isDestroyed()) return;
  const colors = theme === 'dark' ? TITLEBAR_COLORS.dark : TITLEBAR_COLORS.light;
  try { mainWindow.setTitleBarOverlay(colors); } catch {}
});

// Returns the right resume command for a given session, dispatched by the
// filePath of the source: claude lives under ~/.claude/projects/, codex under
// ~/.codex/sessions/. Both share the openInTerminal IPC so the renderer
// doesn't have to know which CLI to invoke.
// Validate a `cwd` payload before handing it to a shell/exec. Same gate as
// openInVSCode: well-formed absolute path, no NUL, lstat-existent non-symlink
// directory. Falls back to HOME if the path is missing or unusable so the
// "Open in Terminal" button still works for old/missing JSONLs.
function safeCwd(cwd) {
  if (typeof cwd !== 'string' || cwd.length === 0 || cwd.length > 4096) return os.homedir();
  if (cwd.includes('\0')) return os.homedir();
  const isPosixAbs = cwd.startsWith('/');
  const isWindowsAbs = /^[A-Za-z]:[\\/]/.test(cwd);
  if (!isPosixAbs && !isWindowsAbs) return os.homedir();
  try {
    const st = fs.lstatSync(cwd);
    if (st.isSymbolicLink() || !st.isDirectory()) return os.homedir();
  } catch { return os.homedir(); }
  return cwd;
}

function resumeCommandFor(payload) {
  const { cwd, id, filePath, source } = payload || {};
  if (!isValidSessionId(id)) throw new Error('Invalid session id');
  const dir = safeCwd(cwd);
  // Source from renderer is the authoritative signal (works for demo mode
  // where filePath uses fake jordan paths). Fall back to filePath sniffing
  // for older callers that don't pass source.
  const isCodex = source === 'codex'
    || (typeof filePath === 'string' && pathStartsWith(filePath, CODEX_DIR + path.sep));
  console.log(`[resume] source=${source} filePath=${filePath} → ${isCodex ? 'codex' : 'claude'}`);
  // codex CLI resumes via `codex resume <session-id>`. cwd matters less for
  // codex because the session's own metadata records cwd; we still cd to it.
  return {
    dir,
    cli: isCodex ? 'codex' : 'claude',
    // id passes isValidSessionId so the alphabet is safe — but quote it anyway
    // for defense-in-depth, in case the allowed alphabet ever widens.
    bashCmd: isCodex
      ? `cd ${shellQuote(dir)} && codex resume ${shellQuote(id)}`
      : `cd ${shellQuote(dir)} && claude --resume ${shellQuote(id)}`,
    args: isCodex ? ['resume', id] : ['--resume', id],
  };
}

ipcMain.handle('sessions:openInTerminal', async (_e, payload) => {
  const { id, filePath } = payload || {};
  if (!isValidSessionId(id)) throw new Error('Invalid session id');
  const { dir, bashCmd, cli, args } = resumeCommandFor(payload);

  if (process.platform === 'darwin') {
    const script = `tell application "Terminal"\nactivate\ndo script ${JSON.stringify(bashCmd)}\nend tell`;
    return runOsascript(script);
  }
  if (process.platform === 'win32') {
    // `id` is already regex-validated (isValidSessionId). `dir` is renderer-supplied
    // so we never interpolate it into a shell command line — it goes only through
    // execFile's `cwd:` option so Windows starts the child in the right directory
    // without parsing the path through cmd.exe. We also refuse `dir` values that
    // start with `-` to defeat argv flag smuggling for tools that take positional
    // path arguments (wt.exe -d <dir>).
    if (typeof dir !== 'string' || dir.length === 0) throw new Error('Invalid cwd');
    const safeDir = dir;
    const dirLooksLikeFlag = safeDir.startsWith('-') || safeDir.startsWith('/');
    const terms = detectTerminals();
    const opts = { windowsHide: false, cwd: safeDir };
    // Inner command line that runs inside the spawned shell.
    const innerCmd = `${cli} ${args.join(' ')}`;
    // Resolve known Windows system programs to absolute paths so a writable
    // directory earlier in PATH can't shadow them with a malicious binary.
    // wt.exe lives in WindowsApps (Microsoft Store), so we keep PATH lookup
    // there but explicitly verify via `where` from the System32 location.
    const system32 = process.env.SystemRoot ? path.join(process.env.SystemRoot, 'System32') : 'C:\\Windows\\System32';
    const absCmd = path.join(system32, 'cmd.exe');
    const absPwsh = path.join(system32, 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    if (terms.wt) {
      // wt.exe -d sets the *initial directory of the new tab*; skip it when the
      // path could be confused with a flag and rely on the inherited cwd instead.
      const wtArgs = dirLooksLikeFlag
        ? [absCmd, '/K', innerCmd]
        : ['-d', safeDir, absCmd, '/K', innerCmd];
      // wt.exe is installed via WindowsApps; keep PATH lookup for it but the
      // inner cmd.exe is anchored to System32.
      return new Promise((resolve, reject) => {
        execFile('wt.exe', wtArgs, opts, (err) => { if (err) reject(err); else resolve(true); });
      });
    }
    if (terms.powershell) {
      // pwsh.exe (PowerShell 7+) lives in Program Files when installed;
      // legacy powershell.exe in System32. Prefer absolute paths and only
      // fall back to PATH lookup for pwsh which doesn't have a stable abs path.
      const pwshAbs = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe';
      const ps = fs.existsSync(pwshAbs) ? pwshAbs : absPwsh;
      return new Promise((resolve, reject) => {
        execFile(ps, ['-NoExit', '-Command', innerCmd], opts, (err) => { if (err) reject(err); else resolve(true); });
      });
    }
    return new Promise((resolve, reject) => {
      execFile(absCmd, ['/K', innerCmd], opts, (err) => { if (err) reject(err); else resolve(true); });
    });
  }
  // Linux: try the cross-DE `xdg-terminal-exec` (Debian 12+, common DE wrapper),
  // then fall back to specific terminals in a preference order. We pass the
  // command through `sh -c` so `cd && claude --resume` runs inside the new
  // terminal session rather than being interpreted by the launcher.
  if (process.platform === 'linux') {
    const { bashCmd } = resumeCommandFor(payload);
    const candidates = [
      ['xdg-terminal-exec', ['sh', '-c', bashCmd]],
      ['gnome-terminal', ['--', 'sh', '-c', bashCmd]],
      ['konsole', ['-e', 'sh', '-c', bashCmd]],
      ['xfce4-terminal', ['--command', 'sh -c ' + JSON.stringify(bashCmd)]],
      ['alacritty', ['-e', 'sh', '-c', bashCmd]],
      ['kitty', ['sh', '-c', bashCmd]],
      ['x-terminal-emulator', ['-e', 'sh', '-c', bashCmd]],
      ['xterm', ['-e', 'sh', '-c', bashCmd]],
    ];
    for (const [bin, args] of candidates) {
      try {
        await new Promise((resolve, reject) => {
          execFile(bin, args, { detached: true }, (err) => err ? reject(err) : resolve(true));
        });
        return true;
      } catch {}
    }
    throw new Error('No supported Linux terminal found (tried xdg-terminal-exec, gnome-terminal, konsole, xfce4-terminal, alacritty, kitty, x-terminal-emulator, xterm).');
  }
  throw new Error('Terminal integration is not available on this platform.');
});

ipcMain.handle('sessions:openInITerm', async (_e, payload) => {
  if (process.platform !== 'darwin') throw new Error('iTerm is macOS-only.');
  // Dispatch by source (codex vs claude) the same way Terminal does.
  const { bashCmd } = resumeCommandFor(payload);
  const script = [
    'tell application "iTerm"', '  activate',
    '  set newWindow to (create window with default profile)',
    '  tell current session of newWindow', `    write text ${JSON.stringify(bashCmd)}`,
    '  end tell', 'end tell',
  ].join('\n');
  return runOsascript(script);
});

// All three IPCs accept either:
// Returns composite "<source>:<id>" key for IPC payloads { source, id }.
function payloadKey(payload) {
  if (payload && typeof payload === 'object') {
    const { source, id } = payload;
    if (!isValidSessionId(id)) throw new Error('Invalid session id');
    return compositeKey(source, id);
  }
  throw new Error('Invalid favorite/exclude/alias payload');
}

ipcMain.handle('favorites:list', async () => [...favoriteSet]);
ipcMain.handle('favorites:toggle', async (_e, payload) => {
  const key = payloadKey(payload);
  if (favoriteSet.has(key)) favoriteSet.delete(key); else favoriteSet.add(key);
  await saveJsonSet(favoritesPath, favoriteSet);
  return favoriteSet.has(key);
});

ipcMain.handle('excludes:list', async () => [...excludeSet]);
ipcMain.handle('excludes:toggle', async (_e, payload) => {
  const key = payloadKey(payload);
  if (excludeSet.has(key)) excludeSet.delete(key); else excludeSet.add(key);
  await saveJsonSet(excludesPath, excludeSet);
  return excludeSet.has(key);
});

// Session aliases — user-set nicknames that override the auto-derived title.
ipcMain.handle('aliases:get', async () => ({ ...aliasMap }));
ipcMain.handle('aliases:set', async (_e, payload) => {
  if (!payload || typeof payload !== 'object') throw new Error('Invalid alias call');
  const { source, id, alias } = payload;
  if (!isValidSessionId(id)) throw new Error('Invalid session id');
  if (alias != null && typeof alias !== 'string') throw new Error('Invalid alias');
  const key = compositeKey(source, id);
  // Strip control chars / ANSI / bidi BEFORE persisting so the on-disk
  // aliases.json never carries the pathological input — renderer cleans on
  // display too, but defending at the boundary keeps future UI paths safe.
  const sanitized = (alias || '')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')   // OSC
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')             // CSI
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g, '') // C0 + C1 + DEL
    .replace(/[‪-‮⁦-⁩]/g, '');         // bidi overrides
  const trimmed = sanitized.trim();
  if (!trimmed) delete aliasMap[key];
  else aliasMap[key] = trimmed.slice(0, 120);
  await saveAliases();
  return aliasMap[key] || null;
});

ipcMain.handle('config:read', async (_e, opts) => {
  const source = opts?.source;
  console.log(`[config:read] source=${source || 'claude (default)'}`);
  if (source === 'codex') return await readCodexConfig();
  return await readClaudeConfig();
});
ipcMain.handle('usage:summary', async (_e, opts) => await usageSummary(opts?.source));

ipcMain.handle('claude:authStatus', async () => {
  // Normalise to the shared AuthStatus shape (matches Codex's handler below).
  // Whatever fields the CLI emits, the renderer only depends on
  // { loggedIn, email, name?, apiProvider, authMethod?, subscriptionType? }.
  const EMPTY = { loggedIn: false, email: null, name: null, apiProvider: 'anthropic', authMethod: null, subscriptionType: null };
  const raw = await new Promise((resolve) => {
    execFile('claude', ['auth', 'status'], { timeout: 5000 }, (err, stdout) => {
      if (err) return resolve(null);
      try { resolve(JSON.parse(String(stdout).trim())); }
      catch { resolve(null); }
    });
  });
  if (!raw || typeof raw !== 'object') return EMPTY;
  // Tolerate both flat fields (raw.email) and nested (raw.account.email) — the
  // CLI has shipped both shapes over the years.
  const account = raw.account || {};
  return {
    loggedIn: !!(raw.loggedIn || raw.logged_in || account.email || raw.email),
    email: account.email || raw.email || null,
    name: account.name || account.fullName || raw.name || null,
    apiProvider: 'anthropic',
    authMethod: account.authMethod || raw.authMethod || raw.auth_method || null,
    subscriptionType: account.subscriptionType || raw.subscriptionType || raw.subscription_type || null,
  };
});

// Codex stores its identity inside ~/.codex/auth.json. The id_token JWT carries
// the user's email, name, and chatgpt_plan_type — we decode the payload (no
// signature verification needed, this is display-only) to surface them. Plan
// type also lands in every session's rate_limits payload, so we fall back to
// the most recent session if the JWT can't be read.
ipcMain.handle('codex:authStatus', async () => {
  let email = null, name = null, planType = null, loggedIn = false;
  try {
    const raw = await readJsonFileSafe(path.join(CODEX_DIR, 'auth.json'));
    if (raw == null) throw new Error('codex auth.json unreadable');
    const obj = JSON.parse(raw);
    loggedIn = !!(obj && obj.tokens);
    const idToken = obj?.tokens?.id_token;
    if (idToken && typeof idToken === 'string') {
      const parts = idToken.split('.');
      if (parts.length >= 2) {
        // base64url decode
        const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/').padEnd(parts[1].length + (4 - parts[1].length % 4) % 4, '=');
        const payload = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
        email = payload.email || null;
        name = payload.name || null;
        const auth = payload['https://api.openai.com/auth'];
        if (auth && auth.chatgpt_plan_type) planType = auth.chatgpt_plan_type;
      }
    }
  } catch {}
  // Fallback: surface plan_type from the most recently parsed session if the
  // JWT wasn't readable (e.g. permissions issue).
  if (!planType) {
    try {
      const all = await listSessions({ noRefresh: true });
      const latestCodex = all.filter(s => s.source === 'codex' && s.planType).sort((a, b) => (b.mtime || 0) - (a.mtime || 0))[0];
      if (latestCodex && latestCodex.planType) planType = latestCodex.planType;
    } catch {}
  }
  return {
    loggedIn,
    email,
    name,
    apiProvider: 'openai',
    authMethod: 'chatgpt',
    subscriptionType: planType,
  };
});

/* ---------- Real rate limits via Claude Code OAuth probe ---------- */

// Pull the OAuth access token Claude Code stored when the user logged in.
// Prefer the on-disk credentials file (no prompt). Fall back to macOS Keychain
// via `security`, which the OS prompts the user to authorize the first time —
// the renderer warns about that before this is ever called.
async function readClaudeOAuthToken() {
  const fp = path.join(CLAUDE_DIR, '.credentials.json');
  try {
    const raw = await readJsonFileSafe(fp);
    if (raw == null) throw new Error('credentials unreadable');
    const t = pickAccessToken(JSON.parse(raw));
    if (t) return t;
  } catch {}
  if (process.platform === 'darwin') {
    try {
      const out = execFileSync('security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'], { encoding: 'utf8', timeout: 8000 });
      const t = pickAccessToken(JSON.parse(out.trim()));
      if (t) return t;
    } catch {}
  }
  return null;
}

function pickAccessToken(obj) {
  if (!obj || typeof obj !== 'object') return null;
  return obj.claudeAiOauth?.accessToken
    || obj.accessToken
    || obj.access_token
    || obj.oauth?.accessToken
    || null;
}

// Probe Anthropic Messages API with the smallest possible request so we can
// read the `anthropic-ratelimit-unified-*` response headers. The body costs
// ~1 token of the user's 5h budget per call; the renderer rate-limits this.
function probeAnthropicLimits(token) {
  return new Promise((resolve, reject) => {
    const req = net.request({
      method: 'POST',
      url: 'https://api.anthropic.com/v1/messages',
    });
    // Wall-clock timeout so a hanging socket can't pin the Usage view in a
    // permanent "loading" state. net.request has no built-in timeout; cap
    // at 15s (Anthropic normally responds in <1s) and abort cleanly.
    const probeTimer = setTimeout(() => {
      try { req.abort(); } catch {}
      reject(new Error('Anthropic probe timed out after 15s'));
    }, 15000);
    const clearProbeTimer = () => { clearTimeout(probeTimer); };
    req.setHeader('content-type', 'application/json');
    req.setHeader('anthropic-version', '2023-06-01');
    req.setHeader('anthropic-beta', 'oauth-2025-04-20');
    req.setHeader('authorization', 'Bearer ' + token);

    // The Messages API response body is normally < 1 KB. Cap accumulation at
    // 512 KB defensively — a hostile MITM / proxy could otherwise stream a
    // huge body forever and OOM the main process.
    const BODY_CAP = 512 * 1024;
    let body = '';
    let bodyTruncated = false;
    req.on('response', (res) => {
      const headers = res.headers || {};
      const get = (k) => {
        const v = headers[k] ?? headers[k.toLowerCase()];
        return Array.isArray(v) ? v[0] : v;
      };
      // Surface every rate-limit-ish header for debugging, not just unified.
      const headersDump = {};
      for (const [k, v] of Object.entries(headers)) {
        const lk = k.toLowerCase();
        if (lk.includes('ratelimit') || lk === 'anthropic-request-id' || lk === 'request-id' || lk === 'content-type' || lk === 'retry-after') {
          headersDump[lk] = Array.isArray(v) ? v[0] : v;
        }
      }
      res.on('data', (chunk) => {
        if (bodyTruncated) return;
        const s = chunk.toString('utf8');
        if (body.length + s.length > BODY_CAP) {
          body += s.slice(0, BODY_CAP - body.length);
          bodyTruncated = true;
          try { req.abort(); } catch {}
        } else {
          body += s;
        }
      });
      // resolve() may be called by either `end` (normal) or `aborted` (we
      // hit the body cap and called req.abort()). Both paths have valid
      // headers — that's the only thing this probe actually consumes — so
      // surface them either way.
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearProbeTimer();
        const win = (prefix) => ({
          utilization: floatOrNull(get(`anthropic-ratelimit-unified-${prefix}-utilization`)),
          status: get(`anthropic-ratelimit-unified-${prefix}-status`) || null,
          reset: numOrNull(get(`anthropic-ratelimit-unified-${prefix}-reset`)),
        });
        resolve({
          status: res.statusCode,
          body,
          headersDump,
          truncated: bodyTruncated,
          limits: {
            status: get('anthropic-ratelimit-unified-status') || null,
            representativeClaim: get('anthropic-ratelimit-unified-representative-claim') || null,
            fiveHour: win('5h'),
            weekly: win('7d'),
            overage: win('overage'),
          },
        });
      };
      res.on('end', finish);
      res.on('aborted', finish);
      res.on('close', finish);
    });
    req.on('error', (e) => {
      clearProbeTimer();
      // If the abort came from us hitting the cap, treat it as a clean
      // finish — headers are what we care about, and they're already on the
      // response object via the `response` handler above.
      if (bodyTruncated) return;
      reject(e);
    });
    req.on('abort', () => {
      // Same as above: only an aborts the cap triggered should surface as
      // a normal completion; otherwise let error/end fire as they will.
    });
    req.write(JSON.stringify({
      model: 'claude-haiku-4-5',
      max_tokens: 1,
      messages: [{ role: 'user', content: 'hi' }],
    }));
    req.end();
  });
}

function numOrNull(v) {
  if (v == null) return null;
  const n = parseInt(String(v), 10);
  return Number.isFinite(n) ? n : null;
}

function floatOrNull(v) {
  if (v == null) return null;
  const n = parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
}

// Codex rate-limits probe via `codex app-server --listen stdio://`.
// Approach borrowed from github.com/testpassword/CodexLimitsWidget:
//   1. Spawn the codex binary in app-server mode (JSON-RPC over stdio).
//   2. Send `initialize` (id=1) with experimentalApi capability.
//   3. Send `account/rateLimits/read` (id=2).
//   4. Parse the response, normalize to our RateLimits shape (5h + weekly),
//      kill the subprocess.
// Returns the same envelope shape probeAnthropicLimits produces so the
// rateLimits:get dispatcher only differs by which prober runs.
function probeCodexLimits() {
  return new Promise((resolve, reject) => {
    const { spawn } = require('child_process');
    let proc;
    try {
      proc = spawn('codex', ['app-server', '--listen', 'stdio://'], { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      return reject(new Error('codex binary not found in PATH'));
    }

    // Bound the stdout/stderr accumulators — a runaway codex app-server (bug
    // or fork) would otherwise stream into `buffer`/`stderr` until the main
    // process OOMs. 4 MB / 1 MB is plenty for the JSON-RPC traffic we expect.
    const STDOUT_CAP = 4 * 1024 * 1024;
    const STDERR_CAP = 1 * 1024 * 1024;
    let buffer = '';
    const pending = new Map();
    let stderrTotal = 0;
    const stderr = [];

    proc.stdout.on('data', (chunk) => {
      const s = chunk.toString('utf8');
      buffer += s;
      // Cap between line boundaries: drop the earliest text if a line never
      // arrives within the budget. Normal protocol traffic stays line-bounded
      // so this only matters for misbehaving servers.
      if (buffer.length > STDOUT_CAP) {
        buffer = buffer.slice(buffer.length - STDOUT_CAP);
        const firstNl = buffer.indexOf('\n');
        if (firstNl >= 0) buffer = buffer.slice(firstNl + 1);
      }
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id != null && pending.has(msg.id)) {
          const cb = pending.get(msg.id);
          pending.delete(msg.id);
          cb(msg);
        }
      }
    });
    proc.stderr.on('data', (c) => {
      if (stderrTotal >= STDERR_CAP) return;
      const s = c.toString('utf8');
      stderrTotal += s.length;
      stderr.push(stderrTotal > STDERR_CAP ? s.slice(0, STDERR_CAP - (stderrTotal - s.length)) : s);
    });

    const send = (id, method, params) => {
      proc.stdin.write(JSON.stringify({ id, method, params: params ?? null }) + '\n');
    };
    const waitFor = (id, ms = 15000) => new Promise((res, rej) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        rej(new Error(`timeout waiting for id=${id}`));
      }, ms);
      pending.set(id, (msg) => {
        clearTimeout(timer);
        if (msg.error) rej(new Error(JSON.stringify(msg.error)));
        else res(msg.result);
      });
    });

    proc.on('error', (e) => reject(new Error('failed to spawn codex: ' + e.message)));
    // If the app-server quits before we get a response, fail the probe
    // immediately instead of waiting for the 15s waitFor() timeout to fire.
    let procExited = false;
    proc.on('exit', (code, signal) => {
      procExited = true;
      // Reject any in-flight waiters; resolve path will have already
      // killed the proc and called resolve(), in which case `pending` is empty.
      for (const cb of pending.values()) {
        cb({ error: { message: `codex app-server exited (code=${code}, signal=${signal})` } });
      }
      pending.clear();
    });
    void procExited;

    (async () => {
      try {
        send(1, 'initialize', {
          clientInfo: { name: 'claude-lens', version: '0.1.0' },
          capabilities: { experimentalApi: true },
        });
        await waitFor(1);
        send(2, 'account/rateLimits/read', null);
        const result = await waitFor(2);
        try { proc.kill(); } catch {}
        resolve({ status: 200, body: '', headersDump: { stderr: stderr.join('').slice(0, 500) }, limits: normalizeCodexLimits(result) });
      } catch (e) {
        try { proc.kill(); } catch {}
        reject(e);
      }
    })();
  });
}

// Translate Codex's `rateLimitsByLimitId.codex` shape into our existing
// RateLimits envelope so the renderer / Sidebar quota card don't care which
// provider produced it.
function normalizeCodexLimits(raw) {
  const bucket = (raw && raw.rateLimitsByLimitId && raw.rateLimitsByLimitId.codex) || (raw && raw.rateLimits) || null;
  if (!bucket) {
    return { status: null, representativeClaim: null, fiveHour: emptyWin(), weekly: emptyWin(), overage: emptyWin() };
  }
  // Pick which window is the 5h vs weekly by windowDurationMins (300 / 10080).
  const windowByMins = { 300: null, 10080: null };
  for (const w of [bucket.primary, bucket.secondary]) {
    if (w && windowByMins.hasOwnProperty(w.windowDurationMins)) windowByMins[w.windowDurationMins] = w;
  }
  // Normalise resetsAt to Unix seconds — renderer's resetInLabel multiplies by
  // 1000 expecting a number. Codex sometimes returns an ISO string; coerce so
  // the label doesn't go null when the underlying field is just a different
  // format.
  const toUnixSeconds = (v) => {
    if (typeof v === 'number' && Number.isFinite(v)) return Math.floor(v);
    if (typeof v === 'string') {
      const ms = Date.parse(v);
      if (Number.isFinite(ms)) return Math.floor(ms / 1000);
    }
    return null;
  };
  const toWin = (w) => w ? {
    utilization: w.usedPercent != null ? w.usedPercent / 100 : null,
    status: 'allowed',
    reset: toUnixSeconds(w.resetsAt),
  } : emptyWin();
  return {
    status: bucket.rateLimitReachedType ? 'limited' : 'allowed',
    representativeClaim: 'five_hour',
    fiveHour: toWin(windowByMins[300]),
    weekly: toWin(windowByMins[10080]),
    overage: emptyWin(),
  };
}
function emptyWin() { return { utilization: null, status: null, reset: null }; }

// In-memory cache. 5 min default — short enough to feel live, long enough that
// 1-token probes don't add up. Renderer can force a refetch.
// Keyed by source so claude + codex caches don't trample each other.
const rateLimitsCacheBySource = new Map(); // source → { fetchedAt, data }
const RATE_LIMITS_TTL = 5 * 60 * 1000;

// Per-source rate-limits provider registry. Dispatcher reads from here so
// adding a new AI tool is one entry, not new branches in the IPC handler.
const RATE_LIMIT_PROVIDERS = {
  claude: {
    needsToken: true,
    probe: async () => {
      const token = await readClaudeOAuthToken();
      if (!token) return { ok: false, error: 'no-token', message: 'Sign in via `claude` CLI first' };
      const result = await probeAnthropicLimits(token);
      const bodyPreview = String(result.body || '').slice(0, 4000);
      if (result.status === 401 || result.status === 403) {
        return { ok: false, error: 'unauthorized', status: result.status, message: 'Token expired — re-login Claude Code', debug: { status: result.status, headers: result.headersDump, body: bodyPreview } };
      }
      const haveAny = result.limits.fiveHour.utilization != null || result.limits.weekly.utilization != null;
      if (!haveAny) {
        return { ok: false, error: 'no-headers', status: result.status, message: 'API did not return rate limit headers', debug: { status: result.status, headers: result.headersDump, body: bodyPreview } };
      }
      return { ok: true, limits: result.limits, debug: { status: result.status, headers: result.headersDump, body: bodyPreview } };
    },
  },
  codex: {
    needsToken: false,
    probe: async () => {
      try {
        const result = await probeCodexLimits();
        const haveAny = result.limits.fiveHour.utilization != null || result.limits.weekly.utilization != null;
        if (!haveAny) {
          return { ok: false, error: 'no-data', message: 'codex app-server returned no rate limits' };
        }
        return { ok: true, limits: result.limits, debug: result.headersDump };
      } catch (e) {
        return { ok: false, error: 'codex-probe-failed', message: String(e?.message || e) };
      }
    },
  },
};

ipcMain.handle('rateLimits:get', async (_e, { force = false, source = 'claude' } = {}) => {
  // Defense-in-depth consent gate: Claude probes hit Anthropic's API with the
  // user's OAuth token. Renderer enforces consent before calling, but main also
  // checks the persisted appPrefs flag so a compromised renderer can't skip it.
  // Codex probe is a local subprocess (no network) — no gate.
  if (source !== 'codex' && appPrefs.rateLimitsConsent !== 'granted') {
    return { ok: false, error: 'no-consent', message: 'Rate limits consent not granted' };
  }
  const provider = RATE_LIMIT_PROVIDERS[source] || RATE_LIMIT_PROVIDERS.claude;
  const cached = rateLimitsCacheBySource.get(source);
  if (!force && cached && Date.now() - cached.fetchedAt < RATE_LIMITS_TTL) {
    return { ok: true, cached: true, ...cached.data };
  }
  try {
    const res = await provider.probe();
    if (!res.ok) return res;
    const data = { limits: res.limits, fetchedAt: Date.now() };
    rateLimitsCacheBySource.set(source, { fetchedAt: Date.now(), data });
    return { ok: true, cached: false, ...data, debug: res.debug };
  } catch (e) {
    return { ok: false, error: 'network', message: String(e?.message || e) };
  }
});

// Quick credential discovery check — used by the renderer's consent flow to
// know whether we'll hit the keychain prompt path before asking the user.
ipcMain.handle('rateLimits:credentialsLocation', async () => {
  const fp = path.join(CLAUDE_DIR, '.credentials.json');
  try {
    // Use lstat — readJsonFileSafe (the actual reader) rejects symlinks, so
    // claiming `source: 'file'` here when the path is a symlink would lie to
    // the consent UI ("we'll just read the file, no Keychain") and then fail.
    const st = await fsp.lstat(fp);
    if (!st.isSymbolicLink() && st.isFile()) return { source: 'file', path: fp };
  } catch {}
  if (process.platform === 'darwin') return { source: 'keychain' };
  return { source: 'none' };
});
ipcMain.handle('config:openFile', async (_e, filePath) => {
  const real = await ensureInsideAny([CLAUDE_DIR, CODEX_DIR], filePath);
  shell.openPath(real);
});

function shellQuote(s) {
  if (s === undefined || s === null) return "''";
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

app.on('before-quit', () => { isQuitting = true; });

// File watcher on ~/.claude/projects was disabled — recursive fs.watch on macOS
// blows up under heavy session-write traffic and can OOM the main process.
// Manual ⌘R rescan is the supported pattern; revisit with chokidar + per-project debounce later.

// Override the productName in dev too, otherwise macOS Dock / Cmd-Tab / Activity
// Monitor / Windows taskbar all show "Electron" instead of "Lens". Packaged
// builds get this from package.json.build.productName; dev needs this override.
app.setName('Lens');
if (process.platform === 'win32') {
  // Without this, Windows groups our taskbar entry under "Electron" instead of
  // creating a discrete "Lens" entry with its own icon and pinned-state.
  app.setAppUserModelId('io.maliming.lens');
}
// Surface the tagline in the system "About Lens" dialog (macOS Lens menu →
// About; Linux/Windows variant if invoked). The Dock itself only shows the
// app name — there's no first-class macOS UI for a tagline.
const TAGLINE = 'Search, resume, and understand your AI coding sessions';
if (app.setAboutPanelOptions) {
  app.setAboutPanelOptions({
    applicationName: 'Lens',
    applicationVersion: app.getVersion(),
    version: '',
    copyright: 'Copyright © 2026 maliming',
    credits: TAGLINE,
  });
}

// Single-instance lock: the atomic-write queue is per-process. Two Lens
// instances opened simultaneously (double-click after a hide, login items
// + manual launch, etc.) would race on favorites/aliases/sessions-cache
// writes and could lose updates. Lock the userData dir to one process;
// new launches focus the existing window instead of starting a fresh one.
//
// All startup wiring (whenReady, window-all-closed, activate) goes inside the
// `else` branch — a second instance must NOT register them; otherwise the
// briefly-alive process can fire createWindow/createTray before app.quit()
// settles, racing with the primary.
const _gotLock = app.requestSingleInstanceLock();
if (!_gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    showOrCreateWindow();
  });

  app.whenReady().then(async () => {
    console.log(`[startup] Lens ${app.getVersion()} on ${process.platform} (${process.arch}); electron ${process.versions.electron}, node ${process.versions.node}`);
    console.log(`[startup] userData = ${app.getPath('userData')}`);
    // Windows/Linux ship a default File/Edit/View/Window/Help menu bar that adds
    // nothing for this app — strip it. On macOS the menu bar is a system-level
    // affordance, leave the default in place there.
    if (process.platform !== 'darwin') {
      Menu.setApplicationMenu(null);
    }
    await loadPersistedSets();
    console.log(`[startup] persisted sets loaded. favorites=${favoriteSet.size}, excludes=${excludeSet.size}, aliases=${Object.keys(aliasMap).length}, cachedSessions=${cachedSessions ? cachedSessions.length : 0}`);
    createWindow();
    createTray();
    console.log(`[startup] window + tray ready; prefs=${JSON.stringify(appPrefs)}`);
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('activate', () => {
    showOrCreateWindow();
  });
}
