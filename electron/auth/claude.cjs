// Claude subscription usage, two ways in.
//
// The preferred one asks the CLI:
//   - `probeClaudeUsageViaCli()` — spawns `claude -p` in stream-json mode and
//     sends one `get_usage` control request, the same call behind the CLI's
//     own `/usage` panel. Structurally the twin of `auth/codex.cjs`: a local
//     subprocess speaking a line protocol, no credential handling on our side.
//     What it buys over the direct fetch below is token renewal — the CLI
//     refreshes an expired access token as part of serving the request, while
//     Lens reading the stored token can only find it stale. That is the normal
//     state of an idle machine: the token lasts eight hours and nothing but
//     the CLI renews it, so a user who hasn't run `claude` since morning had
//     no quota reading at all.
//
// The direct one is the fallback:
//   - `readClaudeOAuthCredential()` — pulls the access token *and its expiry*
//     from either the CLI's `~/.claude/.credentials.json` or, on macOS, the
//     system Keychain (`security find-generic-password -s "Claude Code-credentials"`).
//     Returns null if neither yields a usable token.
//   - `fetchClaudeUsage(token)` — GETs `/api/oauth/usage`, the endpoint the
//     control request reaches internally. Free (no Messages call, no token
//     spend), and it carries model-scoped weekly windows (Fable etc.) in a
//     generic `limits` array whose display names come from the API — a model
//     rename shows up here without a Lens update.
//
// Both paths end at `normalizeUsage`, because both carry the same body: the
// control response's `rate_limits` is verbatim what the endpoint returns. The
// fallback earns its keep because the control request is an experimental API
// (the SDK spells the method `usage_EXPERIMENTAL_MAY_CHANGE_...`), so it can
// be renamed or dropped in any CLI release — at which point Lens quietly goes
// back to reading the token itself.
//
// Everything here is pure (no Electron app state) so the IPC layer can
// require this directly without going through a factory.

const path = require('path');
const { execFileSync, spawn } = require('child_process');
const { net } = require('electron');

const { CLAUDE_DIR } = require('../lib/paths.cjs');
const { readJsonFileSafe } = require('../lib/json-io.cjs');

function pickAccessToken(obj) {
  if (!obj || typeof obj !== 'object') return null;
  return obj.claudeAiOauth?.accessToken
    || obj.accessToken
    || obj.access_token
    || obj.oauth?.accessToken
    || null;
}

// Claude Code stores the access token's expiry alongside it (epoch ms). The
// CLI renews lazily — only a real session / API call refreshes the pair and
// writes it back — so a credential left untouched for longer than its
// lifetime (8h as issued today) still sits on disk with a dead token. Reading
// the expiry lets the probe skip a request it knows will 401.
//
// Tolerate epoch seconds too: anything below year-2001 in ms is far more
// likely a seconds value than a 1970 timestamp.
const EPOCH_MS_FLOOR = 1e12;

function pickExpiresAt(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const raw = obj.claudeAiOauth?.expiresAt
    ?? obj.expiresAt
    ?? obj.expires_at
    ?? obj.oauth?.expiresAt;
  if (raw == null) return null;
  const n = typeof raw === 'number' ? raw : parseInt(String(raw), 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n < EPOCH_MS_FLOOR ? n * 1000 : n;
}

// Treat a token that dies within the next minute as already dead — the probe
// would otherwise race the expiry and come back 401 anyway. A credential with
// no readable expiry fails open (expiresAt null → never reported expired) so
// an unfamiliar on-disk shape degrades to the old behaviour instead of
// blocking the probe outright.
const EXPIRY_SKEW_MS = 60 * 1000;

function toCredential(parsed) {
  const token = pickAccessToken(parsed);
  if (!token) return null;
  const expiresAt = pickExpiresAt(parsed);
  return {
    token,
    expiresAt,
    expired: expiresAt != null && expiresAt - EXPIRY_SKEW_MS <= Date.now(),
  };
}

async function readClaudeOAuthCredential() {
  const fp = path.join(CLAUDE_DIR, '.credentials.json');
  try {
    const raw = await readJsonFileSafe(fp);
    if (raw == null) throw new Error('credentials unreadable');
    const cred = toCredential(JSON.parse(raw));
    if (cred) return cred;
  } catch {}
  if (process.platform === 'darwin') {
    try {
      const out = execFileSync(
        'security',
        ['find-generic-password', '-s', 'Claude Code-credentials', '-w'],
        { encoding: 'utf8', timeout: 8000 },
      );
      const cred = toCredential(JSON.parse(out.trim()));
      if (cred) return cred;
    } catch {}
  }
  return null;
}

// `/api/oauth/usage` reports utilization as 0-100 percent; RateWindow keeps
// the 0-1 scale the old ratelimit headers used so the renderer math
// (pct(), thresholds) stays untouched.
function fracOrNull(v) {
  if (v == null) return null;
  const n = typeof v === 'number' ? v : parseFloat(String(v));
  if (!Number.isFinite(n)) return null;
  return n / 100;
}

// `resets_at` arrives as an ISO string, but Claude Code's own parser also
// tolerates epoch seconds — mirror that so a server-side format change
// doesn't null every countdown. RateWindow.reset is epoch seconds.
function resetToEpochSeconds(v) {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? Math.floor(v) : null;
  const ms = Date.parse(String(v));
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

// The usage endpoint has no per-window allowed/warning/rejected status, so a
// window that is fully spent synthesizes 'rejected' (same vocabulary as the
// old headers → rateStatusKind still classifies it) and everything else
// stays null → renders as plain 'ok' with the utilization bar carrying the
// signal.
function windowStatus(utilization) {
  return utilization != null && utilization >= 1 ? 'rejected' : null;
}

function toWindow(w) {
  const utilization = fracOrNull(w?.utilization);
  return {
    utilization,
    status: windowStatus(utilization),
    reset: resetToEpochSeconds(w?.resets_at),
  };
}

// Display names are API-controlled remote strings headed for the UI and the
// sidebar tooltip — strip control chars and cap length here so the renderer
// never holds a pathological value (it still routes through cleanDisplayText).
function cleanName(v) {
  if (typeof v !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const s = v.replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '').trim();
  return s ? s.slice(0, 64) : null;
}

const MAX_MODEL_WINDOWS = 8;

// Model-scoped weekly windows, name-keyed off the API's own display_name so
// renamed models (Fable → whatever ships next) surface without a code change.
// Two shapes feed this:
//   - the generic `limits` array: {kind:'weekly_scoped', percent, resets_at,
//     scope:{model:{display_name}}} — percent is already 0-100 like the
//     fixed windows' utilization
//   - legacy fixed keys `seven_day_opus` / `seven_day_sonnet`, appended only
//     when the limits array didn't already carry that model
function extractModelWindows(u) {
  const out = [];
  const seen = new Set();
  const push = (name, utilization, resetsAt) => {
    const cleaned = cleanName(name);
    if (!cleaned || seen.has(cleaned.toLowerCase()) || out.length >= MAX_MODEL_WINDOWS) return;
    seen.add(cleaned.toLowerCase());
    const frac = fracOrNull(utilization);
    if (frac == null) return;
    out.push({
      name: cleaned,
      utilization: frac,
      status: windowStatus(frac),
      reset: resetToEpochSeconds(resetsAt),
    });
  };
  if (Array.isArray(u?.limits)) {
    for (const entry of u.limits) {
      if (!entry || entry.kind !== 'weekly_scoped') continue;
      push(entry.scope?.model?.display_name, entry.percent, entry.resets_at);
    }
  }
  push('Opus', u?.seven_day_opus?.utilization, u?.seven_day_opus?.resets_at);
  push('Sonnet', u?.seven_day_sonnet?.utilization, u?.seven_day_sonnet?.resets_at);
  return out;
}

function normalizeUsage(u) {
  return {
    // The old header probe surfaced an aggregate status + representative
    // claim; the usage endpoint has neither. Kept as fields so the renderer
    // shape is stable across sources.
    status: null,
    representativeClaim: null,
    fiveHour: toWindow(u?.five_hour),
    weekly: toWindow(u?.seven_day),
    overage: { utilization: null, status: null, reset: null },
    modelWindows: extractModelWindows(u),
  };
}

// Ask the CLI for the usage snapshot instead of reading the token ourselves.
//
// `claude -p` with stream-json on both ends speaks the control protocol the
// Agent SDK uses. One `get_usage` request is enough; no user message is sent,
// so no turn runs, nothing is billed, and no session file lands in
// `~/.claude/projects` for Lens to then list back to the user.
//
// The flags are all load-bearing:
//   --restricted   skips the user's hooks. Without it a SessionStart hook runs
//                  on every poll — Lens would be firing someone's shell script
//                  every five minutes for a number they didn't ask for. It
//                  still reads the keychain, which `--bare` (the other
//                  hook-skipping mode) does not: that one returns
//                  rate_limits_available:false and is useless here.
//   skip_behaviors the request otherwise scans every transcript touched in the
//                  last seven days to build a "behaviors" section we ignore.
//                  Cheap on a small history, not on a 200 MB one.
const CLAUDE_CLI_PROBE_TIMEOUT_MS = 20000;
const CLI_STDOUT_CAP = 4 * 1024 * 1024;
const CLI_STDERR_CAP = 1 * 1024 * 1024;

function probeClaudeUsageViaCli() {
  return new Promise((resolveOuter, rejectOuter) => {
    let proc;
    const requestId = `lens-usage-${Date.now()}`;
    try {
      proc = spawn('claude', [
        '-p', '--restricted',
        '--input-format', 'stream-json',
        '--output-format', 'stream-json',
      ], { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      return rejectOuter(new Error('claude binary not found in PATH'));
    }

    let buffer = '';
    let stderrTotal = 0;
    const stderr = [];
    let settled = false;
    let timer = null;

    // One cleanup path for success, protocol error, timeout, spawn failure and
    // early exit — same shape as the codex prober, and for the same reason:
    // `exit` normally fires after our own kill(), so the first settle wins and
    // the rest are no-ops.
    const settle = (err, result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try { proc.stdin?.end(); } catch {}
      try { proc.kill(); } catch {}
      if (err) rejectOuter(err);
      else resolveOuter(result);
    };

    timer = setTimeout(
      () => settle(new Error(`claude usage probe timed out after ${CLAUDE_CLI_PROBE_TIMEOUT_MS}ms`)),
      CLAUDE_CLI_PROBE_TIMEOUT_MS,
    );

    proc.stdout.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      // Cap between line boundaries, dropping the earliest text if a line
      // never arrives within the budget.
      if (buffer.length > CLI_STDOUT_CAP) {
        buffer = buffer.slice(buffer.length - CLI_STDOUT_CAP);
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
        // The stream also carries `system` frames (hook lifecycle, init). Only
        // the response to our own request id ends the probe.
        if (msg.type !== 'control_response') continue;
        const env = msg.response || {};
        if (env.request_id && env.request_id !== requestId) continue;
        if (env.subtype === 'error') {
          settle(new Error(String(env.error || 'get_usage returned an error')));
          return;
        }
        settle(null, env.response || {});
        return;
      }
    });

    proc.stderr.on('data', (c) => {
      if (stderrTotal >= CLI_STDERR_CAP) return;
      const s = c.toString('utf8');
      stderrTotal += s.length;
      stderr.push(stderrTotal > CLI_STDERR_CAP ? s.slice(0, CLI_STDERR_CAP - (stderrTotal - s.length)) : s);
    });

    proc.on('error', (e) => settle(new Error('failed to spawn claude: ' + e.message)));
    proc.on('exit', (code, signal) => {
      if (settled) return;
      const tail = stderr.join('').trim().slice(-300);
      settle(new Error(`claude exited before answering (code=${code}, signal=${signal})${tail ? ': ' + tail : ''}`));
    });

    try {
      proc.stdin.write(JSON.stringify({
        type: 'control_request',
        request_id: requestId,
        request: { subtype: 'get_usage', skip_behaviors: true },
      }) + '\n');
    } catch (e) {
      settle(new Error('failed to send get_usage: ' + e.message));
    }
  });
}

// Fetch the subscription usage snapshot Claude Code's /usage panel shows.
// Plain GET — costs nothing from the user's quota.
function fetchClaudeUsage(token) {
  return new Promise((resolve, reject) => {
    const req = net.request({
      method: 'GET',
      url: 'https://api.anthropic.com/api/oauth/usage',
    });
    // Wall-clock timeout so a hanging socket can't pin the Usage view in a
    // permanent "loading" state. net.request has no built-in timeout; cap
    // at 15s (Anthropic normally responds in <1s) and abort cleanly.
    const probeTimer = setTimeout(() => {
      try { req.abort(); } catch {}
      reject(new Error('Anthropic usage fetch timed out after 15s'));
    }, 15000);
    const clearProbeTimer = () => { clearTimeout(probeTimer); };
    req.setHeader('content-type', 'application/json');
    req.setHeader('anthropic-beta', 'oauth-2025-04-20');
    req.setHeader('authorization', 'Bearer ' + token);

    // The usage response body is normally < 4 KB. Cap accumulation at 512 KB
    // defensively — a hostile MITM / proxy could otherwise stream a huge
    // body forever and OOM the main process.
    const BODY_CAP = 512 * 1024;
    let body = '';
    let bodyTruncated = false;
    req.on('response', (res) => {
      res.on('data', (chunk) => {
        if (bodyTruncated) return;
        const s = chunk.toString('utf8');
        if (body.length + s.length > BODY_CAP) {
          body += s.slice(0, BODY_CAP - body.length);
          bodyTruncated = true;
          try { req.abort(); } catch {}
        } else {
          body += s;
        }
      });
      // resolve() may be called by either `end` (normal) or `aborted` (we
      // hit the body cap and called req.abort()). Unlike the old header
      // probe, everything here lives in the body, so a truncated body only
      // parses if the cut landed after valid JSON — the null limits fall
      // through to the caller's no-data handling.
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearProbeTimer();
        let usage = null;
        try {
          const parsed = JSON.parse(body);
          if (parsed && typeof parsed === 'object' && !parsed.error) usage = parsed;
        } catch {}
        resolve({
          status: res.statusCode,
          body,
          truncated: bodyTruncated,
          limits: usage ? normalizeUsage(usage) : null,
        });
      };
      res.on('end', finish);
      res.on('aborted', finish);
      res.on('close', finish);
    });
    req.on('error', (e) => {
      clearProbeTimer();
      // If the abort came from us hitting the cap, `finish` already resolved
      // with whatever body made it through.
      if (bodyTruncated) return;
      reject(e);
    });
    req.end();
  });
}

module.exports = {
  pickAccessToken,
  pickExpiresAt,
  readClaudeOAuthCredential,
  fetchClaudeUsage,
  probeClaudeUsageViaCli,
  // Shared by both paths: the control response's `rate_limits` and the
  // endpoint's body are the same object.
  normalizeUsage,
};
