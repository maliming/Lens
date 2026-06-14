import { createContext, useContext, useEffect, useState, useCallback, ReactNode } from 'react';
import { Locale, TKey, translate, detectInitialLocale } from './i18n';

type Ctx = {
  locale: Locale;
  setLocale: (l: Locale) => void;
  t: (key: TKey, vars?: Record<string, string | number>) => string;
};

const I18nCtx = createContext<Ctx | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(() => detectInitialLocale());

  useEffect(() => {
    try { localStorage.setItem('app-locale', locale); } catch {}
    document.documentElement.lang = locale;
  }, [locale]);

  const setLocale = useCallback((l: Locale) => setLocaleState(l), []);
  const t = useCallback(
    (key: TKey, vars?: Record<string, string | number>) => translate(locale, key, vars),
    [locale]
  );

  return <I18nCtx.Provider value={{ locale, setLocale, t }}>{children}</I18nCtx.Provider>;
}

export function useTranslation(): Ctx {
  const ctx = useContext(I18nCtx);
  if (!ctx) throw new Error('useTranslation must be used inside <I18nProvider>');
  return ctx;
}
