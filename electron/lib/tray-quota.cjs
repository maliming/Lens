// Weekly quota in the macOS menu bar.
//
// macOS-only by construction: `tray.setTitle()` exists on no other platform,
// so on Windows / Linux every method here is a no-op and the Settings row that
// drives it is hidden. Renderer-side polling can't do this job — the window is
// usually hidden behind the tray when the user wants to glance at the menu
// bar, and Chromium throttles a hidden window's timers. So main polls.
//
// Probes go through the shared rate-limits service, which means the 5-minute
// interval below lands on the same TTL the renderer's poll uses: whichever
// side probes first pays, the other reads the cache.

const POLL_INTERVAL = 5 * 60 * 1000;

// Declaration order is the fallback order; the user picks the real one in
// Settings (`menuBarQuotaOrder`), because the title carries no labels and
// position is the only thing telling the two numbers apart.
const PROVIDERS = [
  // `needsConsent` mirrors the rate-limits service's own gate. A provider the
  // user has not opted into is not merely failing to report — it was never
  // asked, and saying N/A for it would describe a problem that doesn't exist.
  { id: 'claude', name: 'Claude Code', needsConsent: true },
  { id: 'codex', name: 'OpenAI Codex', needsConsent: false },
];

// Stands in for a provider that exists on this machine but whose last probe
// came back without a number. Without it the surviving percentage slides into
// the first slot and silently reads as the other provider's — the one failure
// mode a label-free title has to rule out. A provider the host doesn't have is
// not shown at all (see `activeProviders`): there is no second number for it to
// be confused with, so a placeholder would be pure noise.
//
// Spelled out rather than an en dash because the usual way to land here is an
// expired Claude token on an idle machine, and a lone dash beside a live
// percentage reads as a separator, not as "this number is missing".
const MISSING = 'N/A';

// Weekly utilization (0..1 used) → whole-percent remaining. A malformed header
// outside the range would otherwise render as "-14%" or "312%".
function remainingPercent(window) {
  const u = window && typeof window.utilization === 'number' ? window.utilization : null;
  if (u == null || !Number.isFinite(u)) return null;
  return Math.round(Math.min(1, Math.max(0, 1 - u)) * 100);
}

// `reset` is a Unix epoch in SECONDS (Anthropic's header unit). Renders the
// two coarsest non-zero units — "2d 4h", "3h 12m", "8m" — because the menu
// item is a glance target, not a countdown.
function resetsInLabel(reset) {
  if (typeof reset !== 'number' || !Number.isFinite(reset)) return null;
  const ms = reset * 1000 - Date.now();
  if (ms <= 0) return null;
  const mins = Math.floor(ms / 60000);
  const days = Math.floor(mins / 1440);
  const hours = Math.floor((mins % 1440) / 60);
  const rem = mins % 60;
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return rem > 0 ? `${hours}h ${rem}m` : `${hours}h`;
  return `${Math.max(1, mins)}m`;
}

function createTrayQuota({ getTray, getPrefs, rateLimits }) {
  const supported = process.platform === 'darwin';
  // id → { percent, reset } for whatever the last poll could resolve. A source
  // that failed is deleted rather than kept at a stale number: a menu bar
  // showing yesterday's percentage is worse than one showing nothing.
  const snapshot = new Map();
  // id → why its last probe produced no number. Kept separate from `snapshot`
  // so the title can tell "hasn't been probed yet" (stay blank) apart from
  // "probed and came back empty" (say N/A) — without it, a launch flashes a
  // placeholder for the second it takes the first poll to land.
  const failures = new Map();
  let timer = null;
  let polling = false;
  // Bumped on every sync so a poll that was in flight when the feature got
  // switched off (or the tray destroyed) can't paint a title afterwards.
  let generation = 0;

  // Providers this host can produce a number for at all. A machine with only
  // one of the two CLIs would otherwise carry a permanent placeholder for the
  // other — and for the missing provider it never clears, because nothing on
  // this machine can ever fill it. The answer comes from the shared service so
  // the Settings rows and this title cannot disagree about who exists.
  //
  // Consent is filtered here rather than in the service because it is a
  // different question: the service answers "can this host report a quota",
  // which Settings needs whatever the consent flag currently says, while the
  // title needs "is there a number coming". Declining the probe drops the
  // provider from the title entirely instead of parking an N/A there forever.
  // `sync()` runs on every consent change, so this re-evaluates immediately.
  function activeProviders() {
    const ids = rateLimits.availableSources();
    const prefs = getPrefs();
    return PROVIDERS.filter(p => {
      if (!ids.includes(p.id)) return false;
      if (p.needsConsent && prefs?.rateLimitsConsent !== 'granted') return false;
      return true;
    });
  }

  // Pref order, defensively normalised: unknown ids dropped, duplicates
  // collapsed, and any provider the pref never mentioned appended in
  // declaration order. A hand-edited or stale prefs file therefore degrades to
  // a sane order instead of hiding a provider.
  function orderedProviders() {
    const prefs = getPrefs();
    const active = activeProviders();
    const wanted = Array.isArray(prefs && prefs.menuBarQuotaOrder) ? prefs.menuBarQuotaOrder : [];
    const out = [];
    for (const id of wanted) {
      const p = active.find(x => x.id === id);
      if (p && !out.includes(p)) out.push(p);
    }
    for (const p of active) if (!out.includes(p)) out.push(p);
    return out;
  }

  function enabled() {
    if (!supported) return false;
    const prefs = getPrefs();
    return !!(prefs && prefs.showTrayIcon && prefs.menuBarQuota);
  }

  // Why a provider has no number, phrased for the context menu. The probe's
  // own `message` is written for the Usage pane and repeats the provider name,
  // which reads badly after the "Claude Code — " prefix the menu already
  // supplies, so map the error codes to menu-sized phrases instead.
  const REASONS = {
    expired: 'CLI unavailable, stored token expired',
    'no-token': 'CLI unavailable and not signed in',
    unauthorized: 'token rejected, sign in again',
    'no-consent': 'usage access not granted',
    'no-data': 'no quota reported',
  };

  function reasonFor(result) {
    if (!result) return 'probe failed';
    if (result.ok) return 'no weekly window reported';
    return REASONS[result.error] || 'probe failed';
  }

  // One reading of a probe result, shared by the poll and the subscription, so
  // a number that arrives by push can never mean something different from the
  // same number arriving by poll. A source that couldn't be read is deleted
  // rather than left at its last value: a menu bar showing yesterday's
  // percentage is worse than one showing nothing.
  function absorb(id, result) {
    const weekly = result && result.ok && result.limits ? result.limits.weekly : null;
    const percent = remainingPercent(weekly);
    if (percent == null) {
      snapshot.delete(id);
      failures.set(id, reasonFor(result));
      return;
    }
    const reset = weekly && typeof weekly.reset === 'number' ? weekly.reset : null;
    snapshot.set(id, { percent, reset });
    failures.delete(id);
  }

  function applyTitle() {
    const tray = getTray();
    if (!tray) return;
    if (!enabled()) {
      try { tray.setTitle(''); } catch {}
      return;
    }
    const providers = orderedProviders();
    // Nothing has been probed yet (launch, or the feature was just switched
    // on): show the bare icon rather than a row of placeholders that resolves
    // into numbers a second later. Once a probe has answered, an empty result
    // is real news and gets said out loud — a blank title there is
    // indistinguishable from the feature being off.
    if (!providers.some(p => snapshot.has(p.id) || failures.has(p.id))) {
      try { tray.setTitle(''); } catch {}
      return;
    }
    const parts = providers.map(p => {
      const entry = snapshot.get(p.id);
      return entry ? `${entry.percent}%` : MISSING;
    });
    // Two spaces, not a separator glyph: the menu bar already renders in the
    // system font at system tracking, and a "·" between two short numbers
    // reads as noise there.
    try { tray.setTitle(parts.join('  ')); } catch {}
  }

  async function poll() {
    if (!enabled() || polling) return;
    polling = true;
    const gen = generation;
    try {
      const results = await Promise.all(activeProviders().map(async p => {
        try {
          return [p.id, await rateLimits.get({ source: p.id })];
        } catch {
          return [p.id, null];
        }
      }));
      // A sync() during the probe means these numbers answer a question the
      // user has already changed — drop them rather than repaint.
      if (gen !== generation) return;
      for (const [id, result] of results) absorb(id, result);
      applyTitle();
    } finally {
      polling = false;
    }
  }

  // Called on startup and after anything that changes the answer: the pref
  // itself, the tray being created / destroyed, or rate-limits consent being
  // granted (which is what makes the Claude half probeable at all).
  function sync() {
    if (!supported) return;
    generation++;
    if (timer) { clearInterval(timer); timer = null; }
    if (!enabled()) {
      snapshot.clear();
      failures.clear();
      applyTitle();
      return;
    }
    timer = setInterval(() => { poll().catch(() => {}); }, POLL_INTERVAL);
    // Don't let the quota poll be the reason a quit hangs.
    if (typeof timer.unref === 'function') timer.unref();
    applyTitle();
    poll().catch(() => {});
  }

  // The renderer probes the same service on its own five-minute schedule, and
  // forces one the moment a window resets. Waiting for our own next tick to
  // notice would leave the menu bar on a number the app's own Usage view has
  // already replaced — for up to a full interval, and right after a reset,
  // which is precisely when the user looks. So take every probe as it lands,
  // whoever paid for it, and let the timer below cover the stretches when the
  // renderer isn't polling at all (window hidden, or closed to the tray).
  const unsubscribe = rateLimits.subscribe((source, result) => {
    if (!enabled()) return;
    if (!activeProviders().some(p => p.id === source)) return;
    absorb(source, result);
    applyTitle();
  });

  function stop() {
    generation++;
    unsubscribe();
    if (timer) { clearInterval(timer); timer = null; }
  }

  // Read-only rows for the tray's context menu. Returns [] when the feature is
  // off so the menu keeps its current two-item shape. The menu is rebuilt on
  // every right-click, so these render whatever the last poll resolved.
  function menuItems() {
    if (!enabled()) return [];
    // Same order as the title. This menu is where the user learns which
    // number belongs to whom, so the two must never disagree.
    const rows = orderedProviders().map(p => {
      const entry = snapshot.get(p.id);
      if (!entry) {
        const why = failures.get(p.id);
        return { label: why ? `${p.name} — ${why}` : `${p.name} — checking…`, enabled: false };
      }
      const resets = resetsInLabel(entry.reset);
      const suffix = resets ? ` · resets in ${resets}` : '';
      return { label: `${p.name} — ${entry.percent}% weekly left${suffix}`, enabled: false };
    });
    // No providers on this host: return nothing rather than a separator with
    // nothing above it.
    if (rows.length === 0) return [];
    return [...rows, { type: 'separator' }];
  }

  return { sync, stop, menuItems };
}

module.exports = { createTrayQuota };
