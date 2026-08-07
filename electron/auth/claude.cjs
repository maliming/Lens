// Claude OAuth credential read + subscription usage fetch.
//
// Two surfaces:
//   - `readClaudeOAuthToken()`  — pulls the access token from either the
//     CLI's `~/.claude/.credentials.json` or, on macOS, the system
//     Keychain (`security find-generic-password -s "Claude Code-credentials"`).
//     Returns null if neither yields a usable token.
//   - `fetchClaudeUsage(token)` — GETs `/api/oauth/usage`, the same endpoint
//     Claude Code's own /usage panel reads. Free (no Messages call, no token
//     spend), and unlike the old ratelimit-header probe it carries
//     model-scoped weekly windows (Fable etc.) in a generic `limits` array
//     whose display names come from the API — a model rename shows up here
//     without a Lens update. Returns the envelope shape that `rateLimits:get`
//     consumes (status + body + limits.{5h,7d,overage,modelWindows}).
//
// Both functions are pure (no Electron app state) so the IPC layer can
// require this directly without going through a factory.

const path = require('path');
const { execFileSync } = require('child_process');
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

async function readClaudeOAuthToken() {
  const fp = path.join(CLAUDE_DIR, '.credentials.json');
  try {
    const raw = await readJsonFileSafe(fp);
    if (raw == null) throw new Error('credentials unreadable');
    const t = pickAccessToken(JSON.parse(raw));
    if (t) return t;
  } catch {}
  if (process.platform === 'darwin') {
    try {
      const out = execFileSync(
        'security',
        ['find-generic-password', '-s', 'Claude Code-credentials', '-w'],
        { encoding: 'utf8', timeout: 8000 },
      );
      const t = pickAccessToken(JSON.parse(out.trim()));
      if (t) return t;
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
  readClaudeOAuthToken,
  fetchClaudeUsage,
};
