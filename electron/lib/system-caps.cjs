// System / platform capability detection.
//
//   fixPath()         — GUI-launch PATH fix (Finder, Spotlight, .desktop shortcuts
//                       all start with a minimal launchctl/systemd env that's
//                       missing ~/.local/bin, /opt/homebrew/bin, NVM shims, etc.).
//                       Resolves the user's real PATH by spawning their login
//                       shell once, then prepends a few well-known fallbacks.
//                       Idempotent and cheap; safe to call at startup.
//   detectTerminals() — which terminal emulators are usable on this host
//                       (Terminal/iTerm on mac; cmd/pwsh/wt on Windows).
//   detectAiTools()   — whether `claude` / `codex` CLIs are installed and
//                       whether the user has prior history under ~/.claude /
//                       ~/.codex. Either signal counts as "installed".
//
// detectTerminals + detectAiTools cache their result on first call — both probe
// PATH lookups + filesystem stats that won't change during a single Lens
// process run, so re-running them on every system:capabilities IPC would just
// burn cycles.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const { HOME } = require('./paths.cjs');

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

module.exports = {
  fixPath,
  detectTerminals,
  detectAiTools,
};
