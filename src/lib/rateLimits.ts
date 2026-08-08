// Real Anthropic rate-limit window data, read from the OAuth usage endpoint
// with the user's Claude Code OAuth token. Renderer-side consent + polling.
//
// Three states: 'pending' (haven't asked), 'granted', 'denied'. Pending makes
// the renderer surface a one-shot consent modal explaining the trade-off
// (token leaves for Anthropic, possible Keychain prompt on macOS) before any
// IPC fires.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { RateLimits, RateLimitsResult } from '../types';

const CONSENT_KEY = 'rate-limits-consent';
type Consent = 'pending' | 'granted' | 'denied';

export function useRateLimitsConsent(): [Consent, (v: Consent) => void] {
  const [consent, setConsent] = useState<Consent>(() => {
    try {
      const v = localStorage.getItem(CONSENT_KEY);
      return v === 'granted' || v === 'denied' ? v : 'pending';
    } catch { return 'pending'; }
  });
  // Main process is the single source of truth (appPrefs). localStorage is a
  // synchronous seed so the first render doesn't have to wait for the IPC
  // round-trip; on mount we pull the canonical value from main and reconcile.
  useEffect(() => {
    let cancelled = false;
    window.api.getAppPrefs?.().then(prefs => {
      if (cancelled) return;
      const main = (prefs as { rateLimitsConsent?: Consent } | undefined)?.rateLimitsConsent;
      if (main === 'granted' || main === 'denied') {
        if (main !== consent) {
          try { localStorage.setItem(CONSENT_KEY, main); } catch {}
          setConsent(main);
        }
      } else if (consent !== 'pending') {
        // localStorage has a decision but main doesn't — push it to main once.
        window.api.setRateLimitsConsent?.(consent).catch(() => {});
      }
    }).catch(() => {});
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const set = useCallback((v: Consent) => {
    try { localStorage.setItem(CONSENT_KEY, v); } catch {}
    setConsent(v);
    // Mirror to main process so its `rateLimits:get` gate sees the change
    // without waiting for an app restart.
    window.api.setRateLimitsConsent?.(v).catch(() => {});
  }, []);
  return [consent, set];
}

const POLL_INTERVAL = 5 * 60 * 1000;
// A window that resets in 10 minutes would otherwise sit at "limit reached"
// until the next 5-minute tick happens to land (and even then main's own
// 5-minute cache can hand back the pre-reset snapshot). So each successful
// probe also arms a one-shot forced re-probe just after the earliest reset.
// One-shot matters: a repeating retry against a stale answer would hammer
// Anthropic's usage endpoint for nothing — one extra call, then wait for the
// ordinary poll.
const RESET_REFRESH_BUFFER = 10_000;
// Floor so a reset that is already in the past when the timer is armed doesn't
// fire a probe in the same tick as the response that reported it.
const MIN_RESET_REFRESH_DELAY = 60_000;
// Two windows rolling over this close together are treated as one event. Kept
// separate from the floor above: they answer different questions (how long to
// wait vs. which resets are the same rollover) and want to move independently.
const RESET_MERGE_WINDOW = 60_000;
// Sanity bound on a reset timestamp. A malformed header far enough in the
// future overflows setTimeout's 2^31-1 ms argument, which the spec turns into
// "fire immediately" — the opposite of what the value asks for, and a wasted
// paid probe. The real windows are 5 hours and 7 days.
const MAX_RESET_HORIZON = 30 * 24 * 60 * 60 * 1000;

export type RateLimitsDebug = { status: number; headers?: Record<string, string>; body: string };
export type RateLimitsState = {
  limits: RateLimits | null;
  // Which provider the current `limits` came from. The hook deliberately keeps
  // the previous provider's numbers on screen across a source flip, so without
  // this the reset scheduler cannot tell whose resets it is looking at — and
  // arming a Claude network probe off Codex's schedule would fire requests at
  // moments that mean nothing for the data on screen.
  limitsSource: 'claude' | 'codex' | null;
  fetchedAt: number | null;
  loading: boolean;
  error: string | null;
  debug: RateLimitsDebug | null;
};

export function useRateLimits(enabled: boolean, source: 'claude' | 'codex' = 'claude'): {
  state: RateLimitsState;
  refresh: () => void;
} {
  const [state, setState] = useState<RateLimitsState>({ limits: null, limitsSource: null, fetchedAt: null, loading: false, error: null, debug: null });
  const timerRef = useRef<number | null>(null);
  // Two-layer staleness guard (see useSourceAuth for the rationale):
  // 1. Drop results belonging to a source the user has flipped away from.
  // 2. Drop results when a newer tick has already started — prevents a slow
  //    Anthropic probe from clobbering the fast one that ran right after.
  const activeSourceRef = useRef(source);
  const seqRef = useRef(0);

  const tick = useCallback(async (force = false) => {
    const fetchSource = source;
    const seq = ++seqRef.current;
    activeSourceRef.current = fetchSource;
    setState(s => ({ ...s, loading: true }));
    try {
      const r = await window.api.getRateLimits({ force, source: fetchSource });
      if (activeSourceRef.current !== fetchSource || seq !== seqRef.current) return;
      if (r.ok) {
        setState({ limits: r.limits, limitsSource: fetchSource, fetchedAt: r.fetchedAt, loading: false, error: null, debug: (r.debug ?? null) as RateLimitsDebug | null });
      } else {
        setState(s => ({ ...s, loading: false, error: r.message, debug: (r.debug ?? null) as RateLimitsDebug | null }));
      }
    } catch (e: any) {
      if (activeSourceRef.current !== fetchSource || seq !== seqRef.current) return;
      setState(s => ({ ...s, loading: false, error: String(e?.message || e) }));
    }
  }, [source]);

  // Latest state, readable from event handlers that must not re-subscribe every
  // time the numbers change.
  const stateRef = useRef(state);
  useEffect(() => { stateRef.current = state; }, [state]);
  const sourceRef = useRef(source);
  useEffect(() => { sourceRef.current = source; }, [source]);
  // The reset whose forced refresh has already been spent. Waking the app up
  // repeatedly must not re-buy the same rollover.
  const forcedResetKeyRef = useRef<string | null>(null);

  // Refresh on becoming visible again. Forced only when a window has actually
  // rolled over and this rollover has not been paid for yet; otherwise plain,
  // which main's TTL usually answers from cache at no cost.
  const wake = useCallback(() => {
    const s = stateRef.current;
    const key = s.limitsSource === sourceRef.current ? resetSchedule(s.limits).join(',') : '';
    if (hasRolledOver(s) && key && forcedResetKeyRef.current !== key) {
      forcedResetKeyRef.current = key;
      tick(true);
    } else {
      tick(false);
    }
  }, [tick]);

  // Focus fires every time the user clicks back into an already-visible window,
  // so it only acts when a window has actually rolled over. That is the case
  // visibilitychange can miss: after a laptop sleeps with Lens on screen the
  // page never goes hidden, it just wakes up holding a window that has expired.
  const onFocus = useCallback(() => {
    if (hasRolledOver(stateRef.current)) wake();
  }, [wake]);

  useEffect(() => {
    if (!enabled) {
      // Bump the seq counter so any in-flight tick() from before the flip lands
      // after `setState({...empty})` and gets discarded — otherwise the cleared
      // quota would briefly come back when the slow probe finishes.
      seqRef.current++;
      // Clear cached data when consent is revoked / demo mode toggled on, so the
      // sidebar bars and Usage hero stop showing stale numbers immediately.
      setState({ limits: null, limitsSource: null, fetchedAt: null, loading: false, error: null, debug: null });
      if (timerRef.current != null) { clearInterval(timerRef.current); timerRef.current = null; }
      return;
    }
    // Source switch (or first enable): kick off a fresh tick but **keep the
    // previous limits visible** until the new value lands. Previously we
    // wiped to `null` here, which made RateBar drop to its 2% empty
    // fallback and animate back up over the 350ms transition — visually
    // reads as "bar resets to zero and refills" on every poll / source
    // flip. Stale Claude data showing for ~1s after a Codex switch is the
    // worse-of-two-evils tradeoff we're explicitly making; the active
    // source label in the sidebar makes the brief inconsistency obvious.
    seqRef.current++;
    // Visibility gate. Lens hides to the tray instead of quitting and can even
    // launch hidden at login, so an ungated interval keeps buying Claude probes
    // while nobody is looking at the numbers. Nothing is lost by pausing: the
    // wake handler above catches up the moment the window comes back.
    const stop = () => {
      if (timerRef.current != null) { clearInterval(timerRef.current); timerRef.current = null; }
    };
    const start = () => {
      stop();
      timerRef.current = window.setInterval(() => tick(false), POLL_INTERVAL);
    };
    const onVisibility = () => {
      if (document.hidden) { stop(); return; }
      wake();
      start();
    };
    if (!document.hidden) {
      setState(s => ({ ...s, loading: true }));
      tick(false);
      start();
    }
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('focus', onFocus);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('focus', onFocus);
    };
  }, [enabled, tick, wake, onFocus]);

  // Reset-aligned refresh. `force` skips main's TTL cache, which would
  // otherwise replay the pre-reset snapshot for up to five more minutes.
  // Keyed on the reset values alone — deliberately NOT on `fetchedAt`, which
  // would re-arm after every probe and turn a reset the API keeps reporting as
  // past into a standing stream of forced requests. One arm per distinct set of
  // resets is what makes this "refresh once when a window rolls over": every
  // poll in between reports the same resets and leaves the pending timers
  // alone, and if a forced probe comes back with the same stale reset, nothing
  // re-arms — the ordinary poll takes it from there. Re-arming on a changed key
  // is free: the targets are absolute, so a timer cannot fire twice for one
  // rollover.
  const scheduleKey = state.limitsSource === source ? resetSchedule(state.limits).join(',') : '';
  useEffect(() => {
    if (!enabled || !scheduleKey) return;
    const fire = () => {
      // Hidden: skip the probe entirely. The rollover is not lost — the
      // wake handler sees the expired window and runs the refresh then, when
      // there is someone to read it.
      if (document.hidden) return;
      forcedResetKeyRef.current = scheduleKey;
      tick(true);
    };
    const ids = scheduleKey.split(',').map(value => {
      const delay = Number(value) + RESET_REFRESH_BUFFER - Date.now();
      return window.setTimeout(fire, Math.max(delay, MIN_RESET_REFRESH_DELAY));
    });
    return () => ids.forEach(clearTimeout);
  }, [enabled, tick, scheduleKey]);

  return { state, refresh: () => tick(true) };
}

// Every window's reset moment, epoch ms, ascending. Each one gets its own
// timer: the 7-day rollover sits hours or days away from the 5-hour one, so
// watching only the earliest would leave the weekly badge stale until an
// unrelated poll happened to land on it. Nulls and non-finite values are
// skipped so a malformed header can't take the whole schedule down.
function resetSchedule(limits: RateLimits | null): number[] {
  if (!limits) return [];
  const stamps: number[] = [];
  const horizon = Date.now() + MAX_RESET_HORIZON;
  for (const w of [limits.fiveHour, limits.weekly, ...(limits.modelWindows ?? [])]) {
    if (w?.reset == null) continue;
    const ms = w.reset * 1000;
    if (Number.isFinite(ms) && ms <= horizon) stamps.push(ms);
  }
  stamps.sort((a, b) => a - b);
  // Collapse resets landing close together — when both windows roll over at
  // nearly the same moment, a second probe seconds later reports the same thing
  // and costs the same quota. The cluster keeps its LATEST member: probing at
  // the earliest one would run before the later window has actually rolled
  // over, so that window would silently lose its aligned refresh.
  const merged: number[] = [];
  for (const ms of stamps) {
    if (merged.length && ms - merged[merged.length - 1] < RESET_MERGE_WINDOW) merged.pop();
    merged.push(ms);
  }
  return merged;
}

// Re-render driver for countdown labels. `resetInLabel` reads the clock at
// render time, but nothing else re-renders between five-minute polls, so a
// "10m" label would otherwise sit frozen until fresh data arrived.
export function useNowTick(intervalMs = 30_000): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    // Skipped while hidden: nobody is reading the countdown, and re-rendering
    // the quota cards behind a hidden window is pure waste. Coming back into
    // view re-renders anyway.
    const id = window.setInterval(() => { if (!document.hidden) setTick(t => t + 1); }, intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return tick;
}

// Whether either window in a snapshot has passed its reset moment.
function hasRolledOver(state: RateLimitsState): boolean {
  if (!state.limits) return false;
  return [state.limits.fiveHour, state.limits.weekly, ...(state.limits.modelWindows ?? [])].some(isWindowExpired);
}

// Whether a window's reset moment has already passed. Its numbers describe a
// window that has since rolled over, so they say nothing about the live one —
// callers drop the "limit reached" badge instead of asserting a stale verdict.
export function isWindowExpired(w: { reset: number | null } | null | undefined): boolean {
  if (!w || w.reset == null) return false;
  const ms = w.reset * 1000;
  return Number.isFinite(ms) && ms <= Date.now();
}

export function pct(w: { utilization: number | null }): number | null {
  if (w.utilization == null) return null;
  return Math.max(0, Math.min(100, w.utilization * 100));
}

// Anthropic returns reset as Unix epoch seconds. Pass the i18n translator to
// get locale-aware unit suffixes; falls back to English when omitted.
export function resetInLabel(reset: number | null, tr?: (key: any, vars?: Record<string, string | number>) => string): string | null {
  if (reset == null) return null;
  const t = reset * 1000;
  if (!Number.isFinite(t)) return null;
  const ms = t - Date.now();
  // Past the reset the window has rolled over and these numbers are stale, so
  // there is no countdown left to state — the old "now" read as "your quota is
  // resetting right this second", which stayed on screen long after it wasn't.
  // The reset-aligned refresh above replaces the data seconds later.
  if (ms <= 0) return null;
  const min = Math.floor(ms / 60000);
  if (min < 60) return tr ? tr('time.minLeft', { n: min }) : `${min}m`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h < 24) {
    if (m > 0) return tr ? tr('time.hmLeft', { h, m }) : `${h}h ${m}m`;
    return tr ? tr('time.hLeft', { n: h }) : `${h}h`;
  }
  const d = Math.floor(h / 24);
  const remainingHours = h % 24;
  if (remainingHours > 0) {
    return tr
      ? `${tr('time.dLeft', { n: d })} ${tr('time.hLeft', { n: remainingHours })}`
      : `${d}d ${remainingHours}h`;
  }
  return tr ? tr('time.dLeft', { n: d }) : `${d}d`;
}

// Anthropic's `anthropic-ratelimit-unified-*-status` header reports one of
// 'allowed' | 'allowed_warning' | 'rejected' (not the 'warning'/'exceeded'
// this code once assumed). Collapse it to a display kind so the badge colour
// and label never leak the raw enum. Match on substrings so an unknown but
// non-'allowed' value still surfaces as a limit hit rather than nothing.
export type RateStatusKind = 'ok' | 'warning' | 'exceeded';

export function rateStatusKind(status: string | null | undefined): RateStatusKind {
  if (!status) return 'ok';
  const s = status.toLowerCase();
  if (s === 'allowed') return 'ok';
  if (s.includes('warning')) return 'warning';
  return 'exceeded';
}

// Short relative time since a timestamp — "just now" / "12s" / "3m" / "1h".
export function agoLabel(ts: number | null, tr?: (key: any, vars?: Record<string, string | number>) => string): string {
  if (ts == null) return '—';
  const ms = Date.now() - ts;
  if (ms < 15_000) return tr ? tr('time.justNow') : 'just now';
  if (ms < 60_000) {
    // "12s ago" — sub-minute branch; we don't bother i18n-ising seconds
    // because it only appears for ~45 seconds total, falling through to
    // the minute branch quickly.
    return `${Math.floor(ms / 1000)}s ago`;
  }
  if (ms < 3_600_000) {
    const n = Math.floor(ms / 60_000);
    return tr ? tr('time.minAgo', { n }) : `${n}m ago`;
  }
  if (ms < 86_400_000) {
    const n = Math.floor(ms / 3_600_000);
    return tr ? tr('time.hAgo', { n }) : `${n}h ago`;
  }
  const n = Math.floor(ms / 86_400_000);
  return tr ? tr('time.dAgo', { n }) : `${n}d ago`;
}
