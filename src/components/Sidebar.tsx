import { useEffect, useRef, useState } from 'react';
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

function QuotaRing({ label, window, notReported }: { label: string; window: { utilization: number | null; reset: number | null }; notReported?: boolean }) {
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

  // Remaining headroom, same thresholds the bars used: low left = nearly out.
  const stroke = unknown ? 'stroke-border'
    : left <= 10 ? 'stroke-rose-500'
    : left <= 30 ? 'stroke-amber-500'
    : 'stroke-accent';
  const text = unknown ? 'text-text-muted'
    : left <= 10 ? 'text-rose-500'
    : left <= 30 ? 'text-amber-500'
    : 'text-text';

  const R = 15.5;
  const CIRC = 2 * Math.PI * R;
  const arc = unknown ? 0 : (left / 100) * CIRC;

  return (
    <div
      className="flex flex-col items-center gap-1 min-w-0 flex-1"
      title={notReported
        ? t('quota.notReported', { label })
        : `${label} · ${unknown ? '—' : t('sidebar.quotaLeft', { n: left.toFixed(1) })}${resetLabel ? ` · ${t('sidebar.resetsIn', { when: resetLabel })}` : ''}`}
    >
      <div className={cn('relative w-[42px] h-[42px] flex-shrink-0', notReported && 'opacity-45')}>
        <svg viewBox="0 0 40 40" className="w-full h-full -rotate-90" aria-hidden>
          <circle cx="20" cy="20" r={R} fill="none" strokeWidth="3.5" className="stroke-border/70" />
          <circle
            cx="20" cy="20" r={R} fill="none" strokeWidth="3.5" strokeLinecap="round"
            className={cn(stroke, 'transition-[stroke-dasharray] duration-700 ease-out', unknown && !notReported && 'animate-pulse')}
            strokeDasharray={`${arc} ${CIRC}`}
          />
        </svg>
        <span className={cn('absolute inset-0 flex items-center justify-center text-[11px] font-bold tabular-nums', text)}>
          {unknown ? '—' : Math.round(left)}
        </span>
      </div>
      <span className="text-[9.5px] text-text-muted truncate max-w-full leading-none">{label}</span>
    </div>
  );
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
  useNowTick();
  const hasQuota = !!rateLimits?.limits;
  // Mount the section once the probe is enabled — even before the first
  // response lands — so it doesn't blink in/out around source flips or
  // refreshes. Skeleton bars render via RateBar's null-window fallback.
  const showQuotaSection = hasQuota || quotaEnabled;
  const EMPTY_WINDOW = { utilization: null, reset: null };
  const fiveHour = rateLimits?.limits?.fiveHour ?? EMPTY_WINDOW;
  const weekly = rateLimits?.limits?.weekly ?? EMPTY_WINDOW;
  // Before data lands both bars show the skeleton; once it has, a window the
  // provider never reported is simply not there.
  const fiveHourMissing = hasQuota && !hasWindow(fiveHour);
  const headlineReset = hasQuota
    ? (resetInLabel(rateLimits!.limits!.weekly.reset, t) ?? resetInLabel(rateLimits!.limits!.fiveHour.reset, t))
    : null;

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
              title={hasQuota ? t('quota.updated', { when: agoLabel(rateLimits!.fetchedAt, t) }) : undefined}
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
            </div>
            <div className="flex items-start gap-1">
              <QuotaRing label="5h" window={fiveHour} notReported={fiveHourMissing} />
              <QuotaRing label="7d" window={weekly} />
              {(rateLimits?.limits?.modelWindows ?? []).slice(0, 1).map(w => (
                <QuotaRing key={w.name} label={cleanDisplayText(w.name)} window={w} />
              ))}
            </div>
            <div className="flex items-center justify-between gap-2 mt-2.5">
              <span className="text-[10.5px] text-text-muted truncate">
                {headlineReset ? t('sidebar.resetsIn', { when: headlineReset }) : ''}
              </span>
              {/* The numbers are the point of this section, and the one thing
                  you want from them is a fresher copy. Usage is one click away
                  in the nav right below, so spending this slot on a second
                  route there bought nothing. */}
              <button
                onClick={onRefreshQuota}
                disabled={!onRefreshQuota || rateLimits?.loading}
                title={t('footer.refresh')}
                aria-label={t('footer.refresh')}
                className="p-1 -m-1 rounded text-text-muted hover:text-accent disabled:opacity-40 disabled:hover:text-text-muted transition"
              >
                <RefreshCw className={cn('w-3 h-3', rateLimits?.loading && 'animate-spin')} />
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

