// Embedded terminal.
//
// The structured chat path (chat.cjs) renders a session the way Lens renders
// everything else, but it can only surface what the Agent SDK exposes and what
// the event mapper understands. Slash commands, plan mode's real semantics,
// thinking output and the CLI's own progress UI have no representation there.
//
// This is the other half: a real PTY running the user's `claude --resume`, so
// anything Claude Code can do in a terminal it can do here, at the cost of
// being a terminal rather than Lens-rendered content. The two are deliberately
// separate surfaces rather than one compromised surface.
//
// Safety notes:
//   * `claude` is spawned directly with an argv array — never through a shell,
//     so nothing in the session id or path can be interpreted as syntax.
//   * cwd and session id come from parsed session metadata, exactly as in
//     chat.cjs; the renderer's copies are not trusted.
//   * Keystrokes from the renderer go straight to the child's stdin, which is
//     the point of a terminal. That is the same authority the user already has
//     by opening one, and matches Lens's stated trust model for its renderer.

const path = require('path');
const fs = require('fs');

const { decodeProjectDir } = require('./parsers/claude.cjs');
const { PROJECTS_DIR, CODEX_SESSIONS_DIR } = require('./lib/paths.cjs');
const { resolveSessionCwd } = require('./lib/session-cwd.cjs');
const { ensureInside } = require('./lib/fs-safety.cjs');
const { isValidSessionId } = require('./lib/shell.cjs');
const { detectAiTools } = require('./lib/system-caps.cjs');
const { agentEnv } = require('./lib/agent-env.cjs');

// Backstop, not policy. Each terminal is a whole CLI process, and the process
// is the dominant cost by a wide margin — a 2026-08-11 measurement put it in
// the high hundreds of megabytes each, scaling linearly with the count. Treat
// that as an order of magnitude rather than a constant: it tracks whatever the
// CLI ships, not anything Lens controls.
//
// How many is too many is the user's call, handled in the renderer with a
// warning at a threshold they set. This ceiling exists only so a bug or a
// runaway loop cannot spawn processes without bound.
const MAX_TERMINALS = 12;
// One keystroke chunk. Paste is the only realistic way to exceed this, and a
// megabyte of paste into a CLI is a mistake either way.
const MAX_WRITE_BYTES = 64 * 1024;
const MAX_COLS = 500;
const MAX_ROWS = 200;
// Recent output kept per terminal so a reloaded renderer can repaint what is
// already on screen. A renderer reload throws away the xterm buffer while the
// PTY keeps running in main — without this the user comes back to a live but
// blank terminal. Sized for a screenful of a redraw-heavy TUI, not for history.
const REPLAY_BYTES = 256 * 1024;

let ptyLib = null;
function loadPty() {
  // Required lazily: it is a native module, and a user who never opens the
  // terminal should not pay for loading it — nor be blocked at startup if the
  // platform prebuild is somehow missing.
  if (!ptyLib) ptyLib = require('@lydell/node-pty');
  return ptyLib;
}

// Per-source differences, kept in one table rather than sprinkled through the
// handler. The two CLIs disagree on almost everything structural:
//
//   Claude — id is the file's own name; sessions live under a per-project
//            directory whose name encodes the cwd; resumes with `--resume <id>`.
//   Codex  — id lives *inside* the file (session_id) and the filename is a
//            timestamped rollout; sessions live under sessions/YYYY/MM/DD;
//            resumes with `resume <id>`.
//
// Adding a third tool means adding a row here, not editing the handler.
const SOURCE_ADAPTERS = {
  claude: {
    bin: 'claude',
    root: PROJECTS_DIR,
    readMeta: (parsers, filePath) => parsers.claude.readSessionMetadata(filePath),
    resumeId: (meta, real) => path.basename(real, '.jsonl'),
    cwdOf: (meta, real) => resolveSessionCwd(
      meta, path.basename(path.dirname(real)), decodeProjectDir,
    ),
    // The CLI paints its own chrome with truecolor fills chosen by its `theme`
    // setting, which no terminal palette can override — verified: the fill
    // stays 55,55,55 on a light background, and COLORFGBG makes no difference.
    // Passing the theme through is what makes Lens's light terminal actually
    // look light. `--settings` layers over the user's settings rather than
    // replacing them (verified: plugins and slash commands all still load).
    // How much the agent may do without asking. The CLI's own default comes
    // from `permissions.defaultMode` in settings, and the mode a user picks in
    // the TUI is not written back anywhere a resume can find — so a resumed
    // session lands on the configured default whatever they were working in.
    // Passing it explicitly is the only way for Lens to make that predictable.
    // The renderer's menu is the same list; this one is the check that matters,
    // since these values are spliced into argv.
    modes: ['acceptEdits', 'auto', 'bypassPermissions', 'manual', 'dontAsk', 'plan'],
    argv: (id, opts) => [
      '--resume', id,
      '--settings', JSON.stringify({ theme: opts.theme === 'light' ? 'light' : 'dark' }),
      ...(opts.mode ? ['--permission-mode', opts.mode] : []),
    ],
  },
  codex: {
    bin: 'codex',
    root: CODEX_SESSIONS_DIR,
    readMeta: (parsers, filePath) => parsers.codex.readCodexSessionMetadata(filePath),
    // The rollout filename is a timestamp, not the conversation id — resuming
    // by it would fail. The id the CLI wants is recorded in the file.
    resumeId: (meta) => meta?.codexId || null,
    cwdOf: (meta) => (typeof meta?.cwd === 'string' && meta.cwd.trim() ? meta.cwd : null),
    // Codex exposes no theme setting in config.toml and no CLI flag for one.
    //
    // Its approval policy is the counterpart of Claude's permission mode: when
    // the model has to stop and ask before running something. The sandbox flag
    // is deliberately not offered — it decides what a command can reach on
    // disk, which is not a dropdown Lens should be putting in front of anyone.
    modes: ['untrusted', 'on-request', 'never'],
    argv: (id, opts) => [
      'resume', id,
      ...(opts.mode ? ['--ask-for-approval', opts.mode] : []),
    ],
  },
};

// Returns the handler table plus lifecycle controls. Registration itself is
// left to ipc.cjs, which documents itself as the one place every
// `ipcMain.handle` lives — a rule worth keeping, because the value of that file
// is being able to audit the whole renderer-reachable surface in one read.
function createPtyManager({ getMainWindow, claude, codex }) {
  const parsers = { claude, codex };
  // termId -> { proc, senderId, source, filePath, cwd, replay, spawnTheme }
  const terms = new Map();
  // `source\0realPath` for starts that are past the ceiling check but have not
  // reached `terms` yet.
  const starting = new Set();
  let seq = 0;

  function senderOk(event) {
    const win = getMainWindow();
    return !!win && !win.isDestroyed() && event.sender === win.webContents;
  }

  function send(channel, payload) {
    const win = getMainWindow();
    if (!win || win.isDestroyed()) return;
    win.webContents.send(channel, payload);
  }

  function get(termId, senderId) {
    const entry = terms.get(termId);
    if (!entry || entry.senderId !== senderId) return null;
    return entry;
  }

  // Ending a terminal has to mean the process is gone, not that a signal was
  // sent. node-pty's Unix kill() is `process.kill(pid, 'SIGHUP')` and nothing
  // more: it does not wait, and it does not reach the descendants the CLI
  // spawned. Deleting the entry before that returned "closed" for a process
  // that was still running — which let a restart start a second CLI against
  // the same session file while the first was still writing to it.
  //
  // So: keep the entry (still counted, still un-startable) until exit is
  // observed, signal the whole process group, and escalate on a timer.
  // forkpty makes the child a session leader, so its pid is the group id and
  // a negative pid reaches everything it started.
  const ESCALATE_MS = 1500;
  const FORCE_MS = 3000;

  function signalGroup(pid, sig) {
    try { process.kill(-pid, sig); return; } catch {}
    // No group (or already reaped) — fall back to the process itself.
    try { process.kill(pid, sig); } catch {}
  }

  // One step of the escalation above.
  //
  // Windows has neither process groups nor SIGHUP. Measured there against this
  // same node-pty: `process.kill(-pid, …)` throws ESRCH, `SIGHUP` throws
  // ENOSYS, and a SIGTERM on the pid afterwards left both the CLI's child and
  // its grandchild running — the escalation was a no-op followed by a leak, and
  // once it had torn the console down, node-pty could no longer reap them
  // either. `proc.kill()` on its own took the whole tree with it, so on Windows
  // that is every step.
  const killsWholeConsole = process.platform === 'win32';

  function terminate(entry, sig) {
    if (killsWholeConsole) {
      try { entry.proc.kill(); } catch {}
      return;
    }
    signalGroup(entry.proc.pid, sig);
  }

  function kill(termId) {
    const entry = terms.get(termId);
    if (!entry) return Promise.resolve(false);
    if (entry.closing) return entry.closing;

    entry.closing = new Promise((resolve) => {
      const done = () => {
        clearTimeout(t1);
        clearTimeout(t2);
        terms.delete(termId);
        resolve(true);
      };
      entry.onClosed = done;

      terminate(entry, 'SIGHUP');
      const t1 = setTimeout(() => terminate(entry, 'SIGTERM'), ESCALATE_MS);
      const t2 = setTimeout(() => {
        terminate(entry, 'SIGKILL');
        // SIGKILL cannot be caught, but the exit event may still not arrive if
        // the pty was already torn down. Settle so callers are never stranded.
        done();
      }, FORCE_MS);
    });
    return entry.closing;
  }

  const handlers = {};

  handlers['pty:start'] = async (event, payload) => {
    if (!senderOk(event)) return { ok: false, error: 'bad-sender' };
    const adapter = SOURCE_ADAPTERS[payload?.source];
    if (!adapter) return { ok: false, error: 'unsupported-source' };

    // Containment first, always. Matching a re-attach on the renderer's raw
    // string would both bypass this gate and let two spellings of the same file
    // (a symlink, a differently-cased path) each start their own agent against
    // one session.
    let real;
    try {
      real = await ensureInside(adapter.root, payload.filePath);
    } catch {
      return { ok: false, error: 'path-rejected' };
    }
    if (path.extname(real) !== '.jsonl') return { ok: false, error: 'not-a-session' };

    // Re-attach rather than spawn a second agent against the same session.
    // This is the renderer-reload path: main still has the process, the
    // renderer lost its terminal. Hand back the id and the recent output.
    for (const [id, entry] of terms) {
      if (entry.source !== payload.source || entry.filePath !== real) continue;
      // A terminal on its way out is not something to hand back.
      if (entry.closing) continue;
      entry.senderId = event.sender.id;
      // Track the spelling the current renderer uses, so a later pty:list still
      // matches what its session list holds.
      if (typeof payload.filePath === 'string') entry.requestedPath = payload.filePath;
      // Report the theme this process was *actually* launched with, not the
      // one the caller asked for. The CLI's chrome colour is baked in at
      // spawn, so a reattached terminal keeps the old look — and the UI can
      // only offer to fix it if it knows.
      return {
        ok: true, termId: id, cwd: entry.cwd, replay: entry.replay,
        replaySeq: entry.replaySeq, reattached: true, spawnTheme: entry.spawnTheme,
      };
    }

    // Everything from here to `terms.set` is asynchronous, so the ceiling has
    // to count what is already on its way up. Without the pending set, several
    // concurrent starts each see room and all spawn.
    const startKey = `${payload.source}\u0000${real}`;
    if (starting.has(startKey)) return { ok: false, error: 'already-starting' };
    if (terms.size + starting.size >= MAX_TERMINALS) {
      return { ok: false, error: 'too-many-terminals' };
    }
    starting.add(startKey);
    try {
      return await beginTerminal({ adapter, payload, event, real, startKey });
    } finally {
      starting.delete(startKey);
    }
  };

  async function beginTerminal({ adapter, payload, event, real }) {
    const binPath = detectAiTools()[payload.source]?.binaryPath;
    if (!binPath) return { ok: false, error: 'cli-not-found' };

    let meta = null;
    try {
      meta = await adapter.readMeta(parsers, real);
    } catch {
      return { ok: false, error: 'unreadable-session' };
    }

    const sessionId = adapter.resumeId(meta, real);
    if (!isValidSessionId(sessionId)) return { ok: false, error: 'bad-session-id' };

    const cwd = adapter.cwdOf(meta, real);
    if (!cwd) return { ok: false, error: 'no-cwd' };
    try {
      if (!fs.lstatSync(cwd).isDirectory()) return { ok: false, error: 'cwd-missing' };
    } catch {
      return { ok: false, error: 'cwd-missing' };
    }

    const cols = Math.min(Math.max(Number(payload?.cols) || 80, 20), MAX_COLS);
    const rows = Math.min(Math.max(Number(payload?.rows) || 24, 5), MAX_ROWS);
    const theme = payload?.theme === 'light' ? 'light' : 'dark';
    // Validate against the adapter's own list rather than trusting the string.
    // Anything unrecognised (including a renderer that has been tampered with)
    // means "don't pass the flag", which leaves the CLI on its own default.
    const mode = adapter.modes?.includes(payload?.mode) ? payload.mode : null;

    let proc;
    try {
      const pty = loadPty();
      proc = pty.spawn(binPath, adapter.argv(sessionId, { theme, mode }), {
        name: 'xterm-256color',
        cols,
        rows,
        cwd,
        // agentEnv strips the *session* markers Lens may have inherited. With
        // CLAUDE_CODE_CHILD_SESSION present the CLI turns transcript saving
        // off entirely — the JSONL never grows and the transcript above looks
        // frozen no matter how often it is reloaded.
        env: agentEnv(process.env, {
          // These CLIs render differently when they think they are inside an
          // editor's task runner; tell them plainly this is a real terminal.
          TERM: 'xterm-256color',
          COLORTERM: 'truecolor',
        }),
      });
    } catch (err) {
      return { ok: false, error: 'spawn-failed', message: String(err?.message || err) };
    }

    seq += 1;
    const termId = `t${seq}`;
    const entry = {
      proc, senderId: event.sender.id, source: payload.source, filePath: real,
      // The spelling the renderer asked with, kept only so pty:list can hand it
      // back for comparison against SessionMeta.filePath, which the scanner
      // never resolves — under a symlinked projects directory that is the only
      // string that matches. Never used to reach the filesystem: every access
      // goes through `real`.
      requestedPath: typeof payload.filePath === 'string' ? payload.filePath : real,
      cwd, replay: '', seq: 0, replaySeq: 0, spawnTheme: theme,
      closing: null, onClosed: null,
    };
    terms.set(termId, entry);

    proc.onData((data) => {
      // Keep a bounded tail; slicing on every chunk is cheap next to the cost
      // of rendering it.
      entry.seq += 1;
      entry.replay = (entry.replay + data).slice(-REPLAY_BYTES);
      entry.replaySeq = entry.seq;
      // Every chunk is numbered. The start/reattach response carries the seq
      // its replay ends at, so the renderer can tell which live chunks the
      // replay already contains — otherwise output produced while the response
      // was in flight gets written twice.
      send('pty:data', { termId, data, seq: entry.seq });
    });
    proc.onExit(({ exitCode, signal }) => {
      const e = terms.get(termId);
      if (e?.onClosed) e.onClosed();
      else terms.delete(termId);
      // A process that dies while its pty:start response is still travelling
      // exits against a termId the renderer has not adopted yet. That case is
      // handled there — the event is parked until the id arrives — and cannot
      // be answered from here: this callback and the response below are never
      // in the same tick.
      send('pty:exit', { termId, exitCode, signal: signal ?? null });
    });

    // Hand back whatever the process has already emitted: output starts the
    // moment it spawns, and the renderer cannot match it to a terminal until
    // this response arrives.
    return {
      ok: true, termId, cwd, replay: entry.replay, replaySeq: entry.replaySeq,
      reattached: false, spawnTheme: theme,
    };
  }

  // A renderer reload throws away everything the renderer knew while these
  // processes keep running here. Without a way to enumerate them they become
  // invisible: not counted, not closeable, and still holding their memory.
  handlers['pty:list'] = async (event) => {
    if (!senderOk(event)) return { ok: false, error: 'bad-sender' };
    return {
      ok: true,
      // `max` lets the renderer stop offering "open anyway" when the hard
      // ceiling is already reached — main would refuse, and the user would be
      // left with an empty failed panel and no explanation.
      max: MAX_TERMINALS,
      terminals: [...terms.entries()]
        .filter(([, e]) => !e.closing)
        .map(([termId, e]) => ({
          termId, source: e.source, filePath: e.filePath,
          requestedPath: e.requestedPath, cwd: e.cwd,
        })),
    };
  };

  handlers['pty:write'] = async (event, payload) => {
    if (!senderOk(event)) return { ok: false, error: 'bad-sender' };
    const entry = get(payload?.termId, event.sender.id);
    if (!entry) return { ok: false, error: 'unknown-terminal' };
    const data = payload?.data;
    if (typeof data !== 'string') return { ok: false, error: 'bad-data' };
    if (Buffer.byteLength(data, 'utf8') > MAX_WRITE_BYTES) return { ok: false, error: 'too-long' };
    try { entry.proc.write(data); } catch { return { ok: false, error: 'write-failed' }; }
    return { ok: true };
  };

  handlers['pty:resize'] = async (event, payload) => {
    if (!senderOk(event)) return { ok: false, error: 'bad-sender' };
    const entry = get(payload?.termId, event.sender.id);
    if (!entry) return { ok: false, error: 'unknown-terminal' };
    const cols = Math.min(Math.max(Number(payload?.cols) || 80, 20), MAX_COLS);
    const rows = Math.min(Math.max(Number(payload?.rows) || 24, 5), MAX_ROWS);
    try { entry.proc.resize(cols, rows); } catch {}
    return { ok: true };
  };

  handlers['pty:stop'] = async (event, payload) => {
    if (!senderOk(event)) return { ok: false, error: 'bad-sender' };
    if (!get(payload?.termId, event.sender.id)) return { ok: false, error: 'unknown-terminal' };
    // Awaited: the caller (a restart, or the user closing) must not proceed
    // while the old process is still holding the session.
    await kill(payload.termId);
    return { ok: true };
  };

  return {
    handlers,
    // Bounded: quit must not hang on a process that refuses to die, but it also
    // must not exit while children are still running if they can be reaped in
    // time. The escalation above force-kills well inside this window.
    stopAll(timeoutMs = 4000) {
      const all = [...terms.keys()].map(id => kill(id));
      return Promise.race([
        Promise.all(all),
        new Promise(resolve => setTimeout(resolve, timeoutMs)),
      ]);
    },
    dropSender(senderId) {
      const hits = [...terms.entries()].filter(([, e]) => e.senderId === senderId);
      return Promise.all(hits.map(([id]) => kill(id)));
    },
  };
}

module.exports = { createPtyManager };
