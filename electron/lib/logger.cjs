// File logger — writes to <userData>/logs/main.log (which is what Electron's
// `app.getPath('logs')` points to). Console output also goes to the file.
// Rotation is "truncate when bigger than ~2 MB" — keeps the file useful, never
// grows unbounded.
//
// `installConsoleCapture()` wires console.error / console.log so anything
// logged through them also lands in the file. It's invoked once from main.cjs
// early — before the app fully initialises — so the lazy `_logFile()` path
// silently no-ops until `app.getPath('logs')` works.
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

let _logFilePath = null;
function _logFile() {
  if (_logFilePath) return _logFilePath;
  try {
    const dir = app.getPath('logs');
    fs.mkdirSync(dir, { recursive: true });
    _logFilePath = path.join(dir, 'main.log');
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
    const text = parts
      .map(x =>
        x instanceof Error ? (x.stack || String(x))
          : typeof x === 'object' ? JSON.stringify(x)
          : String(x))
      .join(' ');
    fs.appendFileSync(p, `${ts} [${level}] ${text}\n`);
  } catch {}
}

function installConsoleCapture() {
  const _origConsoleError = console.error.bind(console);
  const _origConsoleLog = console.log.bind(console);
  console.error = (...args) => { _origConsoleError(...args); logToFile('error', args); };
  console.log = (...args) => { _origConsoleLog(...args); logToFile('info', args); };
}

function installCrashHandlers() {
  // uncaughtException is a sync-stack failure — main state is definitionally
  // unknown, so log and exit rather than serve potentially torn IPC results.
  // unhandledRejection is more often a transient (cancelled fetch, slow
  // subprocess teardown) so we log but don't terminate; if it actually
  // corrupted shared state a subsequent throw catches it on uncaughtException.
  process.on('uncaughtException', (err) => {
    console.error('[main] uncaughtException:', err?.stack || err);
    setTimeout(() => process.exit(1), 50);
  });
  process.on('unhandledRejection', (reason) => {
    console.error('[main] unhandledRejection:', reason);
  });
}

module.exports = {
  logToFile,
  installConsoleCapture,
  installCrashHandlers,
};
