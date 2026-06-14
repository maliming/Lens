import { useState } from 'react';
import { Clock, Star, X, Coins, RefreshCw, Check, Command, Settings as Gear } from 'lucide-react';
import * as Tooltip from '@radix-ui/react-tooltip';
import { ClaudeIcon } from './ClaudeIcon';
import type { View } from '../types';
import { fmtTokens, kbdShortcut } from '../lib/format';
import { cn } from '../lib/utils';
import type { Profile } from '../lib/profile';
import { useSourceAuth, planLabel, planBadgeClass } from '../lib/sourceAuth';
import { useTranslation } from '../lib/I18nProvider';
import type { TKey } from '../lib/i18n';
import { pct, resetInLabel, agoLabel, type RateLimitsState } from '../lib/rateLimits';
import { DEMO_AUTH } from '../lib/demoData';
import { AISourceSelector } from './AISourceSelector';
import { useCurrentSource, getSource } from '../lib/sources';

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
  counts: { sessions: number; favorites: number; excluded: number };
  totalTokens: number;
  onReload: () => void;
  profile: Profile;
  onOpenProfile: () => void;
  rateLimits?: RateLimitsState;
  demoMode?: boolean;
};

// Search lives as the first item — it's the hero workflow per v4 brief.
// 'search' is not a real view; clicking it opens the command palette.
const PRIMARY_NAV: Array<{ id: View | 'search'; labelKey: TKey; icon: any; countKey: 'sessions' | 'favorites' | null }> = [
  { id: 'search', labelKey: 'nav.search', icon: Command, countKey: null },
  { id: 'sessions', labelKey: 'nav.history', icon: Clock, countKey: 'sessions' },
  { id: 'favorites', labelKey: 'nav.favorites', icon: Star, countKey: 'favorites' },
  { id: 'usage', labelKey: 'nav.usage', icon: Coins, countKey: null },
  { id: 'config', labelKey: 'nav.config', icon: WorkspaceNavIcon, countKey: null },
  { id: 'settings', labelKey: 'nav.settings', icon: Gear, countKey: null },
];

export function Sidebar({ view, onViewChange, theme, onThemeChange, counts, totalTokens, onReload, profile, onOpenProfile, rateLimits, demoMode = false }: Props) {
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
      {/* Identity + quota merged into one card (v11).
          Quota is part of account status, not a separate concern. Plan A from
          the brief: identity block on top, hairline divider, then quota.
          The card itself isn't a button — top region opens the profile,
          "View details" links to Usage. */}
      <SidebarSourceSlot demoMode={demoMode} />
      <ProfileQuotaCard
        profile={profile}
        authEmail={auth?.email}
        planName={planName}
        planSubscriptionType={auth?.subscriptionType}
        rateLimits={rateLimits}
        onOpenProfile={onOpenProfile}
        onViewUsage={() => onViewChange('usage')}
        noNameLabel={t('profile.noName')}
        liveLabel={t('quota.liveBadge')}
      />



      {/* Primary nav with labels. Search is a real view now (v11 brief);
          ⌘K still opens the palette globally for quick jumping. */}
      <nav className="px-2 flex flex-col gap-1">
        {PRIMARY_NAV.map(item => {
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
      <div className="no-drag mx-1 mb-3 rounded-2xl border border-border bg-surface/35 overflow-hidden">
        <div className="px-3 pt-3 pb-2.5 grid grid-cols-2 gap-2">
          <div className="min-w-0">
            <div className="text-[13.5px] font-semibold text-text tabular-nums leading-none">{counts.sessions}</div>
            <div className="text-[9.5px] text-text-muted uppercase tracking-wider mt-1">{t('footer.sessions')}</div>
          </div>
          <div className="min-w-0">
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

function RateBar({ label, window, windowSize, className }: { label: string; window: { utilization: number | null; reset: number | null }; windowSize: string; className?: string }) {
  const { t } = useTranslation();
  const p = pct(window);
  const left = p == null ? null : Math.max(0, 100 - p);
  const resetLabel = resetInLabel(window.reset, t);
  // Bar color signals remaining headroom — same thresholds, inverted reading.
  // Low "left" = red (almost out), mid = amber, high = accent (plenty).
  const barGradient = left == null ? 'from-text-muted/30 to-text-muted/30'
    : left <= 10 ? 'from-rose-400 to-rose-600'
    : left <= 30 ? 'from-amber-400 to-orange-500'
    : 'from-accent to-purple-500';
  return (
    <div className={cn('min-w-0', className)} title={`${label} window · ${resetLabel ?? '—'} until reset · window ${windowSize}`}>
      <div className="flex items-baseline justify-between gap-2 mb-1.5 min-w-0">
        <span className="text-[12.5px] font-semibold text-text">{label}</span>
        <span className="text-[12.5px] tabular-nums text-text font-semibold">{left != null ? t('sidebar.quotaLeft', { n: left.toFixed(1) }) : '—'}</span>
      </div>
      <div className="h-[6px] bg-border rounded-full overflow-hidden">
        <div
          className={cn('h-full rounded-full bg-gradient-to-r transition-[width] duration-500', barGradient)}
          style={{ width: `${Math.max(left ?? 0, left === 0 ? 0 : 2)}%` }}
        />
      </div>
    </div>
  );
}

// AI-tool selector slot — wraps useCurrentSource so the dropdown stays
// stateless and the persisted choice lives in one place. Rendered above the
// merged profile/quota card.
function SidebarSourceSlot({ demoMode }: { demoMode: boolean }) {
  const [source, setSource] = useCurrentSource();
  return <AISourceSelector value={source} onChange={setSource} demoMode={demoMode} />;
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
  onOpenProfile,
  onViewUsage,
  noNameLabel,
  liveLabel,
}: {
  profile: Profile;
  authEmail?: string;
  planName: string | null;
  planSubscriptionType?: string;
  rateLimits?: RateLimitsState;
  onOpenProfile: () => void;
  onViewUsage: () => void;
  noNameLabel: string;
  liveLabel: string;
}) {
  const { t } = useTranslation();
  const hasQuota = !!rateLimits?.limits;
  const headlineReset = hasQuota
    ? (resetInLabel(rateLimits!.limits!.weekly.reset, t) ?? resetInLabel(rateLimits!.limits!.fiveHour.reset, t))
    : null;

  return (
    <div className="no-drag mx-1 mb-5 rounded-2xl border border-border-soft bg-surface/60 overflow-hidden">
      <button onClick={onOpenProfile} className="w-full flex items-center gap-3 px-3 pt-3 pb-3 text-left hover:bg-muted/30 transition">
        <div className={cn('w-[42px] h-[42px] rounded-[14px] bg-gradient-to-br flex items-center justify-center text-white font-bold text-[18px] shadow-[0_8px_18px_rgba(124,63,242,0.24)] flex-shrink-0', profile.avatarGradient)}>
          {profile.avatarInitial || '?'}
        </div>
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

      {hasQuota && (
        <>
          <div className="h-px bg-border-soft/70 mx-3" />
          <div className="px-3 pt-2.5 pb-3">
            <div className="flex items-center justify-between mb-1.5" title={t('quota.updated', { when: agoLabel(rateLimits!.fetchedAt, t) })}>
              <span className="text-[9.5px] uppercase tracking-wider font-semibold text-text-muted flex items-center gap-1">
                <span className="w-1 h-1 rounded-full bg-emerald-500" aria-hidden />
                {liveLabel}
              </span>
            </div>
            <RateBar label="5h" window={rateLimits!.limits!.fiveHour} windowSize="5h" />
            <RateBar label="7d" window={rateLimits!.limits!.weekly} windowSize="7d" className="mt-2" />
            <div className="flex items-center justify-between gap-2 mt-2.5">
              <span className="text-[10.5px] text-text-muted truncate">
                {headlineReset ? t('sidebar.resetsIn', { when: headlineReset }) : ''}
              </span>
              <button onClick={onViewUsage} className="text-[10.5px] font-medium text-text-muted hover:text-accent whitespace-nowrap flex items-center gap-0.5 transition">
                {t('sidebar.details')}
                <span aria-hidden>→</span>
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

