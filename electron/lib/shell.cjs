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
//                                 build both the bash command and the argv
//                                 form the IPC's spawn paths need.
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
