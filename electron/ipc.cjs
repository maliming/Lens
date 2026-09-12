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
  isValidSessionId, runOsascript,
  resumeCommandFor, payloadKey,
} = require('./lib/shell.cjs');
const { deepSearch } = require('./search.cjs');
const { readClaudeConfig, readCodexConfig } = require('./config.cjs');
const { applyLaunchAtLogin, isSourceOrder } = require('./lib/prefs.cjs');
const { toRendererSessionsWithRevision } = require('./lib/session-data.cjs');

// Deep search input caps. Keeps a misbehaving / hostile renderer from forcing
// a many-second whole-corpus scan; a sane human query maxes out far below
// these numbers.
const DEEP_SEARCH_QUERY_MAX_LEN = 512;
const DEEP_SEARCH_QUERY_MAX_TERMS = 32;

function registerIpc(deps) {
  const {
    pty,
    listSessions,
    markSessionsDelivered,
    refreshSessionsInBackground,
    claude, codex,
    userData, prefsStore,
    usageSummary,
    rateLimits, trayQuota,
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

  // Embedded-terminal handlers. They are built in pty.cjs (spawn, containment,
  // process lifecycle) but registered here so this file stays the single place
  // the renderer-reachable IPC surface can be audited.
  for (const [channel, handler] of Object.entries(pty.handlers)) {
    ipcMain.handle(channel, handler);
  }

  ipcMain.handle('sessions:list', async (_e, opts) => {
    const source = opts?.source === 'claude' || opts?.source === 'codex' ? opts.source : null;
    const sessions = await listSessions({ force: opts?.force === true, source });
    if (source) {
      const projected = toRendererSessionsWithRevision(sessions, source);
      markSessionsDelivered?.(source, projected.revision, projected.sessions.length);
      return projected.sessions;
    }
    const projected = ['claude', 'codex'].map(sessionSource => {
      const result = toRendererSessionsWithRevision(sessions, sessionSource);
      markSessionsDelivered?.(sessionSource, result.revision, result.sessions.length);
      return result.sessions;
    });
    return projected.flat().sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
  });

  ipcMain.handle('sessions:refresh', async (_e, source) => {
    if (source !== 'claude' && source !== 'codex') throw new Error('Invalid session source');
    refreshSessionsInBackground(source).catch(error => {
      console.error('session refresh failed', source, error);
    });
    return true;
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

  // Index of subagent / workflow transcripts spawned by a parent session, for
  // the detail view's inline-expand feature. Same path gate as sessions:get;
  // the agent transcript files it points at all live under PROJECTS_DIR, so the
  // renderer loads each one back through sessions:get. Codex has no subagent
  // tree, so it returns empty.
  // Cheap change check. The embedded terminal drives transcript reloads, but a
  // TUI redraws continuously even when idle — using "the terminal produced
  // output" as the trigger meant re-reading the whole JSONL every few seconds
  // forever. A stat costs microseconds and answers the only question that
  // matters: did the file actually grow?
  ipcMain.handle('sessions:stat', async (_e, filePath) => {
    try {
      const real = await ensureInsideAny([PROJECTS_DIR, CODEX_SESSIONS_DIR], filePath);
      const st = await fsp.stat(real);
      return { ok: true, mtime: st.mtimeMs, size: st.size };
    } catch {
      return { ok: false };
    }
  });

  ipcMain.handle('sessions:subagents', async (_e, filePath) => {
    const empty = { taskAgents: [], workflowRuns: [] };
    if (typeof filePath !== 'string') return empty;
    let real;
    try { real = await ensureInsideAny([PROJECTS_DIR, CODEX_SESSIONS_DIR], filePath); }
    catch { return empty; }
    if (!real.endsWith('.jsonl')) return empty;
    let realCodexBase = CODEX_SESSIONS_DIR;
    try { realCodexBase = await fsp.realpath(CODEX_SESSIONS_DIR); } catch {}
    if (isInsideBase(real, realCodexBase)) return empty;
    // Non-fatal: a scan error must never reject the detail-pane load.
    try { return await claude.getSubagents(real); }
    catch { return empty; }
  });

  // One whole-corpus walk at a time. A new query aborts the in-flight walk
  // instead of queueing behind it: the renderer has already dropped that
  // result, so finishing it would be pure disk IO that delays the query the
  // user is actually waiting for. The entry is registered synchronously so a
  // third call arriving while the second is still waiting for the first to
  // unwind aborts the second, not the already-aborted first.
  let _deepSearchInflight = null;
  function startDeepSearch(query, source) {
    const prev = _deepSearchInflight;
    const controller = new AbortController();
    const promise = (async () => {
      if (prev) {
        prev.controller.abort();
        try { await prev.promise; } catch {}
      }
      return deepSearch(query, source, { signal: controller.signal });
    })();
    const entry = { controller, promise };
    _deepSearchInflight = entry;
    promise.catch(() => {}).finally(() => {
      if (_deepSearchInflight === entry) _deepSearchInflight = null;
    });
    return entry;
  }
  ipcMain.handle('sessions:deepSearch', async (_e, payload) => {
    const query = payload?.query;
    if (typeof query !== 'string') return [];
    if (query.length === 0 || query.length > DEEP_SEARCH_QUERY_MAX_LEN) return [];
    if ((query.match(/\S+/g) || []).length > DEEP_SEARCH_QUERY_MAX_TERMS) return [];
    const { controller, promise } = startDeepSearch(query, payload?.source);
    try { return await promise; }
    catch (e) {
      // The renderer's stale guard discards a superseded result anyway; an
      // empty array keeps the channel's return shape for the abort case.
      if (controller.signal.aborted) return [];
      throw e;
    }
  });
  // Explicit stop from the Search page (Stop button, Esc, source switch).
  // Waits for the walk to unwind so a search issued right after starts on
  // an idle disk. Resolves false when nothing was running.
  ipcMain.handle('sessions:deepSearchCancel', async () => {
    const cur = _deepSearchInflight;
    if (!cur) return false;
    cur.controller.abort();
    try { await cur.promise; } catch {}
    return true;
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
    const sessions = await listSessions({ noRefresh: true, source });
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
    const { source, cwd } = await resolveSessionWithCwd(payload);
    // Same builder the launchers use. A pasted command runs in a shell Lens
    // never spawned — the "externally launched terminal" case RESUME_ENV is
    // there for — so a hand-rolled string here would silently drop that
    // declaration and copy would resume differently from the buttons.
    const { bashCmd } = resumeCommandFor({ ...payload, source, cwd });
    clipboard.writeText(bashCmd);
    return bashCmd;
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
    // Which providers can yield a quota number here. Settings uses it to decide
    // whether the menu-bar rows are worth showing at all, and reads it from the
    // same service the poller does so the two never disagree.
    quotaSources: rateLimits.availableSources(),
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
  // favorites.json / excludes.json / aliases.json / per-source session caches /
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
    // Granting consent is what unlocks the Claude half of the menu-bar title;
    // revoking it should drop that half right away rather than at the next tick.
    trayQuota.sync();
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
    if (typeof patch.menuBarQuota === 'boolean') appPrefs.menuBarQuota = patch.menuBarQuota;
    if (isSourceOrder(patch.menuBarQuotaOrder)) appPrefs.menuBarQuotaOrder = patch.menuBarQuotaOrder.slice();
    await saveAppPrefs();
    // Apply side-effects immediately.
    if (prev.showTrayIcon !== appPrefs.showTrayIcon) {
      if (appPrefs.showTrayIcon) createTray(); else destroyTray();
    }
    if (prev.launchAtLogin !== appPrefs.launchAtLogin) {
      applyLaunchAtLogin(appPrefs.launchAtLogin);
    }
    // Runs after the createTray/destroyTray above: turning the tray back on
    // hands the poller a brand-new Tray to paint, and turning it off leaves it
    // with none, so the title state has to be re-derived either way.
    if (prev.menuBarQuota !== appPrefs.menuBarQuota
      || prev.showTrayIcon !== appPrefs.showTrayIcon
      || String(prev.menuBarQuotaOrder) !== String(appPrefs.menuBarQuotaOrder)) {
      trayQuota.sync();
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
    const { dir, bashCmd, cmdCmd, psCmd } = resumeCommandFor({ ...payload, source, cwd });

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
          ? [absCmd, '/K', cmdCmd]
          : ['-d', safeDir, absCmd, '/K', cmdCmd];
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
          execFile(ps, ['-NoExit', '-Command', psCmd], opts, (err) => { if (err) reject(err); else resolve(true); });
        });
      }
      return new Promise((resolve, reject) => {
        execFile(absCmd, ['/K', cmdCmd], opts, (err) => { if (err) reject(err); else resolve(true); });
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

  // Live quota probe. The service is shared with main's menu-bar poller, so
  // the two never probe twice for the same 5-minute window; consent gating and
  // caching both live in there.
  ipcMain.handle('rateLimits:get', async (_e, opts = {}) => rateLimits.get(opts || {}));

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
