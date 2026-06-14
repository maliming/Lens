import { useEffect, useMemo, useRef, useState } from 'react';
import { Search, Star, GitBranch, Play, Filter, Clock, X, ChevronDown, List as ListIcon, LayoutGrid, Calendar } from 'lucide-react';
import { cn } from '../lib/utils';
import { cleanDisplayText, fmtTime, fmtTokens, sessionTimestamp } from '../lib/format';
import { deriveDisplayTitle, projectShortName, meaningfulBranch } from '../lib/sessionTitle';
import { useTranslation } from '../lib/I18nProvider';
import { useCurrentSource, srcKey } from '../lib/sources';
import { useDisplayPrefs } from '../lib/displayPrefs';
import { useSystemCapabilities } from '../lib/systemCapabilities';
import type { SessionMeta } from '../types';

type TimeFilter = 'all' | 'today' | '7' | '30' | 'year';
type Sort = 'relevance' | 'recent' | 'oldest' | 'tokens' | 'messages';
type ViewMode = 'list' | 'card' | 'timeline';
const VIEW_MODE_STORAGE = 'search-view-mode-v1';

// Per-source so the Claude and Codex recent-query chips don't mix; queries
// against Claude's session corpus rarely make sense against Codex and vice
// versa, and showing the wrong tool's history was a real point of confusion.
const recentStorageKey = (source: string) => `search-recent-v1:${source}`;
const RECENT_MAX = 8;
const PAGE_SIZE = 50;

// Map each option to its i18n key so the labels follow the active locale.
// The actual user-visible string is resolved via t() at render time.
const TIME_KEYS: Record<TimeFilter, string> = {
  all: 'search.time.all',
  today: 'search.time.today',
  '7': 'search.time.week',
  '30': 'search.time.month',
  year: 'search.time.year',
};

const SORT_KEYS: Record<Sort, string> = {
  relevance: 'search.sort.relevance',
  recent: 'search.sort.recent',
  oldest: 'search.sort.oldest',
  tokens: 'search.sort.tokens',
  messages: 'search.sort.messages',
};

const SUGGESTED_PROMPTS = [
  'Search by error message',
  'Search by file name',
  'Search by feature',
  'Search by repository',
  'Search by branch',
];

type Props = {
  sessions: SessionMeta[];
  favorites: Set<string>;
  excluded: Set<string>;
  loading?: boolean;
  onSelectSession: (id: string) => void;
  onToggleFavorite: (id: string) => void;
  onStatus: (msg: string) => void;
};

type DeepSources = { user: number; assistant: number; summary: number; tool: number };

type ResultRowData = {
  session: SessionMeta;
  title: string;
  project: string;
  branch: string | null;
  tokens: number;
  msgs: number;
  snippet?: string;
  matchCount?: number;
  coverage?: number;
  sources?: DeepSources;
};

function loadRecent(source: string): string[] {
  try {
    const raw = localStorage.getItem(recentStorageKey(source));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    // Defensive — localStorage could be corrupted into a non-array shape
    // (other tab wrote, version mismatch, manual edit). Filter to strings
    // so the renderer's `.map(...)` never crashes the Search page.
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is string => typeof x === 'string').slice(0, RECENT_MAX);
  } catch {}
  return [];
}

export function SearchView({ sessions, favorites, excluded, loading = false, onSelectSession, onToggleFavorite, onStatus }: Props) {
  const { t } = useTranslation();
  const [currentSource] = useCurrentSource();
  // Result layout — list (default, dense rows), card (2-column tiles), or
  // timeline (rows grouped by day). Persisted per-user so re-opening Search
  // keeps the chosen mode.
  // Default to timeline — the chronological layout is the most expressive
  // view of "what did I do recently". User's choice (if they switch) is
  // persisted in localStorage and wins on next mount.
  const [viewMode, setViewMode] = useState<ViewMode>(() => {
    try {
      const v = localStorage.getItem(VIEW_MODE_STORAGE);
      if (v === 'list' || v === 'card' || v === 'timeline') return v;
    } catch {}
    return 'timeline';
  });
  useEffect(() => { try { localStorage.setItem(VIEW_MODE_STORAGE, viewMode); } catch {} }, [viewMode]);
  const [query, setQuery] = useState('');
  const [submitted, setSubmitted] = useState('');
  const [project, setProject] = useState('');
  // Default to last 7 days — Search is for recall, not exhaustive browsing.
  // The chip stays editable so power users can widen the window.
  const [timeFilter, setTimeFilter] = useState<TimeFilter>('7');
  const [sort, setSort] = useState<Sort>('relevance');
  const [favOnly, setFavOnly] = useState(false);
  const [recent, setRecent] = useState<string[]>(() => loadRecent(currentSource));
  const [deepHits, setDeepHits] = useState<Map<string, { snippet: string; matchCount: number; coverage?: number; sources?: DeepSources }>>(new Map());
  const [deepLoading, setDeepLoading] = useState(false);
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const inputRef = useRef<HTMLInputElement>(null);
  // Monotonic counter so the latest submitDeep wins if the user re-queries or
  // flips source mid-flight. Bumped on every submit; results check vs current
  // before writing state.
  const deepSeqRef = useRef(0);
  // Latest source / query mirrored for closure-safe comparison in the async
  // submitDeep — capturing the value at call-time would still let a slow
  // search resolve and overwrite the new state.
  const currentSourceRef = useRef(currentSource);
  useEffect(() => { currentSourceRef.current = currentSource; }, [currentSource]);
  // Latest submitted query — also mirrored to a ref so we can drop results
  // whose original query no longer matches what the user is asking about.
  const latestQueryRef = useRef('');

  // Track which source the current `recent` state actually belongs to, so a
  // source flip doesn't race: when currentSource changes, the persistence
  // effect would otherwise fire FIRST (with new source key + old recent
  // state) and clobber the new source's recents before the load effect runs.
  const recentSourceRef = useRef(currentSource);
  useEffect(() => {
    // Persist only when the in-memory recent matches the source it came from.
    if (recentSourceRef.current !== currentSource) return;
    localStorage.setItem(recentStorageKey(currentSource), JSON.stringify(recent));
  }, [recent, currentSource]);
  // Source switch: load the new source's recents synchronously and re-tag
  // the ref so the next save targets the correct source.
  useEffect(() => {
    setRecent(loadRecent(currentSource));
    recentSourceRef.current = currentSource;
  }, [currentSource]);
  useEffect(() => { inputRef.current?.focus(); }, []);

  // Reset pagination whenever the result set could change.
  useEffect(() => { setVisibleCount(PAGE_SIZE); }, [query, project, timeFilter, sort, favOnly, deepHits]);

  // Source switch: the user's pending query, deep hits, and project filter
  // were all against the OLD source's sessions. Wipe so the Search page
  // starts clean on the new source rather than showing stale state.
  useEffect(() => {
    ++deepSeqRef.current;
    latestQueryRef.current = '';
    setQuery('');
    setSubmitted('');
    setProject('');
    setDeepHits(new Map());
    setDeepLoading(false);
    setVisibleCount(PAGE_SIZE);
  }, [currentSource]);

  const projectOptions = useMemo(() => {
    const m = new Map<string, { cwd: string; count: number }>();
    for (const s of sessions) {
      const dir = s.projectDir;
      if (!m.has(dir)) m.set(dir, { cwd: s.projectCwd || s.decodedCwd, count: 0 });
      m.get(dir)!.count++;
    }
    return [...m.entries()].sort((a, b) => b[1].count - a[1].count);
  }, [sessions]);

  const submitDeep = async (q: string) => {
    const trimmed = q.trim();
    if (!trimmed) {
      // Empty submit acts as cancel: bump the seq + clear latest-query so any
      // in-flight deep search's `.then` doesn't paint stale hits over the
      // now-empty result list.
      ++deepSeqRef.current;
      latestQueryRef.current = '';
      setSubmitted('');
      setDeepHits(new Map());
      return;
    }
    setSubmitted(trimmed);
    // Clean the query before saving to recent chips — a pasted string with
    // control / bidi chars would otherwise corrupt the visible chip later.
    const recentEntry = cleanDisplayText(trimmed).slice(0, 200);
    if (recentEntry) setRecent(prev => [recentEntry, ...prev.filter(x => x !== recentEntry)].slice(0, RECENT_MAX));
    setDeepLoading(true);
    // Deep search reads every JSONL regardless of the active time window. If
    // the user kept the default 7-day filter, old hits would render but be
    // immediately filtered out of the list. Widen automatically so the
    // results the user just asked for are actually visible.
    if (timeFilter !== 'all') setTimeFilter('all');
    // Stale guard: tag the request with its source + query + seq, drop the
    // result if anything's changed by the time it lands. Compare against
    // refs (currentSourceRef / latestQueryRef) not closure captures, otherwise
    // a fast Claude→Codex flip or re-query lets the old result through.
    const reqSeq = ++deepSeqRef.current;
    const reqSource = currentSource;
    latestQueryRef.current = trimmed;
    try {
      const hits = await window.api.deepSearch(trimmed, reqSource);
      if (reqSeq !== deepSeqRef.current || reqSource !== currentSourceRef.current || trimmed !== latestQueryRef.current) return;
      // Key by `source:id` so future cross-source hits never collide on
      // identical session UUIDs (the sessions list itself already uses this
      // composite shape via srcKey()).
      const m = new Map<string, { snippet: string; matchCount: number; coverage?: number; sources?: DeepSources }>();
      for (const h of hits) m.set(`${h.source}:${h.id}`, { snippet: h.snippet, matchCount: h.matchCount, coverage: h.coverage, sources: h.sources });
      setDeepHits(m);
    } catch (e: any) {
      if (reqSeq !== deepSeqRef.current || reqSource !== currentSourceRef.current) return;
      onStatus('Search failed: ' + e.message);
    } finally {
      if (reqSeq === deepSeqRef.current && reqSource === currentSourceRef.current) {
        setDeepLoading(false);
      }
    }
  };

  const onSubmit = (e: React.FormEvent) => { e.preventDefault(); submitDeep(query); };

  const clearAll = () => {
    // Bump seq + latest query so any in-flight deep search is invalidated
    // before we clear out hits — otherwise a slow .then could re-populate.
    ++deepSeqRef.current;
    latestQueryRef.current = '';
    setQuery(''); setSubmitted(''); setDeepHits(new Map());
    setProject(''); setTimeFilter('all'); setSort('relevance'); setFavOnly(false);
  };

  const cutoffMs = useMemo(() => {
    if (timeFilter === 'all') return null;
    const now = Date.now();
    if (timeFilter === 'today') {
      const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime();
    }
    if (timeFilter === '7') return now - 7 * 86400e3;
    if (timeFilter === '30') return now - 30 * 86400e3;
    if (timeFilter === 'year') return now - 365 * 86400e3;
    return null;
  }, [timeFilter]);

  // Tokenize the SUBMITTED query, not the live input. The previously-
  // submitted deep hits stay rendered while the user starts typing the next
  // query — and the row filter should agree with what those hits match
  // (otherwise editing `foo` to `bar` would silently empty the list even
  // though the foo-search hits are still on screen).
  const queryTerms = useMemo(() => tokenizeQuery(submitted || query), [submitted, query]);

  const filteredRows: ResultRowData[] = useMemo(() => {
    const rows: ResultRowData[] = [];
    for (const s of sessions) {
      const k = `${s.source}:${s.id}`;
      if (excluded.has(k)) continue;
      if (favOnly && !favorites.has(k)) continue;
      if (project && s.projectDir !== project) continue;
      const lastMs = sessionTimestamp(s);
      if (cutoffMs != null && lastMs < cutoffMs) continue;
      const projName = projectShortName(s.projectCwd || s.decodedCwd);
      const rawTitle = s.alias || s.summary || s.firstUser || '(no human message)';
      const title = deriveDisplayTitle(rawTitle).primary;
      const branchName = meaningfulBranch(s.gitBranch);
      if (queryTerms.length > 0) {
        const haystack = (title + ' ' + projName + ' ' + (branchName || '') + ' ' + (s.firstUser || '')).toLowerCase();
        const hit = deepHits.get(`${s.source}:${s.id}`);
        // OR semantics: any term hitting the shallow haystack counts. deepHit
        // (already OR-matched on backend) also keeps the row in.
        const shallowHit = queryTerms.some(t => haystack.includes(t));
        if (!shallowHit && !hit) continue;
      }
      const tokens = (s.tokensIn || 0) + (s.tokensOut || 0) + (s.tokensCacheRead || 0) + (s.tokensCacheCreate || 0);
      const msgs = (s.userMsgs || 0) + (s.assistantMsgs || 0);
      const hit = deepHits.get(`${s.source}:${s.id}`);
      rows.push({ session: s, title, project: projName, branch: branchName, tokens, msgs, snippet: hit?.snippet, matchCount: hit?.matchCount, coverage: hit?.coverage, sources: hit?.sources });
    }
    rows.sort((a, b) => {
      switch (sort) {
        case 'tokens': return b.tokens - a.tokens;
        case 'messages': return b.msgs - a.msgs;
        case 'oldest': return sessionTimestamp(a.session) - sessionTimestamp(b.session);
        case 'recent':
        case 'relevance':
        default: {
          if (sort === 'relevance' && (a.matchCount || b.matchCount)) {
            // Same rule the backend used: coverage (distinct terms hit)
            // dominates raw matchCount. Without this the renderer reshuffles
            // multi-word search results and a hit on one term × N can beat
            // a hit on three terms × 1.
            const dCov = (b.coverage || 0) - (a.coverage || 0);
            if (dCov !== 0) return dCov;
            return (b.matchCount || 0) - (a.matchCount || 0);
          }
          return sessionTimestamp(b.session) - sessionTimestamp(a.session);
        }
      }
    });
    return rows;
  }, [sessions, excluded, favOnly, favorites, project, cutoffMs, queryTerms, submitted, deepHits, sort]);

  const hasFilters = !!query || !!project || timeFilter !== 'all' || sort !== 'relevance' || favOnly;
  // Loading state — sessions are still being scanned from disk. We show a
  // skeleton list rather than blanking; "blank for a moment" was the v0 bug
  // because both empty-states' conditions were unreachable while loading.
  const isLoading = loading && sessions.length === 0;
  const showHint = !hasFilters && !submitted && filteredRows.length === 0 && !isLoading;
  const noResults = hasFilters && filteredRows.length === 0 && !isLoading;

  const displayRows = useMemo(() => filteredRows.slice(0, visibleCount), [filteredRows, visibleCount]);
  const hasMore = filteredRows.length > visibleCount;
  const loadMore = () => setVisibleCount(c => Math.min(c + PAGE_SIZE, filteredRows.length));

  return (
    <main data-pane="detail" className="flex-1 min-w-0 min-h-0 overflow-hidden bg-surface border border-border rounded-2xl flex flex-col">
      <header className="flex-shrink-0 px-8 pt-7 pb-4 border-b border-border-soft">
        <div className="mb-3">
          <h1 className="text-[22px] font-bold text-text leading-tight">{t('search.title')}</h1>
          <p className="text-[12.5px] text-text-muted mt-0.5">{t('search.subtitle')}</p>
        </div>

        <form onSubmit={onSubmit}>
          <div className="relative">
            <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-text-muted pointer-events-none" />
            <input
              id="search-input"
              ref={inputRef}
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder={t('search.placeholder')}
              className="w-full pl-10 pr-44 h-11 bg-surface border border-border rounded-xl text-[14px] outline-none focus:border-accent transition"
            />
            <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1.5">
              {query && (
                <button type="button" onClick={() => { ++deepSeqRef.current; latestQueryRef.current = ''; setQuery(''); setSubmitted(''); setDeepHits(new Map()); }} className="p-1 rounded text-text-muted hover:bg-muted" title={t('common.clear')}>
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
              <button
                type="submit"
                disabled={!query.trim() || deepLoading}
                className={cn(
                  'inline-flex items-center gap-1.5 h-8 px-2.5 rounded-md text-[11.5px] font-semibold transition disabled:opacity-40 disabled:cursor-not-allowed',
                  query.trim() && !deepLoading ? 'bg-accent text-white hover:opacity-90' : 'bg-muted text-text-muted',
                )}
                title={t('search.deep.tooltip')}
              >
                <Search className="w-3 h-3" />
                {deepLoading ? `${t('search.deepSearch')}…` : t('search.deepSearch')}
                <kbd className={cn('text-[10px] px-1 py-0 rounded border font-mono', query.trim() && !deepLoading ? 'border-white/30 text-white' : 'border-border-soft text-text-muted')}>↵</kbd>
              </button>
            </div>
          </div>
          <p className="text-[10.5px] text-text-muted mt-1.5">{t('search.hint')}</p>
        </form>

        <div className="flex flex-wrap items-center gap-2 mt-3">
          <SelectChip
            icon={<Filter className="w-3 h-3" />}
            label={project ? (projectShortName(projectOptions.find(([d]) => d === project)?.[1].cwd || '') || 'Project') : t('search.allProjects')}
            value={project}
            onChange={setProject}
            options={[{ value: '', label: t('search.allProjects') }, ...projectOptions.map(([dir, info]) => ({
              value: dir,
              label: `${projectShortName(info.cwd) || info.cwd} (${info.count})`,
            }))]}
          />
          <SelectChip
            icon={<Clock className="w-3 h-3" />}
            label={t(TIME_KEYS[timeFilter] as any)}
            value={timeFilter}
            onChange={(v) => setTimeFilter(v as TimeFilter)}
            options={(Object.keys(TIME_KEYS) as TimeFilter[]).map(k => ({ value: k, label: t(TIME_KEYS[k] as any) }))}
          />
          <button
            onClick={() => setFavOnly(v => !v)}
            className={cn(
              'inline-flex items-center gap-1.5 h-8 px-3 rounded-lg text-[12px] font-medium border transition-colors',
              favOnly ? 'bg-amber-50 border-amber-200 text-amber-700 dark:bg-amber-900/30 dark:border-amber-700/40 dark:text-amber-300' : 'bg-surface border-border-soft text-text-muted hover:bg-muted'
            )}
          >
            <Star className={cn('w-3 h-3', favOnly && 'fill-amber-400 text-amber-400')} />
            {t('search.favorites')}
          </button>
          <div className="ml-auto flex items-center gap-2">
            <SelectChip
              label={`${t('search.sortPrefix')}: ${t(SORT_KEYS[sort] as any)}`}
              value={sort}
              onChange={(v) => setSort(v as Sort)}
              options={(Object.keys(SORT_KEYS) as Sort[]).map(k => ({ value: k, label: t(SORT_KEYS[k] as any) }))}
              align="right"
            />
            {hasFilters && (
              <button onClick={clearAll} className="text-[11.5px] text-text-muted hover:text-text underline-offset-2 hover:underline">{t('common.clear')}</button>
            )}
          </div>
        </div>

        {!query && recent.length > 0 && (
          <div className="mt-3 flex flex-wrap items-center gap-1.5">
            <span className="text-[10.5px] uppercase tracking-wider font-semibold text-text-muted mr-1">{t('search.recent')}</span>
            {recent.map(r => (
              <button key={r} onClick={() => { setQuery(r); submitDeep(r); }} className="px-2.5 py-1 rounded-full text-[11.5px] bg-muted/60 border border-border-soft text-text-muted hover:text-text hover:border-border transition">
                {r}
              </button>
            ))}
            <button onClick={() => setRecent([])} className="ml-1 text-[10.5px] text-text-muted hover:text-text">{t('common.clear').toLowerCase()}</button>
          </div>
        )}
      </header>

      <div className="flex-1 min-h-0 overflow-y-auto px-8 pt-4 pb-8">
        {isLoading ? (
          <SkeletonResults />
        ) : (
          <>
            <ResultsHeading
              count={filteredRows.length}
              shown={displayRows.length}
              deepLoading={deepLoading}
              viewMode={viewMode}
              onViewMode={setViewMode}
            />
            {displayRows.length === 0 ? (
              showHint ? <EmptyState onPick={(q) => { setQuery(q); inputRef.current?.focus(); }} /> :
              noResults ? <NoResults /> : null
            ) : (
              <div className="animate-fade-up">
                <ResultsLayout
                  rows={displayRows}
                  mode={viewMode}
                  query={submitted || query}
                  favorites={favorites}
                  onSelect={onSelectSession}
                  onToggleFav={onToggleFavorite}
                  onStatus={onStatus}
                />
                <MoreSentinel hasMore={hasMore} onLoad={loadMore} shown={displayRows.length} total={filteredRows.length} />
              </div>
            )}
          </>
        )}
      </div>
    </main>
  );
}

/* ============================== Result row ============================== */

function ResultRow({ row, isFav, query, onSelect, onToggleFav, onStatus }: {
  row: ResultRowData;
  isFav: boolean;
  query: string;
  onSelect: (id: string) => void;
  onToggleFav: (id: string) => void;
  onStatus: (msg: string) => void;
}) {
  const { t } = useTranslation();
  const [prefs] = useDisplayPrefs();
  const caps = useSystemCapabilities();
  const useITerm = caps?.platform === 'darwin' && caps.terminals.iterm && prefs.preferredTerminal === 'iterm';
  const handleResume = async (e: React.MouseEvent) => {
    e.stopPropagation();
    // Match SessionDetail / SessionList: the user's chosen terminal app wins.
    // Search used to hardwire Terminal.app regardless of the iTerm preference.
    const fn = useITerm ? window.api.openInITerm : window.api.openInTerminal;
    const label = useITerm ? 'iTerm' : 'Terminal';
    try {
      await fn(row.session.projectCwd || row.session.decodedCwd, row.session.id, row.session.filePath, row.session.source);
      onStatus('Opened in ' + label);
      setTimeout(() => onStatus(''), 2500);
    } catch (e: any) { onStatus('Error: ' + e.message); }
  };
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onSelect(srcKey(row.session))}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(srcKey(row.session)); } }}
      className="group w-full text-left rounded-xl border border-border-soft hover:border-border bg-surface px-4 py-3 transition flex items-start gap-3 cursor-pointer outline-none focus-visible:border-accent"
    >
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 min-w-0">
          {isFav && <Star className="w-3.5 h-3.5 fill-amber-400 text-amber-400 flex-shrink-0" />}
          <h3 className="text-[14px] font-semibold text-text truncate">{highlight(row.title, query)}</h3>
          <span className="ml-auto text-[11px] text-text-muted tabular-nums flex-shrink-0">{fmtTime(row.session.lastTs, t)}</span>
        </div>
        <div className="flex items-center gap-2 mt-1 text-[11.5px] text-text-muted">
          <span className="truncate">{row.project}</span>
          {row.branch && (
            <span className="flex items-center gap-1 text-amber-600 dark:text-amber-400 flex-shrink-0"><GitBranch className="w-3 h-3" />{row.branch}</span>
          )}
        </div>
        {(row.snippet || hasShallowMatch(row, query)) && (
          <div className="mt-2 rounded-md bg-accent-soft/40 border border-accent/15 px-2.5 py-1.5">
            <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[10px] uppercase tracking-wider font-semibold text-accent/70 mb-1">
              <Search className="w-2.5 h-2.5" />
              <span>{t('search.matchedIn')}</span>
              {getMatchSources(row, query).map((src, i) => (
                <span key={i} className="inline-flex items-center gap-1 normal-case tracking-normal text-[10.5px] font-semibold bg-accent/10 text-accent rounded px-1.5 py-0.5">
                  {src.label}
                  {src.count != null && src.count > 1 && <span className="tabular-nums text-accent/70 font-normal">·{src.count}</span>}
                </span>
              ))}
            </div>
            {row.snippet && (
              <p className="text-[12px] text-text line-clamp-3 leading-snug">
                …{highlight(cleanDisplayText(row.snippet), query)}…
              </p>
            )}
          </div>
        )}
        <div className="flex items-center gap-3 mt-2 text-[11px] text-text-muted">
          <span className="tabular-nums">{fmtTokens(row.tokens)} tokens</span>
          <span className="text-text-muted/50">·</span>
          <span className="tabular-nums">{row.msgs} msgs</span>
        </div>
      </div>
      <div className="flex flex-col items-end gap-1 flex-shrink-0">
        <button onClick={(e) => { e.stopPropagation(); onToggleFav(row.session.id); }} className="p-1 rounded hover:bg-muted">
          <Star className={cn('w-3.5 h-3.5', isFav ? 'fill-amber-400 text-amber-400' : 'text-text-muted')} />
        </button>
        <button onClick={handleResume} className="inline-flex items-center gap-1 px-2 h-7 rounded-md bg-accent-soft text-accent text-[11px] font-semibold opacity-0 group-hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent transition">
          <Play className="w-3 h-3" /> {t('detail.btn.resume')}
        </button>
      </div>
    </div>
  );
}

/* ============================== Heading + sentinel ============================== */

function ResultsHeading({ count, shown, deepLoading, viewMode, onViewMode }: {
  count: number;
  shown: number;
  deepLoading: boolean;
  viewMode: ViewMode;
  onViewMode: (m: ViewMode) => void;
}) {
  const { t } = useTranslation();
  const showingAll = shown >= count;
  return (
    <div className="flex items-center justify-between mb-3">
      <div className="text-[11.5px] text-text-muted">
        {deepLoading ? (
          <span className="inline-flex items-center gap-1.5"><span className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse" /> {t('search.searchingAll')}</span>
        ) : (
          <>
            <span className="tabular-nums font-semibold text-text">{count}</span> {count === 1 ? t('search.result') : t('search.results')}
            {!showingAll && count > 0 && <span className="text-text-muted/70"> · {t('search.showingFirst', { n: shown })}</span>}
          </>
        )}
      </div>
      {/* View mode switcher — segmented chip group. Hidden when there are no
         results to display so the header stays clean for empty / loading states. */}
      {count > 0 && (
        <div className="inline-flex items-center gap-0.5 bg-muted/40 border border-border-soft rounded-md p-0.5">
          <ViewModeChip mode="timeline" active={viewMode} onSelect={onViewMode} icon={Calendar}   label={t('search.viewMode.timeline')} />
          <ViewModeChip mode="list"     active={viewMode} onSelect={onViewMode} icon={ListIcon}   label={t('search.viewMode.list')} />
          <ViewModeChip mode="card"     active={viewMode} onSelect={onViewMode} icon={LayoutGrid} label={t('search.viewMode.card')} />
        </div>
      )}
    </div>
  );
}

function ViewModeChip({ mode, active, onSelect, icon: Icon, label }: {
  mode: ViewMode;
  active: ViewMode;
  onSelect: (m: ViewMode) => void;
  icon: any;
  label: string;
}) {
  const on = active === mode;
  return (
    <button
      onClick={() => onSelect(mode)}
      title={label}
      className={cn(
        'inline-flex items-center gap-1 px-2 h-6 rounded text-[10.5px] font-medium transition',
        on ? 'bg-surface text-text shadow-sm' : 'text-text-muted hover:text-text',
      )}
    >
      <Icon className="w-3 h-3" />
      <span className="hidden sm:inline">{label}</span>
    </button>
  );
}

// Picks the layout for a given view mode. Each mode reuses the same ResultRow
// component but rearranges container layout — keeps interaction (click, fav,
// resume button) identical across modes.
function ResultsLayout({ rows, mode, query, favorites, onSelect, onToggleFav, onStatus }: {
  rows: ResultRowData[];
  mode: ViewMode;
  query: string;
  favorites: Set<string>;
  onSelect: (id: string) => void;
  onToggleFav: (id: string) => void;
  onStatus: (msg: string) => void;
}) {
  const { t, locale } = useTranslation();
  if (mode === 'card') {
    // Two-column grid of larger cards. Each tile breathes — title + branch +
    // keyword tag chips + a footer with relative time, tokens, msgs.
    return (
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        {rows.map(r => (
          <CardItem
            key={`${r.session.source}:${r.session.id}`}
            row={r}
            isFav={favorites.has(`${r.session.source}:${r.session.id}`)}
            query={query}
            onSelect={onSelect}
            onToggleFav={onToggleFav}
          />
        ))}
      </div>
    );
  }
  if (mode === 'timeline') {
    // Group rows by day; render relative date headers ("Today" / "Yesterday")
    // with N results, a vertical track on the left, a time column per row, and
    // a tinted bullet dot at each row anchor.
    const groups = new Map<string, ResultRowData[]>();
    for (const r of rows) {
      const ms = sessionTimestamp(r.session);
      const ts = ms ? new Date(ms) : null;
      const key = ts
        ? `${ts.getFullYear()}-${String(ts.getMonth() + 1).padStart(2, '0')}-${String(ts.getDate()).padStart(2, '0')}`
        : 'unknown';
      const list = groups.get(key) || [];
      list.push(r);
      groups.set(key, list);
    }
    const sortedKeys = [...groups.keys()].sort((a, b) => b.localeCompare(a));
    return (
      <div className="flex flex-col gap-8">
        {sortedKeys.map(k => (
          <div key={k}>
            {/* Day header — bold relative label + count */}
            <div className="flex items-baseline gap-2 mb-4">
              <h3 className="text-[15px] font-bold text-text">{relDayLabel(k, t, locale)}</h3>
              <span className="text-[11.5px] text-text-muted">
                {groups.get(k)!.length} {groups.get(k)!.length === 1 ? t('search.result') : t('search.results')}
              </span>
            </div>
            {/* Continuous vertical track across the whole day group. Each row
               is just (time, dot, card); the track is drawn ONCE here so it
               never breaks between rows. */}
            <div className="relative">
              <span
                className="absolute top-2 bottom-2 left-[84px] w-px bg-border-soft"
                aria-hidden
              />
              <div className="flex flex-col gap-5">
                {groups.get(k)!.map(r => (
                  <TimelineItem
                    key={`${r.session.source}:${r.session.id}`}
                    row={r}
                    isFav={favorites.has(`${r.session.source}:${r.session.id}`)}
                    query={query}
                    locale={locale}
                    onSelect={onSelect}
                    onToggleFav={onToggleFav}
                  />
                ))}
              </div>
            </div>
          </div>
        ))}
      </div>
    );
  }
  // Default: list.
  return (
    <div className="flex flex-col gap-2">
      {rows.map(r => (
        <ResultRow
          key={`${r.session.source}:${r.session.id}`}
          row={r}
          isFav={favorites.has(`${r.session.source}:${r.session.id}`)}
          query={query}
          onSelect={onSelect}
          onToggleFav={onToggleFav}
          onStatus={onStatus}
        />
      ))}
    </div>
  );
}

// ===== Timeline helpers =====

// "2026-06-01" → "Today" / "Yesterday" / "Jun 11" etc, based on the user's
// local clock. Used for timeline group headers per the reference screenshot.
// `tr` is the i18n translator from the calling component — passed in so the
// fixed labels follow the active locale.
function relDayLabel(key: string, tr: (k: any) => string, locale: string): string {
  if (key === 'unknown') return tr('search.day.undated');
  const today = new Date();
  const t = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const [y, m, d] = key.split('-').map(Number);
  const day = new Date(y, m - 1, d);
  const diffDays = Math.round((t.getTime() - day.getTime()) / 86_400_000);
  if (diffDays < 0) {
    // Future date (clock skew on the writing machine, or corrupt JSONL). Don't
    // call it "Today" or a past weekday; surface the actual calendar date so
    // the user can spot the bad data.
    return day.toLocaleDateString(locale, { month: 'short', day: 'numeric', year: 'numeric' });
  }
  if (diffDays === 0) return tr('search.day.today');
  if (diffDays === 1) return tr('search.day.yesterday');
  // Pass the user's selected app locale so weekday / month names follow the
  // i18n picker instead of the OS default ("Wednesday" vs "周三").
  if (diffDays < 7) return day.toLocaleDateString(locale, { weekday: 'long' });
  return day.toLocaleDateString(locale, { month: 'short', day: 'numeric', year: day.getFullYear() === t.getFullYear() ? undefined : 'numeric' });
}

function formatTimeHM(ts: string | null, locale: string): string {
  if (!ts) return '';
  const d = new Date(ts);
  if (isNaN(d.getTime())) return '';
  // Let the locale decide 12 vs 24-hour. zh-CN/de/fr/ru expect 24h; en
  // expects AM/PM. Forcing hour12 made the timeline look wrong outside en.
  return d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
}

function TimelineItem({ row, isFav, query, locale, onSelect, onToggleFav }: {
  row: ResultRowData;
  isFav: boolean;
  query: string;
  locale: string;
  onSelect: (id: string) => void;
  onToggleFav: (id: string) => void;
}) {
  const { t } = useTranslation();
  // Layout: [time column 76px | gutter 16px (where dot sits at left edge) | card]
  // The day-group's parent draws the continuous track at left:84px which goes
  // through the gutter; each row places its dot at the same x to land on the
  // track, vertically anchored to the title baseline.
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onSelect(srcKey(row.session))}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(srcKey(row.session)); } }}
      className="group relative grid grid-cols-[76px_minmax(0,1fr)] gap-4 items-stretch cursor-pointer outline-none min-w-0"
    >
      {/* Time column — top-aligned to the title baseline of the card */}
      <div className="pt-4 pr-2 text-right">
        <span className="text-[11.5px] tabular-nums text-text-muted">{formatTimeHM(row.session.lastTs, locale)}</span>
      </div>
      {/* Bullet dot — absolutely positioned to land on the track. Top offset
         picked to vertically center on the card's title row (~18px down inside
         the card, which has py-4). */}
      <span
        className="absolute left-[80px] top-[22px] w-2 h-2 rounded-full bg-accent ring-2 ring-surface"
        aria-hidden
      />
      {/* Card — min-w-0 lets the truncate-h3 child shrink below its natural
         width; without it, long titles push the card past the grid column. */}
      <div className="rounded-xl border border-border-soft group-hover:border-border bg-surface px-4 py-4 transition ml-2 min-w-0">
        <div className="flex items-center gap-2 min-w-0">
          {isFav && <Star className="w-3.5 h-3.5 fill-amber-400 text-amber-400 flex-shrink-0" />}
          <h3 className="text-[14.5px] font-semibold text-text truncate flex-1">{highlight(row.title, query)}</h3>
          <span className="text-[11.5px] text-text-muted tabular-nums flex-shrink-0">{fmtTime(row.session.lastTs, t)}</span>
          <button onClick={e => { e.stopPropagation(); onToggleFav(row.session.id); }} className="p-1 rounded hover:bg-muted">
            <Star className={cn('w-3.5 h-3.5', isFav ? 'fill-amber-400 text-amber-400' : 'text-text-muted')} />
          </button>
        </div>
        <div className="flex items-center gap-2 mt-2 text-[12px] text-text-muted">
          <span className="truncate">{row.project}</span>
          {row.branch && (
            <span className="flex items-center gap-1 text-amber-600 dark:text-amber-400 flex-shrink-0"><GitBranch className="w-3 h-3" />{row.branch}</span>
          )}
        </div>
        <div className="flex items-center gap-2 mt-2 text-[11.5px] text-text-muted tabular-nums">
          <span>{fmtTokens(row.tokens)} tokens</span>
          <span className="text-text-muted/50">·</span>
          <span>{row.msgs} msgs</span>
        </div>
      </div>
    </div>
  );
}

// Pull a few representative tag words from the title. Used to fill the
// keyword chips row in the card view per the screenshot. Stopwords stripped
// and length-capped so the chips don't run away.
const TITLE_STOPWORDS = new Set([
  'the','a','an','to','for','of','in','on','with','and','or','at','from','by','as','is','are','was','were','it','this','that','these','those','be','been','being','my','your','our','their','its','do','does','did','have','has','had','can','will','should','would','what','when','where','why','how','which','who','whom','off','out','up','down','via','vs','&',
]);

function extractTitleTags(title: string, max = 4): string[] {
  if (!title) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of title.split(/[^A-Za-z0-9]+/)) {
    if (!raw) continue;
    const w = raw.toLowerCase();
    if (w.length < 3 || w.length > 16) continue;
    if (TITLE_STOPWORDS.has(w)) continue;
    if (seen.has(w)) continue;
    seen.add(w);
    out.push(w);
    if (out.length >= max) break;
  }
  return out;
}

function CardItem({ row, isFav, query, onSelect, onToggleFav }: {
  row: ResultRowData;
  isFav: boolean;
  query: string;
  onSelect: (id: string) => void;
  onToggleFav: (id: string) => void;
}) {
  const { t } = useTranslation();
  const tags = extractTitleTags(row.title);
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onSelect(srcKey(row.session))}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(srcKey(row.session)); } }}
      className="group rounded-xl border border-border-soft hover:border-border bg-surface p-6 transition cursor-pointer outline-none focus-visible:border-accent flex flex-col min-h-[240px]"
    >
      {/* Title row — line-clamp-2 prevents 5-line titles from blowing the card
         layout out of shape; ellipsis at the end signals truncation. */}
      <div className="flex items-start gap-2 min-w-0">
        <h3 className="text-[15.5px] font-semibold text-text leading-snug flex-1 line-clamp-2 break-words">{highlight(row.title, query)}</h3>
        <button onClick={e => { e.stopPropagation(); onToggleFav(row.session.id); }} className="p-0.5 rounded hover:bg-muted -mt-0.5 flex-shrink-0">
          <Star className={cn('w-3.5 h-3.5', isFav ? 'fill-amber-400 text-amber-400' : 'text-text-muted')} />
        </button>
      </div>
      {/* Project / branch — close under title */}
      <div className="flex items-center gap-2 mt-2 text-[12px] text-text-muted">
        <span className="truncate">{row.project}</span>
        {row.branch && (
          <span className="flex items-center gap-1 text-amber-600 dark:text-amber-400 flex-shrink-0"><GitBranch className="w-3 h-3" />{row.branch}</span>
        )}
      </div>
      {/* Big spacer — generous whitespace per reference. flex-1 absorbs all
         extra height so the tag chips + footer drop to the bottom of the card,
         and rows in the same grid row stay aligned at the bottom. */}
      <div className="flex-1 min-h-[28px]" />
      {/* Tag chips derived from title words */}
      {tags.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {tags.map(tag => (
            <span key={tag} className="text-[11px] px-2 py-0.5 rounded-md bg-muted/60 border border-border-soft text-text-muted">
              {tag}
            </span>
          ))}
        </div>
      )}
      {/* Footer — relative time + tokens + msgs, divider above */}
      <div className="flex items-center gap-2 mt-4 pt-4 border-t border-border-soft/70 text-[11.5px] text-text-muted tabular-nums">
        <span>{fmtTime(row.session.lastTs, t)}</span>
        <span className="text-text-muted/50">·</span>
        <span>{fmtTokens(row.tokens)} tokens</span>
        <span className="text-text-muted/50">·</span>
        <span>{row.msgs} msgs</span>
      </div>
    </div>
  );
}

function MoreSentinel({ hasMore, onLoad, shown, total }: { hasMore: boolean; onLoad: () => void; shown: number; total: number }) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);
  const fired = useRef(false);
  useEffect(() => {
    if (!hasMore) return;
    const el = ref.current;
    if (!el) return;
    fired.current = false;
    const io = new IntersectionObserver(entries => {
      if (entries[0].isIntersecting && !fired.current) {
        fired.current = true;
        onLoad();
      }
    }, { rootMargin: '300px' });
    io.observe(el);
    return () => io.disconnect();
  }, [hasMore, onLoad, shown]);
  if (!hasMore) return null;
  return (
    <div ref={ref} className="flex items-center justify-center gap-2 py-6 text-[11.5px] text-text-muted">
      <span className="w-1.5 h-1.5 rounded-full bg-accent/60 animate-pulse" />
      <span>{t('search.loadingMore')} <span className="tabular-nums">{shown} / {total}</span></span>
    </div>
  );
}

/* ============================== Select chip ============================== */

type ChipOption = { value: string; label: string };
function SelectChip({ icon, label, value, onChange, options, align = 'left' }: {
  icon?: React.ReactNode;
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: ChipOption[];
  align?: 'left' | 'right';
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    if (open) document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  const active = value !== '' && value !== 'all' && value !== 'relevance';
  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(v => !v)}
        className={cn(
          'inline-flex items-center gap-1.5 h-8 px-3 rounded-lg text-[12px] font-medium border transition-colors whitespace-nowrap',
          active ? 'bg-accent-soft border-accent/30 text-accent' : 'bg-surface border-border-soft text-text-muted hover:bg-muted hover:text-text'
        )}
      >
        {icon}
        <span>{label}</span>
        <ChevronDown className="w-3 h-3 opacity-60" />
      </button>
      {open && (
        <div className={cn(
          'absolute top-full mt-1 z-30 min-w-[180px] max-h-[300px] overflow-y-auto rounded-lg border border-border bg-elevated shadow-pop p-1',
          align === 'right' ? 'right-0' : 'left-0'
        )}>
          {options.map(o => (
            <button
              key={o.value}
              onClick={() => { onChange(o.value); setOpen(false); }}
              className={cn(
                'w-full text-left px-2.5 py-1.5 rounded text-[12.5px] hover:bg-muted',
                o.value === value && 'bg-accent-soft text-accent font-medium'
              )}
            >
              {o.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/* ============================== Empty + no-results + highlight ============================== */

// Skeleton list shown while sessions are still being read from disk. Six rows
// of pulse-shimmer placeholders matching the real ResultRow shape so the layout
// doesn't shift when content arrives.
function SkeletonResults() {
  return (
    <div className="animate-fade-in">
      <div className="flex items-center justify-between mb-3">
        <div className="h-3 w-24 rounded bg-muted/60 animate-pulse-soft" />
      </div>
      <div className="flex flex-col gap-2">
        {Array.from({ length: 6 }).map((_, i) => (
          <SkeletonRow key={i} delayMs={i * 60} />
        ))}
      </div>
    </div>
  );
}

function SkeletonRow({ delayMs = 0 }: { delayMs?: number }) {
  return (
    <div
      className="rounded-xl border border-border-soft bg-surface px-4 py-3 flex items-start gap-3 opacity-0 animate-fade-up"
      style={{ animationDelay: `${delayMs}ms`, animationFillMode: 'forwards' }}
    >
      <div className="flex-1 min-w-0 space-y-2">
        <div className="flex items-center gap-2">
          <div className="h-3.5 rounded bg-muted/70 animate-pulse-soft" style={{ width: `${60 + (delayMs % 30)}%` }} />
          <div className="ml-auto h-3 w-10 rounded bg-muted/50 animate-pulse-soft" />
        </div>
        <div className="flex items-center gap-2">
          <div className="h-2.5 w-20 rounded bg-muted/50 animate-pulse-soft" />
          <div className="h-2.5 w-16 rounded bg-amber-200/40 dark:bg-amber-800/30 animate-pulse-soft" />
        </div>
        <div className="flex items-center gap-3">
          <div className="h-2.5 w-14 rounded bg-muted/40 animate-pulse-soft" />
          <div className="h-2.5 w-12 rounded bg-muted/40 animate-pulse-soft" />
        </div>
      </div>
    </div>
  );
}

function EmptyState({ onPick }: { onPick: (q: string) => void }) {
  const { t } = useTranslation();
  return (
    <div className="text-center mt-20 max-w-md mx-auto">
      <div className="w-14 h-14 mx-auto rounded-2xl bg-accent-soft border border-accent/20 flex items-center justify-center mb-3">
        <Search className="w-6 h-6 text-accent" />
      </div>
      <h2 className="text-[16px] font-semibold text-text">{t('search.empty.title')}</h2>
      <p className="text-[12.5px] text-text-muted mt-1.5 mb-5">{t('search.empty.hint')}</p>
      <div className="flex flex-wrap justify-center gap-1.5">
        {SUGGESTED_PROMPTS.map(p => (
          <button key={p} onClick={() => onPick(p.replace(/^Search by /, ''))} className="px-2.5 py-1 rounded-full text-[11.5px] bg-muted/40 border border-border-soft text-text-muted hover:text-text hover:border-border">
            {p}
          </button>
        ))}
      </div>
    </div>
  );
}

function NoResults() {
  const { t } = useTranslation();
  return (
    <div className="text-center mt-20 max-w-md mx-auto">
      <div className="w-14 h-14 mx-auto rounded-2xl bg-muted border border-border-soft flex items-center justify-center mb-3">
        <Search className="w-6 h-6 text-text-muted" />
      </div>
      <h2 className="text-[16px] font-semibold text-text">{t('search.noResults')}</h2>
      <p className="text-[12.5px] text-text-muted mt-1.5">{t('search.noResultsHint')}</p>
    </div>
  );
}

// Derive "Matched in X" chips from what we know on the frontend (title / repo / branch)
// plus the per-role breakdown the backend deepSearch returns. Order = strongest signal first.
// Multi-term OR: any term hitting the field counts.
function getMatchSources(row: ResultRowData, query: string): Array<{ label: string; count?: number }> {
  const terms = tokenizeQuery(query);
  if (terms.length === 0) return [];
  const out: Array<{ label: string; count?: number }> = [];
  const titleLower = row.title.toLowerCase();
  const projLower = row.project.toLowerCase();
  const branchLower = row.branch?.toLowerCase() ?? '';
  if (terms.some(t => titleLower.includes(t))) out.push({ label: 'Session Title' });
  if (terms.some(t => projLower.includes(t))) out.push({ label: 'Repository' });
  if (branchLower && terms.some(t => branchLower.includes(t))) out.push({ label: 'Branch' });
  const s = row.sources;
  if (s) {
    if (s.assistant > 0) out.push({ label: 'Assistant', count: s.assistant });
    if (s.user > 0) out.push({ label: 'User Prompt', count: s.user });
    if (s.summary > 0) out.push({ label: 'Summary', count: s.summary });
    if (s.tool > 0) out.push({ label: 'Tool Output', count: s.tool });
  }
  return out.slice(0, 4);
}

function hasShallowMatch(row: ResultRowData, query: string): boolean {
  const terms = tokenizeQuery(query);
  if (terms.length === 0) return false;
  const t = row.title.toLowerCase();
  const p = row.project.toLowerCase();
  const b = row.branch?.toLowerCase() ?? '';
  return terms.some(term => t.includes(term) || p.includes(term) || (b && b.includes(term)));
}

// OR-tokenizer — mirrors backend tokenizeQuery so frontend filter / highlight
// stay aligned with deepSearch semantics. Quoted "phrases" stay glued.
function tokenizeQuery(query: string): string[] {
  const out: string[] = [];
  const re = /"([^"]+)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(query)) !== null) {
    const t = (m[1] || m[2] || '').toLowerCase().trim();
    if (t.length >= 2 && !out.includes(t)) out.push(t);
  }
  return out;
}

function highlight(text: string, query: string): React.ReactNode {
  const terms = tokenizeQuery(query);
  if (terms.length === 0) return text;
  try {
    const escaped = terms.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    // Split with `g`; test each part with a non-global anchored regex so
    // .test()'s lastIndex doesn't stride past every other matched chunk.
    const splitRe = new RegExp(`(${escaped.join('|')})`, 'gi');
    const matchRe = new RegExp(`^(${escaped.join('|')})$`, 'i');
    const parts = text.split(splitRe);
    return parts.map((p, i) => p && matchRe.test(p) ? <mark key={i} className="bg-accent/20 text-accent rounded px-0.5">{p}</mark> : <span key={i}>{p}</span>);
  } catch { return text; }
}
