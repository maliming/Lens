// Real Anthropic rate-limit window data, obtained by probing the Messages API
// with the user's Claude Code OAuth token. Renderer-side consent + polling.
//
// Three states: 'pending' (haven't asked), 'granted', 'denied'. Pending makes
// the renderer surface a one-shot consent modal explaining the trade-off
// (~1 token per probe, possible Keychain prompt on macOS) before any IPC fires.

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

export type RateLimitsDebug = { status: number; headers: Record<string, string>; body: string };
export type RateLimitsState = {
  limits: RateLimits | null;
  fetchedAt: number | null;
  loading: boolean;
  error: string | null;
  debug: RateLimitsDebug | null;
};

export function useRateLimits(enabled: boolean, source: 'claude' | 'codex' = 'claude'): {
  state: RateLimitsState;
  refresh: () => void;
} {
  const [state, setState] = useState<RateLimitsState>({ limits: null, fetchedAt: null, loading: false, error: null, debug: null });
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
        setState({ limits: r.limits, fetchedAt: r.fetchedAt, loading: false, error: null, debug: (r.debug ?? null) as RateLimitsDebug | null });
      } else {
        setState(s => ({ ...s, loading: false, error: r.message, debug: (r.debug ?? null) as RateLimitsDebug | null }));
      }
    } catch (e: any) {
      if (activeSourceRef.current !== fetchSource || seq !== seqRef.current) return;
      setState(s => ({ ...s, loading: false, error: String(e?.message || e) }));
    }
  }, [source]);

  useEffect(() => {
    if (!enabled) {
      // Bump the seq counter so any in-flight tick() from before the flip lands
      // after `setState({...empty})` and gets discarded — otherwise the cleared
      // quota would briefly come back when the slow probe finishes.
      seqRef.current++;
      // Clear cached data when consent is revoked / demo mode toggled on, so the
      // sidebar bars and Usage hero stop showing stale numbers immediately.
      setState({ limits: null, fetchedAt: null, loading: false, error: null, debug: null });
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
    setState(s => ({ ...s, loading: true }));
    tick(false);
    timerRef.current = window.setInterval(() => tick(false), POLL_INTERVAL);
    return () => {
      if (timerRef.current != null) { clearInterval(timerRef.current); timerRef.current = null; }
    };
  }, [enabled, tick]);

  return { state, refresh: () => tick(true) };
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
  if (ms <= 0) return tr ? tr('time.now') : 'now';
  const min = Math.floor(ms / 60000);
  if (min < 60) return tr ? tr('time.minLeft', { n: min }) : `${min}m`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h < 24) {
    if (m > 0) return tr ? tr('time.hmLeft', { h, m }) : `${h}h ${m}m`;
    return tr ? tr('time.hLeft', { n: h }) : `${h}h`;
  }
  const d = Math.floor(h / 24);
  return tr ? tr('time.dLeft', { n: d }) : `${d}d`;
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
