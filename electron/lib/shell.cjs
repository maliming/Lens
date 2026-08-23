// Shell / session-resume helpers — pure utilities used by the IPC layer when
// dispatching "Open in Terminal / iTerm" or building copy-pasteable
// resume commands.
//
//   shellQuote(s)               — single-quote string for POSIX shells.
//   isValidSessionId(id)        — strict regex for renderer-supplied ids;
//                                 rejects leading `-` so the id can never
//                                 smuggle a CLI flag through `--resume <id>`.
//   safeCwd(cwd)                — validate renderer-supplied working dirs
//                                 before handing them to a shell; falls back
//                                 to $HOME when unusable.
//   runOsascript(script)        — fire-and-resolve wrapper around `osascript -e`.
//   resumeCommandFor(payload)   — pick claude/codex CLI for a session and
//                                 build the command line each launch path
//                                 needs (bash / cmd / PowerShell) plus the
//                                 argv form, each carrying the session env
//                                 the CLI has to be told about explicitly.
//   payloadKey(payload)         — composite-key validator + builder for
//                                 favorites/excludes/aliases payloads.
//
// `payloadKey` needs `compositeKey` from the parsers/shared module to build
// the `<source>:<id>` key used by favorites/excludes/aliases. `resumeCommandFor`
// used to sniff `filePath` against CODEX_DIR to infer source, but that
// implicit fallback gave a renderer-supplied path direct influence over
// command dispatch without going through IPC-level containment first. The
// IPC handlers now resolve source explicitly (containment + source field)
// and pass it down — this module no longer touches paths.cjs / fs-safety.cjs.

const os = require('os');
const fs = require('fs');
const { execFile } = require('child_process');

const { compositeKey } = require('../parsers/shared.cjs');

function shellQuote(s) {
  if (s === undefined || s === null) return "''";
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

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

function runOsascript(script) {
  return new Promise((resolve, reject) => {
    execFile('osascript', ['-e', script], (err) => { if (err) reject(err); else resolve(true); });
  });
}

// Environment a launched CLI needs, declared in the command text rather than
// inherited. Claude Code marks its own children with CLAUDE_CODE_CHILD_SESSION
// so a nested `claude` does not write the same JSONL twice, and a child that
// sees it writes no transcript at all. A Lens started from an agent's own
// terminal carries that marker and hands it to every terminal it opens.
// `CLAUDE_CODE_FORCE_SESSION_PERSISTENCE` is the CLI's supported way to say
// "this is a top-level session" — the same assertion pty.cjs makes for the
// embedded terminal, and the one its own warning text names.
//
// It has to travel *in the command* here rather than in the environment of the
// process we spawn: the macOS path goes through osascript, and the session
// Terminal / iTerm opens inherits *that app's* environment, not Lens's.
// gnome-terminal's client/server split loses it the same way on Linux.
const RESUME_ENV = { CLAUDE_CODE_FORCE_SESSION_PERSISTENCE: '1' };

// PowerShell single-quoted strings escape an embedded quote by doubling it —
// not the POSIX `'\''` dance shellQuote does.
function psQuote(s) {
  return "'" + String(s).replace(/'/g, "''") + "'";
}

// Returns the right resume command for a given session. Caller MUST resolve
// `source` to 'claude' or 'codex' before invoking — historically this helper
// fell back to sniffing `filePath` against CODEX_DIR, but that gave a
// renderer-supplied path direct influence over CLI dispatch without going
// through IPC-level path containment. Source resolution now lives in
// `ipc.cjs` where `ensureInsideAny` is the authoritative gate.
function resumeCommandFor(payload) {
  const { cwd, id, source } = payload || {};
  if (!isValidSessionId(id)) throw new Error('Invalid session id');
  if (source !== 'claude' && source !== 'codex') throw new Error('Invalid source');
  const dir = safeCwd(cwd);
  const isCodex = source === 'codex';
  // codex CLI resumes via `codex resume <session-id>`. cwd matters less for
  // codex because the session's own metadata records cwd; we still cd to it.
  const cli = isCodex ? 'codex' : 'claude';
  const args = isCodex ? ['resume', id] : ['--resume', id];
  const env = isCodex ? {} : { ...RESUME_ENV };
  const entries = Object.entries(env);
  // One prefix per shell dialect the launch paths hand a command line to.
  const bashEnv = entries.map(([k, v]) => `${k}=${shellQuote(v)} `).join('');
  const cmdEnv = entries.map(([k, v]) => `set "${k}=${v}" && `).join('');
  const psEnv = entries.map(([k, v]) => `$env:${k}=${psQuote(v)}; `).join('');
  return {
    dir,
    cli,
    args,
    env,
    // id passes isValidSessionId so the alphabet is safe — but quote it anyway
    // for defense-in-depth, in case the allowed alphabet ever widens.
    bashCmd: isCodex
      ? `cd ${shellQuote(dir)} && ${bashEnv}codex resume ${shellQuote(id)}`
      : `cd ${shellQuote(dir)} && ${bashEnv}claude --resume ${shellQuote(id)}`,
    // The Windows launchers take their cwd through execFile's `cwd:` option, so
    // these carry only the env declaration and the invocation.
    cmdCmd: `${cmdEnv}${cli} ${args.join(' ')}`,
    psCmd: `${psEnv}${cli} ${args.join(' ')}`,
  };
}

// Composite "<source>:<id>" key for IPC payloads { source, id }. Used by
// favorites/excludes/aliases. Throws on malformed payload — let the IPC
// surface return an error to the renderer rather than silently storing junk.
function payloadKey(payload) {
  if (payload && typeof payload === 'object') {
    const { source, id } = payload;
    if (!isValidSessionId(id)) throw new Error('Invalid session id');
    return compositeKey(source, id);
  }
  throw new Error('Invalid favorite/exclude/alias payload');
}

module.exports = {
  shellQuote,
  isValidSessionId,
  safeCwd,
  runOsascript,
  resumeCommandFor,
  payloadKey,
};
