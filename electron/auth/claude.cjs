// Claude OAuth credential read + Anthropic rate-limits probe.
//
// Two surfaces:
//   - `readClaudeOAuthToken()`  — pulls the access token from either the
//     CLI's `~/.claude/.credentials.json` or, on macOS, the system
//     Keychain (`security find-generic-password -s "Claude Code-credentials"`).
//     Returns null if neither yields a usable token.
//   - `probeAnthropicLimits(token)` — POSTs a 1-token messages.create call
//     so we can read the `anthropic-ratelimit-unified-*` response headers.
//     The body costs ~1 token of the user's 5h budget per call; the
//     renderer rate-limits this. Returns the envelope shape that
//     `rateLimits:get` consumes (status + headersDump + limits.{5h,7d,overage}).
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

function numOrNull(v) {
  if (v == null) return null;
  const n = parseInt(String(v), 10);
  return Number.isFinite(n) ? n : null;
}

function floatOrNull(v) {
  if (v == null) return null;
  const n = parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
}

// Probe Anthropic Messages API with the smallest possible request so we
// can read the `anthropic-ratelimit-unified-*` response headers. The body
// costs ~1 token of the user's 5h budget per call; the renderer rate-
// limits this.
function probeAnthropicLimits(token) {
  return new Promise((resolve, reject) => {
    const req = net.request({
      method: 'POST',
      url: 'https://api.anthropic.com/v1/messages',
    });
    // Wall-clock timeout so a hanging socket can't pin the Usage view in a
    // permanent "loading" state. net.request has no built-in timeout; cap
    // at 15s (Anthropic normally responds in <1s) and abort cleanly.
    const probeTimer = setTimeout(() => {
      try { req.abort(); } catch {}
      reject(new Error('Anthropic probe timed out after 15s'));
    }, 15000);
    const clearProbeTimer = () => { clearTimeout(probeTimer); };
    req.setHeader('content-type', 'application/json');
    req.setHeader('anthropic-version', '2023-06-01');
    req.setHeader('anthropic-beta', 'oauth-2025-04-20');
    req.setHeader('authorization', 'Bearer ' + token);

    // The Messages API response body is normally < 1 KB. Cap accumulation
    // at 512 KB defensively — a hostile MITM / proxy could otherwise
    // stream a huge body forever and OOM the main process.
    const BODY_CAP = 512 * 1024;
    let body = '';
    let bodyTruncated = false;
    req.on('response', (res) => {
      const headers = res.headers || {};
      const get = (k) => {
        const v = headers[k] ?? headers[k.toLowerCase()];
        return Array.isArray(v) ? v[0] : v;
      };
      // Surface every rate-limit-ish header for debugging, not just unified.
      const headersDump = {};
      for (const [k, v] of Object.entries(headers)) {
        const lk = k.toLowerCase();
        if (lk.includes('ratelimit') || lk === 'anthropic-request-id' || lk === 'request-id' || lk === 'content-type' || lk === 'retry-after') {
          headersDump[lk] = Array.isArray(v) ? v[0] : v;
        }
      }
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
      // hit the body cap and called req.abort()). Both paths have valid
      // headers — that's the only thing this probe actually consumes — so
      // surface them either way.
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearProbeTimer();
        const win = (prefix) => ({
          utilization: floatOrNull(get(`anthropic-ratelimit-unified-${prefix}-utilization`)),
          status: get(`anthropic-ratelimit-unified-${prefix}-status`) || null,
          reset: numOrNull(get(`anthropic-ratelimit-unified-${prefix}-reset`)),
        });
        resolve({
          status: res.statusCode,
          body,
          headersDump,
          truncated: bodyTruncated,
          limits: {
            status: get('anthropic-ratelimit-unified-status') || null,
            representativeClaim: get('anthropic-ratelimit-unified-representative-claim') || null,
            fiveHour: win('5h'),
            weekly: win('7d'),
            overage: win('overage'),
          },
        });
      };
      res.on('end', finish);
      res.on('aborted', finish);
      res.on('close', finish);
    });
    req.on('error', (e) => {
      clearProbeTimer();
      // If the abort came from us hitting the cap, treat it as a clean
      // finish — headers are what we care about, and they're already on
      // the response object via the `response` handler above.
      if (bodyTruncated) return;
      reject(e);
    });
    req.on('abort', () => {
      // Same as above: only an abort the cap triggered should surface as
      // a normal completion; otherwise let error/end fire as they will.
    });
    req.write(JSON.stringify({
      model: 'claude-haiku-4-5',
      max_tokens: 1,
      messages: [{ role: 'user', content: 'hi' }],
    }));
    req.end();
  });
}

module.exports = {
  pickAccessToken,
  readClaudeOAuthToken,
  numOrNull,
  floatOrNull,
  probeAnthropicLimits,
};
