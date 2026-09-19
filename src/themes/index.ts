import { useSyncExternalStore } from 'react';
import { getDisplayPrefs, subscribeDisplayPrefs } from '../lib/displayPrefs';
import type { ThemeFamily } from './families';

export { THEME_FAMILIES, isThemeFamily, type ThemeFamily } from './families';

// Typefaces a family needs beyond the system font and Lens's own. Only families
// whose real typeface is openly licensed ship it; the rest approximate with the
// system font. Loaded on first use, so someone who stays on Lens never pays for
// them.
const FONT_LOADERS: Partial<Record<ThemeFamily, () => Promise<unknown>>> = {
  claude: () => import('@fontsource-variable/source-serif-4'),
  github: () => Promise.all([
    import('@fontsource-variable/mona-sans'),
    import('@fontsource/monaspace-neon/400.css'),
    import('@fontsource/monaspace-neon/600.css'),
  ]),
};
const loadedFonts = new Set<ThemeFamily>();

export function loadThemeFonts(family: ThemeFamily): void {
  const load = FONT_LOADERS[family];
  if (!load || loadedFonts.has(family)) return;
  loadedFonts.add(family);
  load().catch(() => loadedFonts.delete(family));
}

// The active family, re-rendering only when it changes. Primitives read this on
// every render, so subscribing to the whole prefs object would re-render all of
// them whenever any unrelated display toggle flips.
export function useThemeFamily(): ThemeFamily {
  return useSyncExternalStore(subscribeDisplayPrefs, () => getDisplayPrefs().themeFamily);
}

// Mirrors the Style pref onto `<html data-theme-family>`, which is what every
// family's variables are scoped to. index.html sets the same attribute before
// first paint; this keeps it in step once the pref changes at runtime.
export function initThemeFamily(): void {
  let current: ThemeFamily | null = null;
  const apply = () => {
    const next = getDisplayPrefs().themeFamily;
    if (next === current) return;
    current = next;
    document.documentElement.dataset.themeFamily = next;
    loadThemeFonts(next);
  };
  apply();
  subscribeDisplayPrefs(apply);
}
