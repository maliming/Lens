import { useEffect, useState, useCallback } from 'react';
import type { AppPrefs } from '../types';

// Match the per-platform default in `electron/main.cjs` so the renderer
// doesn't briefly show 'hide' on Windows / Linux before the IPC payload lands.
// macOS users expect close=hide (app keeps running in menu bar); everyone
// else expects close=quit.
const isMacRenderer = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent || '');
const DEFAULT: AppPrefs = {
  showTrayIcon: true,
  closeBehavior: isMacRenderer ? 'hide' : 'quit',
  launchAtLogin: false,
  embeddedTerminal: false,
  menuBarQuota: false,
  menuBarQuotaOrder: ['claude', 'codex'],
  rateLimitsConsent: 'pending',
};

// Module-level singleton, mirroring useCurrentSource. Per-hook `useState` would
// give every caller its own copy of prefs that main considers shared: a write
// from one component (App opening the terminal consent modal) never reached the
// other (the Settings switch that shows the same flag), so the switch stayed
// visibly off after the user had just turned it on. One store, one write path,
// every subscriber re-renders.
let _prefs: AppPrefs = DEFAULT;
let _loaded = false;
let _inflight: Promise<void> | null = null;
const _subs = new Set<() => void>();

function emit() {
  for (const fn of _subs) fn();
}

function loadOnce() {
  // Shared promise so StrictMode's double effect — and several components
  // mounting in the same tick — make one IPC call between them.
  if (_loaded || _inflight) return _inflight ?? Promise.resolve();
  if (!window.api?.getAppPrefs) { _loaded = true; emit(); return Promise.resolve(); }
  _inflight = window.api.getAppPrefs()
    .then(p => { _prefs = p; })
    .catch(() => { /* keep defaults */ })
    .finally(() => { _loaded = true; _inflight = null; emit(); });
  return _inflight;
}

// Single source of truth lives in the main process (userData/app-prefs.json).
// The renderer pulls once and writes through `setAppPrefs`; main's response is
// the new state, so the store never guesses what the write produced.
export function useAppPrefs(): [AppPrefs, (patch: Partial<AppPrefs>) => Promise<void>, boolean] {
  const [, bump] = useState(0);

  useEffect(() => {
    const fn = () => bump(n => n + 1);
    _subs.add(fn);
    loadOnce();
    return () => { _subs.delete(fn); };
  }, []);

  const update = useCallback(async (patch: Partial<AppPrefs>) => {
    if (!window.api?.setAppPrefs) return;
    const next = await window.api.setAppPrefs(patch);
    _prefs = next;
    emit();
  }, []);

  return [_prefs, update, _loaded];
}
