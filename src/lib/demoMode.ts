// Demo mode lives behind a hard gate: only Vite-dev (`import.meta.env.DEV`)
// builds ever read or expose the demo flag. A packaged production build is
// guaranteed to render real on-disk data — even a stray localStorage `demo-mode`
// from an older build is ignored.
//
// Override: a `DEMO_BUILD=1 npm run dist:*` build flips `__DEMO_BUILD__` true
// at compile time, forcing demo on for the whole shipped artifact (used for
// UI-preview builds we hand out for review).

/// <reference types="vite/client" />
import { useEffect, useState } from 'react';

declare const __DEMO_BUILD__: boolean;

const KEY = 'demo-mode';

export const IS_DEV: boolean = !!(import.meta as any).env?.DEV;
export const IS_DEMO_BUILD: boolean = typeof __DEMO_BUILD__ !== 'undefined' && __DEMO_BUILD__;
// One flag every consumer checks — if this is false the toggle is hidden, the
// flag in localStorage is never read, and the fake data never gets mounted.
export const DEMO_AVAILABLE: boolean = IS_DEV || IS_DEMO_BUILD;

export function useDemoMode(): [boolean, (v: boolean) => void] {
  const [on, setOn] = useState<boolean>(() => {
    if (IS_DEMO_BUILD) return true;
    if (!IS_DEV) return false; // packaged prod — demo content never mounts
    try {
      const v = localStorage.getItem(KEY);
      if (v === '1') return true;
      if (v === '0') return false;
      // First-run default in dev: ON so `npm run dev` shows demo content immediately.
      return true;
    } catch { return false; }
  });
  useEffect(() => {
    if (!IS_DEV || IS_DEMO_BUILD) return;
    try { localStorage.setItem(KEY, on ? '1' : '0'); } catch {}
  }, [on]);
  // Only the dev build exposes a working setter; packaged prod / forced-demo
  // builds return a no-op so callers can't accidentally flip state.
  return [on, IS_DEV && !IS_DEMO_BUILD ? setOn : () => {}];
}
