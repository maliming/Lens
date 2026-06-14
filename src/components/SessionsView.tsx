import { useCallback, useEffect, useMemo, useState, useRef } from 'react';
import { SessionList } from './SessionList';
import { SessionDetail } from './SessionDetail';
import { Resizer } from './Resizer';
import { sessionTimestamp } from '../lib/format';
import { DEMO_MESSAGES } from '../lib/demoData';
import { useCurrentSource, srcKey } from '../lib/sources';
import type { MessageItem, SessionMeta, UsageSummary, View } from '../types';

type Props = {
  view: View;
  sessions: SessionMeta[];
  favorites: Set<string>;
  excluded: Set<string>;
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
// not Favorites' or Excluded's). Legacy v1 storage was a single blob; we
// migrate it onto the History view and keep the other views fresh.
type ViewKey = 'sessions' | 'favorites' | 'excluded';
type FiltersByView = Record<ViewKey, Filters>;

const FILTERS_STORAGE = 'session-filters-v2';
const LEGACY_FILTERS_STORAGE = 'session-filters-v1';
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
        return blank;
      }
    }
    // Legacy single-blob → seed History only; Favorites/Excluded start fresh
    // so the user's older "show me X" choice doesn't leak across views.
    const legacy = localStorage.getItem(LEGACY_FILTERS_STORAGE);
    if (legacy) {
      const obj = JSON.parse(legacy);
      if (obj && typeof obj === 'object') {
        blank.sessions = { ...DEFAULT_FILTERS, ...obj, query: '' };
      }
    }
  } catch {}
  return blank;
}

function asViewKey(v: string): ViewKey {
  return v === 'favorites' || v === 'excluded' ? v : 'sessions';
}

export function SessionsView({ view, sessions, favorites, excluded, excludeRules, onExcludeRulesChange, demoMode, loading, activeId, onActiveIdChange, onToggleFavorite, onToggleExclude, onStatus, onOpenInfo }: Props) {
  const [messages, setMessages] = useState<MessageItem[] | null>(null);
  const [loadingMessages, setLoadingMessages] = useState(false);
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
  const [deepHits, setDeepHits] = useState<Map<string, { snippet: string; matchCount: number }> | null>(null);
  const [deepSearchLoading, setDeepSearchLoading] = useState(false);
  const activeReqRef = useRef<string | null>(null);
  // Monotonic counter + latest-query ref for deep-search stale guarding.
  // Comparing against the closure's `filters.query` would let a slow search
  // resolve after the user edited the input — using a ref ensures we always
  // compare to the live value.
  const deepSeqRef = useRef(0);
  const latestDeepQueryRef = useRef('');
  const [currentSource] = useCurrentSource();
  // Mirror currentSource into a ref so the stale guard inside an async deep
  // search compares against the LATEST source rather than the closure capture.
  // Without this a fast Claude → Codex flip can let a Claude search resolve
  // and overwrite Codex's deepHits because closure `currentSource` still
  // reads "claude" inside the .then.
  const currentSourceRef = useRef(currentSource);
  useEffect(() => { currentSourceRef.current = currentSource; }, [currentSource]);

  // Source-scoped state: when the user flips Claude ↔ Codex the per-source
  // session set changes wholesale, so any project filter / deep-search hits
  // from the old source are guaranteed stale. Clear them so the new source
  // starts with a clean filter rather than carrying over an irrelevant
  // projectDir that ends up with zero matches.
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
    setDeepHits(null);
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
    if (q && !deepHits) {
      arr = arr.filter(s => {
        const hay = [s.alias, s.summary, s.firstUser, s.decodedCwd, s.gitBranch, s.projectDir, s.id]
          .filter(Boolean).join(' ').toLowerCase();
        return hay.includes(q);
      });
    }
    if (deepHits) arr = arr.filter(s => deepHits.has(`${s.source}:${s.id}`));
    return arr;
  }, [sessions, view, favorites, excluded, filters.time, filters.query, deepHits]);

  const filtered = useMemo(() => {
    let arr = filters.project
      ? preProjectFiltered.filter(s => s.projectDir === filters.project)
      : preProjectFiltered.slice();

    switch (filters.sort) {
      case 'oldest': arr.sort((a, b) => sessionTimestamp(a) - sessionTimestamp(b)); break;
      case 'largest': arr.sort((a, b) => (b.fileSize || 0) - (a.fileSize || 0)); break;
      case 'messages': arr.sort((a, b) => ((b.userMsgs || 0) + (b.assistantMsgs || 0)) - ((a.userMsgs || 0) + (a.assistantMsgs || 0))); break;
      case 'tokens': arr.sort((a, b) => totalTokens(b) - totalTokens(a)); break;
      default:
        if (deepHits) arr.sort((a, b) => (deepHits.get(`${b.source}:${b.id}`)?.matchCount || 0) - (deepHits.get(`${a.source}:${a.id}`)?.matchCount || 0));
        else arr.sort((a, b) => sessionTimestamp(b) - sessionTimestamp(a));
    }
    return arr;
  }, [preProjectFiltered, filters.project, filters.sort, deepHits]);

  const activeSession = useMemo(() => sessions.find(s => srcKey(s) === activeId) || null, [sessions, activeId]);

  useEffect(() => {
    if (!activeSession) { setMessages(null); return; }
    setMessages(null);
    setLoadingMessages(true);
    // Key the in-flight token by source+id, not bare id. Two sessions with the
    // same UUID across Claude and Codex would otherwise share a token — the
    // earlier source's getSession could resolve after the user flipped source
    // and write the wrong messages into the detail pane.
    // Key includes filePath so two sessions with the same `source:id` but
    // different on-disk locations (rare but possible after a rename / cache
    // resurrection) don't read each other's messages.
    const reqKey = srcKey(activeSession) + '@' + (activeSession.filePath || '');
    activeReqRef.current = reqKey;
    if (demoMode) {
      const demo = DEMO_MESSAGES[activeSession.id] || [];
      setMessages(demo);
      setLoadingMessages(false);
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
      setLoadingMessages(false);
    }).catch(e => {
      if (cancelled || activeReqRef.current !== reqKey) return;
      onStatus('Load error: ' + e.message);
      setLoadingMessages(false);
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
  }, [activeSession?.id, activeSession?.filePath, demoMode, onStatus, messageRefreshTick]);

  const runDeepSearch = async () => {
    if (deepSearchLoading) return;  // ignore re-trigger while in flight
    const q = filters.query.trim();
    if (q.length < 2) { onStatus('Type at least 2 chars'); setTimeout(() => onStatus(''), 2000); return; }
    // Stale guard: tag the request by source + query + seq. If anything
    // changes by the time the IPC lands, drop the result so a slow search
    // doesn't paint hits from a query/source the user has already moved off.
    const reqSeq = ++deepSeqRef.current;
    const reqSource = currentSource;
    latestDeepQueryRef.current = q;
    setDeepSearchLoading(true);
    onStatus(`Deep-searching "${q}"…`);
    try {
      const hits = await window.api.deepSearch(q, reqSource);
      if (reqSeq !== deepSeqRef.current || reqSource !== currentSourceRef.current || q !== latestDeepQueryRef.current) return;
      // Key by `source:id` so a Codex session can't collide with a Claude one
      // that happens to share the same UUID prefix in some edge case.
      setDeepHits(new Map(hits.map(h => [`${h.source}:${h.id}`, { snippet: h.snippet, matchCount: h.matchCount }])));
      onStatus(`Deep search: ${hits.length} matched`);
      setTimeout(() => onStatus(''), 2500);
    } catch (e: any) {
      if (reqSeq !== deepSeqRef.current) return;
      onStatus('Error: ' + e.message);
    } finally {
      if (reqSeq === deepSeqRef.current) setDeepSearchLoading(false);
    }
  };

  const clearDeep = () => {
    // Bump seq + drop latest-query so a still-pending deep search can't
    // re-populate the hits we just cleared.
    ++deepSeqRef.current;
    latestDeepQueryRef.current = '';
    setDeepHits(null);
  };

  return (
    <>
      <SessionList
        items={filtered}
        projectChoices={preProjectFiltered}
        favorites={favorites}
        excluded={excluded}
        excludeRules={excludeRules}
        onExcludeRulesChange={onExcludeRulesChange}
        activeId={activeId}
        deepHits={deepHits}
        filters={filters}
        sessions={sessions}
        onSelect={onActiveIdChange}
        onFilters={setFilters}
        onToggleFavorite={onToggleFavorite}
        onToggleExclude={onToggleExclude}
        onDeepSearch={runDeepSearch}
        onClearDeep={clearDeep}
        deepSearchLoading={deepSearchLoading}
        loading={loading}
        onStatus={onStatus}
        view={view as 'sessions' | 'favorites' | 'excluded'}
      />
      <Resizer cssVar="--list-width" storageKey="list-width" min={320} max={450} side="left" />
      <SessionDetail
        session={activeSession}
        messages={messages}
        loading={loadingMessages}
        favorites={favorites}
        excluded={excluded}
        query={filters.query}
        onToggleFavorite={onToggleFavorite}
        onToggleExclude={onToggleExclude}
        onStatus={onStatus}
        onOpenInfo={onOpenInfo}
        onRefreshMessages={() => setMessageRefreshTick(t => t + 1)}
      />
    </>
  );
}

function totalTokens(s: SessionMeta) {
  return (s.tokensIn || 0) + (s.tokensOut || 0) + (s.tokensCacheRead || 0) + (s.tokensCacheCreate || 0);
}
