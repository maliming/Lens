import { useCallback, useEffect, useMemo, useState, useRef } from 'react';
import { SessionList } from './SessionList';
import { SessionDetail } from './SessionDetail';
import { Resizer } from './Resizer';
import { sessionTimestamp, visibleMessageCount } from '../lib/format';
import { DEMO_MESSAGES } from '../lib/demoData';
import { useCurrentSource, srcKey } from '../lib/sources';
import { useTranslation } from '../lib/I18nProvider';
import type { MessageItem, SessionMeta, UsageSummary, View } from '../types';

// SessionsView (History / Favorites / Excluded) does only a lightweight
// metadata-driven filter on the search input. Deep full-text search lives in
// the dedicated Search view (⌘K) — running it from a history pane would let
// the row list silently exclude sessions the user can see in the list, which
// reads as "history is broken" rather than "search ran over JSONL content".

type Props = {
  view: View;
  sessions: SessionMeta[];
  favorites: Set<string>;
  // `excluded` is the EFFECTIVE set — manual excludes + rule-derived ones.
  // It drives row visibility / list inclusion. `manualExcluded` is the raw
  // user-toggled set; only it can be flipped by the per-row Restore action.
  // Rule-only hits show a "Hidden by rule" state instead of a Restore link
  // because toggling the manual exclude wouldn't unhide them anyway.
  excluded: Set<string>;
  manualExcluded: Set<string>;
  excludeRules: string[];
  onExcludeRulesChange: (next: string[]) => void;
  demoMode: boolean;
  usage: UsageSummary | null;
  loading: boolean;
  activeId: string | null;
  onActiveIdChange: (id: string | null) => void;
  onToggleFavorite: (id: string) => void;
  onToggleExclude: (id: string) => void;
  onStatus: (msg: string) => void;
  onOpenInfo: () => void;
};

export type Filters = {
  query: string;
  project: string;
  time: 'all' | '3' | '7' | '10' | '30';
  sort: 'recent' | 'oldest' | 'largest' | 'messages' | 'tokens';
};

// Filters are stored per-view so a project pick in Favorites isn't wiped when
// the user jumps Search → History (App dispatches `history:relaxFilters` to
// make the chosen row visible, but that should only affect History's filter,
// not Favorites' or Excluded's).
type ViewKey = 'sessions' | 'favorites' | 'excluded';
type FiltersByView = Record<ViewKey, Filters>;

const FILTERS_STORAGE = 'session-filters';
const DEFAULT_FILTERS: Filters = { query: '', project: '', time: '7', sort: 'recent' };
const VIEW_KEYS: ViewKey[] = ['sessions', 'favorites', 'excluded'];

function loadFiltersByView(): FiltersByView {
  const blank: FiltersByView = {
    sessions: { ...DEFAULT_FILTERS },
    favorites: { ...DEFAULT_FILTERS },
    excluded: { ...DEFAULT_FILTERS },
  };
  try {
    const raw = localStorage.getItem(FILTERS_STORAGE);
    if (raw) {
      const obj = JSON.parse(raw);
      if (obj && typeof obj === 'object') {
        for (const v of VIEW_KEYS) {
          if (obj[v] && typeof obj[v] === 'object') {
            blank[v] = { ...DEFAULT_FILTERS, ...obj[v], query: '' };
          }
        }
      }
    }
  } catch {}
  return blank;
}

function asViewKey(v: string): ViewKey {
  return v === 'favorites' || v === 'excluded' ? v : 'sessions';
}

export function SessionsView({ view, sessions, favorites, excluded, manualExcluded, excludeRules, onExcludeRulesChange, demoMode, loading, activeId, onActiveIdChange, onToggleFavorite, onToggleExclude, onStatus, onOpenInfo }: Props) {
  const { t } = useTranslation();
  const [messages, setMessages] = useState<MessageItem[] | null>(null);
  const [loadingMessages, setLoadingMessages] = useState(false);
  // Big-session confirmation. Detail-view loads slurp the full JSONL into
  // memory (the IPC returns one MessageItem[] for the renderer to keep
  // around), so a 263MB session can pin hundreds of MB until the user
  // navigates away. We pause auto-load above this size and ask the user
  // to opt in via SessionDetail's overlay. `largeConfirmedKey` stores the
  // composite key the user already opted-in for so revisiting the same
  // session in the same window doesn't re-prompt.
  const LARGE_SESSION_THRESHOLD = 50 * 1024 * 1024; // 50 MB
  const [largeConfirmedKey, setLargeConfirmedKey] = useState<string | null>(null);
  const [pendingLargeKey, setPendingLargeKey] = useState<string | null>(null);
  // Set true while a refresh refetch is in-flight (different from initial
  // load — we don't clear `messages` for refresh, so loadingMessages stays
  // false). SessionDetail uses this to drive the spinner / done-check on
  // the toolbar refresh button.
  const [refreshingMessages, setRefreshingMessages] = useState(false);
  // Bumped by SessionDetail's refresh button so the message-loading effect
  // re-runs (active session id hasn't changed → we need an explicit signal).
  const [messageRefreshTick, setMessageRefreshTick] = useState(0);
  const [filtersByView, setFiltersByView] = useState<FiltersByView>(loadFiltersByView);
  const viewKey = asViewKey(view);
  const filters = filtersByView[viewKey];
  const setFilters: React.Dispatch<React.SetStateAction<Filters>> = useCallback((next) => {
    setFiltersByView(prev => {
      const cur = prev[viewKey];
      const updated = typeof next === 'function' ? (next as (p: Filters) => Filters)(cur) : next;
      return { ...prev, [viewKey]: updated };
    });
  }, [viewKey]);
  const activeReqRef = useRef<string | null>(null);
  // Tracks the last session+filePath actually loaded into the detail pane so
  // we can tell a refresh tick apart from a real session switch. When they
  // match we don't clear `messages` — the refetch lands silently and
  // SessionDetail folds new turns in without snapping the scroll position.
  const lastReqKeyRef = useRef<string | null>(null);
  // Mirrors `messageRefreshTick` so a re-fired effect can tell whether the
  // user actually hit the Refresh button (tick incremented) vs. the effect
  // running twice for unrelated reasons (React 18 StrictMode double-mount
  // in dev, fast-refresh after edits, etc.). Without this, StrictMode's
  // second pass on a fresh session mount sees `lastReqKeyRef.current ===
  // reqKey` and silently flips the toolbar into the spinning "refreshing"
  // state for no real refresh.
  const lastRefreshTickRef = useRef<number>(0);
  const [currentSource] = useCurrentSource();

  // Source-scoped state: when the user flips Claude ↔ Codex the per-source
  // session set changes wholesale, so any project filter from the old source
  // is guaranteed stale. Clear so the new source starts with a clean filter
  // rather than carrying over an irrelevant projectDir that ends up with
  // zero matches.
  useEffect(() => {
    setFiltersByView(prev => {
      const next: FiltersByView = { ...prev };
      let changed = false;
      for (const v of VIEW_KEYS) {
        if (next[v].project) {
          next[v] = { ...next[v], project: '' };
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [currentSource]);

  useEffect(() => {
    // Strip query (in-flight typing isn't worth persisting); keep the other
    // dimensions per-view.
    const persist: Partial<Record<ViewKey, Omit<Filters, 'query'>>> = {};
    for (const v of VIEW_KEYS) {
      const { project, time, sort } = filtersByView[v];
      persist[v] = { project, time, sort };
    }
    localStorage.setItem(FILTERS_STORAGE, JSON.stringify(persist));
  }, [filtersByView]);

  // App.tsx dispatches this when the user jumps from Search → History. Drop
  // History's project filter; widen time to 'all' ONLY when the chosen
  // session's lastTs falls outside the current time window. Sort and the
  // other views' filters are untouched.
  useEffect(() => {
    const h = (e: Event) => {
      const detail = (e as CustomEvent).detail as { lastTs: number };
      setFiltersByView(prev => {
        const cur = prev.sessions;
        const next: Filters = { ...cur, project: '' };
        if (detail?.lastTs && cur.time !== 'all') {
          const days = parseInt(cur.time, 10);
          if (Number.isFinite(days) && detail.lastTs < Date.now() - days * 86400000) {
            next.time = 'all';
          }
        }
        return { ...prev, sessions: next };
      });
    };
    window.addEventListener('history:relaxForTarget', h);
    return () => window.removeEventListener('history:relaxForTarget', h);
  }, []);

  // Auto-clear the current view's project filter when the projectDir it points
  // at has no sessions in the current view (e.g. the only favorite under that
  // project was just unfavorited). Same idea as before but evaluated per view,
  // so other views' filters are untouched.
  useEffect(() => {
    if (!filters.project) return;
    const k = (s: SessionMeta) => `${s.source}:${s.id}`;
    const stillHasProject = sessions.some(s => {
      if (s.projectDir !== filters.project) return false;
      if (viewKey === 'favorites') return favorites.has(k(s));
      if (viewKey === 'excluded') return excluded.has(k(s));
      return !excluded.has(k(s));
    });
    if (!stillHasProject) setFilters(prev => ({ ...prev, project: '' }));
  }, [viewKey, filters.project, sessions, favorites, excluded, setFilters]);

  // Two-stage filter: pre-project applies view + time + query + deep, then we
  // apply project. The pre-project slice feeds the project picker dropdown so
  // it shows every project the user could still switch to — previously the
  // dropdown reused the post-project list, which collapsed to just the active
  // project (+ "no project") after one selection.
  const preProjectFiltered = useMemo(() => {
    let arr = sessions.slice();
    const k = (s: SessionMeta) => `${s.source}:${s.id}`;
    if (view === 'favorites') arr = arr.filter(s => favorites.has(k(s)));
    else if (view === 'excluded') arr = arr.filter(s => excluded.has(k(s)));
    else arr = arr.filter(s => !excluded.has(k(s)));

    if (filters.time !== 'all') {
      const days = parseInt(filters.time, 10);
      const cutoff = Date.now() - days * 86400000;
      arr = arr.filter(s => sessionTimestamp(s) >= cutoff);
    }
    const q = filters.query.trim().toLowerCase();
    if (q) {
      arr = arr.filter(s => {
        const hay = [s.alias, s.summary, s.firstUser, s.decodedCwd, s.gitBranch, s.projectDir, s.id]
          .filter(Boolean).join(' ').toLowerCase();
        return hay.includes(q);
      });
    }
    return arr;
  }, [sessions, view, favorites, excluded, filters.time, filters.query]);

  const filtered = useMemo(() => {
    let arr = filters.project
      ? preProjectFiltered.filter(s => s.projectDir === filters.project)
      : preProjectFiltered.slice();

    switch (filters.sort) {
      case 'oldest': arr.sort((a, b) => sessionTimestamp(a) - sessionTimestamp(b)); break;
      case 'largest': arr.sort((a, b) => (b.fileSize || 0) - (a.fileSize || 0)); break;
      case 'messages': arr.sort((a, b) => visibleMessageCount(b) - visibleMessageCount(a)); break;
      case 'tokens': arr.sort((a, b) => totalTokens(b) - totalTokens(a)); break;
      default:
        arr.sort((a, b) => sessionTimestamp(b) - sessionTimestamp(a));
    }
    return arr;
  }, [preProjectFiltered, filters.project, filters.sort]);

  const activeSession = useMemo(() => sessions.find(s => srcKey(s) === activeId) || null, [sessions, activeId]);

  useEffect(() => {
    if (!activeSession) {
      // Always reset BOTH messages and the loading/refresh flags here. A
      // previous run may have set loadingMessages=true before activeSession
      // flipped to null (e.g. Search → History where the inView guard fires
      // momentarily); without the reset the detail pane stays stuck on the
      // "Loading messages…" placeholder forever.
      setMessages(null);
      setLoadingMessages(false);
      setRefreshingMessages(false);
      lastReqKeyRef.current = null;
      activeReqRef.current = null;
      return;
    }
    // Key the in-flight token by source+id, not bare id. Two sessions with the
    // same UUID across Claude and Codex would otherwise share a token — the
    // earlier source's getSession could resolve after the user flipped source
    // and write the wrong messages into the detail pane.
    // Key includes filePath so two sessions with the same `source:id` but
    // different on-disk locations (rare but possible after a rename / cache
    // resurrection) don't read each other's messages.
    const reqKey = srcKey(activeSession) + '@' + (activeSession.filePath || '');
    // Refresh = same session AND user actually bumped `messageRefreshTick`.
    // Checking the tick (not just the key) blocks StrictMode's dev-mode
    // double-mount and any other re-fire that re-runs the effect for the
    // same session without the user pressing Refresh.
    const tickChanged = lastRefreshTickRef.current !== messageRefreshTick;
    const isRefresh = lastReqKeyRef.current === reqKey && tickChanged;
    lastReqKeyRef.current = reqKey;
    lastRefreshTickRef.current = messageRefreshTick;
    activeReqRef.current = reqKey;
    // Big-session gate: when the JSONL is over the threshold and the user
    // hasn't already confirmed for this session, surface the confirm
    // overlay in SessionDetail and bail before the IPC slurps the file.
    // Refresh skips the gate — if the user already loaded once and is
    // hitting refresh, they've already accepted the cost.
    const tooBig = !isRefresh
      && !demoMode
      && (activeSession.fileSize || 0) > LARGE_SESSION_THRESHOLD
      && largeConfirmedKey !== reqKey;
    if (tooBig) {
      setMessages(null);
      setLoadingMessages(false);
      setRefreshingMessages(false);
      setPendingLargeKey(reqKey);
      return;
    }
    setPendingLargeKey(null);
    if (!isRefresh) {
      setMessages(null);
      setLoadingMessages(true);
    } else {
      setRefreshingMessages(true);
    }
    if (demoMode) {
      const demo = DEMO_MESSAGES[activeSession.id] || [];
      setMessages(demo);
      setLoadingMessages(false);
      setRefreshingMessages(false);
      return;
    }
    // cancelled flag so the cleanup (view switch / unmount / session change)
    // blocks any late-arriving .then from writing state. activeReqRef already
    // covers the source/filePath collision case; this also covers a clean
    // teardown when the component itself goes away.
    let cancelled = false;
    window.api.getSession(activeSession.filePath).then(msgs => {
      if (cancelled || activeReqRef.current !== reqKey) return;
      setMessages(msgs);
      // Always clear BOTH spinners on a settled fetch — a previous run may
      // have left loadingMessages=true if a non-refresh run was superseded
      // by a refresh-typed re-run before the original fetch settled.
      setLoadingMessages(false);
      setRefreshingMessages(false);
    }).catch(e => {
      if (cancelled || activeReqRef.current !== reqKey) return;
      onStatus(t('status.loadError', { error: e.message }));
      setLoadingMessages(false);
      setRefreshingMessages(false);
    });
    return () => { cancelled = true; };
    // Depend on identity-stable primitives (id + filePath) not the activeSession
    // object — background SWR refreshes replace the sessions array every minute,
    // so the .find()-derived activeSession reference changes even when the user
    // is sitting on the same session. Keying on id avoids re-fetching JSONL
    // and re-flashing the "Loading messages…" placeholder on every focus.
    // messageRefreshTick is in deps so the explicit Refresh button in
    // SessionDetail re-runs this effect without touching the session id.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSession?.id, activeSession?.filePath, demoMode, onStatus, messageRefreshTick, largeConfirmedKey, LARGE_SESSION_THRESHOLD]);

  return (
    <>
      <SessionList
        items={filtered}
        projectChoices={preProjectFiltered}
        favorites={favorites}
        excluded={excluded}
        manualExcluded={manualExcluded}
        excludeRules={excludeRules}
        onExcludeRulesChange={onExcludeRulesChange}
        activeId={activeId}
        filters={filters}
        sessions={sessions}
        onSelect={onActiveIdChange}
        onFilters={setFilters}
        onToggleFavorite={onToggleFavorite}
        onToggleExclude={onToggleExclude}
        loading={loading}
        onStatus={onStatus}
        view={view as 'sessions' | 'favorites' | 'excluded'}
      />
      <Resizer cssVar="--list-width" storageKey="list-width" min={320} max={450} side="left" />
      <SessionDetail
        session={activeSession}
        messages={messages}
        loading={loadingMessages}
        refreshing={refreshingMessages}
        favorites={favorites}
        excluded={excluded}
        query={filters.query}
        onToggleFavorite={onToggleFavorite}
        onToggleExclude={onToggleExclude}
        onStatus={onStatus}
        onOpenInfo={onOpenInfo}
        onRefreshMessages={() => setMessageRefreshTick(t => t + 1)}
        // Big-session opt-in: when the active session is over
        // LARGE_SESSION_THRESHOLD and not yet confirmed for this session,
        // SessionDetail renders a confirm overlay instead of auto-loading.
        // Clicking the overlay's "Load" button bumps `largeConfirmedKey`,
        // which re-fires the fetch effect and starts the IPC.
        pendingLargeLoad={
          pendingLargeKey && activeSession
            && pendingLargeKey === srcKey(activeSession) + '@' + (activeSession.filePath || '')
            ? { sizeBytes: activeSession.fileSize || 0, onConfirm: () => setLargeConfirmedKey(pendingLargeKey) }
            : null
        }
      />
    </>
  );
}

function totalTokens(s: SessionMeta) {
  return (s.tokensIn || 0) + (s.tokensOut || 0) + (s.tokensCacheRead || 0) + (s.tokensCacheCreate || 0);
}
