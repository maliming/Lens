const { app, BrowserWindow, shell, Tray, Menu, nativeImage } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

// Extracted utilities. See electron/lib/* for full docs on each module.
const { installConsoleCapture, installCrashHandlers } = require('./lib/logger.cjs');
const {
  CLAUDE_DIR, PROJECTS_DIR, CODEX_DIR, CODEX_SESSIONS_DIR,
} = require('./lib/paths.cjs');
installConsoleCapture();
installCrashHandlers();

const claudeParser = require('./parsers/claude.cjs');
const codexParser = require('./parsers/codex.cjs');
const { mapPool } = require('./lib/concurrency.cjs');
const { fixPath } = require('./lib/system-caps.cjs');

// Resolve real PATH so packaged GUI launches see ~/.local/bin / homebrew /
// NVM shims (see lib/system-caps.cjs).
fixPath();

let mainWindow = null;
let tray = null;
let isQuitting = false;

// Phase 4 modules. Userdata + prefs + sessions cache get one instance each
// (created lazily — userDataDir isn't valid until `app.whenReady`). main
// state previously sprinkled across module-level globals (favoriteSet,
// excludeSet, aliasMap, appPrefs, fileMetaCache, cachedSessions etc.) is
// owned by these factories now.
const { createUserData } = require('./lib/userdata.cjs');
const { createAppPrefs } = require('./lib/prefs.cjs');
const { createSessionsCache } = require('./lib/sessions-cache.cjs');
const { probeCodexLimits: _probeCodexLimits } = require('./auth/codex.cjs');
// codex probe needs the current client version (sent in JSON-RPC initialize).
// `app.getVersion()` isn't safe to call at module load; wrap so each
// invocation pulls the live value.
function probeCodexLimits() {
  return _probeCodexLimits({ clientVersion: app.getVersion() });
}

// Phase 6 modules: deep-search, usage aggregation, workspace config readers.
const { createUsage } = require('./usage.cjs');
const { readClaudeStatsCache } = require('./parsers/claude-stats-cache.cjs');
const { usageSummary } = createUsage({
  listSessions: (opts) => listSessions(opts),
  // Reader for `~/.claude/stats-cache.json` so usage:summary can fill in
  // months that the local JSONL inventory no longer covers — see the
  // parser module for the full rationale.
  readClaudeStatsCache,
});

// Phase 7b: all IPC handlers live in ipc.cjs as `registerIpc({ deps })`.
const { registerIpc } = require('./ipc.cjs');

let userData = null;       // createUserData(...)
let prefsStore = null;     // createAppPrefs(...)
let sessionsStore = null;  // createSessionsCache(...)
let claude = null;         // claudeParser.createParser(...)
let codex = null;          // codexParser.createParser(...)

// `appPrefs` is the only store value main.cjs reaches at module scope
// (window-bounds save + close-behavior branching in `createWindow`). All
// other store state (favorites/excludes/aliases) lives inside `userData`
// and is touched only via the IPC layer in `ipc.cjs`.
let appPrefs = {};
async function saveAppPrefs() { return prefsStore.save(); }
async function saveSessionsCache(sessions) { return sessionsStore.save(sessions); }
function getCachedSessions() { return sessionsStore.getCachedSessions(); }
function setCachedSessions(v) { sessionsStore.setCachedSessions(v); }

async function loadPersistedSets() {
  const userDataDir = app.getPath('userData');
  userData = createUserData({ userDataDir });
  prefsStore = createAppPrefs({ userDataDir });
  sessionsStore = createSessionsCache({ userDataDir });
  await userData.load();
  await prefsStore.load();
  appPrefs = prefsStore.get();
  // Build per-source parsers now that userdata + meta cache exist.
  // Userdata lookups go through getter callbacks (not direct Set refs) so
  // a toggleFavorite IPC call mutates state and the next parser call
  // immediately sees fresh values.
  const userdataLookup = {
    isFavorite: (k) => userData.isFavorite(k),
    isExcluded: (k) => userData.isExcluded(k),
    getAlias:   (k) => userData.getAlias(k),
  };
  const fileMetaCache = sessionsStore.getFileMetaCache();
  claude = claudeParser.createParser({ fileMetaCache, userdata: userdataLookup });
  codex = codexParser.createParser({ fileMetaCache, userdata: userdataLookup });
  // Stale sessions from last run — populates cachedSessions + per-file
  // mtime map so the first listSessions() call returns instantly.
  await sessionsStore.load();
}




// SWR (stale-while-revalidate) — pattern used by Linear / VS Code / SWR /
// React-Query. Disk-persisted last result is returned instantly; a fresh
// scan runs in the background; renderer gets pushed the updated list via
// an event. State lives in `sessionsStore` (lib/sessions-cache.cjs); only
// the in-flight scanner promise is local to main.cjs.
let backgroundScanInflight = null;

// Two-phase scan:
//   1. Cheap pass — readdir + stat every .jsonl. ~50ms for 600+ files.
//   2. Sort by mtime desc → deep-read TOP_N first, push that. UI shows the
//      newest sessions in ~500ms regardless of total count.
//   3. Background-read the rest, push the full list when done.
const TOP_BATCH = 30;
let firstBatchResolver = null;
let firstBatchPromise = null;



// ============================ Codex scanner ============================
// Codex stores sessions at ~/.codex/sessions/<year>/<month>/<day>/rollout-...jsonl
// Line 1 is `session_meta` (id, cwd, originator, cli_version, model_provider).
// Subsequent lines are `event_msg` (token_count etc.) and `response_item`
// (messages with role=user/assistant and content arrays, function_calls, reasoning).



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
      const [claudeStats, codexStats] = await Promise.all([claude.statAllJsonl(), codex.statAllCodexJsonl()]);
      const taggedClaude = claudeStats.map(f => ({ ...f, kind: 'claude' }));
      const taggedCodex = codexStats.map(f => ({ ...f, kind: 'codex' }));
      const statted = [...taggedClaude, ...taggedCodex].sort((a, b) => (b.mtime || 0) - (a.mtime || 0));

      const buildOne = async (f) => f.kind === 'codex' ? codex.buildCodexSession(f) : claude.buildSession(f);

      // Whether this is a cold scan (no prior cache) or a refresh of an existing
      // cache. Cold path uses progressive pushes so users see the list fill in
      // instead of staring at an empty pane. Refresh path holds the existing
      // cached list visible and only swaps once the full rescan is done — that
      // way the sidebar History count doesn't dip from 543 → 30 → 180 → ...
      // → 543 every time the window regains focus.
      const prevCached = getCachedSessions();
      const isCold = !prevCached || prevCached.length === 0;

      // Phase A — deep-read the most recent TOP_BATCH.
      const topFiles = statted.slice(0, TOP_BATCH);
      const top = await mapPool(topFiles, 16, buildOne);
      if (isCold) {
        setCachedSessions(top.slice());
        pushSessions(getCachedSessions());
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
          const merged = [...getCachedSessions(), ...collected].sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
          setCachedSessions(merged);
          pushSessions(merged);
        }
      });

      // Final flush + sort + persist. This is the only push on a refresh, so
      // the renderer sees one atomic swap from old-cache → fresh-list, no count
      // wobble in between.
      const all = [...top, ...collected].sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
      setCachedSessions(all);
      pushSessions(all);
      saveSessionsCache(all).catch(() => {});
      return all;
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
  const cached = getCachedSessions();
  if (cached || force) {
    if (!noRefresh && !backgroundScanInflight) refreshSessionsInBackground().catch(() => {});
    return cached || [];
  }
  // First boot, no cache → wait only for the TOP_BATCH push, not the full scan.
  if (!noRefresh) refreshSessionsInBackground().catch(() => {});
  if (firstBatchPromise) await firstBatchPromise;
  return getCachedSessions() || [];
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

function createWindow({ startHidden = false } = {}) {
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
    // 1380 covers sidebar (default 220) + list (default ~360) + detail-min
    // (~640) + chrome gaps + breathing room. The constructor floor needs to
    // match `setMinimumSize` below — earlier these drifted (1280 here,
    // 1380 below), so the constructor floor was effectively dead.
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
    // Show window unless this is a launch-at-login boot — then the tray
    // is the only visible affordance until the user clicks it.
    show: !startHidden,
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
          // Quit route: the async pipeline can't complete before Electron
          // tears the process down. `prefsStore.saveSync()` is the only
          // allowed write path here — it owns appPrefsPath internally and
          // mirrors the async atomicWriteJson's durability (tmp + fsync +
          // rename + fsync parent dir on non-Win).
          prefsStore.saveSync();
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
    const cs = getCachedSessions();
    console.log(`[startup] persisted sets loaded. favorites=${userData.favoritesSet.size}, excludes=${userData.excludesSet.size}, aliases=${Object.keys(userData.aliasesMap).length}, cachedSessions=${cs ? cs.length : 0}`);
    // Register IPC handlers now that userdata + parser instances exist.
    // mainWindow / tray are wired via getter callbacks so handlers always see
    // the live values (the window can be recreated after a hide-close).
    registerIpc({
      listSessions, claude, codex,
      userData, prefsStore,
      usageSummary,
      probeCodexLimits,
      titleBarColors: TITLEBAR_COLORS,
      getMainWindow: () => mainWindow,
      createTray, destroyTray,
    });
    // Detect launch-at-login: when macOS / Windows auto-starts Lens at
    // user login, `getLoginItemSettings()` reports `wasOpenedAtLogin`
    // and/or `wasOpenedAsHidden` (we set `openAsHidden: true` in
    // applyLaunchAtLogin). In that case start with the window hidden so
    // Lens only appears in the tray — clicking the tray icon brings the
    // window back. Without this the user would see a full window pop up
    // on every boot, which defeats the point of "background app".
    let startHidden = false;
    try {
      const lis = app.getLoginItemSettings();
      if (lis && (lis.wasOpenedAtLogin || lis.wasOpenedAsHidden)) {
        startHidden = appPrefs.showTrayIcon !== false;
        console.log(`[startup] launch-at-login detected — wasOpenedAtLogin=${lis.wasOpenedAtLogin} wasOpenedAsHidden=${lis.wasOpenedAsHidden} → startHidden=${startHidden}`);
      }
    } catch {}
    createWindow({ startHidden });
    createTray();
    if (startHidden && process.platform === 'darwin' && app.dock) {
      // Hide Dock too so a tray-only launch doesn't leave a Lens icon
      // bouncing in the Dock the user never clicked. showOrCreateWindow
      // re-shows the Dock when the tray icon is clicked.
      try { app.dock.hide(); } catch {}
    }
    console.log(`[startup] window + tray ready; prefs=${JSON.stringify(appPrefs)}`);
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('activate', () => {
    showOrCreateWindow();
  });
}
