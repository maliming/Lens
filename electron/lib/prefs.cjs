// App preferences (tray / close behaviour / launch-at-login / window bounds
// / rate-limits-consent gate). Persisted as `<userData>/app-prefs.json`.
//
// Per-field validation on load so a corrupted prefs file (manual edit,
// version mismatch, partial write that survived without atomic guarantees
// on older builds) shouldn't be able to put non-booleans into boolean
// flags. Mirrors the renderer's `displayPrefs` parser.
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const { readJsonFileSafe, atomicWriteJson } = require('./json-io.cjs');

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
  // first launch's renderer init. Note this is a UI / usability gate, NOT
  // a hard security boundary: a compromised renderer can call
  // setRateLimitsConsent('granted') exactly like the user does. If you
  // need a true confirmation step, gate the probe behind a main-side
  // native dialog.
  rateLimitsConsent: 'pending',
};

function applyLaunchAtLogin(on) {
  // `openAsHidden: true` so when the OS auto-launches Lens at user login,
  // the window stays hidden and Lens is only visible in the tray. The
  // user explicitly chose "launch at login" to keep Lens available in the
  // background — popping a window in their face on every boot defeats
  // that intent.
  try { app.setLoginItemSettings({ openAtLogin: !!on, openAsHidden: !!on }); } catch {}
}

function createAppPrefs({ userDataDir }) {
  const appPrefsPath = path.join(userDataDir, 'app-prefs.json');
  let prefs = { ...APP_PREFS_DEFAULTS };

  async function load() {
    try {
      const raw = await readJsonFileSafe(appPrefsPath);
      if (raw == null) return;
      const obj = JSON.parse(raw);
      if (!obj || typeof obj !== 'object') return;
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
      prefs = next;
      // Reflect persisted launchAtLogin to the OS in case it drifted.
      applyLaunchAtLogin(prefs.launchAtLogin);
    } catch { prefs = { ...APP_PREFS_DEFAULTS }; }
  }

  async function save() {
    try { await atomicWriteJson(appPrefsPath, prefs); } catch {}
  }

  // Synchronous atomic write — the only allowed write path on the quit
  // route, where the async pipeline can't complete before Electron tears
  // the process down. Mirrors `atomicWriteJson`'s durability guarantees
  // (tmp file → fsync → rename → fsync parent dir on non-Win) so a sudden
  // power loss after quit doesn't drop the just-recorded window bounds.
  //
  // KNOWN RACE (narrow): an async write to `appPrefsPath` could be in the
  // window between fsync and rename when this fires. The in-flight rename
  // would then land AFTER our sync rename and overwrite the just-saved
  // bounds. Mitigations considered:
  //   • Wait for the queue in the close handler — Electron's close event
  //     doesn't honor async returns reliably without preventDefault dance.
  //   • Shared per-path lock between sync and async — requires reaching
  //     across module boundaries and complicates atomicWriteJson's hot
  //     path for an exit-only edge case.
  // The race window is microseconds: user toggles a pref AND closes the
  // app within a few ms. Acceptable risk for now; if it ever matters the
  // fix is the preventDefault dance in main.cjs's close handler.
  //
  // Encapsulating here (vs. inlining in main.cjs) keeps `appPrefsPath`
  // private to this module — it was that path leaking out and not being
  // re-imported that produced the silent failure on first refactor.
  function saveSync() {
    try {
      const tmp = appPrefsPath + '.tmp-' + process.pid + '-quit';
      const fd = fs.openSync(tmp, 'w');
      try {
        fs.writeFileSync(fd, JSON.stringify(prefs, null, 2), 'utf8');
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
  }

  function get() { return prefs; }
  function snapshot() { return { ...prefs }; }
  function set(patch) {
    prefs = { ...prefs, ...patch };
  }

  return {
    appPrefsPath,
    load, save, saveSync,
    get, snapshot, set,
    applyLaunchAtLogin,
  };
}

module.exports = {
  APP_PREFS_DEFAULTS,
  applyLaunchAtLogin,
  createAppPrefs,
};
