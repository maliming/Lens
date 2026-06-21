import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { Play, Copy, FolderOpen, Star, GitBranch, FileText, SlidersHorizontal, Check, Code2, Search, X, Info, RefreshCw, ChevronUp, ChevronDown } from 'lucide-react';
import { cn } from '../lib/utils';
import { cleanDisplayText, fmtBytes, fmtTime, fmtTokens, shortCwd, visibleMessageCount } from '../lib/format';
import { meaningfulBranch } from '../lib/sessionTitle';
import { useTranslation } from '../lib/I18nProvider';
import type { MessageItem, SessionMeta, SessionSubagents } from '../types';
import { Message } from './Message';
import { UnlinkedSubagents } from './SubagentTranscript';
import { linkSubagents, linkedFor, messageHasLinkedSubagent, linkedMatchesQuery, taskAgentMatches, workflowRunMatches } from '../lib/subagents';
import { useDisplayPrefs, type DisplayPrefs } from '../lib/displayPrefs';
import { useSystemCapabilities } from '../lib/systemCapabilities';

// Initial render is sized to comfortably fill a default-sized viewport in
// one shot. The auto-fill loop below is still there as a safety net for
// tiny windows or pathologically short turns, but at this floor most
// sessions skip it entirely (so the user sees a single stable paint with
// no perceptible auto-fill bump). 16 covers a 1044px window at typical
// message density (~3-4 turns/screen × 4 screens of scroll buffer).
const INITIAL_VISIBLE = 16;
// Step used by both the auto-fill loop AND the scroll-up loader.
const LOAD_STEP = 8;
// Auto-fill stops once scrollHeight ≥ clientHeight × this. Slightly above 1
// so the bottom of the last turn isn't pinned exactly to the bottom edge.
const FILL_RATIO = 1.2;
// Scroll-position threshold (px from top) that triggers the next page.
const SCROLL_TRIGGER_PX = 200;

// Cap on how many matched messages search mode renders at once. Search bypasses
// the idle lazy-load slice (we don't want matches to silently sit off-screen),
// but rendering every match in a 5000-turn session would stall reconciliation +
// TreeWalker work. 200 covers the common cases (logs / customer-support sessions
// rarely exceed ~150 matched turns); beyond that we surface an "Show all" button
// so the user opts in to the wait. Pick from the tail — newest matches are
// almost always what the user wants first.
const SEARCH_RENDER_CAP = 200;

// Main-process MAX_SESSION_FILE_SIZE mirror. Past this, `sessions:get` IPC
// hard-rejects — the renderer would show the user a "Load anyway" button
// that throws on click, so we surface a dedicated "too large" state above
// the cap instead. Duplicated here intentionally: renderer code can't
// import main-process modules. If the backend cap moves in
// electron/lib/jsonl.cjs, bump this too.
const DETAIL_HARD_CAP_BYTES = 200 * 1024 * 1024;

type Props = {
  session: SessionMeta | null;
  messages: MessageItem[] | null;
  loading: boolean;
  refreshing?: boolean;
  favorites: Set<string>;
  excluded: Set<string>;
  query: string;
  onToggleFavorite: (id: string) => void;
  onToggleExclude: (id: string) => void;
  onStatus: (m: string) => void;
  onOpenInfo: () => void;
  onRefreshMessages?: () => void;
  // When the active session's JSONL is large enough to warrant an opt-in,
  // the parent pauses auto-load and passes this. Rendering it surfaces the
  // confirm overlay; `onConfirm()` re-fires the parent's fetch effect.
  // `null` = no gating in effect; either size is fine or user already
  // accepted for this session.
  pendingLargeLoad?: { sizeBytes: number; onConfirm: () => void } | null;
  // Index of subagent / workflow transcripts spawned by this session. Wired to
  // the originating Agent / Workflow tool card for inline expand. `null` while
  // it loads or for sources without a subagent tree (Codex).
  subagents?: SessionSubagents | null;
};

export function SessionDetail({ session, messages, loading, refreshing, favorites, query, onToggleFavorite, onStatus, onOpenInfo, onRefreshMessages, pendingLargeLoad, subagents }: Props) {
  const { t } = useTranslation();
  const [globalMode, setGlobalMode] = useState<'markdown' | 'raw'>('markdown');
  const [visibleCount, setVisibleCount] = useState<number>(INITIAL_VISIBLE);
  const [prefs, setPrefs] = useDisplayPrefs();
  const [localSearch, setLocalSearch] = useState('');
  // Total <mark> count + 0-based index of the currently focused one. We collect
  // marks by walking scrollRef in a useLayoutEffect (every time the search
  // query / visible message set / mode changes) so prev/next can step through
  // them in document order across all rendered messages.
  const [matchTotal, setMatchTotal] = useState(0);
  const [matchIdx, setMatchIdx] = useState(0);
  // When the user clicks "Show all" we lift the SEARCH_RENDER_CAP for the
  // current query. Reset on session switch + on every query change below so
  // typing a new term doesn't drag the previous "show all" decision over.
  const [searchShowAll, setSearchShowAll] = useState(false);
  const [justCopied, setJustCopied] = useState(false);
  // Hooks must run unconditionally — early return for `!session` is below, so
  // this stays at the top with the other hooks. Moving it below the guard
  // triggers React error #310 (rendered more hooks than previous render).
  const caps = useSystemCapabilities();
  const searchInputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Scroll-position preservation while prepending older turns.
  const loadingMoreRef = useRef(false);
  const prevScrollHeightRef = useRef(0);
  // True while the viewport-aware auto-fill loop is still growing the
  // initially-rendered window. While this flag is set, every layout pass pins
  // scrollTop to the bottom so the user lands on the most recent turn even
  // as older ones get appended above. The first scroll event flips it off.
  const initialFillRef = useRef(true);
  // Toolbar refresh button feedback. `refreshState` lives one tick longer
  // than the parent's `refreshing` prop so a "Refreshed" checkmark shows
  // briefly after the fetch returns — otherwise instant refreshes look
  // identical to no-ops and the user can't tell anything happened.
  const [refreshState, setRefreshState] = useState<'idle' | 'busy' | 'done'>('idle');
  const prevRefreshingRef = useRef(false);
  useEffect(() => {
    if (refreshing && !prevRefreshingRef.current) {
      setRefreshState('busy');
    } else if (!refreshing && prevRefreshingRef.current) {
      setRefreshState('done');
      const id = setTimeout(() => setRefreshState('idle'), 1200);
      prevRefreshingRef.current = refreshing ?? false;
      return () => clearTimeout(id);
    }
    prevRefreshingRef.current = refreshing ?? false;
  }, [refreshing]);
  // Detail pane's own minWidth keeps the toolbar wide enough to fit Resume +
  // Copy + Refresh + Finder + VS Code + Display options + MD/Raw on a single
  // row even at the app's minimum window size, so we no longer auto-strip
  // labels — `prefs.toolbarLabels` is the sole signal.
  const showLabel = prefs.toolbarLabels;

  // Reset the in-session search when switching sessions; keep it when the
  // current session is just being refreshed (parent toggles messages=null
  // briefly to mark the refetch — that's not a navigation).
  useEffect(() => {
    setLocalSearch('');
    setSearchShowAll(false);
  }, [session?.source, session?.id]);

  // Each new query starts capped — "Show all" doesn't carry over because the
  // term may match an entirely different set of turns.
  useEffect(() => {
    setSearchShowAll(false);
  }, [localSearch]);

  // Re-initialise the lazy-load window every time `messages` transitions
  // from null back to a populated array — that's the session-switch flow
  // (the parent clears + refetches). Refresh keeps `messages` non-null so
  // this doesn't fire there; the refresh path is handled below.
  const prevMessagesNullRef = useRef(true);
  useEffect(() => {
    const wasNull = prevMessagesNullRef.current;
    prevMessagesNullRef.current = messages == null;
    if (wasNull && messages != null) {
      setVisibleCount(INITIAL_VISIBLE);
      loadingMoreRef.current = false;
      prevScrollHeightRef.current = 0;
      initialFillRef.current = true;
    }
  }, [messages]);

  // Refresh path. `messages` stays non-null and just grows in place. Extend
  // visibleCount by the raw delta so the slice(-want) still anchors to the
  // turns the user was already looking at — old DOM nodes reconcile by key
  // (which is absolute index), new turns slot in below. Then if the user
  // was effectively at the bottom, re-pin to the new bottom so they see the
  // freshly-arrived turn.
  const prevRawMsgsLenRef = useRef(0);
  const prevSessionKeyRef = useRef<string | null>(null);
  useLayoutEffect(() => {
    const sessionKey = session ? `${session.source}:${session.id}` : null;
    const rawLen = messages?.length ?? 0;
    const prevSessionKey = prevSessionKeyRef.current;
    const prevRawLen = prevRawMsgsLenRef.current;
    prevSessionKeyRef.current = sessionKey;
    prevRawMsgsLenRef.current = rawLen;
    if (!messages || !sessionKey) return;
    if (sessionKey !== prevSessionKey) return;
    if (rawLen <= prevRawLen) return;
    const root = scrollRef.current;
    const wasAtBottom = root
      ? (root.scrollHeight - root.scrollTop - root.clientHeight) < 80
      : false;
    setVisibleCount(c => c + (rawLen - prevRawLen));
    if (wasAtBottom && root) {
      requestAnimationFrame(() => {
        const r = scrollRef.current;
        if (r) r.scrollTop = r.scrollHeight;
      });
    }
  }, [messages, session?.id, session?.source]);

  const effectiveQuery = localSearch.trim() || query;

  // Tool messages (tool_use args / tool_result content) carry most of the
  // technical detail in a session — file paths, code snippets, command output.
  // Deep global search reads raw JSONL bytes so it matches inside those even
  // when the user has Tools hidden in Display prefs. We mirror that here: if
  // an in-session query hits a tool message's text, surface it so the result
  // set matches the user's mental model "this term IS in this session".
  // Without this, opening a session that the global search matched can show
  // 0 in-session matches, which reads as a bug.
  const q = localSearch.trim().toLowerCase();
  const matchesQuery = (m: MessageItem) => !!q && (m.text || '').toLowerCase().includes(q);
  // Tie subagent / workflow transcripts to the Agent / Workflow call that
  // spawned them. Recomputed only when the messages or the index change.
  const links = useMemo(() => linkSubagents(messages, subagents ?? null), [messages, subagents]);
  const filteredMessages = messages
    ? messages.filter(m => {
        const isTool = m.isToolUse || m.isToolResult;
        if (!isTool) return true;
        if (prefs.showTools) return true;
        // An Agent / Workflow card carries the only entry point to its
        // subagent transcripts — keep it visible even when tools are hidden,
        // or the feature silently disappears with the "Show tools" toggle.
        if (messageHasLinkedSubagent(m, links)) return true;
        return matchesQuery(m);
      })
    : null;

  // When localSearch is active, further restrict to messages containing the
  // query — OR whose Agent/Workflow card spawned a subagent whose index fields
  // match (lightweight: index only, no transcript read). Keeps the card in view
  // so the matched preview rendered inside it is reachable.
  const matchesMessageOrSubagent = (m: MessageItem) =>
    matchesQuery(m) || linkedMatchesQuery(linkedFor(m, links), q);
  const searchScoped = q && filteredMessages
    ? filteredMessages.filter(matchesMessageOrSubagent)
    : filteredMessages;

  const totalMsgs = searchScoped?.length || 0;
  const want = Math.min(visibleCount, totalMsgs);
  // Search mode bypasses the idle lazy-load slice (matches off-screen would
  // read as a bug). Past SEARCH_RENDER_CAP matched turns we cap to the newest
  // K — rendering every match in a 5000-turn session would stall both React
  // reconciliation and the TreeWalker pass. The omitted count gets surfaced
  // below as a "Show all" affordance so the user opts in to the wait.
  const searchCap = searchShowAll ? totalMsgs : SEARCH_RENDER_CAP;
  const searchOmitted = q && totalMsgs > searchCap ? totalMsgs - searchCap : 0;
  const visibleMessages = searchScoped && q
    ? (totalMsgs > searchCap ? searchScoped.slice(-searchCap) : searchScoped)
    : (searchScoped && totalMsgs > want ? searchScoped.slice(-want) : searchScoped);
  const hiddenCount = q ? 0 : totalMsgs - want;

  // Collect every <mark> Message components inserted via highlightDom and keep
  // matchTotal in sync. Reset matchIdx to 0 whenever the set changes (typing,
  // mode flip, lazy-load extending the visible window). Children's
  // useLayoutEffect runs before this parent one, so the marks are already in
  // the DOM by the time we query.
  useLayoutEffect(() => {
    const root = scrollRef.current;
    if (!root || !localSearch.trim()) {
      setMatchTotal(0);
      setMatchIdx(0);
      return;
    }
    const marks = root.querySelectorAll<HTMLElement>('mark');
    setMatchTotal(marks.length);
    setMatchIdx(prev => (marks.length === 0 ? 0 : Math.min(prev, marks.length - 1)));
  }, [localSearch, visibleMessages, globalMode, prefs.showTools]);

  // Move focus on the currently-selected mark. Adds `data-current` for the
  // distinguishing color and scrolls it into the viewport center. Runs after
  // the collector above so matchTotal is settled.
  useLayoutEffect(() => {
    const root = scrollRef.current;
    if (!root) return;
    const marks = root.querySelectorAll<HTMLElement>('mark');
    marks.forEach(m => m.removeAttribute('data-current'));
    if (matchTotal === 0) return;
    const target = marks[Math.min(matchIdx, marks.length - 1)];
    if (!target) return;
    target.setAttribute('data-current', 'true');
    target.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [matchIdx, matchTotal]);

  const gotoMatch = (delta: 1 | -1) => {
    if (matchTotal === 0) return;
    setMatchIdx(prev => (prev + delta + matchTotal) % matchTotal);
  };

  // Two distinct prepend modes — pick one based on which ref is armed.
  // - `prevScrollHeightRef > 0`: user-triggered scroll-up loader; preserve
  //   the apparent scroll position so the row they were looking at doesn't
  //   jump under them.
  // - `initialFillRef.current === true`: the auto-fill loop is still growing
  //   the initial render; pin scrollTop to the bottom so the latest turn
  //   stays in view.
  useLayoutEffect(() => {
    const root = scrollRef.current;
    if (!root) return;
    if (prevScrollHeightRef.current > 0) {
      const delta = root.scrollHeight - prevScrollHeightRef.current;
      if (delta > 0) root.scrollTop = root.scrollTop + delta;
      prevScrollHeightRef.current = 0;
      loadingMoreRef.current = false;
    } else if (initialFillRef.current) {
      root.scrollTop = root.scrollHeight;
    }
  }, [want]);

  // Viewport-aware auto-fill. Each time the rendered set grows, peek at the
  // scroll container: if content still doesn't overflow comfortably AND
  // there's more to reveal, schedule another step. Stops on its own once the
  // user can scroll. Loop guards on `hiddenCount` so it always terminates.
  useLayoutEffect(() => {
    const root = scrollRef.current;
    if (!root || !messages) return;
    if (!initialFillRef.current) return;
    if (hiddenCount <= 0) { initialFillRef.current = false; return; }
    if (root.scrollHeight >= root.clientHeight * FILL_RATIO) {
      initialFillRef.current = false;
      return;
    }
    // Defer to the next frame so layout has stabilised; otherwise short turns
    // (one-line text) measure as a few pixels before final fonts settle.
    const raf = requestAnimationFrame(() => {
      setVisibleCount(c => Math.min(c + LOAD_STEP, totalMsgs));
    });
    return () => cancelAnimationFrame(raf);
  }, [want, hiddenCount, totalMsgs, messages]);

  // Scroll-driven lazy loader. Once the user scrolls within SCROLL_TRIGGER_PX
  // of the top, append the next batch. No button, no banner — the act of
  // scrolling IS the trigger. Also flips off the initial-fill flag so future
  // visibleCount bumps preserve the user's scroll position instead of
  // re-pinning to the bottom.
  const onScroll = (e: React.UIEvent<HTMLElement>) => {
    const root = e.currentTarget;
    // Programmatic scroll-to-bottom inside the auto-fill loop also fires a
    // scroll event; only treat the user as having taken over when they've
    // moved meaningfully away from the bottom.
    if (initialFillRef.current) {
      const distFromBottom = root.scrollHeight - root.scrollTop - root.clientHeight;
      if (distFromBottom > 60) initialFillRef.current = false;
    }
    if (loadingMoreRef.current || hiddenCount <= 0) return;
    if (root.scrollTop < SCROLL_TRIGGER_PX) {
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
      const cmd = await window.api.copyResumeCommand(session.id, session.filePath, session.source);
      // Inline button feedback for ~1.5s. Status bar still gets the longer message
      // so users who look at the bottom strip see the exact command.
      setJustCopied(true);
      onStatus(t('status.copied', { cmd }));
      setTimeout(() => setJustCopied(false), 1500);
      setTimeout(() => onStatus(''), 2500);
    } catch (e: any) {
      onStatus(t('status.copyFailed', { error: e.message }));
    }
  };
  // iTerm only makes sense on macOS with iTerm actually installed.
  const itermAvailable = caps?.platform === 'darwin' && caps.terminals.iterm;
  const effectivePreferred = itermAvailable ? prefs.preferredTerminal : 'terminal';

  const handleTerminal = async () => {
    // Primary action — uses the user's preferred terminal app from Settings.
    const fn = effectivePreferred === 'iterm' ? window.api.openInITerm : window.api.openInTerminal;
    const label = effectivePreferred === 'iterm' ? 'iTerm' : 'Terminal';
    try { await fn(session.id, session.filePath, session.source); onStatus(t('status.openedIn', { target: label })); setTimeout(() => onStatus(''), 2500); }
    catch (e: any) { onStatus(t('status.error', { error: e.message })); }
  };
  const handleReveal = () => window.api.revealInFinder(session.filePath);
  const handleVSCode = async () => {
    try { await window.api.openInVSCode(session.id, session.filePath, session.source); onStatus(t('status.openedIn', { target: 'VS Code' })); setTimeout(() => onStatus(''), 2500); }
    catch (e: any) { onStatus(t('status.error', { error: e.message })); }
  };

  // Run summary / firstUser through cleanDisplayText (same helper SessionList
  // rows use) so ANSI / control chars / bidi marks never reach the DOM.
  const title = cleanDisplayText(session.summary) || cleanDisplayText(session.firstUser) || t('list.noTitle');

  return (
    <div
      className="flex-1 min-h-0 bg-surface border border-border rounded-2xl overflow-hidden flex flex-col"
      // Pane needs a real minimum width so the header toolbar (Terminal, iTerm,
      // VS Code, Finder, Copy, Tools, Refresh, MD/Raw + in-session search) has
      // room to lay out on a single row. Below ~640px the buttons wrap and the
      // header doubles in height.
      style={{ minWidth: 640 }}
    >
      {/* overflow-anchor:none disables Chromium's native scroll anchoring.
          The scroll-up loader already restores position manually (prepend
          delta in the useLayoutEffect above); with native anchoring left on,
          the browser ALSO shifts scrollTop by the same delta, so the two
          stack and the view jumps back down toward the latest turn. */}
      <main data-pane="detail" ref={scrollRef} onScroll={onScroll} className="flex-1 min-h-0 min-w-0 overflow-y-auto overflow-x-hidden [overflow-anchor:none]">
      {/* Compact Header (~140px) */}
      <div className="sticky top-0 z-10 bg-bg/95 backdrop-blur border-b border-border-soft px-6 py-3 min-w-0">
        <div className="flex items-center gap-2 mb-1.5 min-w-0">
          <h1 className="selectable text-[18px] font-bold text-text flex-1 leading-tight min-w-0 truncate" title={title}>
            {title}
          </h1>
          {totalTok > 0 && (
            <button onClick={onOpenInfo} className="text-[12px] tabular-nums text-accent font-semibold hover:bg-accent-soft px-2 py-0.5 rounded transition flex-shrink-0">
              {fmtTokens(totalTok)} {t('units.tokens')}
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
            <span>{visibleMessageCount(session)} {t('units.msgs')}</span>
            <span className="text-text-muted/50">·</span>
            <span>{fmtTime(session.lastTs, t)}</span>
            <span className="text-text-muted/50">·</span>
            <span>{fmtBytes(session.fileSize)}</span>
          </span>
        </div>

        {/* Toolbar order: Resume → Copy → Refresh → Finder → VS Code → Display
            options → (right) MD/Raw. Single rhythm, no divider chips —
            buttons all share the same icon weight so the eye doesn't need
            help grouping them. Wraps to a second row when the pane is too
            narrow. */}
        <div className="flex flex-wrap items-center gap-2 min-w-0">
          {/* Resume is THE hero action — visually distinct from the rest by
             solid accent fill rather than a separator. Opens the user's
             preferred terminal (iTerm on macOS if available, otherwise
             system Terminal). */}
          <button onClick={handleTerminal} title={effectivePreferred === 'iterm' ? t('detail.tip.openInIterm') : t('detail.tip.openInTerminal')} className="h-10 px-4 bg-accent text-white rounded-lg text-[13.5px] font-semibold hover:opacity-90 flex items-center gap-1.5 shadow-soft whitespace-nowrap flex-shrink-0">
            <Play className="w-4 h-4" />{t('detail.btn.resume')}
          </button>
          <ToolbarBtn
            onClick={handleCopy}
            icon={justCopied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
            label={justCopied ? t('common.copied') : t('common.copy')}
            showLabel={showLabel}
            title={t('detail.tip.copyCmd')}
            active={justCopied}
          />
          {/* Re-read this session's JSONL from disk so newly-appended messages
             (e.g. Claude Code is still writing while we're looking) show up
             without restarting the app. Spinner during the refetch + brief
             green check when it finishes so the user actually sees feedback
             when the diff is empty (no new turns to render). */}
          {onRefreshMessages && (
            <ToolbarBtn
              onClick={() => { if (refreshState !== 'busy') onRefreshMessages(); }}
              icon={
                refreshState === 'done'
                  ? <Check className="w-4 h-4 text-emerald-500" />
                  : <RefreshCw className={cn('w-4 h-4', refreshState === 'busy' && 'animate-spin')} />
              }
              label={t(refreshState === 'done' ? 'detail.btn.refreshed' : 'detail.btn.refresh')}
              showLabel={showLabel}
              title={t('detail.tip.refresh')}
              active={refreshState !== 'idle'}
            />
          )}
          <ToolbarBtn onClick={handleReveal} icon={<FolderOpen className="w-4 h-4" />} label={t('detail.btn.finder')} showLabel={showLabel} title={t('detail.tip.revealJsonl')} />
          <ToolbarBtn onClick={handleVSCode} icon={<Code2 className="w-4 h-4" />} label={t('detail.btn.vscode')} showLabel={showLabel} title={t('detail.tip.openInVSCode')} />
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
            onKeyDown={e => {
              if (e.key === 'Escape') { setLocalSearch(''); return; }
              if (e.key === 'Enter') {
                e.preventDefault();
                gotoMatch(e.shiftKey ? -1 : 1);
              }
            }}
            placeholder={t('detail.searchPlaceholder')}
            className="w-full pl-9 pr-40 py-2 bg-surface border border-border-soft rounded-lg text-[13px] outline-none focus:border-accent focus:ring-1 focus:ring-accent placeholder:text-text-muted"
          />
          {localSearch && (
            <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1">
              <span className="text-[11px] text-text-muted tabular-nums px-1 min-w-[3.5rem] text-right">
                {matchTotal > 0
                  ? t('detail.search.matchCounter', { cur: matchIdx + 1, total: matchTotal })
                  : t('detail.search.noMatches')}
              </span>
              <button
                onClick={() => gotoMatch(-1)}
                disabled={matchTotal === 0}
                title={t('detail.search.prev')}
                aria-label={t('detail.search.prev')}
                className="p-1 rounded hover:bg-muted text-text-muted disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <ChevronUp className="w-3.5 h-3.5" />
              </button>
              <button
                onClick={() => gotoMatch(1)}
                disabled={matchTotal === 0}
                title={t('detail.search.next')}
                aria-label={t('detail.search.next')}
                className="p-1 rounded hover:bg-muted text-text-muted disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <ChevronDown className="w-3.5 h-3.5" />
              </button>
              <button
                onClick={() => setLocalSearch('')}
                title={t('detail.search.clear')}
                aria-label={t('detail.search.clear')}
                className="p-1 rounded hover:bg-muted text-text-muted"
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Messages */}
      <div className="px-7 py-5">
        {pendingLargeLoad && !loading && (() => {
          // Two-tier overlay: SessionsView opens this at LARGE_SESSION_
          // THRESHOLD (~50 MB), and we split the copy at DETAIL_HARD_CAP_
          // BYTES (200 MB) — the wall where the backend `sessions:get`
          // throws. Without the split, the user would see a Load button
          // that fails on click.
          const sizeMb = (pendingLargeLoad.sizeBytes / 1024 / 1024).toFixed(1);
          const beyondCap = pendingLargeLoad.sizeBytes > DETAIL_HARD_CAP_BYTES;
          return (
            <div className="max-w-md mx-auto bg-surface border border-border rounded-xl px-5 py-6 my-8 text-center">
              <div className="text-[13px] text-text mb-2 font-medium">
                {beyondCap
                  ? t('detail.tooLarge.title', { size: sizeMb })
                  : t('detail.large.title', { size: sizeMb })}
              </div>
              <div className="text-[11.5px] text-text-muted mb-4 leading-relaxed">
                {beyondCap ? t('detail.tooLarge.body') : t('detail.large.body')}
              </div>
              {!beyondCap && (
                <button
                  onClick={pendingLargeLoad.onConfirm}
                  className="px-4 py-2 rounded-lg bg-accent text-white text-[12px] font-medium hover:bg-accent/90 transition"
                >
                  {t('detail.large.load')}
                </button>
              )}
            </div>
          );
        })()}
        {loading && <div className="text-center text-text-muted text-[12px] py-10">{t('detail.loadingMessages')}</div>}
        {!loading && !pendingLargeLoad && filteredMessages && filteredMessages.length === 0 && (
          <div className="text-center text-text-muted text-[12px] py-10">{t('detail.noContent')}</div>
        )}
        {!loading && filteredMessages && visibleMessages && visibleMessages.length > 0 && (
          <>
            {messages?.some(m => m.imagesTruncated) && (
              <div className="bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-900 text-amber-800 dark:text-amber-300 text-[11.5px] rounded-lg px-3 py-2 mb-4">
                {t('detail.imagesTruncated')}
              </div>
            )}
            {searchOmitted > 0 && (
              <div className="flex items-center justify-between gap-3 bg-accent/5 border border-accent/30 rounded-lg px-3 py-2 mb-4 text-[11.5px] text-text-muted">
                <span>{t('detail.search.omittedNotice', { n: searchOmitted })}</span>
                <button
                  onClick={() => setSearchShowAll(true)}
                  className="px-2 py-0.5 rounded bg-accent text-white text-[11px] font-medium hover:bg-accent/90 transition flex-shrink-0"
                >
                  {t('detail.search.showAll')}
                </button>
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
                  linked={linkedFor(m, links)}
                />
              ))}
              {/* Orphan subagents / workflow runs we couldn't anchor to a
                 specific tool call still surface here rather than vanishing.
                 In search mode, narrow to the ones whose index fields match so
                 the region doesn't read as an unrelated block. */}
              <UnlinkedSubagents
                taskAgents={q ? links.unlinkedTaskAgents.filter(a => taskAgentMatches(a, q)) : links.unlinkedTaskAgents}
                runs={q ? links.unlinkedWorkflowRuns.filter(r => workflowRunMatches(r, q)) : links.unlinkedWorkflowRuns}
                query={effectiveQuery}
                source={session.source}
                prefs={prefs}
              />
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
          {/* Conversation-content toggles — what you see in the message
             stream. Off by default since tool blocks are usually noise
             when skimming a session. */}
          <CheckItem checked={prefs.showTools} onChange={v => onChange({ showTools: v })}>{t('display.showTools')}</CheckItem>
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

