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

const {
  readClaudeOAuthCredential, fetchClaudeUsage, probeClaudeUsageViaCli, normalizeUsage,
} = require('../auth/claude.cjs');
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
      // Either path needs a Claude Code install, but not necessarily the
      // binary: a stored credential is enough for the direct fetch, so someone
      // who signed in once still gets a number after taking `claude` off PATH.
      available: tools => !!tools.claude?.installed,

      // Read the token and use it; spawn the CLI only when that can't work.
      //
      // Both routes end at the same endpoint with the same body, so the choice
      // is purely about cost. Spawning is the expensive one, and not in CPU:
      // on macOS the CLI raises its own system permission prompts (Media
      // Library, Documents, Downloads), and because macOS keys those to the
      // binary's path — which changes on every `claude` update — a user gets
      // re-asked after each upgrade. Doing that on a five-minute poll would
      // interrupt someone mid-task for a number they never asked to refresh.
      //
      // A live token avoids it entirely, and a token is live for eight hours.
      // So the CLI runs only when the token is missing, expired, or rejected —
      // roughly once per eight hours instead of once per poll — and what it
      // buys there is the renewal Lens cannot perform itself.
      probe: async () => {
        const cred = await readClaudeOAuthCredential();

        if (cred && !cred.expired) {
          const result = await fetchClaudeUsage(cred.token);
          const bodyPreview = String(result.body || '').slice(0, 4000);
          const haveAny = result.limits != null
            && (result.limits.fiveHour.utilization != null || result.limits.weekly.utilization != null || result.limits.modelWindows.length > 0);
          if (haveAny) {
            return { ok: true, limits: result.limits, debug: { via: 'token', status: result.status, body: bodyPreview } };
          }
          // 401/403 on a token we believed was live means the credential was
          // revoked or rotated out from under us — the CLI holds the refresh
          // token and may be able to trade it for a working one, so it is
          // worth the spawn. Any other empty answer is the endpoint's, and
          // asking again through the CLI would only spend a prompt to hear it
          // a second time.
          if (result.status !== 401 && result.status !== 403) {
            return {
              ok: false, error: 'no-data', status: result.status,
              message: 'Usage endpoint returned no rate limit data',
              debug: { via: 'token', status: result.status, body: bodyPreview },
            };
          }
        }

        // No usable token. Hand the question to the CLI, which renews as part
        // of answering it.
        try {
          const viaCli = await probeClaudeUsageViaCli();
          if (viaCli && viaCli.rate_limits_available && viaCli.rate_limits) {
            return { ok: true, limits: normalizeUsage(viaCli.rate_limits), debug: { via: 'cli' } };
          }
          // `rate_limits_available: false` is an answer, not a failure:
          // API-key, Bedrock and Vertex sessions have no plan windows at all.
          if (viaCli && viaCli.rate_limits_available === false) {
            return {
              ok: false, error: 'no-data',
              message: 'No subscription plan limits for this account (API key, Bedrock or Vertex)',
              debug: { via: 'cli', subscription: viaCli.subscription_type ?? null },
            };
          }
          return { ok: false, error: 'no-data', message: 'Claude Code returned no rate limit data', debug: { via: 'cli' } };
        } catch (e) {
          // The CLI was the last resort, so its failure is what the user sees.
          // Which message depends on why the token could not be used: a
          // credential that exists and was rejected is a different problem
          // from never having signed in.
          const why = String(e?.message || e);
          if (!cred) {
            return { ok: false, error: 'no-token', message: 'Not signed in — run claude to sign in', debug: { via: 'cli', cliError: why } };
          }
          if (cred.expired) {
            return { ok: false, error: 'expired', message: 'Claude Code token expired and it could not be renewed — run any claude command', debug: { via: 'cli', cliError: why } };
          }
          return { ok: false, error: 'unauthorized', message: 'Anthropic rejected the token — sign in to Claude Code again', debug: { via: 'cli', cliError: why } };
        }
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
