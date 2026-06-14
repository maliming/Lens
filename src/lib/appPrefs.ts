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
  rateLimitsConsent: 'pending',
};

// Single source of truth lives in the main process (userData/app-prefs.json).
// The renderer pulls once on mount and writes through `setAppPrefs`.
export function useAppPrefs(): [AppPrefs, (patch: Partial<AppPrefs>) => Promise<void>, boolean] {
  const [prefs, setPrefs] = useState<AppPrefs>(DEFAULT);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!window.api.getAppPrefs) { setLoaded(true); return; }
    let cancel = false;
    window.api.getAppPrefs().then(p => {
      if (cancel) return;
      setPrefs(p);
      setLoaded(true);
    }).catch(() => { setLoaded(true); });
    return () => { cancel = true; };
  }, []);

  const update = useCallback(async (patch: Partial<AppPrefs>) => {
    if (!window.api.setAppPrefs) return;
    const next = await window.api.setAppPrefs(patch);
    setPrefs(next);
  }, []);

  return [prefs, update, loaded];
}
