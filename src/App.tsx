import { useEffect, useMemo, useState, useCallback, useRef } from 'react';
import { Sidebar } from './components/Sidebar';
import { SessionsView } from './components/SessionsView';
import { SearchView } from './components/SearchView';
import { UsageView } from './components/UsageView';
import { ConfigView } from './components/ConfigView';
import { SettingsView } from './components/SettingsView';
import { AccountModal } from './components/AccountModal';
import { SessionInfoDrawer } from './components/SessionInfoDrawer';
import { StatusBar } from './components/StatusBar';
import { Resizer } from './components/Resizer';
import { useProfile } from './lib/profile';
import { useSourceAuth, deriveName } from './lib/sourceAuth';
import { useExcludeRules, computeEffectiveExcluded } from './lib/excludeRules';
import { useCurrentSource, srcKey, type SessionSource } from './lib/sources';
import { sessionTimestamp } from './lib/format';
import { useDemoMode } from './lib/demoMode';
import { DEMO_SESSIONS, DEMO_USAGE, DEMO_PROFILE, DEMO_RATE_LIMITS } from './lib/demoData';
import { useRateLimitsConsent, useRateLimits, type RateLimitsState } from './lib/rateLimits';
import { RateLimitsConsentModal } from './components/RateLimitsConsentModal';
import { useTranslation } from './lib/I18nProvider';
import type { SessionMeta, View, UsageSummary } from './types';

export type ThemeMode = 'light' | 'dark' | 'system';

function getSystemTheme(): 'light' | 'dark' {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

// Keeps every nav target mounted so React state, scroll position, deep-search
// results, and (most importantly) SessionDetail's loaded messages survive when
// the user switches views.
//
// When active: `display: contents` makes the wrapper transparent to the outer
// flex row — the view component is laid out as a direct child of the flex
// container, just like the old conditional render.
//
// When inactive: `position: absolute + visibility: hidden + pointer-events:
// none` takes the wrapper out of flex flow so the active view gets the full
// width, but the subtree still paints into a real DOM box with real
// dimensions. That matters because SessionList's `@tanstack/react-virtual`
// uses a ResizeObserver on every row — under `display: none` every row
// reports height 0, and switching back triggers a flood of re-measures
// (visible as the list height "snapping" into place). Keeping a real layout
// while invisible avoids that re-measure entirely.
//
// Side note: the parent of these ViewSlots (`flex-1 flex ... relative`)
// becomes the positioning context for the absolute wrapper, so the hidden
// view inherits the row's full width — slightly wider than the active view
// (it doesn't subtract the sidebar) but row height isn't width-sensitive,
// so the cached measurements still apply when it becomes active again.
function ViewSlot({ active, children }: { active: boolean; children: React.ReactNode }) {
  if (active) return <div style={{ display: 'contents' }}>{children}</div>;
  return (
    <div
      aria-hidden
      style={{
        position: 'absolute',
        inset: 0,
        display: 'flex',
        minHeight: 0,
        visibility: 'hidden',
        pointerEvents: 'none',
      }}
    >
      {children}
    </div>
  );
}

export default function App() {
  const { t } = useTranslation();
  const [view, setView] = useState<View>(() => {
    // Whitelist the persisted view — a corrupt/poisoned localStorage write
    // would otherwise leave the main pane unmatched and render a blank app.
    const saved = localStorage.getItem('view');
    return saved === 'sessions' || saved === 'favorites' || saved === 'excluded'
      || saved === 'usage' || saved === 'config' || saved === 'settings' || saved === 'search'
      ? saved : 'sessions';
  });
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => {
    const saved = localStorage.getItem('theme-mode') as ThemeMode | null;
    return saved || 'system';
  });
  const [theme, setTheme] = useState<'light' | 'dark'>(() => themeMode === 'system' ? getSystemTheme() : themeMode);
  const [realSessions, setSessions] = useState<SessionMeta[]>([]);
  const [realFavorites, setFavorites] = useState<Set<string>>(new Set());
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [excludeRules, setExcludeRules] = useExcludeRules();
  const [demoMode, setDemoMode] = useDemoMode();
  const [currentSource] = useCurrentSource();
  // Mirror current source in a ref so async callbacks (reload, SWR push) can
  // discard stale results without recreating themselves every time source flips.
  const currentSourceRef = useRef(currentSource);
  useEffect(() => { currentSourceRef.current = currentSource; }, [currentSource]);
  // Two separate monotonic counters so each path only invalidates its own
  // class of writes:
  //   • reloadSeqRef — full reload (sessions + favorites + excludes + usage)
  //   • usageSeqRef  — usage-only refresh (SWR push handler + silentRefresh)
  // A SWR push must not cancel an in-flight full reload's session/favorites
  // writes, only its own usage write. Sharing one counter meant the lower-
  // priority usage refresh could trample the freshly-arrived sessions list.
  const reloadSeqRef = useRef(0);
  const usageSeqRef = useRef(0);
  // Bumped on every full reload — ConfigView watches this so the Workspace
  // pane re-reads CLAUDE.md / skills / commands / hooks from disk on ⌘R or
  // the sidebar Rescan button. The renderer never watches the FS itself, so
  // without this an edit to ~/.claude/CLAUDE.md (or a new skill) wouldn't
  // surface until the source flips or the window is restarted.
  const [refreshTick, setRefreshTick] = useState(0);
  const [demoAliases, setDemoAliases] = useState<Record<string, string | null>>({});
  const [rlConsent, setRlConsent] = useRateLimitsConsent();
  const [rlPromptOpen, setRlPromptOpen] = useState(false);
  // Codex's probe spawns the local `codex app-server` — no OAuth token, no
  // consent required. Claude still gates behind the user's explicit opt-in.
  const rlEnabled = !demoMode && (currentSource === 'codex' || rlConsent === 'granted');
  const { state: realRateLimits, refresh: refreshRateLimits } = useRateLimits(rlEnabled, currentSource);
  const rateLimitsState: RateLimitsState = demoMode
    ? { limits: DEMO_RATE_LIMITS, fetchedAt: Date.now(), loading: false, error: null, debug: null }
    : realRateLimits;
  // In demo mode, layer user-set aliases on top of the static DEMO_SESSIONS so
  // Rename works in demo for screenshots without touching the real aliases.json.
  const sessions = useMemo(
    () => {
      const base = demoMode
        ? DEMO_SESSIONS.map(s => {
            const k = srcKey(s);
            return demoAliases[k] !== undefined ? { ...s, alias: demoAliases[k] } : s;
          })
        : realSessions;
      // Filter by the AI tool the user is currently browsing.
      return base.filter(s => s.source === currentSource);
    },
    [demoMode, realSessions, demoAliases, currentSource]
  );
  const favorites = useMemo(
    () => demoMode
      ? new Set(DEMO_SESSIONS.filter(s => s.favorite).map(s => `${s.source}:${s.id}`))
      : realFavorites,
    [demoMode, realFavorites]
  );
  const effectiveExcluded = useMemo(
    () => computeEffectiveExcluded(sessions, excluded, excludeRules),
    [sessions, excluded, excludeRules]
  );
  const [realUsage, setUsage] = useState<UsageSummary | null>(null);
  const usage = demoMode ? DEMO_USAGE : realUsage;
  const [loading, setLoading] = useState(true);
  const [statusMsg, setStatusMsg] = useState('');
  // Per-source active selection so flipping Claude ↔ Codex restores each
  // tool's last-selected session instead of bleeding state across sources.
  const [activeId, setActiveId] = useState<string | null>(() => localStorage.getItem(`active-id:${currentSource}`));
  const [realProfile, setProfile] = useProfile(currentSource);
  // Demo mode overlays a fixed profile so a localStorage-customised name
  // never leaks into demo views.
  const profile = demoMode ? DEMO_PROFILE : realProfile;
  const [profileOpen, setProfileOpen] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);
  const { auth } = useSourceAuth(currentSource);
  const activeSession = sessions.find(s => srcKey(s) === activeId) || null;

  // Auto-populate profile from the active source's auth status if the user
  // hasn't customised it. Customisation is now tracked per source so claude
  // and codex identities stay independent.
  useEffect(() => {
    if (!auth?.email) return;
    const wasCustomized = localStorage.getItem(`profile-customized:${currentSource}`) === '1';
    if (wasCustomized) return;
    const derivedName = deriveName(auth.email);
    if (derivedName && profile.name !== derivedName) {
      setProfile({ name: derivedName, avatarInitial: derivedName[0]?.toUpperCase() || '?' });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auth?.email, currentSource]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    // Repaint the Windows native caption-button overlay to match the new theme.
    // No-op on macOS / Linux — the main process ignores the call there.
    window.api.setTitleBarTheme?.(theme).catch(() => {});
  }, [theme]);

  // Resolve theme based on mode + listen for system changes
  useEffect(() => {
    localStorage.setItem('theme-mode', themeMode);
    if (themeMode === 'system') {
      const mql = window.matchMedia('(prefers-color-scheme: dark)');
      const update = () => setTheme(mql.matches ? 'dark' : 'light');
      update();
      mql.addEventListener('change', update);
      return () => mql.removeEventListener('change', update);
    }
    setTheme(themeMode);
  }, [themeMode]);

  useEffect(() => { localStorage.setItem('view', view); }, [view]);
  useEffect(() => {
    const key = `active-id:${currentSource}`;
    if (activeId) localStorage.setItem(key, activeId);
    else localStorage.removeItem(key);
    // Drop any lingering selection from the previous session so the new detail view
    // doesn't load with random highlights left over from where the user was dragging.
    try { window.getSelection()?.removeAllRanges(); } catch {}
  }, [activeId, currentSource]);

  // When the user flips Claude ↔ Codex, swap activeId to whatever that source
  // had selected last time. Without this the activeId from the old source
  // would stay set and the "source-not-found" cleanup effect below would
  // immediately drop it, costing the user their previous selection.
  useEffect(() => {
    setActiveId(localStorage.getItem(`active-id:${currentSource}`));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentSource]);

  // Smart clear: drop activeId whenever the active session falls outside the
  // current view — view change, favorite toggle, exclude toggle, source flip,
  // or session list update. Used to depend only on `view`, so unfavoriting
  // the selected session in Favorites left a ghost detail pane.
  useEffect(() => {
    if (!activeId) return;
    if (view !== 'sessions' && view !== 'favorites' && view !== 'excluded') return;
    let inView = false;
    if (view === 'sessions') inView = !effectiveExcluded.has(activeId);
    else if (view === 'favorites') inView = favorites.has(activeId);
    else if (view === 'excluded') inView = effectiveExcluded.has(activeId);
    // Also confirm the session is still in the current source's set; a source
    // flip can leave activeId pointing at a row that's no longer reachable.
    if (inView && !sessions.some(s => srcKey(s) === activeId)) inView = false;
    if (!inView) setActiveId(null);
  }, [view, activeId, favorites, effectiveExcluded, sessions]);

  const reload = useCallback(async () => {
    // Stale guard: capture source + a monotonic request id at call time. If
    // the user flips Claude↔Codex OR a fresher reload starts before this one
    // settles, drop the result so hero numbers / usage / streak only commit
    // when neither source nor seq has shifted.
    const reqSource = currentSource;
    const reqSeq = ++reloadSeqRef.current;
    // Signal Workspace (ConfigView) to refetch CLAUDE.md / skills / etc.
    // Sessions + workspace live on disk side-by-side; a refresh that updates
    // one without the other left users wondering why their fresh
    // ~/.claude/CLAUDE.md edit didn't show up.
    setRefreshTick(t => t + 1);
    setLoading(true);
    try {
      const [s, f, e, u] = await Promise.all([
        window.api.listSessions({ force: true }),
        window.api.listFavorites(),
        window.api.listExcludes(),
        window.api.getUsage(reqSource),
      ]);
      if (reqSource !== currentSourceRef.current || reqSeq !== reloadSeqRef.current) return;
      setSessions(s);
      setFavorites(new Set(f));
      setExcluded(new Set(e));
      setUsage(u);
      // Only release the skeleton when we have real rows. Empty array means
      // first-boot with no cache — the SWR push handler below will turn off
      // loading as soon as the first 30 sessions arrive (~500ms).
      if (s.length > 0) setLoading(false);
    } catch (err: any) {
      // Only surface the error if this is still the freshest reload for the
      // current source. A stale failure (user already moved on / triggered a
      // new reload) shouldn't flash a status bar message or kill the loading
      // skeleton of the in-flight successor.
      if (reqSource !== currentSourceRef.current || reqSeq !== reloadSeqRef.current) return;
      setStatusMsg(t('status.error', { error: err.message }));
      setLoading(false);
    }
  }, [currentSource, t]);

  useEffect(() => { reload(); }, [reload]);

  // SWR push: main process pushes a fresh session list when its background
  // rescan completes. We replace state silently so the UI updates without a
  // visible "Loading…" cycle. Refresh usage in parallel since it's derived.
  useEffect(() => {
    if (!window.api.onSessionsUpdated) return;
    return window.api.onSessionsUpdated((fresh) => {
      setSessions(fresh);
      setLoading(false);
      // Capture source + bump the USAGE-only seq so a concurrent silent
      // refresh's slower usage payload can't trample this one — without
      // invalidating a separately-running full reload's sessions/favorites
      // writes.
      const reqSource = currentSourceRef.current;
      const reqSeq = ++usageSeqRef.current;
      window.api.getUsage(reqSource).then(u => {
        if (reqSource === currentSourceRef.current && reqSeq === usageSeqRef.current) setUsage(u);
      }).catch(() => {});
    });
  }, []);

  // Components can dispatch this event to force a fresh listSessions() — e.g.
  // after the user renames a session via the context-menu dialog.
  useEffect(() => {
    const h = () => reload();
    window.addEventListener('sessions:reload', h);
    return () => window.removeEventListener('sessions:reload', h);
  }, [reload]);

  // History pane EmptyState dispatches this when the user clicks "Search
  // content" — switch to the dedicated Search view and re-broadcast the query
  // so SearchView can auto-submit it. Two-event hop is needed because
  // SearchView's input state is owned inside the component, and we want the
  // query to land + grep to fire without an extra click after the view swap.
  useEffect(() => {
    const h = (e: Event) => {
      const detail = (e as CustomEvent).detail as { q?: string };
      const q = (detail?.q || '').trim();
      if (!q) return;
      setView('search');
      // Defer one frame so SearchView's mount/visibility transition lands
      // before we fire the auto-submit. Without this the SearchView listener
      // hasn't mounted yet on first navigation and the event is missed.
      requestAnimationFrame(() => {
        window.dispatchEvent(new CustomEvent('search:autoSubmit', { detail: { q } }));
      });
    };
    window.addEventListener('nav:contentSearch', h);
    return () => window.removeEventListener('nav:contentSearch', h);
  }, []);

  // Optimistic alias patch — updates the in-memory session entry without a full
  // reload(). Demo mode tracks aliases in a separate overlay map so DEMO_SESSIONS
  // stays untouched and the real aliases.json on disk isn't polluted by demo ids.
  // The event MUST carry `source` so a UUID collision between Claude and Codex
  // doesn't rename both rows.
  useEffect(() => {
    const h = (e: Event) => {
      const detail = (e as CustomEvent).detail as { source: SessionSource; id: string; alias: string | null };
      if (!detail?.id || !detail?.source) return;
      const key = `${detail.source}:${detail.id}`;
      if (demoMode) {
        setDemoAliases(prev => ({ ...prev, [key]: detail.alias }));
      } else {
        setSessions(prev => prev.map(s => (s.source === detail.source && s.id === detail.id) ? { ...s, alias: detail.alias } : s));
      }
    };
    window.addEventListener('sessions:patchAlias', h);
    return () => window.removeEventListener('sessions:patchAlias', h);
  }, [demoMode]);

  // Background poller — re-scan every 5 min while window is visible, and on
  // focus / visibility-restore. Crucially this is a SILENT refresh: never
  // toggles the loading skeleton, so swapping focus to the app (dock click,
  // Cmd-Tab, deactivate/reactivate) doesn't blank the UI for 200-500ms while
  // the rescan runs. The main process pushes fresh sessions through
  // onSessionsUpdated when its background walk finishes; that handler updates
  // state in place. Only initial mount + explicit ⌘R / Rescan show the
  // skeleton.
  const silentRefresh = useCallback(() => {
    const reqSource = currentSource;
    // Uses the USAGE-only seq — sessions data arrives via SWR push, which has
    // its own write path. We only protect against a stale usage payload.
    const reqSeq = ++usageSeqRef.current;
    window.api.listSessions({ force: true }).catch(() => {});
    window.api.getUsage(reqSource).then(u => {
      if (reqSource === currentSourceRef.current && reqSeq === usageSeqRef.current) setUsage(u);
    }).catch(() => {});
  }, [currentSource]);

  useEffect(() => {
    let timer: number | null = null;
    const tick = () => { if (!document.hidden) silentRefresh(); };
    const start = () => { stop(); timer = window.setInterval(tick, 5 * 60_000); };
    const stop = () => { if (timer != null) { clearInterval(timer); timer = null; } };
    const onVis = () => {
      if (document.hidden) stop();
      else { silentRefresh(); start(); }
    };
    start();
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('focus', tick);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('focus', tick);
    };
  }, [silentRefresh]);

  // Intercept link clicks → open in default browser (avoid Electron in-app navigation popup)
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const target = (e.target as HTMLElement | null)?.closest('a');
      if (!target) return;
      const href = target.getAttribute('href');
      if (!href) return;
      // Pure in-page anchors fall through to native behavior.
      if (href.startsWith('#')) return;
      // Allowlist scheme: open in OS default browser. Anything else (file:,
      // javascript:, data:, vscode:, etc.) is blocked here even though
      // DOMPurify already strips dangerous href schemes. Defense in depth:
      // some anchors may not be rendered through marked + DOMPurify (e.g.
      // future generated UI), and an unhandled href would otherwise let
      // Electron decide. Better to refuse.
      if (/^https?:\/\//i.test(href) || /^mailto:/i.test(href)) {
        e.preventDefault();
        window.api.openExternal(href).catch(err => console.warn('openExternal failed:', err));
        return;
      }
      // Unknown scheme — refuse silently (preventDefault so Electron doesn't
      // try to navigate the renderer).
      e.preventDefault();
    };
    document.addEventListener('click', handler);
    return () => document.removeEventListener('click', handler);
  }, []);

  // Keyboard: ⌘K palette, ⌘F focus search, ⌘R reload, ⌘I info, Esc close
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const cmd = e.metaKey || e.ctrlKey;
      if (cmd && e.key === 'k') {
        // ⌘K opens the Search view.
        e.preventDefault();
        setView('search');
      } else if (cmd && e.key === 'f') {
        e.preventDefault();
        // Both views stay mounted via ViewSlot, so two distinct ids exist
        // simultaneously — focus the one whose view is actually visible.
        // Fall back to the History input for views that don't host their
        // own search field (Workspace / Usage / Settings).
        const id = view === 'search' ? 'deep-search-input' : 'history-search-input';
        const el = document.getElementById(id) as HTMLInputElement | null;
        el?.focus();
        el?.select();
      } else if (cmd && e.key === 'r') {
        e.preventDefault();
        reload();
        setStatusMsg(t('status.rescanned'));
        setTimeout(() => setStatusMsg(''), 1500);
      } else if (cmd && e.key === 'i') {
        e.preventDefault();
        if (activeSession) setInfoOpen(true);
      } else if (cmd && e.key === ',') {
        e.preventDefault();
        setView('config');
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [reload, activeSession, view]);

  const toggleFav = useCallback(async (id: string) => {
    const isFav = await window.api.toggleFavorite(currentSource, id);
    const key = `${currentSource}:${id}`;
    setFavorites(prev => {
      const next = new Set(prev);
      if (isFav) next.add(key); else next.delete(key);
      return next;
    });
    setSessions(prev => prev.map(s => s.id === id && (s.source) === currentSource ? { ...s, favorite: isFav } : s));
  }, [currentSource]);

  const toggleExc = useCallback(async (id: string) => {
    const isEx = await window.api.toggleExclude(currentSource, id);
    const key = `${currentSource}:${id}`;
    setExcluded(prev => {
      const next = new Set(prev);
      if (isEx) next.add(key); else next.delete(key);
      return next;
    });
    setSessions(prev => prev.map(s => s.id === id && (s.source) === currentSource ? { ...s, excluded: isEx } : s));
    setStatusMsg(isEx ? t('status.excluded') : t('status.restored'));
    setTimeout(() => setStatusMsg(''), 2500);
  }, [currentSource, t]);

  return (
    <div className="h-full w-full flex flex-col bg-bg text-text">
      <div className="drag-region h-9 titlebar flex items-center justify-center select-none">
        <span className="flex items-center gap-1.5 text-[11.5px] min-w-0 px-32">
          <span className="font-semibold text-text/85 flex-shrink-0">Lens</span>
          <span className="text-text-muted/60 flex-shrink-0" aria-hidden>·</span>
          <span className="text-text-muted truncate">{t('app.tagline')}</span>
        </span>
      </div>

      <div className="flex-1 flex min-h-0 overflow-hidden gap-1.5 p-1.5 relative">
        <Sidebar
          view={view}
          onViewChange={setView}
          theme={theme}
          onThemeChange={mode => setThemeMode(mode)}
          counts={{
            // effectiveExcluded / favorites are keyed `source:id`. Sidebar count
            // was reading them with bare `s.id` so cross-source UUID collisions
            // could double-count or miss. Use srcKey() like the favorites line
            // already does.
            sessions: sessions.filter(s => !effectiveExcluded.has(srcKey(s))).length,
            favorites: sessions.filter(s => favorites.has(srcKey(s))).length,
            excluded: sessions.filter(s => effectiveExcluded.has(srcKey(s))).length,
          }}
          totalTokens={usage ? usage.buckets.total.input + usage.buckets.total.output + usage.buckets.total.cacheRead + usage.buckets.total.cacheCreate : 0}
          onReload={reload}
          profile={profile}
          onOpenProfile={() => setProfileOpen(true)}
          rateLimits={rateLimitsState}
          quotaEnabled={rlEnabled || demoMode}
          demoMode={demoMode}
        />
        <Resizer cssVar="--sidebar-width" storageKey="sidebar-width" min={180} max={280} side="left" />

        {/*
          Every view stays mounted (see ViewSlot) so navigating away and back
          keeps detail-pane messages, deep-search hits, scroll positions, and
          input state intact. The previous conditional render unmounted the
          whole subtree, forcing a fresh IPC fetch on re-entry.
        */}
        <ViewSlot active={view === 'sessions' || view === 'favorites' || view === 'excluded'}>
          <SessionsView
            // While inactive, freeze the `view` prop on the last active
            // sessions/favorites/excluded variant so SessionsView doesn't
            // try to reconcile against a value it doesn't understand
            // (e.g. 'search'). The component is hidden so the user can't see
            // the freeze; on next entry the live view value flows through.
            view={(view === 'sessions' || view === 'favorites' || view === 'excluded') ? view : 'sessions'}
            sessions={sessions}
            favorites={favorites}
            excluded={effectiveExcluded}
            manualExcluded={excluded}
            excludeRules={excludeRules}
            onExcludeRulesChange={setExcludeRules}
            demoMode={demoMode}
            usage={usage}
            loading={loading}
            activeId={activeId}
            onActiveIdChange={setActiveId}
            onToggleFavorite={toggleFav}
            onToggleExclude={toggleExc}
            onStatus={setStatusMsg}
            onOpenInfo={() => setInfoOpen(true)}
          />
        </ViewSlot>
        <ViewSlot active={view === 'search'}>
          <SearchView
            isActive={view === 'search'}
            sessions={sessions}
            favorites={favorites}
            excluded={effectiveExcluded}
            loading={loading}
            onSelectSession={(id) => {
              // Jumping from Search to History: the chosen session may be
              // outside History's current filters. Strategy:
              //   - Always drop `project` (the dimension most likely to hide
              //     the row, and the user's project pick in History rarely
              //     matters when they came from a search result).
              //   - Drop `time` ONLY if the session's lastTs falls outside
              //     the current time window. Otherwise keep the user's
              //     time choice (they picked 7-day for a reason).
              //   - Always keep `sort`.
              //
              // SessionsView is unmounted while we're on Search, so the
              // dispatched event has no listener. Write v2 storage in place
              // so the freshly-mounted SessionsView reads the relaxed filter.
              const target = sessions.find(s => srcKey(s) === id);
              const lastTs = target ? sessionTimestamp(target) : 0;
              const wouldHideByTime = (timeStr: string | undefined) => {
                if (!lastTs || !timeStr || timeStr === 'all') return false;
                const days = parseInt(timeStr, 10);
                if (!Number.isFinite(days)) return false;
                return lastTs < Date.now() - days * 86400000;
              };
              try {
                const raw = localStorage.getItem('session-filters');
                const obj = raw ? JSON.parse(raw) : {};
                const cur = (obj.sessions && typeof obj.sessions === 'object') ? obj.sessions : {};
                const next = { ...cur, project: '' };
                if (wouldHideByTime(cur.time)) next.time = 'all';
                obj.sessions = next;
                localStorage.setItem('session-filters', JSON.stringify(obj));
              } catch {}
              window.dispatchEvent(new CustomEvent('history:relaxForTarget', { detail: { lastTs } }));
              setActiveId(id);
              // If the target row is currently excluded by user rules, History
              // would filter it out — jump to Excluded view instead so the
              // selection is actually visible.
              if (effectiveExcluded.has(id)) {
                setView('excluded');
              } else {
                setView('sessions');
              }
            }}
            onToggleFavorite={toggleFav}
            onStatus={setStatusMsg}
          />
        </ViewSlot>
        <ViewSlot active={view === 'usage'}>
          <UsageView usage={usage} demoMode={demoMode} rlConsent={rlConsent} rateLimits={rateLimitsState} onOpenRlPrompt={() => setRlPromptOpen(true)} onRefreshRateLimits={refreshRateLimits} loading={loading} />
        </ViewSlot>
        <ViewSlot active={view === 'config'}>
          <ConfigView demoMode={demoMode} onStatus={setStatusMsg} refreshTick={refreshTick} />
        </ViewSlot>
        <ViewSlot active={view === 'settings'}>
          <SettingsView themeMode={themeMode} resolvedTheme={theme} onThemeChange={setThemeMode} demoMode={demoMode} onDemoModeChange={setDemoMode} rlConsent={rlConsent} onRlConsentChange={setRlConsent} />
        </ViewSlot>
      </div>

      <AccountModal
        open={profileOpen}
        onOpenChange={setProfileOpen}
        profile={profile}
        onChange={setProfile}
      />

      <RateLimitsConsentModal
        open={rlPromptOpen}
        onAccept={() => { setRlConsent('granted'); setRlPromptOpen(false); }}
        onDeny={() => { setRlConsent('denied'); setRlPromptOpen(false); }}
      />

      <SessionInfoDrawer
        open={infoOpen}
        onOpenChange={setInfoOpen}
        session={activeSession}
      />

      <StatusBar sessions={sessions} message={statusMsg} />
    </div>
  );
}
