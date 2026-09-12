// Live subscription quota (rate limits), per AI source.
//
// Two consumers share this one service, and that sharing is the point:
//   • the `rateLimits:get` IPC, driven by the renderer's 5-minute poll
//   • the macOS menu-bar title poller (lib/tray-quota.cjs), driven by main
// Both go through `get()`, so a probe one of them just paid for is reused by
// the other instead of firing a second request at Anthropic.
//
// Provider registry rather than branches: adding a future AI tool is one
// entry here, not new `if (source === ...)` arms in every caller.

const { readClaudeOAuthCredential, fetchClaudeUsage } = require('../auth/claude.cjs');
const { detectAiTools } = require('./system-caps.cjs');

// 5 min TTL — short enough to feel live, long enough that 1-token probes don't
// add up. Keyed by source so claude + codex don't trample each other.
const RATE_LIMITS_TTL = 5 * 60 * 1000;

function createRateLimitsService({ probeCodexLimits, getConsent }) {
  const cacheBySource = new Map();
  const inFlightBySource = new Map();
  // Consumers that want every probe, not just the ones they asked for. The
  // renderer and the menu-bar poller each refresh on their own schedule, and
  // whichever fires first is the one that learns the new number — a listener
  // is how the other one finds out without waiting for its own next tick.
  const listeners = new Set();

  const PROVIDERS = {
    claude: {
      needsToken: true,
      // The probe reads the OAuth credential under ~/.claude — it never runs
      // the CLI — so someone who signed in once still gets a number after
      // taking `claude` off PATH. Presence of the CLI is the wrong question
      // here; presence of a Claude Code install in any form is the right one.
      available: tools => !!tools.claude?.installed,
      probe: async () => {
        const cred = await readClaudeOAuthCredential();
        if (!cred) return { ok: false, error: 'no-token', message: 'Sign in via `claude` CLI first' };
        // Short-circuit a request we know comes back 401: the CLI renews its
        // access token only when it runs, so an idle machine keeps serving a
        // dead one. Re-login is the wrong advice here — the refresh token is
        // still good, it just needs the CLI to spend it.
        if (cred.expired) {
          return { ok: false, error: 'expired', message: 'Claude Code token expired — run any `claude` command to renew it (no re-login needed)' };
        }
        const result = await fetchClaudeUsage(cred.token);
        const bodyPreview = String(result.body || '').slice(0, 4000);
        if (result.status === 401 || result.status === 403) {
          // Expiry is already ruled out above, so a rejection here means the
          // credential itself is no longer accepted (revoked, logged out
          // elsewhere) — that one really does need a fresh login.
          return { ok: false, error: 'unauthorized', status: result.status, message: 'Anthropic rejected the token — re-login Claude Code', debug: { status: result.status, body: bodyPreview } };
        }
        const haveAny = result.limits != null
          && (result.limits.fiveHour.utilization != null || result.limits.weekly.utilization != null || result.limits.modelWindows.length > 0);
        if (!haveAny) {
          return { ok: false, error: 'no-data', status: result.status, message: 'Usage endpoint returned no rate limit data', debug: { status: result.status, body: bodyPreview } };
        }
        return { ok: true, limits: result.limits, debug: { status: result.status, body: bodyPreview } };
      },
    },
    codex: {
      needsToken: false,
      // The probe spawns `codex app-server`. No binary, no number — whatever
      // history is still sitting under ~/.codex.
      available: tools => !!tools.codex?.hasBinary,
      probe: async () => {
        try {
          const result = await probeCodexLimits();
          const haveAny = result.limits.fiveHour.utilization != null || result.limits.weekly.utilization != null;
          if (!haveAny) {
            return { ok: false, error: 'no-data', message: 'codex app-server returned no rate limits' };
          }
          return { ok: true, limits: result.limits, debug: result.headersDump };
        } catch (e) {
          return { ok: false, error: 'codex-probe-failed', message: String(e?.message || e) };
        }
      },
    },
  };

  async function get({ force = false, source = 'claude' } = {}) {
    // Defense-in-depth consent gate: Claude probes hit Anthropic's API with the
    // user's OAuth token. The renderer enforces consent before calling, but we
    // also check the persisted appPrefs flag so a compromised renderer can't
    // skip it. Codex probe is a local subprocess (no network) — no gate.
    if (source !== 'codex' && getConsent() !== 'granted') {
      return { ok: false, error: 'no-consent', message: 'Rate limits consent not granted' };
    }
    const provider = PROVIDERS[source] || PROVIDERS.claude;
    const cached = cacheBySource.get(source);
    if (!force && cached && Date.now() - cached.fetchedAt < RATE_LIMITS_TTL) {
      return { ok: true, cached: true, ...cached.data };
    }
    // Join a probe that is already running instead of starting a second one.
    // Several triggers can land together — the reset-aligned refresh colliding
    // with the ordinary poll, the tray poller waking on its own timer, a manual
    // refresh, or StrictMode's double effect in dev — and each would otherwise
    // open its own network request. A forced caller never joins: it is asking
    // for data newer than anything already in flight (that is the whole point
    // of skipping the TTL above).
    const inFlight = inFlightBySource.get(source);
    if (!force && inFlight) return inFlight;
    const pending = (async () => {
      let result;
      try {
        const res = await provider.probe();
        if (res.ok) {
          const data = { limits: res.limits, fetchedAt: Date.now() };
          cacheBySource.set(source, { fetchedAt: Date.now(), data });
          result = { ok: true, cached: false, ...data, debug: res.debug };
        } else {
          result = res;
        }
      } catch (e) {
        result = { ok: false, error: 'network', message: String(e?.message || e) };
      }
      // Announced for failures too: "this source could not be read just now"
      // is exactly as much news as a new percentage, and a listener that draws
      // the number needs both to avoid presenting a dead one as current.
      for (const fn of listeners) { try { fn(source, result); } catch {} }
      return result;
    })();
    inFlightBySource.set(source, pending);
    try {
      return await pending;
    } finally {
      if (inFlightBySource.get(source) === pending) inFlightBySource.delete(source);
    }
  }

  // Sources this host can actually produce a number for.
  //
  // One answer, two consumers: the menu-bar poller (which providers to probe
  // and draw) and the Settings rows that configure it. Deciding it separately
  // in each would let the two disagree — a title that hides Codex while
  // Settings still offers to put Codex first is worse than either behaviour on
  // its own. `detectAiTools` caches for the process lifetime, so this is a
  // property lookup after the first call.
  function availableSources() {
    const tools = detectAiTools();
    return Object.keys(PROVIDERS).filter(id => PROVIDERS[id].available(tools));
  }

  // Fires after every completed probe, with the same result shape `get()`
  // returns. Cache hits are silent — nothing changed for anyone to react to.
  function subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  return { get, subscribe, sources: Object.keys(PROVIDERS), availableSources };
}

module.exports = { createRateLimitsService, RATE_LIMITS_TTL };
