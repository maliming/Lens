import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Clock, Star, X, BarChart3, RefreshCw, Check, Command, Settings as Gear, Terminal as TerminalIcon } from 'lucide-react';
import * as Tooltip from '@radix-ui/react-tooltip';
import { ClaudeIcon } from './ClaudeIcon';
import type { View } from '../types';
import { fmtTokens, kbdShortcut, cleanDisplayText } from '../lib/format';
import { cn } from '../lib/utils';
import type { Profile } from '../lib/profile';
import { useSourceAuth, planLabel, planBadgeClass } from '../lib/sourceAuth';
import { useTranslation } from '../lib/I18nProvider';
import type { TKey } from '../lib/i18n';
import { pct, resetInLabel, agoLabel, isWindowExpired, hasWindow, useNowTick, type RateLimitsState } from '../lib/rateLimits';
import { DEMO_AUTH } from '../lib/demoData';
import { AISourceSelector } from './AISourceSelector';
import { SourceSwitchConfirmModal } from './SourceSwitchConfirmModal';
import { useCurrentSource, getSource, type SessionSource } from '../lib/sources';
import { getDeepSearchState } from '../lib/deepSearchState';

// Generic adapter — looks up the current source's Glyph from the registry.
// Adding a new AI tool means adding a row in lib/sources.ts SOURCES; this
// component does not need to change.
function WorkspaceNavIcon({ className = '' }: { className?: string }) {
  const [source] = useCurrentSource();
  const { Glyph } = getSource(source);
  return <Glyph className={className} />;
}

type Props = {
  view: View;
  onViewChange: (v: View) => void;
  theme: 'light' | 'dark';
  onThemeChange: (t: 'light' | 'dark') => void;
  counts: { sessions: number; favorites: number; excluded: number; terminals: number };
  totalTokens: number;
  onReload: () => void;
  profile: Profile;
  onOpenProfile: () => void;
  rateLimits?: RateLimitsState;
  onRefreshQuota?: () => void;
  // True once the user has opted into / Codex-locally-runs the quota probe.
  // Keeps the quota section mounted (with skeleton bars) during the in-flight
  // window so it doesn't blink in and out around source flips or refreshes.
  quotaEnabled?: boolean;
  // The embedded terminal is off until asked for, and while it is off the nav
  // entry would lead to a pane that can only refuse to start anything.
  terminalEnabled?: boolean;
  demoMode?: boolean;
};

// Search lives as the first item — it's the hero workflow per v4 brief.
// 'search' is not a real view; clicking it opens the command palette.
const PRIMARY_NAV: Array<{ id: View | 'search'; labelKey: TKey; icon: any; countKey: 'sessions' | 'favorites' | 'terminals' | null }> = [
  { id: 'search', labelKey: 'nav.search', icon: Command, countKey: null },
  { id: 'sessions', labelKey: 'nav.history', icon: Clock, countKey: 'sessions' },
  { id: 'favorites', labelKey: 'nav.favorites', icon: Star, countKey: 'favorites' },
  // Sits with the other filtered views of the session list, because that is
  // what it is: the sessions that happen to have a process running. A terminal
  // outlives the session you opened it from, so without somewhere that lists
  // them the only way back is remembering where you left one.
  { id: 'terminals', labelKey: 'nav.terminals', icon: TerminalIcon, countKey: 'terminals' },
  { id: 'usage', labelKey: 'nav.usage', icon: BarChart3, countKey: null },
  { id: 'config', labelKey: 'nav.config', icon: WorkspaceNavIcon, countKey: null },
  { id: 'settings', labelKey: 'nav.settings', icon: Gear, countKey: null },
];

export function Sidebar({ view, onViewChange, theme, onThemeChange, counts, totalTokens, onReload, profile, onOpenProfile, rateLimits, onRefreshQuota, quotaEnabled = false, terminalEnabled = false, demoMode = false }: Props) {
  const [source] = useCurrentSource();
  const { auth: realAuth, loading: realLoading, refresh } = useSourceAuth(source);
  const { t } = useTranslation();
  // Demo mode: substitute a stable fake auth so the identity card shows a
  // realistic plan badge / email instead of "Free" / nothing.
  const auth = demoMode ? DEMO_AUTH : realAuth;
  const loading = demoMode ? false : realLoading;
  // When the subscription probe hasn't returned yet OR the user isn't logged
  // into Claude CLI, we still show a plan chip — defaulting to "Free" so the
  // identity card never has an unlabeled gap. Once auth resolves with a real
  // tier it replaces it.
  const planName = !loading && auth?.subscriptionType
    ? planLabel(auth.subscriptionType)
    : !loading ? 'Free' : null;
  const [refreshState, setRefreshState] = useState<'idle' | 'busy' | 'done'>('idle');
  const rescanAll = async () => {
    if (refreshState !== 'idle') return;
    setRefreshState('busy');
    try { await Promise.resolve(onReload()); await Promise.resolve(refresh()); }
    finally {
      setRefreshState('done');
      setTimeout(() => setRefreshState('idle'), 3000);
    }
  };

  return (
    <aside data-pane="sidebar" style={{ width: 'var(--sidebar-width, 220px)' }} className="flex-shrink-0 bg-muted/60 border border-border rounded-2xl flex flex-col overflow-hidden">



      {/* Source + identity + quota in one card. All three answer the same
          question at different depths — which AI, who you are on it, what is
          left of it — and every row below the switcher changes when it flips.
          No overflow-hidden on the wrapper: the switcher's menu is absolutely
          positioned and has to escape the card it now lives in.
          
          The quota row is laid out across, not down, so its height does not
          depend on how many windows a provider reports — Claude has three,
          Codex two, and the model list can grow. Stacked bars made the nav
          jump on every source switch; rings sharing one row cannot. */}
      <div className="no-drag mx-2 mt-2 mb-5 rounded-2xl border border-border-soft bg-surface/60 transition-shadow duration-200 hover:shadow-soft">
      <SidebarSourceSlot demoMode={demoMode} />
      <ProfileQuotaCard
        profile={profile}
        authEmail={auth?.email}
        planName={planName}
        planSubscriptionType={auth?.subscriptionType}
        rateLimits={rateLimits}
        quotaEnabled={quotaEnabled}
        onOpenProfile={onOpenProfile}
        onRefreshQuota={onRefreshQuota}
        noNameLabel={t('profile.noName')}
        liveLabel={t('quota.liveBadge')}
      />
      </div>

      {/* Primary nav with labels. Search is a real view now (v11 brief);
          ⌘K still opens the palette globally for quick jumping. */}
      <nav className="px-2 flex flex-col gap-1">
        {PRIMARY_NAV.filter(item => item.id !== 'terminals' || terminalEnabled).map(item => {
          const Icon = item.icon;
          const isSearch = item.id === 'search';
          const active = view === item.id;
          const count = item.countKey ? counts[item.countKey] : null;
          return (
            <button
              key={item.id}
              onClick={() => onViewChange(item.id as View)}
              className={cn(
                'relative overflow-hidden flex items-center gap-3 px-3 h-[38px] rounded-[11px] text-[13.5px] font-medium transition-all duration-150 text-left active:scale-[0.97]',
                active ? 'bg-accent-soft text-accent' : 'text-text-dim hover:bg-muted hover:text-text'
              )}
            >
              {active && <span className="absolute left-0 top-0 bottom-0 w-[3px] bg-accent" />}
              <Icon className="w-4 h-4 flex-shrink-0" />
              <span className="flex-1">{t(item.labelKey)}</span>
              {isSearch && (
                <kbd className="text-[10.5px] px-1.5 py-0.5 rounded-md bg-muted border border-border-soft text-text-muted font-mono">{kbdShortcut('K')}</kbd>
              )}
              {count != null && count > 0 && (
                <span className={cn(
                  'min-w-[26px] h-[22px] px-1.5 rounded-lg text-[11.5px] tabular-nums font-medium flex items-center justify-center',
                  active ? 'bg-accent/15 text-accent' : 'bg-muted text-text-muted'
                )}>
                  {count}
                </span>
              )}
            </button>
          );
        })}
      </nav>

      <div className="flex-1" />

      {/* Filters (always visible — it's a config entry point, not a session count.
          Count badge only shows when there's something hidden.) */}
      <div className="px-2 pb-1">
        <button
          onClick={() => onViewChange('excluded')}
          className={cn(
            'relative overflow-hidden w-full flex items-center gap-3 px-3 h-[38px] rounded-[11px] text-[13px] font-medium transition-all duration-150 text-left active:scale-[0.97]',
            view === 'excluded' ? 'bg-accent-soft text-accent' : 'text-text-muted hover:bg-muted hover:text-text'
          )}
        >
          {view === 'excluded' && <span className="absolute left-0 top-0 bottom-0 w-[3px] bg-accent" />}
          <X className="w-4 h-4 flex-shrink-0" />
          <span className="flex-1">{t('nav.excluded')}</span>
          {counts.excluded > 0 && (
            <span className={cn(
              'min-w-[26px] h-[22px] px-1.5 rounded-lg text-[11.5px] tabular-nums font-medium flex items-center justify-center',
              view === 'excluded' ? 'bg-accent/15 text-accent' : 'bg-muted text-text-muted'
            )}>
              {counts.excluded}
            </span>
          )}
        </button>
      </div>

      {/* Footer — same card geometry as the profile card up top (rounded-2xl
          + hairline divider between stats and action) but a quieter, less
          tinted background so it reads as a supporting block, not a second
          identity card. */}
      <div className="no-drag mx-2 mb-3 rounded-2xl border border-border bg-surface/35 overflow-hidden">
        <div className="px-3 pt-3 pb-2.5 grid grid-cols-2 gap-2">
          <div className="min-w-0 text-center">
            <div className="text-[13.5px] font-semibold text-text tabular-nums leading-none">{counts.sessions}</div>
            <div className="text-[9.5px] text-text-muted uppercase tracking-wider mt-1">{t('footer.sessions')}</div>
          </div>
          <div className="min-w-0 text-center">
            <div className="text-[13.5px] font-semibold text-text tabular-nums leading-none truncate">{fmtTokens(totalTokens)}</div>
            <div className="text-[9.5px] text-text-muted uppercase tracking-wider mt-1">{t('footer.tokens')}</div>
          </div>
        </div>
        <div className="h-px bg-border-soft/70 mx-3" />
        <Tooltip.Root>
          <Tooltip.Trigger asChild>
            <button onClick={rescanAll} disabled={loading || refreshState !== 'idle'} className="w-full h-8 px-3 text-text-muted hover:bg-muted/40 hover:text-accent disabled:hover:text-text-muted disabled:hover:bg-transparent flex items-center justify-center gap-1.5 text-[11.5px] transition">
              {refreshState === 'done'
                ? <Check className="w-3 h-3 text-emerald-500" />
                : <RefreshCw className={cn('w-3 h-3', (loading || refreshState === 'busy') && 'animate-spin')} />}
              <span>{refreshState === 'done' ? t('footer.refreshed') : t('footer.refresh')}</span>
            </button>
          </Tooltip.Trigger>
          <Tooltip.Portal>
            <Tooltip.Content
              side="top"
              sideOffset={8}
              align="center"
              className="z-50 max-w-[260px] bg-elevated border border-border rounded-lg shadow-pop px-3 py-2 text-[11.5px] text-text leading-snug animate-in"
            >
              <div className="font-semibold mb-1">{t('sidebar.rescanTooltip')}</div>
              {/* Render the hint sentence via t() with a sentinel split-point
                 so the styled <code> for the JSONL path stays in the layout
                 while the surrounding text follows the active locale. */}
              <div className="text-text-dim text-[11px]">
                {(() => {
                  const tmpl = t('sidebar.rescanHint', {
                    path: ' __PATH__ ',
                    source: getSource(source).label,
                  });
                  const parts = tmpl.split(' __PATH__ ');
                  return (
                    <>
                      {parts[0]}
                      <code className="font-mono bg-muted px-1 rounded">{getSource(source).pathHint}*.jsonl</code>
                      {parts[1]}
                    </>
                  );
                })()}
              </div>
              <Tooltip.Arrow className="fill-border" />
            </Tooltip.Content>
          </Tooltip.Portal>
        </Tooltip.Root>
      </div>
    </aside>
  );
}

// Claude Code's own warning rule, read out of the CLI binary. It is not a
// percentage but a pair: how much is spent against how much of the window has
// elapsed. Burning 25% of a week in its first 15% is worth flagging; the same
// 25% on a Friday is just normal use. Anthropic also sends an authoritative
// `anthropic-ratelimit-unified-<window>-surpassed-threshold` header, but the
// usage endpoint Lens reads does not carry it, so this is the local rule.
const OUTPACING: Record<number, Array<{ used: number; elapsed: number }>> = {
  [5 * 3600]: [{ used: 0.9, elapsed: 0.72 }],
  [7 * 86400]: [
    { used: 0.75, elapsed: 0.6 },
    { used: 0.5, elapsed: 0.35 },
    { used: 0.25, elapsed: 0.15 },
  ],
};
// Spent outright, whatever the clock says. The pair above answers "are you
// ahead of schedule"; this answers "is there anything left", and a ring is the
// wrong place to stay calm about 6% remaining.
const SPENT = 0.9;

// A source switch keeps the previous provider's figures until the new ones are
// in, so the rings never drop to skeletons in between. The wait is capped so a
// probe that never answers still ends in the skeleton rather than stale data.
const QUOTA_SWAP_TIMEOUT_MS = 1500;
// The per-model ring is the only one a provider may or may not report, so it is
// the only one that grows in and shrinks out.
const EXTRA_RING_MS = 260;

function QuotaRing({ label, window, windowSeconds, notReported, sweep }: { label: string; window: { utilization: number | null; reset: number | null }; windowSeconds: number; notReported?: boolean; sweep?: number }) {
  const { t } = useTranslation();
  // Keeps the countdown honest between the five-minute polls.
  useNowTick();
  const p = pct(window);
  const left = p == null ? null : Math.max(0, 100 - p);
  // Past its reset the arc describes a window that no longer exists, so it
  // renders as unknown rather than as a stale value.
  const expired = isWindowExpired(window);
  const unknown = left == null || expired || !!notReported;
  const resetLabel = resetInLabel(window.reset, t);

  const used = left == null ? null : (100 - left) / 100;
  // How far into the window we are: the reset is its end, so subtracting the
  // window length gives its start.
  const elapsed = window.reset == null
    ? null
    : Math.min(1, Math.max(0, 1 - (window.reset * 1000 - Date.now()) / (windowSeconds * 1000)));
  const outpacing = !unknown && used != null && elapsed != null
    && (OUTPACING[windowSeconds] ?? []).some(r => used >= r.used && elapsed <= r.elapsed);
  const spent = !unknown && used != null && used >= SPENT;

  const stroke = unknown ? 'stroke-border'
    : spent ? 'stroke-danger'
    : outpacing ? 'stroke-warning'
    : 'stroke-accent';
  const text = unknown ? 'text-text-muted'
    : spent ? 'text-danger'
    : outpacing ? 'text-warning'
    : 'text-text';

  const R = 15.5;
  const CIRC = 2 * Math.PI * R;
  const offset = unknown ? CIRC : CIRC - (left / 100) * CIRC;
  const arcRef = useRef<SVGCircleElement | null>(null);
  const numRef = useRef<HTMLSpanElement | null>(null);
  // The figure in the middle while the arc is draining; null once it has
  // landed, so the real value takes over.
  const [drainLeft, setDrainLeft] = useState<number | null>(null);
  // Whether the ring showed a figure the last time the effect ran, and which
  // refresh click it last answered. Together they decide where a sweep starts.
  const wasKnownRef = useRef(false);
  const lastSweepRef = useRef(sweep);
  // The colours the arc and the figure last came to rest on. They cannot be
  // read back from the DOM at rest: by the time a layout effect runs, React has
  // already committed the destination's class names, so the computed colour is
  // the one the sweep is heading for, not the one it is leaving.
  const settledRef = useRef<{ stroke: string; text: string } | null>(null);
  // Layout, not passive: the figure in the middle is rendered straight from the
  // new value, and a passive effect would only rewind it to the sweep's start
  // after that frame has been painted — a one-frame flash of the destination
  // before the count begins.
  useLayoutEffect(() => {
    const el = arcRef.current;
    const num = numRef.current;
    if (!el || !num) return;
    // Where the arc is on screen right now, read before anything is cancelled.
    // Mid-sweep that is the in-flight value, so an interrupted sweep carries on
    // from where the eye already is instead of jumping to its old start. It is
    // also what keeps StrictMode's second effect run honest: the first run's
    // sweep has only just started, so it reads back as that sweep's start.
    // Colours follow the same rule while a sweep owns them; at rest they come
    // from what the last sweep settled on.
    let fromOffset: number | null = null;
    let fromStroke: string | null = null;
    let fromText: string | null = null;
    try {
      const v = parseFloat(getComputedStyle(el).strokeDashoffset);
      if (Number.isFinite(v)) fromOffset = v;
      if (el.getAnimations().some(a => a.playState === 'running')) {
        fromStroke = getComputedStyle(el).stroke || null;
        fromText = getComputedStyle(num).color || null;
      } else if (settledRef.current) {
        fromStroke = settledRef.current.stroke;
        fromText = settledRef.current.text;
      }
    } catch {}
    const wasKnown = wasKnownRef.current;
    const replay = sweep !== lastSweepRef.current;
    wasKnownRef.current = !unknown && left != null;
    lastSweepRef.current = sweep;

    // Drop any sweep still in flight — two animations on one property fight
    // over its value, and a click landing mid-sweep is exactly when that
    // happens.
    try {
      el.getAnimations().forEach(a => a.cancel());
      num.getAnimations().forEach(a => a.cancel());
    } catch {}
    el.style.strokeDashoffset = String(offset);
    setDrainLeft(null);
    if (unknown || left == null) { settledRef.current = null; return; }

    // Colour rides along: passing 30% and 10% mid-sweep flips the stroke, so a
    // ring on its way to 7% goes accent → amber → red instead of arriving red,
    // and one climbing back goes the other way. The figure follows the same
    // marks, over neutral text instead of accent. Resolved from the CSS
    // variables because keyframes need real colours, not class names, and the
    // values differ per theme.
    const rootStyle = getComputedStyle(document.documentElement);
    const hsl = (name: string) => `hsl(${rootStyle.getPropertyValue(name).trim()})`;
    const strokeAt = (pctLeft: number) =>
      pctLeft <= 10 ? hsl('--danger') : pctLeft <= 30 ? hsl('--warning') : hsl('--accent');
    const textAt = (pctLeft: number) =>
      pctLeft <= 10 ? hsl('--danger') : pctLeft <= 30 ? hsl('--warning') : hsl('--text');
    // The last stop uses the colour the ring actually settles on, which is not
    // always the one the marks predict: an outpacing window can be amber with
    // plenty left.
    const endStroke = spent ? hsl('--danger') : outpacing ? hsl('--warning') : hsl('--accent');
    const endText = spent ? hsl('--danger') : outpacing ? hsl('--warning') : hsl('--text');
    settledRef.current = { stroke: endStroke, text: endText };

    // A ring that already showed a figure moves from it, up or down, so a
    // provider switch reads as the same gauge settling somewhere else. A ring
    // with nothing to move from — its first figure, or the model ring that has
    // just grown in — drains from full, and so does a refresh click.
    const fromFull = !wasKnown || replay || fromOffset == null;
    const startOffset = fromFull ? 0 : Math.min(CIRC, Math.max(0, fromOffset!));
    const startLeft = ((CIRC - startOffset) / CIRC) * 100;
    if (Math.abs(startLeft - left) < 0.05) return;

    const frames: Keyframe[] = [{
      strokeDashoffset: String(startOffset),
      stroke: fromFull || !fromStroke ? strokeAt(100) : fromStroke,
      offset: 0,
    }];
    const textFrames: Keyframe[] = [{ color: fromFull || !fromText ? textAt(100) : fromText, offset: 0 }];
    const down = left < startLeft;
    for (const mark of down ? [30, 10] : [10, 30]) {
      const crosses = down ? left < mark && mark < startLeft : startLeft <= mark && mark < left;
      if (!crosses) continue;
      // Where in the sweep the ring passes this mark, as a fraction of the
      // distance from the start to the target.
      const at = Math.abs(startLeft - mark) / Math.abs(startLeft - left);
      const side = down ? mark : mark + 1;
      frames.push({ strokeDashoffset: String(CIRC - (mark / 100) * CIRC), stroke: strokeAt(side), offset: at });
      textFrames.push({ color: textAt(side), offset: at });
    }
    frames.push({ strokeDashoffset: String(offset), stroke: endStroke, offset: 1 });
    textFrames.push({ color: endText, offset: 1 });

    let raf = 0;
    try {
      // fill: none on purpose. The dash offset falls back to the inline style
      // set above and both colours fall back to their classes — all of which
      // are already the final state, so nothing snaps and the classes keep
      // owning the colours once the motion is over.
      const timing: KeyframeAnimationOptions = { duration: 700, easing: 'ease-out', fill: 'none' };
      const anim = el.animate(frames, timing);
      num.animate(textFrames, timing);
      // The number counts down with the arc by reading the arc's live offset
      // each frame, rather than running a second tween whose timing and easing
      // would have to be kept in step by hand.
      const step = () => {
        if (anim.playState !== 'running') { setDrainLeft(null); return; }
        const current = parseFloat(getComputedStyle(el).strokeDashoffset);
        if (Number.isFinite(current)) setDrainLeft(Math.max(0, ((CIRC - current) / CIRC) * 100));
        raf = requestAnimationFrame(step);
      };
      setDrainLeft(startLeft);
      raf = requestAnimationFrame(step);
    } catch { /* older engines just land on the final value */ }
    return () => cancelAnimationFrame(raf);
  }, [offset, sweep, unknown, left, spent, outpacing]);

  // Radix rather than a `title`: the outpacing line exists to answer "why is
  // this amber when it still says 24%", and the native tooltip answers it after
  // a second, in the OS's own styling, on one unbreakable line. The provider is
  // already mounted app-wide in main.tsx, and the rescan button below uses the
  // same shell.
  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>
    <div className="flex flex-col items-center gap-1 min-w-0 flex-1">
      <div className={cn('relative w-[42px] h-[42px] flex-shrink-0', notReported && 'opacity-45')}>
        <svg viewBox="0 0 40 40" className="w-full h-full -rotate-90" aria-hidden>
          <circle cx="20" cy="20" r={R} fill="none" strokeWidth="3.5" className="stroke-border/70" />
          <circle
            ref={arcRef}
            cx="20" cy="20" r={R} fill="none" strokeWidth="3.5" strokeLinecap="round"
            className={cn(stroke, unknown && !notReported && 'animate-pulse')}
            strokeDasharray={CIRC}
            style={{ strokeDashoffset: CIRC }}
          />
        </svg>
        <span ref={numRef} className={cn('absolute inset-0 flex items-center justify-center text-[11px] font-bold tabular-nums', text)}>
          {unknown ? '—' : Math.round(drainLeft ?? left)}
        </span>
      </div>
      <span className="text-[9.5px] text-text-muted truncate max-w-full leading-none">{label}</span>
    </div>
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content
          side="bottom"
          sideOffset={6}
          align="center"
          className="z-50 max-w-[220px] bg-elevated border border-border rounded-lg shadow-pop px-2.5 py-1.5 text-[11.5px] text-text leading-snug animate-in"
        >
          {notReported ? (
            <div className="text-text-dim">{t('quota.notReported', { label })}</div>
          ) : (
            <>
              <div className="font-semibold">
                {label} · {unknown ? '—' : t('sidebar.quotaLeft', { n: left.toFixed(1) })}
              </div>
              {resetLabel && (
                <div className="text-text-dim mt-0.5">{t('sidebar.resetsIn', { when: resetLabel })}</div>
              )}
              {/* Only when the pace is the reason for the colour. Once a window
                  is simply spent, the number says it and this would be noise. */}
              {outpacing && !spent && (
                <div className="text-warning mt-1">{t('quota.outpacing')}</div>
              )}
            </>
          )}
          <Tooltip.Arrow className="fill-border" />
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

// Keeps a value mounted for `exitMs` after it goes away, so it can animate out,
// and holds it hidden for a frame after it arrives, so it can animate in.
function usePresence<T>(value: T | null, exitMs: number): { item: T | null; visible: boolean } {
  const [kept, setKept] = useState<T | null>(value);
  const [visible, setVisible] = useState(value != null);
  const present = value != null;
  useEffect(() => {
    if (present) {
      // Two frames: the first lets the hidden state reach the page, otherwise
      // there is nothing for the transition to start from.
      let inner = 0;
      const outer = requestAnimationFrame(() => { inner = requestAnimationFrame(() => setVisible(true)); });
      return () => { cancelAnimationFrame(outer); cancelAnimationFrame(inner); };
    }
    setVisible(false);
    const id = window.setTimeout(() => setKept(null), exitMs);
    return () => clearTimeout(id);
  }, [present, exitMs]);
  useEffect(() => { if (value != null) setKept(value); }, [value]);
  return { item: value ?? kept, visible: present && visible };
}

function SidebarSourceSlot({ demoMode }: { demoMode: boolean }) {
  const [source, setSource] = useCurrentSource();
  // A flip mid deep-search wipes the Search page, so ask first. The query is
  // captured at click time; the modal keeps showing it even if the scan
  // finishes while the dialog is open, at which point switching is free.
  const [pending, setPending] = useState<{ next: SessionSource; query: string } | null>(null);
  const requestSwitch = (next: SessionSource) => {
    if (next === source) return;
    const deep = getDeepSearchState();
    if (deep.inFlight) { setPending({ next, query: deep.query }); return; }
    setSource(next);
  };
  return (
    <>
      <AISourceSelector value={source} onChange={requestSwitch} demoMode={demoMode} />
      <SourceSwitchConfirmModal
        open={pending != null}
        target={pending?.next ?? null}
        query={pending?.query ?? ''}
        onKeep={() => setPending(null)}
        onSwitch={() => { const next = pending?.next; setPending(null); if (next) setSource(next); }}
      />
    </>
  );
}

// Profile + quota merged into one identity card (restored from the v11 design).
// Top region is a button → opens profile modal.
// Bottom region (when quota available) shows live bars + "Details" → Usage.
function ProfileQuotaCard({
  profile,
  authEmail,
  planName,
  planSubscriptionType,
  rateLimits,
  quotaEnabled = false,
  onOpenProfile,
  onRefreshQuota,
  noNameLabel,
  liveLabel,
}: {
  profile: Profile;
  authEmail?: string;
  planName: string | null;
  planSubscriptionType?: string;
  rateLimits?: RateLimitsState;
  quotaEnabled?: boolean;
  onOpenProfile: () => void;
  onRefreshQuota?: () => void;
  noNameLabel: string;
  liveLabel: string;
}) {
  const { t } = useTranslation();
  const [source] = useCurrentSource();
  const [sweep, setSweep] = useState(0);
  useNowTick();
  // What the rings draw: the active provider's numbers the moment they are in,
  // and until then whatever was already on screen. Both providers share the
  // same 5h and 7d rings, so a switch is just those rings moving from one
  // provider's figures to the other's.
  //
  // Derived in render on purpose. Swapping a shown source in an effect left one
  // render where the new numbers had landed but the rings still counted as
  // empty — and an empty ring's next figure sweeps from full, which undid the
  // whole point of moving from the old value.
  const live = quotaEnabled && rateLimits?.limits && rateLimits.limitsSource === source ? rateLimits.limits : null;
  const [held, setHeld] = useState(live);
  const [stale, setStale] = useState(false);
  useEffect(() => { if (live) setHeld(live); }, [live]);
  const hasLive = live != null;
  useEffect(() => {
    if (hasLive) { setStale(false); return; }
    const id = window.setTimeout(() => setStale(true), QUOTA_SWAP_TIMEOUT_MS);
    return () => clearTimeout(id);
  }, [hasLive, source]);
  const shown = live ?? (quotaEnabled && !stale ? held : null);
  const hasQuota = shown != null;

  // Mount the section once the probe is enabled — even before the first
  // response lands — so it doesn't blink in/out around source flips or
  // refreshes. Skeleton bars render via RateBar's null-window fallback.
  const showQuotaSection = hasQuota || quotaEnabled;
  const extraRing = usePresence(shown?.modelWindows?.[0] ?? null, EXTRA_RING_MS);
  const EMPTY_WINDOW = { utilization: null, reset: null };
  const fiveHour = shown?.fiveHour ?? EMPTY_WINDOW;
  const weekly = shown?.weekly ?? EMPTY_WINDOW;
  // Before data lands both bars show the skeleton; once it has, a window the
  // provider never reported is simply not there.
  const fiveHourMissing = hasQuota && !hasWindow(fiveHour);
  const headline = hasQuota
    ? (hasWindow(weekly) ? { w: weekly, secs: 7 * 86400, label: '7d' }
      : hasWindow(fiveHour) ? { w: fiveHour, secs: 5 * 3600, label: '5h' }
      : null)
    : null;
  const headlineReset = headline ? resetInLabel(headline.w.reset, t) : null;
  // How much of that window has gone by. This is the other half of the pair the
  // ring colours are decided on: the ring shows what is spent, this shows what
  // has elapsed, and the two side by side make "spending faster than the window
  // refills" something you can see rather than something a tooltip has to say.
  const headlineElapsed = headline?.w.reset == null
    ? null
    : Math.min(1, Math.max(0, 1 - (headline.w.reset * 1000 - Date.now()) / (headline.secs * 1000)));

  return (
    <div className="no-drag border-t border-border-soft/60 rounded-b-2xl overflow-hidden">
      <button onClick={onOpenProfile} className="w-full flex items-center gap-3 px-3 pt-3 pb-3 text-left hover:bg-muted/30 transition">
        {profile.avatarImage ? (
          <img
            src={profile.avatarImage}
            alt=""
            referrerPolicy="no-referrer"
            className="w-[42px] h-[42px] rounded-[14px] object-cover shadow-[0_8px_18px_rgba(124,63,242,0.24)] flex-shrink-0"
          />
        ) : (
          <div className={cn('w-[42px] h-[42px] rounded-[14px] bg-gradient-to-br flex items-center justify-center text-white font-bold text-[18px] shadow-[0_8px_18px_rgba(124,63,242,0.24)] flex-shrink-0', profile.avatarGradient)}>
            {profile.avatarInitial || '?'}
          </div>
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 min-w-0">
            <span className="text-[13.5px] font-semibold text-text truncate leading-tight">{profile.name || noNameLabel}</span>
            {planName && (
              <span className={cn('text-[9px] uppercase tracking-[0.06em] font-medium px-1.5 py-[1px] rounded whitespace-nowrap flex-shrink-0', planBadgeClass(planSubscriptionType))}>
                {planName}
              </span>
            )}
          </div>
          {authEmail && (
            <div className="selectable text-[11px] text-text-muted truncate mt-0.5" title={authEmail}>
              {authEmail}
            </div>
          )}
        </div>
      </button>

      {showQuotaSection && (
        <>
          <div className="h-px bg-border-soft/70 mx-3" />
          <div className="px-3 pt-2.5 pb-3">
            <div
              className="flex items-center justify-between mb-1.5"
              title={live ? t('quota.updated', { when: agoLabel(rateLimits!.fetchedAt, t) }) : undefined}
            >
              <span className="text-[9.5px] uppercase tracking-wider font-semibold text-text-muted flex items-center gap-1">
                {/* Pulse the live dot until data arrives so the loading
                   state is visible without an explicit spinner. */}
                <span className={cn(
                  'w-1 h-1 rounded-full',
                  hasQuota ? 'bg-emerald-500' : 'bg-text-muted/60 animate-pulse'
                )} aria-hidden />
                {liveLabel}
              </span>
              <button
                onClick={() => { setSweep(n => n + 1); onRefreshQuota?.(); }}
                disabled={!onRefreshQuota || rateLimits?.loading}
                title={t('footer.refresh')}
                aria-label={t('footer.refresh')}
                className="p-1 -m-1 rounded text-text-muted hover:text-accent disabled:opacity-40 disabled:hover:text-text-muted transition"
              >
                <RefreshCw className={cn('w-3 h-3', rateLimits?.loading && 'animate-spin')} />
              </button>
            </div>
            <div className="flex items-start gap-1">
              <QuotaRing label="5h" window={fiveHour} windowSeconds={5 * 3600} notReported={fiveHourMissing} sweep={sweep} />
              <QuotaRing label="7d" window={weekly} windowSeconds={7 * 86400} sweep={sweep} />
              {extraRing.item && (
                // Grows from zero width rather than appearing at full size, so
                // the two rings beside it slide over instead of jumping. The
                // negative margin cancels the row gap while it is collapsed.
                <div
                  className="flex min-w-0 overflow-hidden ease-out transition-[flex-grow,margin,opacity,transform] motion-reduce:transition-none"
                  style={{
                    flexGrow: extraRing.visible ? 1 : 0,
                    flexBasis: 0,
                    marginLeft: extraRing.visible ? 0 : -4,
                    opacity: extraRing.visible ? 1 : 0,
                    transform: `scale(${extraRing.visible ? 1 : 0.6})`,
                    transitionDuration: `${EXTRA_RING_MS}ms`,
                  }}
                >
                  <QuotaRing key={extraRing.item.name} label={cleanDisplayText(extraRing.item.name)} window={extraRing.item} windowSeconds={7 * 86400} sweep={sweep} />
                </div>
              )}
            </div>
            {/* The track is always here, even with nothing to draw in it.
                Rendering it only when a window is known made the card lose a
                row for the moment between switching provider and the new probe
                answering — and the nav below moved with it. An empty track is
                the honest picture of "we do not know yet" and costs no layout. */}
            <Tooltip.Root>
              <Tooltip.Trigger asChild>
                <div className="mt-3 h-1 rounded-full bg-border overflow-hidden cursor-default">
                  {/* Neutral grey on purpose: this is the clock, not usage.
                      Colouring it would put it in competition with the rings,
                      which are the thing worth reacting to. */}
                  <div
                    className="h-full rounded-full bg-text-muted/50 transition-[width] duration-700 ease-out"
                    style={{ width: `${(headlineElapsed ?? 0) * 100}%` }}
                  />
                </div>
              </Tooltip.Trigger>
              {headline && headlineElapsed != null && (
                <Tooltip.Portal>
                  <Tooltip.Content
                    side="bottom"
                    sideOffset={6}
                    className="z-50 max-w-[220px] bg-elevated border border-border rounded-lg shadow-pop px-2.5 py-1.5 text-[11.5px] text-text leading-snug animate-in"
                  >
                    <div className="font-semibold">{t('quota.windowElapsed', { label: headline.label, n: Math.round(headlineElapsed * 100) })}</div>
                    {headlineReset && (
                      <div className="text-text-dim mt-0.5">{t('sidebar.resetsIn', { when: headlineReset })}</div>
                    )}
                    <Tooltip.Arrow className="fill-border" />
                  </Tooltip.Content>
                </Tooltip.Portal>
              )}
            </Tooltip.Root>
          </div>
        </>
      )}
    </div>
  );
}

