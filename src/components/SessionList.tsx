import { Search, Star, GitBranch, X, Play, Copy, FolderOpen, StarOff, Filter, Plus, Pencil } from 'lucide-react';
import * as Dialog from '@radix-ui/react-dialog';
import { useEffect, useMemo, useRef, useState } from 'react';
import * as ContextMenu from '@radix-ui/react-context-menu';
import { useVirtualizer } from '@tanstack/react-virtual';
import { cn } from '../lib/utils';
import { cleanDisplayText, fmtTime, fmtTokens, kbdShortcut, projectColor, projectInitial, projectTextColor, sessionTimestamp } from '../lib/format';
import { deriveDisplayTitle, projectShortName, meaningfulBranch } from '../lib/sessionTitle';
import { groupSessions, type GroupKey } from '../lib/timelineGroup';
import { matchesExcludeRule } from '../lib/excludeRules';
import { srcKey } from '../lib/sources';
import type { SessionMeta } from '../types';
import type { Filters } from './SessionsView';
import { useTranslation } from '../lib/I18nProvider';
import { useSystemCapabilities } from '../lib/systemCapabilities';
import { useDisplayPrefs } from '../lib/displayPrefs';
import type { TKey } from '../lib/i18n';

type Props = {
  items: SessionMeta[];
  // Same filters as `items` but without the project filter — feeds the project
  // picker dropdown so it keeps offering every project after one is selected.
  projectChoices: SessionMeta[];
  sessions: SessionMeta[];
  favorites: Set<string>;
  excluded: Set<string>;
  excludeRules: string[];
  onExcludeRulesChange: (next: string[]) => void;
  activeId: string | null;
  deepHits: Map<string, { snippet: string; matchCount: number }> | null;
  filters: Filters;
  view: 'sessions' | 'favorites' | 'excluded';
  onSelect: (id: string) => void;
  onFilters: (f: Filters) => void;
  onToggleFavorite: (id: string) => void;
  onToggleExclude: (id: string) => void;
  onDeepSearch: () => void;
  onClearDeep: () => void;
  deepSearchLoading: boolean;
  loading?: boolean;
  onStatus: (msg: string) => void;
};

const TIME_OPTIONS: Array<{ value: Filters['time']; labelKey: TKey; shortKey: TKey }> = [
  { value: 'all', labelKey: 'list.timeAll', shortKey: 'list.timeShort.all' },
  { value: '3', labelKey: 'list.time3d', shortKey: 'list.timeShort.3d' },
  { value: '7', labelKey: 'list.time7d', shortKey: 'list.timeShort.7d' },
  { value: '30', labelKey: 'list.time30d', shortKey: 'list.timeShort.30d' },
];

const SORT_OPTIONS: Array<{ value: Filters['sort']; labelKey: TKey }> = [
  { value: 'recent', labelKey: 'list.sortNewest' },
  { value: 'tokens', labelKey: 'list.sortTokens' },
  { value: 'messages', labelKey: 'list.sortMessages' },
];

export function SessionList({ items, projectChoices, sessions, favorites, excluded, excludeRules, onExcludeRulesChange, activeId, deepHits, filters, view, onSelect, onFilters, onToggleFavorite, onToggleExclude, onDeepSearch, onClearDeep, deepSearchLoading, loading = false, onStatus }: Props) {
  const { t } = useTranslation();
  // Build the project dropdown from `projectChoices` — the same slice as
  // `items` but BEFORE the project filter applies. Using `items` collapses the
  // dropdown to just the current project after one selection, so the user can
  // never switch to a different project without clearing first.
  const projects = useMemo(() => {
    const m = new Map<string, { count: number; cwd: string }>();
    for (const s of projectChoices) {
      const cur = m.get(s.projectDir);
      if (cur) cur.count++;
      else m.set(s.projectDir, { count: 1, cwd: s.decodedCwd });
    }
    return [...m.entries()].sort((a, b) => b[1].count - a[1].count);
  }, [projectChoices]);

  const showGroups = filters.sort === 'recent' && !deepHits;
  const groups = useMemo(
    () => showGroups ? groupSessions(items) : [{ key: null as unknown as GroupKey, items }],
    [items, showGroups]
  );

  return (
    <div
      data-pane="list"
      style={{ width: 'var(--list-width, 420px)' }}
      className="flex-shrink-0 border border-border rounded-2xl flex flex-col bg-surface min-w-0 min-h-0 overflow-hidden"
    >
      {view === 'excluded' && (
        <ExcludeRulesBar rules={excludeRules} onChange={onExcludeRulesChange} allSessions={sessions} />
      )}

      {/* Top toolbar */}
      <div className="px-4 pt-3 pb-2">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-text-muted pointer-events-none" />
          <input
            id="search-input"
            type="search"
            value={filters.query}
            onChange={e => {
              onFilters({ ...filters, query: e.target.value });
              if (!e.target.value.trim() && deepHits) onClearDeep();
            }}
            onKeyDown={e => {
              if (e.key === 'Enter') onDeepSearch();
              if (e.key === 'Escape') { onFilters({ ...filters, query: '' }); onClearDeep(); }
            }}
            placeholder={t('list.searchPlaceholder')}
            className="w-full pl-9 pr-20 h-10 bg-surface border border-border-soft rounded-[11px] text-[13px] outline-none focus:border-accent focus:ring-1 focus:ring-accent placeholder:text-text-muted"
          />
          {filters.query ? (
            <button
              onClick={() => { onFilters({ ...filters, query: '' }); onClearDeep(); }}
              title={t('common.clear')}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 w-6 h-6 rounded-md hover:bg-muted text-text-muted hover:text-text flex items-center justify-center"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          ) : (
            <kbd className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[10px] px-1.5 py-0.5 rounded bg-muted border border-border-soft text-text-muted font-mono">{kbdShortcut('K')}</kbd>
          )}
        </div>

        {/* Filter rows: project + time on row 1, sort on row 2. Two fixed rows
            so the layout stays predictable when the list pane is narrowed. */}
        {/* Responsive filter layout:
            - Wide (project + time fit ≥ basis sum): 2 rows · project+time / sort
            - Narrow:                                  3 rows · project / time / sort
            Sort always lives on its own row thanks to basis-full. */}
        <div className="mt-3 flex flex-wrap gap-2 min-w-0">
          <select
            value={filters.project}
            onChange={e => onFilters({ ...filters, project: e.target.value })}
            className="flex-1 basis-[140px] min-w-0 px-2.5 h-8 bg-surface border border-border-soft rounded-[9px] text-[12.5px] outline-none cursor-pointer hover:bg-muted text-text-dim"
          >
            <option value="">{t('list.project.all')}</option>
            {projects.map(([dir, info]) => (
              <option key={dir} value={dir}>{projectShortName(info.cwd) || info.cwd} ({info.count})</option>
            ))}
          </select>

          <span className="flex flex-1 basis-[170px] rounded-[9px] overflow-hidden border border-border-soft text-[12.5px]">
            {TIME_OPTIONS.map(opt => (
              <button
                key={opt.value}
                onClick={() => onFilters({ ...filters, time: opt.value })}
                title={t(opt.labelKey)}
                className={cn(
                  'flex-1 h-8 transition font-medium',
                  filters.time === opt.value ? 'bg-accent-soft text-accent' : 'text-text-dim hover:bg-muted'
                )}
              >
                {t(opt.shortKey)}
              </button>
            ))}
          </span>

          <span className="flex basis-full rounded-[9px] overflow-hidden border border-border-soft text-[12.5px]">
            {SORT_OPTIONS.map(opt => (
              <button
                key={opt.value}
                onClick={() => onFilters({ ...filters, sort: opt.value })}
                title={t(opt.labelKey)}
                className={cn(
                  'flex-1 h-8 transition font-medium',
                  filters.sort === opt.value ? 'bg-accent-soft text-accent' : 'text-text-dim hover:bg-muted'
                )}
              >
                {t(opt.labelKey)}
              </button>
            ))}
          </span>
        </div>

        {(deepHits || filters.query.length >= 2) && (
          <div className="mt-2 text-right">
            {deepHits ? (
              <button onClick={onClearDeep} className="text-[11px] text-accent flex items-center gap-1 hover:underline ml-auto inline-flex">
                <X className="w-3 h-3" /> {t('list.clearDeep')}
              </button>
            ) : deepSearchLoading ? (
              <span className="text-[11px] text-accent flex items-center gap-1.5 ml-auto inline-flex">
                <span className="inline-block w-3 h-3 border-2 border-accent border-t-transparent rounded-full animate-spin" />
                Searching every JSONL…
              </span>
            ) : (
              <button onClick={onDeepSearch} disabled={deepSearchLoading} className="text-[11px] text-accent hover:underline font-medium disabled:opacity-50 disabled:cursor-wait">
                {t('list.deepCta')}
              </button>
            )}
          </div>
        )}
      </div>

      {/* List — virtualized so 670+ sessions don't blow up the DOM. */}
      <VirtualList
        groups={groups}
        items={items}
        view={view}
        query={filters.query}
        loading={loading}
        sessions={sessions}
        activeId={activeId}
        favorites={favorites}
        excluded={excluded}
        deepHits={deepHits}
        onSelect={onSelect}
        onToggleFavorite={onToggleFavorite}
        onToggleExclude={onToggleExclude}
        onStatus={onStatus}
        onPickSuggestion={q => onFilters({ ...filters, query: q })}
      />

      {/* Footer — visible inside the list pane, lightweight summary */}
      {items.length > 0 && (
        <div className="border-t border-border-soft px-4 py-2 text-[11px] text-text-muted flex items-center gap-x-2 tabular-nums">
          <span>{t('list.sessions', { n: items.length })}</span>
          <span className="text-text-muted/50">·</span>
          <span>{t('list.tokensAllTime', { tokens: fmtTokens(totalListTokens(items)) })}</span>
        </div>
      )}
    </div>
  );
}

// Map the literal English group keys produced by timelineGroup.ts to their
// translation keys. timelineGroup stays language-agnostic; localization lives
// here in the render layer.
const GROUP_KEY_MAP: Record<GroupKey, string> = {
  'Today': 'group.today',
  'Yesterday': 'group.yesterday',
  'This week': 'group.thisWeek',
  'This month': 'group.thisMonth',
  'Earlier': 'group.earlier',
};
function groupHeaderLabel(k: GroupKey | null, t: (k: any) => string): string {
  if (!k) return '';
  return t(GROUP_KEY_MAP[k] as any);
}

function totalListTokens(items: SessionMeta[]): number {
  let n = 0;
  for (const s of items) n += (s.tokensIn || 0) + (s.tokensOut || 0) + (s.tokensCacheRead || 0) + (s.tokensCacheCreate || 0);
  return n;
}

type Row =
  | { kind: 'header'; key: string; height: number }
  | { kind: 'item'; session: SessionMeta; isFirst: boolean; isLast: boolean; height: number };

function VirtualList({
  groups, items, view, query, activeId, favorites, excluded, deepHits,
  loading, sessions,
  onSelect, onToggleFavorite, onToggleExclude, onStatus, onPickSuggestion,
}: {
  groups: Array<{ key: GroupKey | null; items: SessionMeta[] }>;
  items: SessionMeta[];
  view: 'sessions' | 'favorites' | 'excluded';
  query: string;
  loading: boolean;
  sessions: SessionMeta[];
  activeId: string | null;
  favorites: Set<string>;
  excluded: Set<string>;
  deepHits: Map<string, { snippet: string; matchCount: number }> | null;
  onSelect: (id: string) => void;
  onToggleFavorite: (id: string) => void;
  onToggleExclude: (id: string) => void;
  onStatus: (msg: string) => void;
  onPickSuggestion: (q: string) => void;
}) {
  const { t } = useTranslation();
  const parentRef = useRef<HTMLDivElement>(null);

  // Flatten groups → linear row list. Group headers become rows too so the
  // virtualizer can lay everything out in a single sequential index.
  const rows = useMemo<Row[]>(() => {
    const r: Row[] = [];
    for (const g of groups) {
      if (g.key) r.push({ kind: 'header', key: g.key, height: 38 });
      g.items.forEach((s, idx) => {
        const hasDeepHit = deepHits?.has(`${s.source}:${s.id}`);
        const hasAlias = !!s.alias;
        // Deep-hit rows have an extra snippet line; aliased rows surface the
        // original title underneath. Both bump the estimate to avoid layout shift.
        const base = 80 + (hasAlias ? 16 : 0) + (hasDeepHit ? 32 : 0);
        r.push({ kind: 'item', session: s, isFirst: idx === 0, isLast: idx === g.items.length - 1, height: base });
      });
    }
    return r;
  }, [groups, deepHits]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: (i) => rows[i].height,
    overscan: 8,
    // Use composite source:id for item keys so two sessions with the same UUID
    // across Claude and Codex never share a virtualizer slot.
    getItemKey: (i) => rows[i].kind === 'header' ? `h:${(rows[i] as Extract<Row, { kind: 'header' }>).key}` : srcKey((rows[i] as Extract<Row, { kind: 'item' }>).session),
  });

  // Auto-scroll to the active row only when the row isn't already in the
  // virtualizer's rendered range. This way clicking a visible row inside the
  // list doesn't yank scroll — but jumping from Search → History with an
  // off-screen target still lands the row in view.
  useEffect(() => {
    if (!activeId || rows.length === 0) return;
    const idx = rows.findIndex(r => r.kind === 'item' && srcKey(r.session) === activeId);
    if (idx < 0) return;
    if (virtualizer.getVirtualItems().some(v => v.index === idx)) return;
    requestAnimationFrame(() => {
      try { virtualizer.scrollToIndex(idx, { align: 'center', behavior: 'auto' }); } catch {}
    });
  }, [activeId, rows, virtualizer]);

  if (items.length === 0) {
    // Still scanning ~/.claude/projects/ — show pulse skeletons so the pane
    // doesn't read as "no sessions". Falls through to the real EmptyState
    // once loading completes and there really are zero items.
    if (loading && sessions.length === 0) {
      return (
        <div className="flex-1 overflow-y-auto overflow-x-hidden min-w-0 px-3 pt-2 pb-2 animate-fade-in">
          <div className="flex flex-col gap-2">
            {Array.from({ length: 8 }).map((_, i) => (
              <div
                key={i}
                className="rounded-[13px] border border-border-soft bg-surface/70 px-4 py-3 min-h-[80px] opacity-0 animate-fade-up"
                style={{ animationDelay: `${i * 50}ms`, animationFillMode: 'forwards' }}
              >
                <div className="flex items-center gap-2 mb-2">
                  <div className="w-2 h-2 rounded-full bg-muted/60 animate-pulse-soft" />
                  <div className="h-3 rounded bg-muted/70 animate-pulse-soft" style={{ width: `${55 + (i * 5) % 30}%` }} />
                  <div className="ml-auto h-2.5 w-10 rounded bg-muted/40 animate-pulse-soft" />
                </div>
                <div className="flex items-center gap-2">
                  <div className="h-2.5 w-20 rounded bg-muted/50 animate-pulse-soft" />
                  <div className="h-2.5 w-16 rounded bg-amber-200/40 dark:bg-amber-800/30 animate-pulse-soft" />
                </div>
              </div>
            ))}
          </div>
        </div>
      );
    }
    return (
      <div className="flex-1 overflow-y-auto overflow-x-hidden min-w-0 px-3 pt-2 pb-2 animate-fade-in">
        <EmptyState view={view} query={query} onPickSuggestion={onPickSuggestion} />
      </div>
    );
  }

  return (
    <div ref={parentRef} className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden min-w-0 px-3 pt-2 pb-2">
      <div style={{ height: virtualizer.getTotalSize(), position: 'relative', width: '100%' }}>
        {virtualizer.getVirtualItems().map(v => {
          const row = rows[v.index];
          return (
            <div
              key={v.key}
              data-index={v.index}
              ref={virtualizer.measureElement}
              style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${v.start}px)` }}
            >
              {row.kind === 'header' ? (
                <div className="px-1 pt-2 pb-2 text-[10.5px] uppercase tracking-wider font-semibold text-text-muted">
                  {groupHeaderLabel(row.key as GroupKey, t)}
                </div>
              ) : (
                <SessionListItem
                  s={row.session}
                  active={srcKey(row.session) === activeId}
                  isFav={favorites.has(srcKey(row.session))}
                  isEx={excluded.has(srcKey(row.session))}
                  deepHit={deepHits?.get(srcKey(row.session)) ?? undefined}
                  onSelect={() => onSelect(srcKey(row.session))}
                  onToggleFav={() => onToggleFavorite(row.session.id)}
                  onToggleEx={() => onToggleExclude(row.session.id)}
                  onStatus={onStatus}
                  query={query}
                  isFirst={row.isFirst}
                  isLast={row.isLast}
                />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

type ItemProps = {
  s: SessionMeta;
  active: boolean;
  isFav: boolean;
  isEx: boolean;
  deepHit?: { snippet: string; matchCount: number };
  query: string;
  onSelect: () => void;
  onToggleFav: () => void;
  onToggleEx: () => void;
  onStatus: (msg: string) => void;
  isFirst: boolean;
  isLast: boolean;
};

function SessionListItem({ s, active, isFav, isEx, deepHit, query, onSelect, onToggleFav, onToggleEx, onStatus, isFirst, isLast }: ItemProps) {
  const { t } = useTranslation();
  const caps = useSystemCapabilities();
  const [prefs] = useDisplayPrefs();
  // Match SessionDetail's Resume button: one action that respects the user's
  // preferred terminal preference. iTerm is only the actual target when it's
  // both installed (caps) and chosen in settings; otherwise fall back to the
  // system Terminal.
  const itermAvailable = caps?.platform === 'darwin' && caps.terminals.iterm;
  const useITerm = itermAvailable && prefs.preferredTerminal === 'iterm';
  const [renameOpen, setRenameOpen] = useState(false);
  // Every fallback field goes through cleanDisplayText so an alias / summary
  // composed entirely of control chars or bidi overrides can't be shown raw.
  // We intentionally do NOT `|| original` after cleaning — that would defeat
  // the whole hygiene effort for the worst inputs.
  const cleanedAlias = cleanDisplayText(s.alias);
  const cleanedSummary = cleanDisplayText(s.summary);
  const cleanedFirstUser = cleanDisplayText(s.firstUser);
  const rawTitle = cleanedAlias || cleanedSummary || cleanedFirstUser || '(no human message)';
  const title = cleanedAlias
    ? { primary: cleanedAlias, sub: undefined as string | undefined, isSmart: false }
    : deriveDisplayTitle(rawTitle);
  const tokens = (s.tokensIn || 0) + (s.tokensOut || 0) + (s.tokensCacheRead || 0) + (s.tokensCacheCreate || 0);
  const msgs = (s.userMsgs || 0) + (s.assistantMsgs || 0);
  const projName = projectShortName(s.projectCwd || s.decodedCwd);
  const branch = meaningfulBranch(s.gitBranch);

  const handleCopy = async () => {
    const cmd = await window.api.copyResumeCommand(s.projectCwd || s.decodedCwd, s.id, s.filePath, s.source);
    onStatus('Copied: ' + cmd);
    setTimeout(() => onStatus(''), 2500);
  };
  const handleResume = async () => {
    const fn = useITerm ? window.api.openInITerm : window.api.openInTerminal;
    const label = useITerm ? 'iTerm' : 'Terminal';
    try { await fn(s.projectCwd || s.decodedCwd, s.id, s.filePath, s.source); onStatus('Opened in ' + label); setTimeout(() => onStatus(''), 2500); }
    catch (e: any) { onStatus('Error: ' + e.message); }
  };

  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>
        <div
          onClick={onSelect}
          onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(); } }}
          role="button"
          tabIndex={0}
          title={rawTitle}
          className={cn(
            // v8 P2 — smoother transition (200ms ease-out), stronger hover feedback,
            // more intentional active state. No animations beyond bg/border fade.
            'group relative overflow-hidden w-full px-4 py-3 min-h-[80px] cursor-pointer outline-none min-w-0 select-none border border-border-soft flex flex-col justify-center gap-1 transition-[background-color,border-color] duration-200 ease-out',
            isFirst && 'rounded-t-[13px]',
            isLast && 'rounded-b-[13px]',
            !isLast && '-mb-px',
            // Favorited but not active → subtle amber tint so favorites pop in
            // the list without being obnoxious. Active wins over favorite styling.
            active && 'bg-accent-soft/70 border-accent/25 z-[2]',
            !active && isFav && 'bg-amber-50/40 dark:bg-amber-950/15 hover:bg-amber-50/70 dark:hover:bg-amber-950/25',
            !active && !isFav && 'bg-surface/70 hover:bg-muted/80'
          )}
        >
          {active && <span className="absolute left-0 top-0 bottom-0 w-[4px] bg-accent rounded-r-sm" />}

          {/* Row 1: activity dot + star + title + time.
              Dot = info-driven identity per v3 brief: green=today, amber=this week, gray=older. */}
          <div className="flex items-center gap-1.5 min-w-0">
            <ActivityDot ts={sessionTimestamp(s)} active={active} />
            {isFav && <Star className="w-4 h-4 fill-amber-400 text-amber-400 flex-shrink-0" />}
            {s.alias && <Pencil className={cn('w-3 h-3 flex-shrink-0', active ? 'text-accent/70' : 'text-text-muted')} />}
            {s.tooLarge && (
              <span className="text-[9.5px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300 flex-shrink-0" title="Session file exceeds the size cap and cannot be opened.">
                Too large
              </span>
            )}
            <h3 className={cn('text-[14px] font-semibold truncate leading-snug flex-1 min-w-0', active ? 'text-accent' : 'text-text')}>
              {highlight(title.primary, query)}
            </h3>
            <span className={cn('text-[11px] tabular-nums flex-shrink-0', active ? 'text-accent/70' : 'text-text-muted')}>
              {fmtTime(s.lastTs || (s.mtime ? new Date(s.mtime).toISOString() : null))}
            </span>
          </div>

          {/* Aliased rows: surface the auto-derived original so users still see what the session originally was. */}
          {s.alias && (
            <div className={cn('text-[11px] italic truncate min-w-0', active ? 'text-accent/60' : 'text-text-muted')} title={`Original: ${deriveDisplayTitle(s.summary || s.firstUser || '').primary}`}>
              {deriveDisplayTitle(s.summary || s.firstUser || '').primary}
            </div>
          )}

          {/* Row 2: project (with initial badge) + branch on left, stats right. */}
          <div className="flex items-center gap-x-2 mt-1.5 text-[11px] min-w-0">
            {projName && (
              <span className="flex items-center gap-1.5 truncate flex-shrink-0 max-w-[140px]">
                <span className={cn(
                  'w-3.5 h-3.5 rounded-[3px] flex items-center justify-center text-white text-[8.5px] font-bold flex-shrink-0',
                  projectColor(s.projectCwd || s.projectDir).bg
                )}>
                  {projectInitial(s.projectCwd || s.projectDir)}
                </span>
                <span className={cn('font-semibold truncate text-[11.5px]', active ? 'text-accent/90' : projectTextColor(s.projectCwd || s.projectDir))}>
                  {projName}
                </span>
              </span>
            )}
            {branch && (
              <span className="text-[11px] font-medium text-amber-600 dark:text-amber-400 truncate flex items-center gap-0.5 flex-shrink-0 max-w-[140px]">
                <GitBranch className="w-3 h-3 flex-shrink-0" />
                <span className="truncate">{branch}</span>
              </span>
            )}
            <span className="ml-auto flex items-center gap-2 text-[10.5px] tabular-nums text-text-muted/80 flex-shrink-0">
              {tokens > 0 && (
                <span className={cn(active && 'text-accent/70', !active && tokens >= 5_000_000 && 'text-text-dim font-medium')}>
                  {fmtTokens(tokens)}
                </span>
              )}
              <span>{msgs} {t('units.msgs')}</span>
            </span>
            {!isFav && (
              <button
                onClick={e => { e.stopPropagation(); onToggleFav(); }}
                className="p-0.5 rounded opacity-0 group-hover:opacity-100 flex-shrink-0"
                title={t('ctx.addFav')}
              >
                <Star className="w-4 h-4 text-text-muted hover:text-amber-400" />
              </button>
            )}
          </div>

          {deepHit && (
            <div className="text-[10.5px] text-text-dim bg-muted/60 px-2 py-1 rounded mt-1.5 line-clamp-1 border-l-2 border-accent">
              {cleanDisplayText(deepHit.snippet)} <em className="text-text-muted">· {deepHit.matchCount}×</em>
            </div>
          )}
        </div>
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className="min-w-[220px] bg-elevated border border-border rounded-lg shadow-pop py-1 z-50 animate-in">
          <CtxItem onSelect={handleResume} icon={<Play className="w-3.5 h-3.5" />}>{t('detail.btn.resume')}</CtxItem>
          <CtxItem onSelect={handleCopy} icon={<Copy className="w-3.5 h-3.5" />}>{t('ctx.copyCmd')}</CtxItem>
          <CtxItem onSelect={() => window.api.revealInFinder(s.filePath)} icon={<FolderOpen className="w-3.5 h-3.5" />}>{t('ctx.reveal')}</CtxItem>
          <ContextMenu.Separator className="my-1 h-px bg-border-soft" />
          <CtxItem onSelect={() => setRenameOpen(true)} icon={<Pencil className="w-3.5 h-3.5" />}>
            {s.alias ? t('ctx.editAlias') : t('ctx.rename')}
          </CtxItem>
          <CtxItem onSelect={onToggleFav} icon={isFav ? <StarOff className="w-3.5 h-3.5" /> : <Star className="w-3.5 h-3.5" />}>
            {isFav ? t('ctx.removeFav') : t('ctx.addFav')}
          </CtxItem>
          <CtxItem onSelect={onToggleEx} icon={<X className="w-3.5 h-3.5" />}>
            {isEx ? t('ctx.restore') : t('ctx.exclude')}
          </CtxItem>
        </ContextMenu.Content>
      </ContextMenu.Portal>
      <RenameAliasDialog
        open={renameOpen}
        onOpenChange={setRenameOpen}
        session={s}
        onSaved={(alias) => { onStatus(alias ? 'Renamed' : 'Alias removed'); setTimeout(() => onStatus(''), 1800); }}
      />
    </ContextMenu.Root>
  );
}

const SUGGESTIONS = ['OpenIddict', 'authentication', 'deployment', 'support question', 'GitHub review', 'rate limit', 'migration', 'docker'];

function EmptyState({ view, query, onPickSuggestion }: { view: 'sessions' | 'favorites' | 'excluded'; query: string; onPickSuggestion: (q: string) => void }) {
  const { t } = useTranslation();
  const copy = (() => {
    if (query) return { title: t('empty.search.title'), sub: t('empty.search.sub') };
    if (view === 'favorites') return { title: t('empty.favorites.title'), sub: t('empty.favorites.sub') };
    if (view === 'excluded') return { title: t('empty.excluded.title'), sub: t('empty.excluded.sub') };
    return { title: t('empty.history.title'), sub: t('empty.history.sub') };
  })();
  const showSuggestions = !query && view === 'sessions';
  return (
    <div className="text-center px-6 py-14 text-text-muted">
      <div className="text-[15px] font-semibold text-text mb-1">{copy.title}</div>
      <div className="text-[12px] mb-5">{copy.sub}</div>
      {showSuggestions && (
        <>
          <div className="text-[10.5px] uppercase tracking-wider text-text-muted mb-2.5 font-semibold">{t('empty.try')}</div>
          <div className="flex flex-wrap gap-1.5 justify-center max-w-[260px] mx-auto">
            {SUGGESTIONS.map(s => (
              <button key={s} onClick={() => onPickSuggestion(s)} className="px-2.5 py-1 rounded-full text-[11.5px] bg-muted hover:bg-accent-soft hover:text-accent text-text-dim border border-border-soft transition">
                {s}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function CtxItem({ children, icon, onSelect }: { children: React.ReactNode; icon?: React.ReactNode; onSelect: () => void }) {
  return (
    <ContextMenu.Item
      onSelect={onSelect}
      className="flex items-center gap-2.5 px-3 py-1.5 text-[12px] cursor-pointer outline-none data-[highlighted]:bg-accent data-[highlighted]:text-white"
    >
      {icon && <span className="text-text-muted group-data-[highlighted]:text-white">{icon}</span>}
      <span className="flex-1">{children}</span>
    </ContextMenu.Item>
  );
}

const EXCLUDE_EXAMPLES = ['draft', 'spike', 'experiment', 'wip', 'test'];

function ExcludeRulesBar({ rules, onChange, allSessions }: { rules: string[]; onChange: (next: string[]) => void; allSessions: SessionMeta[] }) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState('');

  // Per-rule + total match counts so users see what each filter actually hides.
  const ruleCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of rules) m.set(r, allSessions.filter(s => matchesExcludeRule(s, r)).length);
    return m;
  }, [rules, allSessions]);
  const totalExcluded = useMemo(
    () => allSessions.filter(s => rules.some(r => matchesExcludeRule(s, r))).length,
    [rules, allSessions]
  );
  // Live preview of the current draft so users see impact before clicking Add.
  const draftMatchCount = useMemo(
    () => draft.trim() ? allSessions.filter(s => matchesExcludeRule(s, draft.trim())).length : 0,
    [draft, allSessions]
  );

  const add = (v: string) => {
    const trimmed = v.trim();
    if (!trimmed) return;
    if (rules.includes(trimmed)) { setDraft(''); return; }
    onChange([...rules, trimmed]);
    setDraft('');
  };
  const remove = (r: string) => onChange(rules.filter(x => x !== r));

  return (
    <div className="px-4 pt-3 pb-3 border-b border-border-soft/60 bg-muted/15 space-y-2">
      <div>
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5 text-[10.5px] uppercase tracking-wider font-semibold text-text-muted">
            <Filter className="w-3 h-3" />
            <span>{t('search.filters')}</span>
          </div>
          <span className="text-[10.5px] tabular-nums text-text-muted">
            {t('exclude.count', { rules: rules.length, hidden: totalExcluded })}
          </span>
        </div>
      </div>

      {rules.length > 0 ? (
        <div className="flex flex-wrap gap-1">
          {rules.map(r => (
            <span key={r} className="inline-flex items-center gap-1.5 pl-2 pr-1 py-0.5 bg-surface border border-border-soft rounded-md text-[11px]" title={`Matches ${ruleCounts.get(r) || 0} session${(ruleCounts.get(r) || 0) !== 1 ? 's' : ''}`}>
              <span className="text-text font-mono">{r}</span>
              <span className="text-text-muted tabular-nums text-[10px]">{ruleCounts.get(r) || 0}</span>
              <button onClick={() => remove(r)} className="text-text-muted hover:text-text rounded p-0.5" aria-label={t('common.remove')}>
                <X className="w-2.5 h-2.5" />
              </button>
            </span>
          ))}
        </div>
      ) : (
        <div className="text-[10.5px] text-text-muted leading-snug">
          {t('exclude.emptyHint')}
        </div>
      )}

      <div className="flex gap-1">
        <input
          type="text"
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); add(draft); } }}
          placeholder={t('excluded.rules.placeholder')}
          className="flex-1 px-2 py-1 bg-surface border border-border-soft rounded-md text-[11.5px] outline-none focus:border-accent placeholder:text-text-muted"
        />
        <button
          onClick={() => add(draft)}
          disabled={!draft.trim()}
          className="px-2 py-1 bg-accent text-white rounded-md text-[11.5px] font-medium hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1"
        >
          <Plus className="w-3 h-3" /> {t('excluded.rules.add')}
        </button>
      </div>

      {/* Live impact preview as user types */}
      {draft.trim() && (
        <div className="text-[10.5px] text-text-muted">
          Would hide <span className="font-semibold text-text">{draftMatchCount}</span> additional session{draftMatchCount !== 1 ? 's' : ''}
        </div>
      )}

      {/* Example chips when there are no rules yet */}
      {rules.length === 0 && !draft.trim() && (
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-[10px] uppercase tracking-wider font-semibold text-text-muted">{t('search.suggestion.try')}</span>
          {EXCLUDE_EXAMPLES.map(ex => (
            <button
              key={ex}
              onClick={() => add(ex)}
              className="px-2 py-0.5 text-[11px] font-mono text-text-dim bg-surface border border-border-soft rounded-md hover:border-accent hover:text-accent transition"
            >
              {ex}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function ActivityDot({ ts, active }: { ts: number; active: boolean }) {
  // ts is already normalised to ms epoch via sessionTimestamp (handles
  // Invalid Date and future clamps centrally). 0 means "no usable timestamp"
  // → Infinity here so the dot reads as "older".
  const ms = ts > 0 ? Date.now() - ts : Infinity;
  const DAY = 86400000;
  const cls = active
    ? 'bg-accent/70'
    : ms < DAY
    ? 'bg-emerald-500'
    : ms < 7 * DAY
    ? 'bg-amber-400'
    : 'bg-text-muted/40';
  return <span className={cn('w-1.5 h-1.5 rounded-full flex-shrink-0', cls)} title={ms < DAY ? 'Active today' : ms < 7 * DAY ? 'Active this week' : 'Older session'} />;
}

function highlight(text: string, query: string) {
  if (!query) return text;
  const q = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (!q) return text;
  try {
    // Split needs the global flag; per-part match needs the SAME regex re-
    // instantiated WITHOUT `g` so .test() doesn't carry lastIndex across calls
    // (that would skip alternate match parts and leave them un-highlighted).
    const splitRe = new RegExp('(' + q + ')', 'gi');
    const matchRe = new RegExp('^(' + q + ')$', 'i');
    const parts = text.split(splitRe);
    return parts.map((p, i) => matchRe.test(p) ? <mark key={i}>{p}</mark> : p);
  } catch { return text; }
}

function RenameAliasDialog({ open, onOpenChange, session, onSaved }: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  session: SessionMeta;
  onSaved: (alias: string | null) => void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(session.alias || '');
  const [saving, setSaving] = useState(false);

  // Sync draft when dialog opens for a different session. Was useMemo (render-
  // phase side effect — React StrictMode warns) → useEffect runs after commit.
  useEffect(() => { if (open) setDraft(session.alias || ''); }, [open, session.id, session.alias]);

  const inferredTitle = deriveDisplayTitle(session.summary || session.firstUser || '').primary;

  // Demo mode: don't write demo session ids into the user's real aliases.json
  // on disk. App.tsx routes the patchAlias event to an in-memory demo overlay.
  const isDemoMode = (() => { try { return localStorage.getItem('demo-mode') === '1'; } catch { return false; } })();

  const save = async () => {
    if (saving) return;
    setSaving(true);
    const next = draft.trim() || null;
    try {
      if (!isDemoMode) await window.api.setAlias(session.source, session.id, next);
      window.dispatchEvent(new CustomEvent('sessions:patchAlias', { detail: { source: session.source, id: session.id, alias: next } }));
      onSaved(next);
      onOpenChange(false);
    } catch (e) {
      console.error('alias save failed', e);
    } finally {
      setSaving(false);
    }
  };
  const clear = async () => {
    setSaving(true);
    try {
      if (!isDemoMode) await window.api.setAlias(session.source, session.id, null);
      window.dispatchEvent(new CustomEvent('sessions:patchAlias', { detail: { source: session.source, id: session.id, alias: null } }));
      onSaved(null);
      onOpenChange(false);
    } finally { setSaving(false); }
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/30 z-50 animate-fade-in" />
        <Dialog.Content className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[440px] max-w-[92vw] bg-surface border border-border rounded-2xl shadow-pop z-50 overflow-hidden animate-modal-in">
          <div className="px-5 py-4 border-b border-border-soft">
            <Dialog.Title className="text-[14px] font-semibold text-text">{t('rename.title')}</Dialog.Title>
            <div className="text-[11px] text-text-muted mt-0.5 truncate">{inferredTitle}</div>
          </div>
          <div className="px-5 py-4">
            <label className="text-[11px] uppercase tracking-wider font-semibold text-text-muted block mb-2">{t('rename.label')}</label>
            <input
              autoFocus
              type="text"
              value={draft}
              onChange={e => setDraft(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') save(); if (e.key === 'Escape') onOpenChange(false); }}
              placeholder={t('rename.placeholder')}
              maxLength={120}
              className="w-full px-3 py-2 bg-bg border border-border-soft rounded-lg text-[13px] outline-none focus:border-accent focus:ring-1 focus:ring-accent placeholder:text-text-muted"
            />
            <div className="text-[10.5px] text-text-muted mt-1.5">{t('rename.hint')}</div>
          </div>
          <div className="px-5 py-3 border-t border-border-soft flex items-center justify-between gap-2 bg-muted/30">
            {session.alias ? (
              <button onClick={clear} disabled={saving} className="px-2.5 py-1.5 text-[12px] rounded-md text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950/30 disabled:opacity-50">
                {t('rename.clear')}
              </button>
            ) : <span />}
            <div className="flex gap-2">
              <button onClick={() => onOpenChange(false)} className="px-3 py-1.5 text-[12.5px] rounded-md text-text-dim hover:bg-muted">{t('common.cancel')}</button>
              <button onClick={save} disabled={saving} className="px-3 py-1.5 text-[12.5px] font-medium rounded-md bg-accent text-white hover:opacity-90 disabled:opacity-50">
                {saving ? t('common.saving') : t('common.save')}
              </button>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
