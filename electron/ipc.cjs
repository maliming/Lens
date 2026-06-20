// IPC handler registry.
//
// All `ipcMain.handle(...)` registrations live here so the IPC contract is
// auditable in one place — preload.cjs declares the renderer-visible API
// surface, this file implements the main-side handlers, and the two must
// agree (typed in src/types.ts on the renderer side).
//
// `registerIpc({...deps})` is called once from main.cjs after the per-source
// parsers, the userdata store, the prefs store, and the sessions cache have
// been initialised. Deps that are *re-assignable* (mainWindow can be
// destroyed and recreated; tray can be toggled on/off; appPrefs mutates in
// place) are passed as getter callbacks so handlers always read the latest
// value rather than capturing a stale closure.
//
// New IPCs follow the `feature:action` channel-name convention. Every
// handler that accepts a path from the renderer must route it through
// `ensureInside` / `ensureInsideAny` first — paths that look absolute but
// resolve outside `~/.claude` / `~/.codex` get rejected at the boundary.

const { ipcMain, app, shell, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const { execFile } = require('child_process');

const {
  CLAUDE_DIR, PROJECTS_DIR, CODEX_DIR, CODEX_SESSIONS_DIR,
} = require('./lib/paths.cjs');
const { readJsonFileSafe, saveJsonSet } = require('./lib/json-io.cjs');
const { isInsideBase, ensureInsideAny } = require('./lib/fs-safety.cjs');
const { compositeKey } = require('./parsers/shared.cjs');
const { detectTerminals, detectAiTools } = require('./lib/system-caps.cjs');
const {
  shellQuote, isValidSessionId, runOsascript,
  resumeCommandFor, payloadKey,
} = require('./lib/shell.cjs');
const { deepSearch } = require('./search.cjs');
const { readClaudeConfig, readCodexConfig } = require('./config.cjs');
const { readClaudeOAuthToken, probeAnthropicLimits } = require('./auth/claude.cjs');
const { applyLaunchAtLogin } = require('./lib/prefs.cjs');

// Deep search input caps. Keeps a misbehaving / hostile renderer from forcing
// a many-second whole-corpus scan; a sane human query maxes out far below
// these numbers.
const DEEP_SEARCH_QUERY_MAX_LEN = 512;
const DEEP_SEARCH_QUERY_MAX_TERMS = 32;

// Rate-limits cache. 5 min TTL — short enough to feel live, long enough that
// 1-token probes don't add up. Keyed by source so claude + codex don't
// trample each other.
const RATE_LIMITS_TTL = 5 * 60 * 1000;

function registerIpc(deps) {
  const {
    listSessions,
    claude, codex,
    userData, prefsStore,
    usageSummary,
    probeCodexLimits,
    titleBarColors,
    getMainWindow,
    createTray, destroyTray,
  } = deps;

  const appPrefs = prefsStore.get();
  const saveAppPrefs = () => prefsStore.save();
  const favoriteSet = userData.favoritesSet;
  const excludeSet  = userData.excludesSet;
  const aliasMap    = userData.aliasesMap;
  const favoritesPath = userData.favoritesPath;
  const excludesPath  = userData.excludesPath;

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
      return await codex.getCodexSessionMessages(real);
    }
    return await claude.getSessionMessages(real);
  });

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

  // Source resolution gate for resume/copy IPC. Combines:
  //   • explicit `source` payload (preferred when present);
  //   • `filePath` containment check via `ensureInsideAny` (only path-shape
  //     gate the renderer can satisfy);
  //   • cross-verification: when BOTH `source` and `filePath` are present,
  //     the realpath-derived source MUST match the explicit one. A
  //     mismatch means the renderer is either confused or compromised —
  //     refuse rather than guess.
  //
  // History: the first cut returned `source` immediately when present,
  // skipping containment entirely. That left a window where a renderer
  // could send `source: 'claude'` paired with a `filePath` pointing at
  // ~/Library/something to slip through subsequent file operations. The
  // fix is to *always* verify filePath when provided.
  async function resolveSession(payload) {
    const { id, filePath, source } = payload || {};
    if (!isValidSessionId(id)) throw new Error('Invalid session id');
    const explicit = (source === 'claude' || source === 'codex') ? source : null;
    if (!explicit && typeof filePath !== 'string') throw new Error('Missing source');
    if (typeof filePath !== 'string') return explicit;
    // ensureInsideAny realpaths the input and confirms it lies under one
    // of the allowed bases. A path outside both bases throws.
    const real = await ensureInsideAny([PROJECTS_DIR, CODEX_SESSIONS_DIR], filePath);
    let realCodexBase = CODEX_SESSIONS_DIR;
    try { realCodexBase = await fsp.realpath(CODEX_SESSIONS_DIR); } catch {}
    const fromPath = isInsideBase(real, realCodexBase) ? 'codex' : 'claude';
    if (explicit && explicit !== fromPath) {
      // Explicit source disagrees with the containment-derived source.
      // Either bug or attack — refuse loudly, never silently downgrade.
      throw new Error(`Source mismatch: payload says ${explicit}, filePath resolves to ${fromPath}`);
    }
    return fromPath;
  }

  // Hardened resolver for handlers that need both the source AND a trusted
  // cwd (resume/copy/terminal/iTerm/VS Code). Builds on `resolveSession`,
  // then looks the session up in the main-side list and returns its cwd
  // — never the renderer's. This closes the gap where a renderer could
  // send a valid {id, source, filePath} but pair it with an attacker-
  // controlled cwd (e.g. `/etc`, or a path it knows the user will
  // accidentally `cd` to).
  //
  // Resume / Open uses `projectCwd` (first cwd recorded in the JSONL — where
  // the user launched the session), NOT `lastCwd`. lastCwd reflects whatever
  // the most recent tool happened to `cd` into (build output, vendored
  // module, etc.), which is rarely where the user wants to resume. The
  // string is validated for absolute-path shape + NUL-byte rejection here so
  // downstream callers can quote/run it with one less worry.
  async function resolveSessionWithCwd(payload) {
    const source = await resolveSession(payload);
    const sessions = await listSessions({});
    const sess = sessions.find(s => s.source === source && s.id === payload.id);
    if (!sess) throw new Error('Unknown session');
    // Defense-in-depth: if the renderer supplied `filePath`, require it to
    // match the session row's filePath. Realpath both sides so a symlinked
    // base directory survives the compare. Without this, a renderer can
    // pair a valid {source, id} with an unrelated filePath that survived
    // containment but doesn't actually belong to the session — never a
    // real usage, always a sign of bug or attack. resolveSession's source
    // check already covers most of this, but cross-verifying filePath
    // closes the last seam without measurable cost (one realpath pair).
    if (typeof payload.filePath === 'string' && typeof sess.filePath === 'string') {
      try {
        const a = await fsp.realpath(payload.filePath);
        const b = await fsp.realpath(sess.filePath);
        if (a !== b) throw new Error('filePath does not match session');
      } catch (e) {
        // realpath fail = file deleted/moved; treat as inconsistency.
        if (e.message === 'filePath does not match session') throw e;
        throw new Error('filePath does not match session');
      }
    }
    // Use `projectCwd` (the cwd from the FIRST line of the JSONL — i.e.
    // where the user started the session) rather than `lastCwd`. The
    // parser records `lastCwd` from the JSONL's most recent cwd field,
    // which any tool run that temporarily `cd`'d into a subdir (build
    // output, vendored dependency, etc.) overwrites. Resuming into that
    // tool-incidental directory is jarring: the user typed `claude` in
    // their project root, expects to land back there. `decodedCwd` is
    // the encoded-project-dir reconstruction; final fallback.
    const cwd = sess.projectCwd || sess.decodedCwd;
    if (typeof cwd !== 'string' || cwd.length === 0 || cwd.length > 4096) {
      throw new Error('Session has no usable cwd');
    }
    if (cwd.includes('\0')) throw new Error('Invalid cwd');
    const isPosixAbs = cwd.startsWith('/');
    const isWindowsAbs = /^[A-Za-z]:[\\/]/.test(cwd);
    if (!isPosixAbs && !isWindowsAbs) throw new Error('Invalid cwd');
    return { source, sess, cwd };
  }

  ipcMain.handle('sessions:copyResumeCommand', async (_e, payload) => {
    const { id } = payload || {};
    const { source, cwd } = await resolveSessionWithCwd(payload);
    const cmd = source === 'codex'
      ? `cd ${shellQuote(cwd)} && codex resume ${shellQuote(id)}`
      : `cd ${shellQuote(cwd)} && claude --resume ${shellQuote(id)}`;
    clipboard.writeText(cmd);
    return cmd;
  });

  ipcMain.handle('sessions:revealInFinder', async (_e, filePath) => {
    const real = await ensureInsideAny([PROJECTS_DIR, CLAUDE_DIR, CODEX_DIR], filePath);
    shell.showItemInFolder(real);
  });

  // Open the active AI tool's data root in Finder. Avoids the renderer needing
  // to know absolute home paths; main owns CLAUDE_DIR / CODEX_DIR already.
  ipcMain.handle('app:revealSourceDir', async (_e, source) => {
    // Match the pathHint the UI advertises (Sidebar / Settings show
    // `~/.codex/sessions` for Codex, `~/.claude` for Claude). Opening the
    // parent CODEX_DIR confused users — the button label said one thing and
    // the OS opened the level above.
    const target = source === 'codex' ? CODEX_SESSIONS_DIR : CLAUDE_DIR;
    shell.openPath(target);
  });

  ipcMain.handle('sessions:openInVSCode', async (_e, payload) => {
    // Renderer sends `{ source, id, filePath }` — same envelope as resume/
    // copy/terminal. cwd is sourced from main-side session metadata via
    // `resolveSessionWithCwd`; the renderer never gets to choose an
    // arbitrary directory.
    const { cwd } = await resolveSessionWithCwd(payload);
    const isWindowsAbs = /^[A-Za-z]:[\\/]/.test(cwd);
    // Defense in depth: even main-sourced cwd must exist as a non-symlink
    // directory. A user may have moved/deleted the project after the session
    // was recorded, or the cwd may point at a network mount that disappeared.
    try {
      const st = await fsp.lstat(cwd);
      if (st.isSymbolicLink() || !st.isDirectory()) throw new Error('Not a directory');
    } catch {
      throw new Error('Project directory is no longer accessible');
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

  // Reveal the Electron userData directory — the same folder that holds
  // favorites.json / excludes.json / aliases.json / sessions-cache.json /
  // app-prefs.json plus the bundled Chromium profile (cookies, Cache,
  // IndexedDB). Surfaced from Settings so users can back up or clear local
  // state without hunting for the platform-specific path.
  ipcMain.handle('app:openUserDataFolder', async () => {
    try {
      const dir = app.getPath('userData');
      fs.mkdirSync(dir, { recursive: true });
      await shell.openPath(dir);
      return dir;
    } catch (e) {
      throw new Error('Failed to open app data folder: ' + e.message);
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
    const win = getMainWindow();
    if (process.platform !== 'win32' || !win || win.isDestroyed()) return;
    const colors = theme === 'dark' ? titleBarColors.dark : titleBarColors.light;
    try { win.setTitleBarOverlay(colors); } catch {}
  });

  ipcMain.handle('sessions:openInTerminal', async (_e, payload) => {
    // resolveSessionWithCwd resolves source via containment+cross-check AND
    // sources the cwd from main-side session metadata. The renderer-provided
    // `payload.cwd` is intentionally ignored — passing it through `cwd`
    // here means resumeCommandFor never sees an attacker-controlled path.
    const { source, cwd } = await resolveSessionWithCwd(payload);
    const { dir, bashCmd, cli, args } = resumeCommandFor({ ...payload, source, cwd });

    if (process.platform === 'darwin') {
      const script = `tell application "Terminal"\nactivate\ndo script ${JSON.stringify(bashCmd)}\nend tell`;
      return runOsascript(script);
    }
    if (process.platform === 'win32') {
      // `id` is already regex-validated. `dir` is renderer-supplied so we never
      // interpolate it into a shell command line — it goes only through
      // execFile's `cwd:` option so Windows starts the child in the right
      // directory without parsing the path through cmd.exe. We also refuse
      // `dir` values that start with `-` to defeat argv flag smuggling for
      // tools that take positional path arguments (wt.exe -d <dir>).
      if (typeof dir !== 'string' || dir.length === 0) throw new Error('Invalid cwd');
      const safeDir = dir;
      const dirLooksLikeFlag = safeDir.startsWith('-') || safeDir.startsWith('/');
      const terms = detectTerminals();
      const opts = { windowsHide: false, cwd: safeDir };
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
      for (const [bin, args2] of candidates) {
        try {
          await new Promise((resolve, reject) => {
            execFile(bin, args2, { detached: true }, (err) => err ? reject(err) : resolve(true));
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
    // Mirror Terminal: containment + main-side cwd, renderer cwd ignored.
    const { source, cwd } = await resolveSessionWithCwd(payload);
    const { bashCmd } = resumeCommandFor({ ...payload, source, cwd });
    const script = [
      'tell application "iTerm"', '  activate',
      '  set newWindow to (create window with default profile)',
      '  tell current session of newWindow', `    write text ${JSON.stringify(bashCmd)}`,
      '  end tell', 'end tell',
    ].join('\n');
    return runOsascript(script);
  });

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
    await userData.saveAliases();
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
      loggedIn, email, name,
      apiProvider: 'openai', authMethod: 'chatgpt', subscriptionType: planType,
    };
  });

  // Per-source rate-limits provider registry. Dispatcher reads from here so
  // adding a new AI tool is one entry, not new branches in the IPC handler.
  const rateLimitsCacheBySource = new Map();
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
}

module.exports = { registerIpc };
