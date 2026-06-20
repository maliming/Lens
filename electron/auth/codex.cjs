// Codex rate-limits probe via `codex app-server --listen stdio://`.
//
// Approach borrowed from github.com/testpassword/CodexLimitsWidget:
//   1. Spawn the codex binary in app-server mode (JSON-RPC over stdio).
//   2. Send `initialize` (id=1) with experimentalApi capability.
//   3. Send `account/rateLimits/read` (id=2).
//   4. Parse the response, normalize to our RateLimits shape (5h + weekly),
//      kill the subprocess.
//
// Returns the same envelope shape `auth/claude.cjs`'s probe produces so
// the `rateLimits:get` dispatcher only differs by which prober runs.
//
// `clientVersion` is injected (rather than calling `app.getVersion()` from
// inside the module) so the module stays decoupled from Electron's
// lifecycle and can be loaded in any worker.

const { spawn } = require('child_process');

function emptyWin() {
  return { utilization: null, status: null, reset: null };
}

// Translate Codex's `rateLimitsByLimitId.codex` shape into our existing
// RateLimits envelope so the renderer / Sidebar quota card don't care
// which provider produced it.
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
  // Normalise resetsAt to Unix seconds — renderer's resetInLabel
  // multiplies by 1000 expecting a number. Codex sometimes returns an ISO
  // string; coerce so the label doesn't go null when the underlying field
  // is just a different format.
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

function probeCodexLimits({ clientVersion = 'unknown' } = {}) {
  return new Promise((resolveOuter, rejectOuter) => {
    let proc;
    try {
      proc = spawn('codex', ['app-server', '--listen', 'stdio://'], { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      return rejectOuter(new Error('codex binary not found in PATH'));
    }

    // Bound the stdout/stderr accumulators — a runaway codex app-server
    // (bug or fork) would otherwise stream into `buffer`/`stderr` until
    // the main process OOMs. 4 MB / 1 MB is plenty for the JSON-RPC
    // traffic we expect.
    const STDOUT_CAP = 4 * 1024 * 1024;
    const STDERR_CAP = 1 * 1024 * 1024;
    let buffer = '';
    const pending = new Map();
    const pendingTimers = new Set();
    let stderrTotal = 0;
    const stderr = [];
    let settled = false;

    // Single cleanup path: cancels all pending timers, drops `pending`
    // waiters, and kills the subprocess. settle(err, result) collapses
    // success, error, exit, and `proc.on('error')` (spawn ENOENT) into
    // the same path so a misbehaving spawn can't leave timers / stdin /
    // process state lingering. The very first call wins; subsequent ones
    // are no-ops, which matters because exit usually fires AFTER kill().
    const settle = (err, result) => {
      if (settled) return;
      settled = true;
      for (const t of pendingTimers) clearTimeout(t);
      pendingTimers.clear();
      pending.clear();
      try { proc.stdin?.end(); } catch {}
      try { proc.kill(); } catch {}
      if (err) rejectOuter(err);
      else resolveOuter(result);
    };

    proc.stdout.on('data', (chunk) => {
      const s = chunk.toString('utf8');
      buffer += s;
      // Cap between line boundaries: drop the earliest text if a line
      // never arrives within the budget. Normal protocol traffic stays
      // line-bounded so this only matters for misbehaving servers.
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
        pendingTimers.delete(timer);
        pending.delete(id);
        rej(new Error(`timeout waiting for id=${id}`));
      }, ms);
      pendingTimers.add(timer);
      pending.set(id, (msg) => {
        pendingTimers.delete(timer);
        clearTimeout(timer);
        if (msg.error) rej(new Error(JSON.stringify(msg.error)));
        else res(msg.result);
      });
    });

    // Async spawn errors (ENOENT after `spawn()` returned a process
    // object, EACCES on the binary, etc.) AND `exit` AND the JSON-RPC
    // happy/sad paths all funnel through settle() so cleanup is
    // identical regardless of how the probe ends.
    proc.on('error', (e) => settle(new Error('failed to spawn codex: ' + e.message)));
    proc.on('exit', (code, signal) => {
      // If we already settled (success or local error), this is the
      // normal post-kill exit; ignore. Otherwise reject pending waiters
      // with a useful message before letting settle drop the rest.
      if (settled) return;
      for (const cb of pending.values()) {
        cb({ error: { message: `codex app-server exited (code=${code}, signal=${signal})` } });
      }
      settle(new Error(`codex app-server exited (code=${code}, signal=${signal})`));
    });

    (async () => {
      try {
        send(1, 'initialize', {
          clientInfo: { name: 'Lens', version: clientVersion },
          capabilities: { experimentalApi: true },
        });
        await waitFor(1);
        send(2, 'account/rateLimits/read', null);
        const result = await waitFor(2);
        settle(null, {
          status: 200,
          body: '',
          headersDump: { stderr: stderr.join('').slice(0, 500) },
          limits: normalizeCodexLimits(result),
        });
      } catch (e) {
        settle(e);
      }
    })();
  });
}

module.exports = {
  emptyWin,
  normalizeCodexLimits,
  probeCodexLimits,
};
