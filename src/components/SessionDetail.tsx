import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { Play, Copy, FolderOpen, Star, GitBranch, FileText, SlidersHorizontal, Check, Code2, Wrench, Search, X, Info, RefreshCw } from 'lucide-react';
import { cn } from '../lib/utils';
import { cleanDisplayText, fmtBytes, fmtTime, fmtTokens, shortCwd } from '../lib/format';
import { meaningfulBranch } from '../lib/sessionTitle';
import { useTranslation } from '../lib/I18nProvider';
import type { MessageItem, SessionMeta } from '../types';
import { Message } from './Message';
import { useDisplayPrefs, type DisplayPrefs } from '../lib/displayPrefs';
import { useSystemCapabilities } from '../lib/systemCapabilities';

const RECENT_DEFAULT = 10;
const LOAD_STEP = 10;

type Props = {
  session: SessionMeta | null;
  messages: MessageItem[] | null;
  loading: boolean;
  favorites: Set<string>;
  excluded: Set<string>;
  query: string;
  onToggleFavorite: (id: string) => void;
  onToggleExclude: (id: string) => void;
  onStatus: (m: string) => void;
  onOpenInfo: () => void;
  onRefreshMessages?: () => void;
};

export function SessionDetail({ session, messages, loading, favorites, query, onToggleFavorite, onStatus, onOpenInfo, onRefreshMessages }: Props) {
  const { t } = useTranslation();
  const [globalMode, setGlobalMode] = useState<'markdown' | 'raw'>('markdown');
  const [visibleCount, setVisibleCount] = useState<number>(RECENT_DEFAULT);
  const [prefs, setPrefs] = useDisplayPrefs();
  const [localSearch, setLocalSearch] = useState('');
  const [justCopied, setJustCopied] = useState(false);
  // Hooks must run unconditionally — early return for `!session` is below, so
  // this stays at the top with the other hooks. Moving it below the guard
  // triggers React error #310 (rendered more hooks than previous render).
  const caps = useSystemCapabilities();
  const searchInputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const loadingMoreRef = useRef(false);
  const prevScrollHeightRef = useRef(0);
  // Toolbar auto-compact: when the detail pane is narrow enough that labelled
  // buttons would wrap to a second row, drop labels (icons only) regardless of
  // the user's `toolbarLabels` pref. Labels reappear when the pane widens back.
  // Threshold = roughly the width at which Resume + 7 labelled icons + MD/Raw
  // segment + dividers still fit single-row.
  const toolbarRef = useRef<HTMLDivElement>(null);
  const [toolbarCompact, setToolbarCompact] = useState(false);
  useEffect(() => {
    const el = toolbarRef.current;
    if (!el) return;
    const obs = new ResizeObserver(([entry]) => {
      setToolbarCompact(entry.contentRect.width < 900);
    });
    obs.observe(el);
    return () => obs.disconnect();
  }, []);
  const showLabel = prefs.toolbarLabels && !toolbarCompact;

  useEffect(() => {
    setVisibleCount(RECENT_DEFAULT);
    setLocalSearch('');
    loadingMoreRef.current = false;
    prevScrollHeightRef.current = 0;
  }, [session?.source, session?.id]);

  // Scroll to bottom once messages first appear for the active session
  useEffect(() => {
    if (!messages || visibleCount !== RECENT_DEFAULT) return;
    requestAnimationFrame(() => {
      if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, session?.id]);

  const effectiveQuery = localSearch.trim() || query;

  const filteredMessages = messages
    ? (prefs.showTools ? messages : messages.filter(m => !m.isToolUse && !m.isToolResult))
    : null;

  // When localSearch is active, further restrict to messages containing the query
  const searchScoped = localSearch.trim() && filteredMessages
    ? filteredMessages.filter(m => (m.text || '').toLowerCase().includes(localSearch.toLowerCase()))
    : filteredMessages;

  const totalMsgs = searchScoped?.length || 0;
  const want = Math.min(visibleCount, totalMsgs);
  const visibleMessages = searchScoped && totalMsgs > want ? searchScoped.slice(-want) : searchScoped;
  const hiddenCount = totalMsgs - want;
  const matchCount = localSearch.trim() ? totalMsgs : 0;

  // Preserve apparent scroll position after older messages are prepended
  useLayoutEffect(() => {
    if (prevScrollHeightRef.current > 0 && scrollRef.current) {
      const root = scrollRef.current;
      const delta = root.scrollHeight - prevScrollHeightRef.current;
      if (delta > 0) root.scrollTop = root.scrollTop + delta;
      prevScrollHeightRef.current = 0;
      loadingMoreRef.current = false;
    }
  }, [want]);

  const onScroll = (e: React.UIEvent<HTMLElement>) => {
    if (loadingMoreRef.current || hiddenCount <= 0) return;
    const root = e.currentTarget;
    if (root.scrollTop < 200) {
      loadingMoreRef.current = true;
      prevScrollHeightRef.current = root.scrollHeight;
      setVisibleCount(c => Math.min(c + LOAD_STEP, totalMsgs));
    }
  };

  if (!session) {
    return (
      <main data-pane="detail" className="flex-1 min-w-0 flex flex-col items-center justify-center text-text-muted bg-surface border border-border rounded-2xl">
        <FileText className="w-12 h-12 mb-3 opacity-30" />
        <h2 className="text-base font-medium text-text">{t('detail.emptyTitle')}</h2>
        <p className="text-xs mt-1">{t('detail.emptyHint')}</p>
      </main>
    );
  }

  const isFav = favorites.has(`${session.source}:${session.id}`);
  const tIn = session.tokensIn || 0;
  const tOut = session.tokensOut || 0;
  const tCr = session.tokensCacheRead || 0;
  const tCc = session.tokensCacheCreate || 0;
  const totalTok = tIn + tOut + tCr + tCc;

  const handleCopy = async () => {
    try {
      const cmd = await window.api.copyResumeCommand(session.projectCwd || session.decodedCwd, session.id, session.filePath, session.source);
      // Inline button feedback for ~1.5s. Status bar still gets the longer message
      // so users who look at the bottom strip see the exact command.
      setJustCopied(true);
      onStatus('Copied: ' + cmd);
      setTimeout(() => setJustCopied(false), 1500);
      setTimeout(() => onStatus(''), 2500);
    } catch (e: any) {
      onStatus('Copy failed: ' + e.message);
    }
  };
  // iTerm only makes sense on macOS with iTerm actually installed.
  const itermAvailable = caps?.platform === 'darwin' && caps.terminals.iterm;
  const effectivePreferred = itermAvailable ? prefs.preferredTerminal : 'terminal';

  const handleTerminal = async () => {
    // Primary action — uses the user's preferred terminal app from Settings.
    const fn = effectivePreferred === 'iterm' ? window.api.openInITerm : window.api.openInTerminal;
    const label = effectivePreferred === 'iterm' ? 'iTerm' : 'Terminal';
    try { await fn(session.projectCwd || session.decodedCwd, session.id, session.filePath, session.source); onStatus('Opened in ' + label); setTimeout(() => onStatus(''), 2500); }
    catch (e: any) { onStatus('Error: ' + e.message); }
  };
  const handleReveal = () => window.api.revealInFinder(session.filePath);
  const handleVSCode = async () => {
    try { await window.api.openInVSCode(session.projectCwd || session.decodedCwd); onStatus('Opened in VS Code'); setTimeout(() => onStatus(''), 2500); }
    catch (e: any) { onStatus('Error: ' + e.message); }
  };

  // Detail header used to show raw summary / firstUser, bypassing the
  // cleanDisplayText that SessionList rows go through. Route via the same
  // helper so control chars / bidi can't reorder the header either.
  const title = cleanDisplayText(session.summary) || cleanDisplayText(session.firstUser) || '(no title)';

  return (
    <div
      className="flex-1 min-h-0 bg-surface border border-border rounded-2xl overflow-hidden flex flex-col"
      // Pane needs a real minimum width so the header toolbar (Terminal, iTerm,
      // VS Code, Finder, Copy, Tools, Refresh, MD/Raw + in-session search) has
      // room to lay out on a single row. Below ~640px the buttons wrap and the
      // header doubles in height.
      style={{ minWidth: 640 }}
    >
      <main data-pane="detail" ref={scrollRef} onScroll={onScroll} className="flex-1 min-h-0 min-w-0 overflow-y-auto overflow-x-hidden">
      {/* Compact Header (~140px) */}
      <div className="sticky top-0 z-10 bg-bg/95 backdrop-blur border-b border-border-soft px-6 py-3 min-w-0">
        <div className="flex items-center gap-2 mb-1.5 min-w-0">
          <h1 className="selectable text-[18px] font-bold text-text flex-1 leading-tight min-w-0 truncate" title={title}>
            {title}
          </h1>
          {totalTok > 0 && (
            <button onClick={onOpenInfo} className="text-[12px] tabular-nums text-accent font-semibold hover:bg-accent-soft px-2 py-0.5 rounded transition flex-shrink-0">
              {fmtTokens(totalTok)} tokens
            </button>
          )}
          <button onClick={() => onToggleFavorite(session.id)} className="p-1 rounded hover:bg-muted flex-shrink-0">
            <Star className={cn('w-4 h-4', isFav ? 'fill-amber-400 text-amber-400' : 'text-text-muted')} />
          </button>
          <button onClick={onOpenInfo} title={t('detail.tip.sessionDetails')} className="p-1 rounded hover:bg-muted text-text-muted hover:text-accent flex-shrink-0">
            <Info className="w-4 h-4" />
          </button>
        </div>

        {/* v8 P3 — two coherent groups: identity (where) and stats (how big / how recent).
            Separator divider between them so the row doesn't read as 5 floating chips. */}
        <div className="flex items-center gap-x-3 gap-y-1 text-[11px] text-text-muted mb-2 min-w-0 flex-wrap">
          <span className="selectable font-mono truncate" title={session.projectCwd}>{shortCwd(session.projectCwd || session.decodedCwd)}</span>
          {meaningfulBranch(session.gitBranch) && (
            <span className="flex items-center gap-1 text-amber-600 dark:text-amber-400 flex-shrink-0">
              <GitBranch className="w-3 h-3" /><span className="selectable">{meaningfulBranch(session.gitBranch)}</span>
            </span>
          )}
          <span className="w-px h-3 bg-border-soft flex-shrink-0" aria-hidden />
          <span className="inline-flex items-center gap-1.5 tabular-nums flex-shrink-0">
            <span>{(session.userMsgs || 0) + (session.assistantMsgs || 0)} {t('units.msgs')}</span>
            <span className="text-text-muted/50">·</span>
            <span>{fmtTime(session.lastTs, t)}</span>
            <span className="text-text-muted/50">·</span>
            <span>{fmtBytes(session.fileSize)}</span>
          </span>
        </div>

        {/* Toolbar groups: primary action | open-in helpers | utilities | view mode.
            Wraps to a second row when the pane is too narrow — all buttons stay
            visible, no hidden overflow. */}
        <div ref={toolbarRef} className="flex flex-wrap items-center gap-2 min-w-0">
          {/* Primary — Resume is THE hero action. Opens the user's preferred terminal
             (iTerm on macOS if available, otherwise system Terminal). */}
          <button onClick={handleTerminal} title={effectivePreferred === 'iterm' ? t('detail.tip.openInIterm') : t('detail.tip.openInTerminal')} className="h-10 px-4 bg-accent text-white rounded-lg text-[13.5px] font-semibold hover:opacity-90 flex items-center gap-1.5 shadow-soft whitespace-nowrap flex-shrink-0">
            <Play className="w-4 h-4" />{t('detail.btn.resume')}
          </button>

          <div className="w-px h-6 bg-border-soft mx-1 flex-shrink-0" />

          {/* Open in */}
          <ToolbarBtn onClick={handleVSCode} icon={<Code2 className="w-4 h-4" />} label="VS Code" showLabel={showLabel} title={t('detail.tip.openInVSCode')} />
          <ToolbarBtn onClick={handleReveal} icon={<FolderOpen className="w-4 h-4" />} label="Finder" showLabel={showLabel} title={t('detail.tip.revealJsonl')} />

          <div className="w-px h-6 bg-border-soft mx-1 flex-shrink-0" />

          {/* Utility */}
          <ToolbarBtn
            onClick={handleCopy}
            icon={justCopied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
            label={justCopied ? 'Copied' : 'Copy'}
            showLabel={showLabel}
            title={t('detail.tip.copyCmd')}
            active={justCopied}
          />
          <ToolbarBtn
            onClick={() => setPrefs({ showTools: !prefs.showTools })}
            icon={<Wrench className="w-4 h-4" />}
            label={t('detail.btn.tools')}
            showLabel={showLabel}
            title={prefs.showTools ? t('detail.tip.hideTools') : t('detail.tip.showTools')}
            active={prefs.showTools}
          />
          {/* Re-read this session's JSONL from disk so newly-appended messages
             (e.g. Claude Code is still writing while we're looking) show up
             without restarting the app. */}
          {onRefreshMessages && (
            <ToolbarBtn
              onClick={onRefreshMessages}
              icon={<RefreshCw className="w-4 h-4" />}
              label={t('detail.btn.refresh')}
              showLabel={showLabel}
              title={t('detail.tip.refresh')}
            />
          )}
          <DisplayMenu prefs={prefs} onChange={setPrefs} />

          <div className="ml-auto inline-flex p-0.5 bg-muted rounded-lg flex-shrink-0">
            <button onClick={() => setGlobalMode('markdown')} className={cn('px-3 h-8 rounded-md text-[12px] font-semibold', globalMode === 'markdown' ? 'bg-surface shadow-soft text-text' : 'text-text-muted')}>MD</button>
            <button onClick={() => setGlobalMode('raw')} className={cn('px-3 h-8 rounded-md text-[12px] font-semibold', globalMode === 'raw' ? 'bg-surface shadow-soft text-text' : 'text-text-muted')}>{t('detail.modeRawBtn')}</button>
          </div>
        </div>

        {/* In-session search */}
        <div className="mt-3 relative min-w-0">
          <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-text-muted pointer-events-none" />
          <input
            ref={searchInputRef}
            type="search"
            value={localSearch}
            onChange={e => setLocalSearch(e.target.value)}
            onKeyDown={e => { if (e.key === 'Escape') setLocalSearch(''); }}
            placeholder={t('detail.searchPlaceholder')}
            className="w-full pl-9 pr-20 py-2 bg-surface border border-border-soft rounded-lg text-[13px] outline-none focus:border-accent focus:ring-1 focus:ring-accent placeholder:text-text-muted"
          />
          {localSearch && (
            <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1.5">
              <span className="text-[11px] text-text-muted tabular-nums">{matchCount} match{matchCount !== 1 ? 'es' : ''}</span>
              <button onClick={() => setLocalSearch('')} className="p-1 rounded hover:bg-muted text-text-muted">
                <X className="w-3 h-3" />
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Messages */}
      <div className="px-7 py-5">
        {loading && <div className="text-center text-text-muted text-[12px] py-10">{t('detail.loadingMessages')}</div>}
        {!loading && filteredMessages && filteredMessages.length === 0 && (
          <div className="text-center text-text-muted text-[12px] py-10">{t('detail.noContent')}</div>
        )}
        {!loading && filteredMessages && visibleMessages && visibleMessages.length > 0 && (
          <>
            {messages?.some(m => m.imagesTruncated) && (
              <div className="bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-900 text-amber-800 dark:text-amber-300 text-[11.5px] rounded-lg px-3 py-2 mb-4">
                Some inline images were skipped because this session's total image payload exceeded the cap.
              </div>
            )}
            {hiddenCount > 0 && (
              <div className="bg-surface border border-dashed border-border rounded-lg px-3 py-2 mb-4 flex items-center justify-between text-[11px]">
                <span className="text-text-dim flex items-center gap-2">
                  <span className="inline-block w-1.5 h-1.5 rounded-full bg-accent animate-pulse" />
                  {t('detail.showingLastOf', { shown: want, total: totalMsgs })}
                </span>
                <div className="flex items-center gap-1.5">
                  {/* Explicit Load-more buttons so the user can incrementally
                     reveal older messages even when the visible turns already
                     fit without a scrollbar — pure scroll-up doesn't fire in
                     that case. */}
                  <button
                    onClick={() => setVisibleCount(c => Math.min(c + LOAD_STEP, totalMsgs))}
                    className="px-2.5 py-1 bg-surface border border-border rounded text-[11px] hover:bg-muted"
                  >
                    {t('detail.loadMore', { n: Math.min(LOAD_STEP, hiddenCount) })}
                  </button>
                  <button
                    onClick={() => setVisibleCount(totalMsgs)}
                    className="px-2.5 py-1 bg-surface border border-border rounded text-[11px] hover:bg-muted"
                  >
                    {t('detail.showAll')}
                  </button>
                </div>
              </div>
            )}
            {/* Width stretches to fill the available pane on any monitor; on
               very wide screens the cap kicks in only at xl breakpoints so
               narrow / mid screens never see uneven left/right padding. */}
            <div className={cn('flex flex-col w-full', prefs.compact ? 'gap-2' : 'gap-5')}>
              {visibleMessages.map((m, i) => (
                <Message
                  // Key includes session.id so navigating to another session
                  // unmounts every Message instance — that resets per-message
                  // UI state (timestamp short/long, per-msg MD/RAW override,
                  // collapse). Refresh (SessionsView setMessages(null) → refetch)
                  // also unmounts everything; the user explicitly asked for
                  // "even reopening the same session resets" — refresh counts.
                  key={session.source + ':' + session.id + ':' + ((totalMsgs - visibleMessages.length) + i)}
                  message={m}
                  defaultMode={globalMode}
                  query={effectiveQuery}
                  prefs={prefs}
                  source={session.source}
                />
              ))}
            </div>
          </>
        )}
      </div>
      </main>
    </div>
  );
}

function TokenChip({ label, value, colorClass }: { label: string; value: number; colorClass: string }) {
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-muted border border-border-soft tabular-nums">
      <span className="text-text-muted text-[10px] uppercase tracking-wide font-semibold">{label}</span>
      <span className={cn('font-semibold', colorClass)}>{fmtTokens(value)}</span>
    </span>
  );
}

function DisplayMenu({ prefs, onChange }: { prefs: DisplayPrefs; onChange: (patch: Partial<DisplayPrefs>) => void }) {
  const { t } = useTranslation();
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button title={t('detail.tip.displayOptions')} className="w-9 h-9 bg-bg border border-border-soft rounded-lg hover:bg-muted text-text-dim flex items-center justify-center">
          <SlidersHorizontal className="w-4 h-4" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={6}
          className="min-w-[220px] bg-elevated border border-border rounded-lg shadow-pop py-1 z-50 animate-in"
        >
          <CheckItem checked={prefs.showTimestamps} onChange={v => onChange({ showTimestamps: v })}>{t('display.showTimestamps')}</CheckItem>
          <CheckItem checked={prefs.showMsgTokens} onChange={v => onChange({ showMsgTokens: v })}>{t('display.showMsgTokens')}</CheckItem>
          <CheckItem checked={prefs.showAvatars} onChange={v => onChange({ showAvatars: v })}>{t('display.showAvatars')}</CheckItem>
          <DropdownMenu.Separator className="my-1 h-px bg-border-soft" />
          <CheckItem checked={prefs.compact} onChange={v => onChange({ compact: v })}>{t('display.compact')}</CheckItem>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

function ToolbarBtn({ onClick, icon, label, showLabel, title, active }: { onClick: () => void; icon: React.ReactNode; label: string; showLabel: boolean; title: string; active?: boolean }) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={cn(
        'h-9 border rounded-lg flex items-center justify-center gap-1.5 flex-shrink-0 whitespace-nowrap',
        showLabel ? 'px-2.5 text-[12.5px] font-medium' : 'w-9',
        active ? 'bg-accent-soft border-accent text-accent' : 'bg-bg border-border-soft hover:bg-muted text-text-dim'
      )}
    >
      {icon}
      {showLabel && <span>{label}</span>}
    </button>
  );
}

function CheckItem({ checked, onChange, children }: { checked: boolean; onChange: (v: boolean) => void; children: React.ReactNode }) {
  return (
    <DropdownMenu.CheckboxItem
      checked={checked}
      onCheckedChange={onChange}
      onSelect={e => e.preventDefault()}
      className="flex items-center gap-2 px-3 py-1.5 text-[12px] cursor-pointer outline-none data-[highlighted]:bg-accent data-[highlighted]:text-white"
    >
      <span className="w-3.5 h-3.5 flex items-center justify-center">
        {checked && <Check className="w-3 h-3" />}
      </span>
      <span className="flex-1">{children}</span>
    </DropdownMenu.CheckboxItem>
  );
}

