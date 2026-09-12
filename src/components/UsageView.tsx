import { useEffect, useMemo, useRef } from 'react';
import type { UsageSummary } from '../types';
import { fmtTokens, fmtModel, shortCwd, cleanDisplayText } from '../lib/format';
import { useCurrentSource, getSource } from '../lib/sources';
import { Coins, TrendingUp, Zap, Database, Activity, Hourglass, RefreshCw, AlertCircle, Wifi, Flame, Calendar as CalendarIcon, Trophy } from 'lucide-react';
import { cn } from '../lib/utils';
import { useTranslation } from '../lib/I18nProvider';
import { pct, resetInLabel, rateStatusKind, isWindowExpired, hasWindow, useNowTick, type RateLimitsState } from '../lib/rateLimits';
import { useDisplayPrefs, type ProjectGrouping } from '../lib/displayPrefs';

type Props = {
  usage: UsageSummary | null;
  error?: string | null;
  demoMode: boolean;
  rlConsent: 'pending' | 'granted' | 'denied';
  rateLimits: RateLimitsState;
  isActive?: boolean;
  onRetry: () => void;
  onOpenRlPrompt: () => void;
  onRefreshRateLimits: () => void;
};

// "Billed" tokens — input + output only, mirroring Anthropic's pricing model
// where cache reads (10% discount) and cache writes (1.25× multiplier) are
// surfaced separately. Claude Code's own `/stats` reports this same sum as
// "Total tokens". We keep cacheRead/cacheCreate available on `total` so the
// breakdown line + cache-hit-rate stat still render, but every "how big was
// this" summary (hero card, model bar, project bar, heatmap quartiles,
// daily chart, peak day) routes through here so users comparing against
// Claude Code see matching numbers.
//
// The runtime shape on `byDay` entries that came from `~/.claude/stats-cache.json`
// (filled in usage.cjs) parks the day's whole token count in `input` already,
// so this helper picks it up automatically — no special-case needed.
function billed(x: { input: number; output: number }): number {
  return (x.input || 0) + (x.output || 0);
}

export function UsageView({ usage, error, demoMode, rlConsent, rateLimits, isActive = true, onRetry, onOpenRlPrompt, onRefreshRateLimits }: Props) {
  const { t } = useTranslation();
  const [currentSource] = useCurrentSource();
  const sourceDef = getSource(currentSource);
  const Glyph = sourceDef.Glyph;
  const [{ projectGrouping }, setDisplayPrefs] = useDisplayPrefs();
  const hasBeenActive = useRef(isActive);
  if (isActive) hasBeenActive.current = true;
  if (!hasBeenActive.current) return null;
  if (!usage && error) {
    return (
      <main data-pane="detail" className="flex-1 min-w-0 overflow-y-auto bg-surface border border-border rounded-2xl">
        <div className="h-full min-h-[320px] flex flex-col items-center justify-center gap-3 px-8 text-center">
          <AlertCircle className="w-7 h-7 text-rose-500" />
          <div className="text-[14px] font-semibold text-text">{t('status.error', { error })}</div>
          <button onClick={onRetry} className="px-3 py-1.5 rounded-md border border-border-soft hover:bg-muted text-[12px] flex items-center gap-1.5">
            <RefreshCw className="w-3.5 h-3.5" />
            {t('common.retry')}
          </button>
        </div>
      </main>
    );
  }
  if (!usage) {
    return <UsageSkeleton />;
  }
  const total = usage.buckets.total;
  const totalSum = billed(total);
  // Whether this source bills cache writes at all. Read off the lifetime total
  // rather than branching on the provider id, so a provider that starts (or
  // stops) reporting them needs no code change — and so the rule stays out of
  // the per-source registry, which is about presentation, not data shape.
  const showCacheWrite = total.cacheCreate > 0;
  const cacheHit = total.input + total.cacheRead > 0
    ? (total.cacheRead / (total.input + total.cacheRead)) * 100
    : 0;

  return (
    <main data-pane="detail" className="flex-1 min-w-0 overflow-y-auto overflow-x-hidden bg-surface border border-border rounded-2xl">
      {/* AI-designed layout: cap the inner content at 2000px and centre it.
          Above that, ultra-wide monitors would otherwise stretch every
          chart across the entire pane and read as sparse. The cap is
          generous enough that 1500-1800px monitors still get most of
          the available width. */}
      <div className="px-8 py-8 max-w-[2000px] mx-auto">
        {/* Header */}
        <div className="flex items-center gap-3 mb-1">
          <div
            className="w-9 h-9 rounded-xl flex items-center justify-center shadow-soft"
            style={{ backgroundColor: sourceDef.accentSoft }}
          >
            <Glyph className="w-5 h-5" color={sourceDef.accent} />
          </div>
          <h1 className="text-[22px] font-bold text-text">{sourceDef.label} Token Usage</h1>
        </div>
        <p className="text-text-muted text-[12px] ml-12 mb-6">
          Aggregated from local sessions in <code className="bg-muted px-1.5 rounded text-[11px] font-mono">{sourceDef.pathHint}</code> · {total.sessions} sessions
        </p>

        {/* Hero metrics — 3-second account snapshot per v4 brief */}
        <HeroMetrics usage={usage} />

        <LiveQuotaCard
          demoMode={demoMode}
          rlConsent={rlConsent}
          rateLimits={rateLimits}
          onOpenRlPrompt={onOpenRlPrompt}
          onRefresh={onRefreshRateLimits}
        />

        {/* Insights — turn raw numbers into stories per v3 brief */}
        <InsightCards usage={usage} projectGrouping={projectGrouping} />

        {/* 1. Activity — the only "how much have I used" view */}
        <SectionHeading icon={Hourglass}>{t('usage.activity')}</SectionHeading>
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-3 mb-8">
          <RollingWindow label={t('usage.today')} sub={t('usage.sinceMidnight')} highlight bucket={usage.currentWindows.today} showCacheWrite={showCacheWrite} />
          <RollingWindow label={t('usage.last3d')} sub={t('usage.rolling72h')} bucket={usage.currentWindows.last3d} showCacheWrite={showCacheWrite} />
          <RollingWindow label={t('usage.last7d')} sub={t('usage.weeklyRolling')} bucket={usage.currentWindows.last7d} showCacheWrite={showCacheWrite} />
          <RollingWindow label={t('usage.last30d')} sub={t('usage.monthlyRolling')} bucket={usage.currentWindows.last30d} showCacheWrite={showCacheWrite} />
        </div>

        {/* 1.5 Activity cluster — "Activity Overview" three-segment design.
            Layout courtesy of a UI-design pass:
              - Below xl: single column. Heatmap → Daily Trend → Stats
                stack one per row so narrow windows stay readable.
              - xl (1280-2000): 12-col grid. Heatmap claims 8/12 (capped at
                1120px so cells stay GitHub-dense), the right rail (4/12)
                stacks Daily Trend on top + Stats below — both sized to
                comfortable widths instead of fighting Heatmap for space.
              - 2xl+ (>1536): tilt to 7/5 so Daily Trend + Stats get more
                breathing room on ultra-wide displays without making the
                Heatmap awkwardly wide. */}
        <SectionHeading icon={Flame}>{t('usage.activityHeatmap')}</SectionHeading>
        {/* Activity row — three layouts across breakpoints.
              Wide (2xl, ≥1536px): Stats | Heatmap | Daily Trend on one
              row, 3/6/3 split.
              Medium (xl, 1280-1536, Lens' minimum-window range): the
              user-named `|A B| / |A C|` layout —
                  | Stats | Heatmap   |
                  | Stats | DailyChart|
              Stats (block A) takes the narrow left column and spans
              both rows; Heatmap (B) lands top-right, DailyChart (C)
              bottom-right. The right column gets the wide space the
              heatmap + bar chart need; Stats is happy in ~280-360px.
              Break is at 2xl (not xl) because Lens' minWidth is already
              at xl — without that, every Lens window would skip the
              medium layout entirely.
              Narrow (<xl, <1280px): single column stack — only seen if
              someone overrides minWidth. */}
        <div className="
          grid gap-5 mb-8 items-stretch
          grid-cols-1
          xl:grid-cols-[minmax(0,1fr)_minmax(0,3fr)] xl:grid-rows-[auto_auto]
          2xl:grid-cols-12 2xl:grid-rows-1
        ">
          {/* Stats = block A. Tall left column on xl, leftmost on 2xl. */}
          <div className="
            min-w-0 [&>*]:h-full
            xl:row-span-2 xl:col-start-1
            2xl:row-span-1 2xl:col-start-1 2xl:col-span-3
          ">
            <ActivityStats stats={usage.stats} sessions={total.sessions} />
          </div>
          {/* Heatmap = block B. Right-top on xl, middle column on 2xl. */}
          <div className="
            min-w-0 [&>*]:h-full
            xl:col-start-2 xl:row-start-1
            2xl:col-start-4 2xl:col-span-6 2xl:row-start-1
          ">
            <ActivityHeatmap byDay={usage.byDay} />
          </div>
          {/* Daily Trend = block C. Right-bottom on xl, rightmost on 2xl. */}
          <div className="
            min-w-0 [&>*]:h-full
            xl:col-start-2 xl:row-start-2
            2xl:col-start-10 2xl:col-span-3 2xl:row-start-1
          ">
            <DailyChart byDay={usage.byDay} />
          </div>
        </div>

        {/* 3. Drill-down: model + project in two columns. Cards stretch
            to the same height even when one list is shorter than the
            other — `items-stretch` on the grid + `h-full flex-col` on the
            card wrappers makes the shorter list grow to match the taller. */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 mb-6 items-stretch">
          <div className="flex flex-col h-full">
            <SectionHeading icon={Zap}>By model</SectionHeading>
            <div className="bg-surface border border-border-soft rounded-xl p-4 shadow-soft flex-1">
              <ModelList models={usage.byModel} showCacheWrite={showCacheWrite} />
            </div>
          </div>
          <div className="flex flex-col h-full">
            <SectionHeading
              icon={Database}
              action={
                <GroupingToggle value={projectGrouping} onChange={v => setDisplayPrefs({ projectGrouping: v })} />
              }
            >
              {t('usage.topProjects')}
            </SectionHeading>
            <div className="bg-surface border border-border-soft rounded-xl p-4 shadow-soft flex-1">
              <ProjectList
                projects={projectGrouping === 'repo'
                  ? usage.byRepo.slice(0, 10).map(r => ({ ...r, key: r.repo }))
                  : usage.byProject.slice(0, 10).map(p => ({ ...p, key: p.project, dirCount: 1 }))}
              />
            </div>
          </div>
        </div>

        {/* 4. Lifetime footer — single muted line, no hero */}
        <div className="mt-8 pt-5 border-t border-border-soft text-[11.5px] text-text-muted flex flex-wrap items-center gap-x-3 gap-y-1 tabular-nums">
          <span className="font-semibold text-text">{t('usage.lifetime')}</span>
          <span>·</span>
          <span><span className="text-text">{fmtTokens(totalSum)}</span> tokens</span>
          <span>·</span>
          <span><span className="text-text">{cacheHit.toFixed(0)}%</span> cache hit</span>
          <span>·</span>
          <span><span className="text-text">{total.sessions}</span> sessions</span>
          <span>·</span>
          <span><span className="text-text">{fmtTokens(total.msgs || 0)}</span> messages</span>
          <span className="ml-auto text-[10.5px]">
            in {fmtTokens(total.input)} · out {fmtTokens(total.output)} · cache r {fmtTokens(total.cacheRead)}
            {showCacheWrite && <> · cache w {fmtTokens(total.cacheCreate)}</>}
          </span>
        </div>
      </div>
    </main>
  );
}

function SectionHeading({ icon: Icon, children, action }: { icon: any; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <h2 className="text-[12.5px] font-semibold text-text mb-3 flex items-center gap-2 uppercase tracking-wider text-text-muted">
      <Icon className="w-3.5 h-3.5 text-accent" />
      {children}
      {action && <span className="ml-auto">{action}</span>}
    </h2>
  );
}

function RollingWindow({ label, sub, bucket, highlight, compact, showCacheWrite = true }: {
  label: string;
  sub: string;
  bucket: { input: number; output: number; cacheRead: number; cacheCreate: number; msgs: number; sessions: number; oldestTs: number | null };
  highlight?: boolean;
  compact?: boolean;
  showCacheWrite?: boolean;
}) {
  const tokens = billed(bucket);
  const oldestAgo = bucket.oldestTs ? humanAgo(Date.now() - bucket.oldestTs) : null;
  return (
    <div className={cn(
      'border rounded-xl shadow-soft min-w-0',
      compact ? 'p-3' : 'p-4',
      highlight
        ? 'bg-gradient-to-br from-accent-soft to-surface border-accent/30'
        : 'bg-surface border-border-soft',
    )}>
      <div className="flex items-baseline justify-between mb-1">
        <span className={cn('uppercase tracking-wider font-semibold', compact ? 'text-[10px]' : 'text-[10.5px]', highlight ? 'text-accent' : 'text-text-muted')}>{label}</span>
        <span className="text-[10px] text-text-muted">{sub}</span>
      </div>
      <div className={cn('font-bold tabular-nums text-text leading-tight', compact ? 'text-[22px]' : 'text-[28px]')}>{fmtTokens(tokens)}</div>
      <div className="text-[11px] text-text-muted tabular-nums flex items-center gap-x-2 flex-wrap">
        <span><span className="text-text font-medium">{bucket.sessions}</span> session{bucket.sessions !== 1 ? 's' : ''}</span>
        <span>·</span>
        <span><span className="text-text font-medium">{bucket.msgs}</span> msg{bucket.msgs !== 1 ? 's' : ''}</span>
        {oldestAgo && (<><span>·</span><span>since {oldestAgo}</span></>)}
      </div>
      {/* A provider that never bills cache writes would otherwise get a column
          of permanent zeros in every window — the same reasoning that hides the
          5h quota bar when a provider reports no such window. The test is the
          data, not the provider's name: if any cache-write token has ever been
          recorded for this source, the column stays. */}
      {!compact && tokens > 0 && (
        <div className={cn('mt-2.5 pt-2.5 border-t border-border-soft/60 grid gap-1.5 text-[10px] tabular-nums',
          showCacheWrite ? 'grid-cols-4' : 'grid-cols-3')}>
          <MiniStat label="in" value={bucket.input} color="text-blue-600 dark:text-blue-400" />
          <MiniStat label="out" value={bucket.output} color="text-pink-600 dark:text-pink-400" />
          <MiniStat label="c·r" value={bucket.cacheRead} color="text-amber-600 dark:text-amber-400" />
          {showCacheWrite && <MiniStat label="c·w" value={bucket.cacheCreate} color="text-orange-600 dark:text-orange-400" />}
        </div>
      )}
    </div>
  );
}

function MiniStat({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="min-w-0">
      <div className="text-text-muted uppercase tracking-wider text-[9px]">{label}</div>
      <div className={cn('font-semibold', color)}>{fmtTokens(value)}</div>
    </div>
  );
}

function humanAgo(ms: number): string {
  if (ms < 60_000) return 'just now';
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}


function DailyChart({ byDay }: { byDay: UsageSummary['byDay'] }) {
  const days = byDay.slice(0, 30).reverse();
  const max = Math.max(1, ...days.map(billed));
  const peakDay = days.reduce((peak, d) => billed(d) > billed(peak) ? d : peak, days[0]);
  const peakTotal = peakDay ? billed(peakDay) : 0;

  return (
    // mb-8 was removed when DailyChart became a grid sibling of the
    // heatmap — the parent grid handles spacing via its own `mb-8`. Card
    // also needs to stretch vertically (`h-full flex-col`) so it lines
    // up with the heatmap's full height in the same row.
    <div className="bg-surface border border-border-soft rounded-xl p-5 shadow-soft h-full flex flex-col">
      <div className="flex items-stretch justify-between gap-1 flex-1 min-h-[8rem] mb-3">
        {days.map(d => {
          const t = billed(d);
          const h = Math.max(2, (t / max) * 100);
          const isPeak = d === peakDay;
          return (
            <div key={d.day} className="flex-1 group relative flex flex-col justify-end min-w-0" title={`${d.day}\n${fmtTokens(t)} tokens · ${d.sessions} sessions`}>
              <div
                className={cn(
                  // `transition-[height]`, never `transition-all`: `all`
                  // includes `visibility`, and a visible → hidden transition
                  // holds the element at `visible` for its whole duration
                  // before flipping. Since the bar inherits visibility from the
                  // ViewSlot, that left the bars painted for 150ms after the
                  // user navigated away — the rest of the view vanished on
                  // time and the chart ghosted behind the incoming one. The
                  // heatmap never did this because its cells only transition
                  // colors. Height is the only thing here worth animating.
                  'w-full rounded-t transition-[height]',
                  isPeak ? 'bg-gradient-to-t from-pink-500 to-purple-500' : 'bg-gradient-to-t from-accent/70 to-accent/40 group-hover:from-accent group-hover:to-purple-400'
                )}
                style={{ height: `${h}%` }}
              />
              <div className="absolute -top-7 left-1/2 -translate-x-1/2 px-2 py-1 bg-elevated border border-border rounded text-[10px] whitespace-nowrap opacity-0 group-hover:opacity-100 transition pointer-events-none shadow-pop tabular-nums z-10">
                {fmtTokens(t)}
              </div>
            </div>
          );
        })}
      </div>
      <div className="flex items-center justify-between text-[10.5px] text-text-muted tabular-nums font-mono">
        <span>{days[0]?.day}</span>
        {peakDay && <span className="text-accent">peak: {fmtTokens(peakTotal)} on {peakDay.day}</span>}
        <span>{days[days.length - 1]?.day}</span>
      </div>
    </div>
  );
}

function ModelList({ models, showCacheWrite = true }: { models: UsageSummary['byModel']; showCacheWrite?: boolean }) {
  const filtered = models.filter(m => m.model !== 'unknown');
  const sumAll = filtered.reduce((s, m) => s + billed(m), 0);
  const max = Math.max(1, ...filtered.map(billed));

  if (!filtered.length) return <div className="text-text-muted text-[12px] py-4 text-center">No model data</div>;

  return (
    <div className="space-y-3">
      {filtered.map(m => {
        const t = billed(m);
        const pct = sumAll > 0 ? (t / sumAll) * 100 : 0;
        const w = (t / max) * 100;
        return (
          <div key={m.model} className="min-w-0">
            <div className="flex items-center justify-between mb-1.5 text-[12px] gap-3 min-w-0">
              <span className="font-medium text-text truncate flex items-center gap-2 min-w-0">
                <span className={cn('w-1.5 h-1.5 rounded-full flex-shrink-0', m.model.includes('opus') ? 'bg-purple-500' : m.model.includes('sonnet') ? 'bg-pink-500' : 'bg-amber-500')} />
                <span className="truncate">{fmtModel(m.model)}</span>
              </span>
              <span className="flex items-center gap-3 flex-shrink-0 text-text-muted tabular-nums text-[11px]">
                <span className="text-text font-semibold">{fmtTokens(t)}</span>
                <span>{pct.toFixed(1)}%</span>
                <span>{m.sessions}s</span>
              </span>
            </div>
            <div className="h-2 bg-border rounded-full overflow-hidden">
              <div className={cn('h-full rounded-full', m.model.includes('opus') ? 'bg-purple-500' : m.model.includes('sonnet') ? 'bg-pink-500' : 'bg-amber-500')} style={{ width: `${w}%` }} />
            </div>
            <div className="mt-1 flex gap-3 text-[10px] text-text-muted tabular-nums">
              <span>in {fmtTokens(m.input)}</span>
              <span>out {fmtTokens(m.output)}</span>
              <span>cache r {fmtTokens(m.cacheRead)}</span>
              {showCacheWrite && <span>cache w {fmtTokens(m.cacheCreate)}</span>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// Folder rows and repo rows differ only in what the path means and whether more
// than one directory folded into it, so both arrive here already normalised to
// `{ key, dirCount, ...totals }` rather than the list branching per shape.
type ProjectRow = { key: string; dirCount: number; noRepo?: boolean; input: number; output: number; cacheRead: number; cacheCreate: number; sessions: number };

function ProjectList({ projects }: { projects: ProjectRow[] }) {
  const { t } = useTranslation();
  const max = Math.max(1, ...projects.map(billed));
  if (!projects.length) return <div className="text-text-muted text-[12px] py-4 text-center">{t('usage.noProjectData')}</div>;
  return (
    <div className="space-y-2">
      {projects.map(p => {
        const total = billed(p);
        const w = (total / max) * 100;
        return (
          <div key={p.key} className="grid grid-cols-[1fr_auto] gap-3 items-center min-w-0 group">
            <div className="min-w-0">
              {p.noRepo
                ? <div className="text-[11px] truncate text-text-muted italic" title={t('usage.noRepository.hint')}>{t('usage.noRepository')}</div>
                : <div className="font-mono text-[11px] truncate text-text" title={p.key}>{shortCwd(p.key)}</div>}
              <div className="mt-1 h-1.5 bg-border rounded-full overflow-hidden">
                <div className="h-full bg-gradient-to-r from-accent to-purple-400 rounded-full group-hover:from-pink-500 group-hover:to-purple-500 transition-colors" style={{ width: `${w}%` }} />
              </div>
            </div>
            <div className="text-[11px] tabular-nums text-text-muted flex-shrink-0 text-right">
              <div className="text-text font-semibold">{fmtTokens(total)}</div>
              {/* Only worth saying when it explains why the row is bigger than
                  any single directory the reader would recognise. */}
              <div className="text-[10px]">
                {p.dirCount > 1 || p.noRepo
                  ? `${t('usage.folderCount', { n: p.dirCount })} · ${t('list.sessions', { n: p.sessions })}`
                  : t('list.sessions', { n: p.sessions })}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function GroupingToggle({ value, onChange }: { value: ProjectGrouping; onChange: (v: ProjectGrouping) => void }) {
  const { t } = useTranslation();
  const options: Array<{ value: ProjectGrouping; label: string }> = [
    { value: 'folder', label: t('usage.groupByFolder') },
    { value: 'repo', label: t('usage.groupByRepo') },
  ];
  return (
    <span className="flex rounded-md overflow-hidden border border-border-soft normal-case tracking-normal">
      {options.map(opt => (
        <button
          key={opt.value}
          onClick={() => onChange(opt.value)}
          aria-pressed={value === opt.value}
          className={cn(
            'px-2 h-5 text-[10.5px] font-medium transition-colors',
            value === opt.value ? 'bg-accent-soft text-accent' : 'text-text-dim hover:bg-muted'
          )}
        >
          {opt.label}
        </button>
      ))}
    </span>
  );
}

function LiveQuotaCard({ demoMode, rlConsent, rateLimits, onOpenRlPrompt, onRefresh }: {
  demoMode: boolean;
  rlConsent: 'pending' | 'granted' | 'denied';
  rateLimits: RateLimitsState;
  onOpenRlPrompt: () => void;
  onRefresh: () => void;
}) {
  const { t } = useTranslation();
  const [source] = useCurrentSource();
  // In demo mode the upstream wired DEMO_RATE_LIMITS into rateLimits; render the
  // success hero directly (no CTA / loading / error paths).
  if (demoMode && rateLimits.limits) {
    return <LiveQuotaHero rateLimits={rateLimits} onRefresh={onRefresh} demoMode />;
  }
  if (demoMode) return null;

  // Codex doesn't need a consent flow — its rate limits come from a local
  // subprocess (codex app-server), no OAuth token to authorise. Skip the CTA
  // card entirely for codex; only Claude probes go through the consent gate.
  // Consent not granted yet — show a soft CTA card.
  if (rlConsent !== 'granted' && source !== 'codex') {
    return (
      <div className="mb-8 rounded-2xl border border-accent/30 bg-gradient-to-br from-accent-soft to-surface p-5 flex items-center gap-4">
        <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-accent to-purple-500 flex items-center justify-center flex-shrink-0">
          <Wifi className="w-5 h-5 text-white" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-[13.5px] font-semibold text-text">Show real subscription usage</div>
          <div className="text-[12px] text-text-muted mt-0.5">Read your Claude Code quota from Anthropic's usage endpoint to see real 5h / 7d remaining. Spends none of your quota, refreshed every 5 min.</div>
        </div>
        <button onClick={onOpenRlPrompt} className="px-3.5 py-2 rounded-md bg-accent text-white text-[12.5px] font-medium hover:opacity-90 flex-shrink-0">
          Enable
        </button>
      </div>
    );
  }

  // Granted but no data yet — loading or error.
  if (!rateLimits.limits) {
    return (
      <div className="mb-8 rounded-2xl border border-border-soft bg-surface p-5">
        <div className="flex items-center gap-3">
          {rateLimits.error ? (
            <>
              <AlertCircle className="w-4 h-4 text-rose-500 flex-shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="text-[12.5px] font-medium text-text">Live quota unavailable</div>
                <div className="text-[11.5px] text-text-muted mt-0.5">{rateLimits.error}</div>
              </div>
              <button onClick={onRefresh} disabled={rateLimits.loading} className="px-2.5 py-1.5 rounded-md border border-border-soft hover:bg-muted text-[11.5px] flex items-center gap-1.5 disabled:opacity-50">
                <RefreshCw className={cn('w-3 h-3', rateLimits.loading && 'animate-spin')} />
                Retry
              </button>
            </>
          ) : (
            <>
              <RefreshCw className="w-4 h-4 text-text-muted animate-spin flex-shrink-0" />
              <div className="text-[12.5px] text-text-muted">{source === 'codex' ? 'Probing codex app-server…' : 'Probing Anthropic API…'}</div>
            </>
          )}
        </div>
        {rateLimits.debug && (
          <details className="mt-3 text-[11px] font-mono">
            <summary className="cursor-pointer text-text-muted hover:text-text select-none">Raw API response (status {rateLimits.debug.status})</summary>
            <div className="mt-2 space-y-2">
              {rateLimits.debug.headers != null && (
                <div>
                  <div className="text-[10.5px] uppercase tracking-wider font-semibold text-text-muted mb-1">Headers</div>
                  <pre className="bg-bg border border-border-soft rounded-md p-2 overflow-x-auto text-[11px] text-text-dim">
{JSON.stringify(rateLimits.debug.headers, null, 2)}
                  </pre>
                </div>
              )}
              <div>
                <div className="text-[10.5px] uppercase tracking-wider font-semibold text-text-muted mb-1">Body</div>
                <pre className="bg-bg border border-border-soft rounded-md p-2 overflow-x-auto text-[11px] text-text-dim whitespace-pre-wrap">
{rateLimits.debug.body || '(empty)'}
                </pre>
              </div>
            </div>
          </details>
        )}
      </div>
    );
  }

  // Have data — render the hero.
  return <LiveQuotaHero rateLimits={rateLimits} onRefresh={onRefresh} />;
}

// GitHub-style heatmap: 7 rows (Mon..Sun) × N weeks (last ~52 weeks). Quartile-binned color levels.
function ActivityHeatmap({ byDay }: { byDay: UsageSummary['byDay'] }) {
  const { t } = useTranslation();
  // Build a Map<dayKey, total> + figure out the weeks grid (Mon..Sun cols).
  const map = new Map<string, number>();
  for (const d of byDay) map.set(d.day, billed(d));

  const today = new Date();
  const end = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  // Go back ~365 days, snap to Monday for column alignment.
  const start = new Date(end);
  start.setDate(end.getDate() - 365);
  while (start.getDay() !== 1) start.setDate(start.getDate() - 1); // 1 = Monday

  type Cell = { day: string; total: number; date: Date };
  const cells: Cell[][] = []; // [week][dow]
  let week: Cell[] = [];
  for (let t = start.getTime(); t <= end.getTime(); t += 86400000) {
    const d = new Date(t);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const total = map.get(key) || 0;
    week.push({ day: key, total, date: d });
    if (d.getDay() === 0) { // Sunday closes the week
      cells.push(week);
      week = [];
    }
  }
  if (week.length) cells.push(week);

  // Quartile-binned levels — same shape as GitHub.
  const nonZero = [...map.values()].filter(v => v > 0).sort((a, b) => a - b);
  const q1 = nonZero[Math.floor(nonZero.length * 0.25)] || 1;
  const q2 = nonZero[Math.floor(nonZero.length * 0.5)] || 1;
  const q3 = nonZero[Math.floor(nonZero.length * 0.75)] || 1;
  const level = (v: number) => v === 0 ? 0 : v <= q1 ? 1 : v <= q2 ? 2 : v <= q3 ? 3 : 4;

  const colors = [
    // Zero-day color was bg-muted/40 — invisible on bg-surface. Use the
    // semantic border token so the heatmap cell is always discernible from
    // empty space.
    'bg-border',
    // The lowest activity level used to be bg-accent/20, which read as
    // "almost the same as the zero cell" on light themes — the user
    // couldn't tell at a glance whether a faint cell meant "no activity"
    // or "barely any activity". Lift the floor to /35 (still clearly less
    // than /55) and widen the rest of the ramp evenly so all four
    // non-zero levels are visually distinct.
    'bg-accent/35',
    'bg-accent/55',
    'bg-accent/75',
    'bg-accent',
  ];
  const dayLabels = ['Mon', '', 'Wed', '', 'Fri', '', ''];

  // Month labels: place a label above the week whose first day is in a new month.
  const monthLabels: { col: number; text: string }[] = [];
  let lastMonth = -1;
  cells.forEach((wk, i) => {
    const first = wk[0]?.date;
    if (!first) return;
    if (first.getMonth() !== lastMonth) {
      monthLabels.push({ col: i, text: first.toLocaleString(undefined, { month: 'short' }) });
      lastMonth = first.getMonth();
    }
  });

  // Cells are flex-1 inside their week column so the whole grid stretches to fill
  // the available width — wide screens no longer leave blank space on the right.
  // Aspect-square keeps cells from going rectangular as they grow.
  return (
    <div className="bg-surface border border-border-soft rounded-xl p-4 shadow-soft min-w-0 h-full flex flex-col justify-between">
      {/* Month strip — labels positioned as % so they track cell stretch. */}
      <div className="flex pl-7 mb-1 text-[10px] text-text-muted relative h-3">
        <div className="relative flex-1">
          {monthLabels.map(m => (
            <span
              key={m.col + m.text}
              className="absolute"
              style={{ left: `${(m.col / cells.length) * 100}%` }}
            >
              {m.text}
            </span>
          ))}
        </div>
      </div>
      <div className="flex gap-[3px]">
        {/* Day-of-week labels — fixed row heights matching cell heights so
           labels line up no matter the panel width. */}
        <div className="flex flex-col gap-[3px] mr-1 text-[10px] text-text-muted shrink-0 w-6">
          {dayLabels.map((l, i) => (
            <span key={i} className="h-[14px] flex items-center leading-none tabular-nums">{l}</span>
          ))}
        </div>
        {/* Week columns — flex-1 width-wise (fills panel, no right-side gap),
           but cell HEIGHT is fixed so the heatmap stays the same height as the
           stats card next to it regardless of window width. */}
        <div className="flex gap-[3px] flex-1 min-w-0">
          {cells.map((wk, i) => (
            <div key={i} className="flex flex-col gap-[3px] flex-1 min-w-0">
              {Array.from({ length: 7 }).map((_, dow) => {
                // Reorder Sun..Sat → Mon..Sun
                const target = (dow + 1) % 7;
                const cell = wk.find(c => c.date.getDay() === target);
                if (!cell) return <div key={dow} className="h-[14px] w-full" />;
                return (
                  <div
                    key={dow}
                    title={`${cell.day} · ${cell.total ? fmtTokens(cell.total) + ' tokens' : 'no activity'}`}
                    className={cn('h-[14px] w-full rounded-sm', colors[level(cell.total)])}
                  />
                );
              })}
            </div>
          ))}
        </div>
      </div>
      <div className="flex items-center justify-end gap-1.5 mt-3 text-[10px] text-text-muted">
        <span>{t('usage.less')}</span>
        {colors.map((c, i) => (
          <span key={i} className={cn('w-[9px] h-[9px] rounded-sm', c)} />
        ))}
        <span>{t('usage.more')}</span>
      </div>
    </div>
  );
}

function ActivityStats({ stats, sessions }: { stats: UsageSummary['stats']; sessions: number }) {
  const { t } = useTranslation();
  return (
    <div className="bg-surface border border-border-soft rounded-xl p-4 shadow-soft flex flex-col gap-2.5 h-full min-w-0">
      <StatLine icon={<Trophy className="w-3.5 h-3.5 text-amber-500" />} label={t('usage.favoriteModel')} value={stats.favoriteModel ? fmtModel(stats.favoriteModel) : '—'} />
      <StatLine icon={<Database className="w-3.5 h-3.5 text-accent" />} label={t('usage.sessions')} value={sessions.toLocaleString()} />
      <StatLine icon={<CalendarIcon className="w-3.5 h-3.5 text-emerald-500" />} label={t('usage.activeDays')} value={`${stats.activeDays} / ${stats.totalDays}`} />
      <StatLine icon={<Flame className="w-3.5 h-3.5 text-orange-500" />} label={t('usage.currentStreak')} value={stats.currentStreak > 0 ? t('usage.daysCount', { n: stats.currentStreak }) : t('usage.streakNone')} />
      <StatLine icon={<Flame className="w-3.5 h-3.5 text-rose-500" />} label={t('usage.longestStreak')} value={t('usage.daysCount', { n: stats.longestStreak })} />
      <StatLine icon={<Hourglass className="w-3.5 h-3.5 text-purple-500" />} label={t('usage.longestSession')} value={fmtDuration(stats.longestSessionMs)} />
      <StatLine icon={<CalendarIcon className="w-3.5 h-3.5 text-sky-500" />} label={t('usage.mostActiveDay')} value={stats.mostActiveDay || '—'} />
    </div>
  );
}

function StatLine({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 text-[12px] min-w-0">
      {/* Label can truncate; the value (right side) takes priority because
          it's the data the user actually wants to read. flex-shrink-0 on
          the value pins it; min-w-0 + truncate on the label lets it
          shorten gracefully when the column is narrow. */}
      <span className="flex items-center gap-1.5 text-text-muted min-w-0 truncate" title={label}>{icon}<span className="truncate">{label}</span></span>
      <span className="font-semibold text-text tabular-nums truncate flex-shrink-0" title={value}>{value}</span>
    </div>
  );
}

function fmtDuration(ms: number): string {
  if (!ms || ms < 60_000) return '—';
  const min = Math.floor(ms / 60_000);
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h < 24) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  const d = Math.floor(h / 24);
  const rh = h % 24;
  return rh > 0 ? `${d}d ${rh}h` : `${d}d`;
}

// Hero metrics — 3 oversized headline numbers per v4 brief. Account understandable in 3s.
function UsageSkeleton() {
  return (
    <main data-pane="detail" className="flex-1 min-w-0 overflow-y-auto bg-surface border border-border rounded-2xl animate-fade-in">
      <div className="px-8 py-8 space-y-6">
        <div className="flex items-center gap-3 mb-1">
          <div className="w-9 h-9 rounded-xl bg-muted/60 animate-pulse-soft" />
          <div className="h-6 w-32 rounded bg-muted/60 animate-pulse-soft" />
        </div>
        <div className="grid grid-cols-3 gap-4">
          {Array.from({ length: 3 }).map((_, i) => (
            <div
              key={i}
              className="rounded-2xl border border-border-soft bg-surface px-5 py-4 opacity-0 animate-fade-up"
              style={{ animationDelay: `${i * 80}ms`, animationFillMode: 'forwards' }}
            >
              <div className="h-2.5 w-16 rounded bg-muted/50 animate-pulse-soft mb-3" />
              <div className="h-7 w-24 rounded bg-muted/70 animate-pulse-soft mb-2" />
              <div className="h-2.5 w-20 rounded bg-muted/40 animate-pulse-soft" />
            </div>
          ))}
        </div>
        <div className="grid grid-cols-3 gap-4">
          {Array.from({ length: 3 }).map((_, i) => (
            <div
              key={i}
              className="rounded-2xl border border-border-soft bg-surface px-5 py-4 opacity-0 animate-fade-up h-[130px]"
              style={{ animationDelay: `${(i + 3) * 80}ms`, animationFillMode: 'forwards' }}
            >
              <div className="h-2.5 w-14 rounded bg-muted/50 animate-pulse-soft mb-3" />
              <div className="h-4 w-28 rounded bg-muted/70 animate-pulse-soft mb-1.5" />
              <div className="h-3 w-32 rounded bg-muted/40 animate-pulse-soft" />
            </div>
          ))}
        </div>
        <div className="rounded-2xl border border-border-soft bg-surface px-5 py-5 opacity-0 animate-fade-up" style={{ animationDelay: '480ms', animationFillMode: 'forwards' }}>
          <div className="h-3 w-24 rounded bg-muted/50 animate-pulse-soft mb-4" />
          <div className="h-24 rounded bg-muted/40 animate-pulse-soft" />
        </div>
      </div>
    </main>
  );
}

function HeroMetrics({ usage }: { usage: UsageSummary }) {
  const total = usage.buckets.total;
  const totalTokens = billed(total);
  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-8">
      <HeroMetric eyebrow="Total tokens" value={fmtTokens(totalTokens)} sub="all-time across all sessions" />
      <HeroMetric eyebrow="Active days" value={String(usage.stats.activeDays)} sub={`of ${usage.stats.totalDays} days indexed`} />
      <HeroMetric eyebrow="Total sessions" value={String(total.sessions)} sub={`${fmtTokens(total.msgs || 0)} messages exchanged`} />
    </div>
  );
}

function HeroMetric({ eyebrow, value, sub }: { eyebrow: string; value: string; sub: string }) {
  return (
    <div className="bg-surface border border-border-soft rounded-xl p-5">
      <div className="text-[10.5px] uppercase tracking-wider font-semibold text-text-muted mb-2">{eyebrow}</div>
      <div className="text-[36px] font-bold tabular-nums leading-none text-text">{value}</div>
      <div className="text-[11px] text-text-muted mt-2">{sub}</div>
    </div>
  );
}

// Insight cards: turn aggregate stats into 3 narrative cards at the top of
// Usage. Per v3 brief: "Transform raw numbers into meaningful stories."
function InsightCards({ usage, projectGrouping }: { usage: UsageSummary; projectGrouping: ProjectGrouping }) {
  // Follows the same toggle as the list below it. Leaving this on folders while
  // the list showed repos let the two disagree about which project is biggest —
  // and the hero is the one people read.
  const topRepo = usage.byRepo.find(r => !r.noRepo);
  const topProject = projectGrouping === 'repo'
    ? (topRepo ? { path: topRepo.repo, ...topRepo } : undefined)
    : (usage.byProject[0] ? { path: usage.byProject[0].project, ...usage.byProject[0] } : undefined);
  // Most-productive day from byDay (already token-sorted? no — sort by total here).
  const topDay = useMemo(() => {
    let best: typeof usage.byDay[number] | null = null;
    let bestTotal = -1;
    for (const d of usage.byDay) {
      const t = billed(d);
      if (t > bestTotal) { bestTotal = t; best = d; }
    }
    return best;
  }, [usage.byDay]);

  if (!topProject && !topDay && !usage.stats.favoriteModel) return null;

  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-8">
      {topProject && (
        <InsightCard
          eyebrow="Favorite project"
          title={shortCwd(topProject.path)}
          metric={fmtTokens(billed(topProject)) + ' tokens'}
          sub={`${topProject.sessions} session${topProject.sessions !== 1 ? 's' : ''}`}
          tint="from-purple-500 to-fuchsia-500"
        />
      )}
      {topDay && (
        <InsightCard
          eyebrow="Most productive day"
          title={topDay.day}
          metric={fmtTokens(billed(topDay)) + ' tokens'}
          sub={`${topDay.sessions} session${topDay.sessions !== 1 ? 's' : ''}`}
          tint="from-emerald-500 to-teal-500"
        />
      )}
      {usage.stats.favoriteModel && (
        <InsightCard
          eyebrow="Favorite model"
          title={fmtModel(usage.stats.favoriteModel)}
          metric={`${usage.stats.activeDays} / ${usage.stats.totalDays} active days`}
          sub={`Current streak ${usage.stats.currentStreak}d · longest ${usage.stats.longestStreak}d`}
          tint="from-orange-500 to-rose-500"
        />
      )}
    </div>
  );
}

function InsightCard({ eyebrow, title, metric, sub, tint }: { eyebrow: string; title: string; metric: string; sub: string; tint: string }) {
  return (
    <div className="relative bg-surface border border-border-soft rounded-xl p-4 overflow-hidden">
      <span className={cn('absolute left-0 top-0 bottom-0 w-1 bg-gradient-to-b', tint)} />
      <div className="ml-2">
        <div className="text-[10.5px] uppercase tracking-wider font-semibold text-text-muted mb-1.5">{eyebrow}</div>
        <div className="text-[14.5px] font-bold text-text truncate" title={title}>{title}</div>
        <div className="text-[12px] text-text mt-1 tabular-nums">{metric}</div>
        <div className="text-[10.5px] text-text-muted mt-0.5">{sub}</div>
      </div>
    </div>
  );
}

function LiveQuotaHero({ rateLimits, onRefresh, demoMode }: { rateLimits: RateLimitsState; onRefresh: () => void; demoMode?: boolean }) {
  const { t } = useTranslation();
  // The "Updated …" line below reads the clock at render time, and a tick in
  // the child rings does not re-render this parent — it would sit frozen.
  useNowTick();
  return (
    <div className="mb-8 rounded-2xl border border-accent/20 bg-gradient-to-br from-accent-soft/50 to-surface p-5">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-accent to-purple-500 flex items-center justify-center">
            <Activity className="w-4 h-4 text-white" />
          </div>
          <div>
            <h2 className="text-[14px] font-semibold text-text leading-tight">{t('usage.liveSubscriptionQuota')}</h2>
            <div className="text-[10.5px] text-text-muted">
              {demoMode
                ? 'demo data · for screenshots only'
                /* Without the error branch a probe that keeps failing leaves the
                   last good numbers on screen indefinitely, dated but unqualified. */
                : `${rateLimits.error ? `${t('usage.status.updateFailed')} · ` : ''}Updated ${rateLimits.fetchedAt ? humanAgo(Date.now() - rateLimits.fetchedAt) : '—'}`}
            </div>
          </div>
        </div>
        {!demoMode && (
          <button onClick={onRefresh} disabled={rateLimits.loading} title="Refresh now" className="p-2 rounded-md border border-border-soft hover:bg-muted text-text-muted hover:text-text disabled:opacity-50">
            <RefreshCw className={cn('w-3.5 h-3.5', rateLimits.loading && 'animate-spin')} />
          </button>
        )}
      </div>

      {/* Mirrors claude.ai's usage panel: "Current session" alone, then a
          "Weekly limits" section holding "All models" plus one row per
          model-scoped window under the API's own display name. */}
      {hasWindow(rateLimits.limits!.fiveHour) && (
        <div className="grid grid-cols-1 gap-4 mb-5">
          <QuotaRing label={t('usage.fiveHourWindow')} window={rateLimits.limits!.fiveHour} />
        </div>
      )}
      <div className="mb-3 text-[12.5px] font-semibold text-text">{t('usage.weeklyLimits')}</div>
      <div className="grid grid-cols-1 gap-4">
        <QuotaRing label={t('usage.allModels')} window={rateLimits.limits!.weekly} />
        {(rateLimits.limits!.modelWindows ?? []).map(w => (
          <QuotaRing key={w.name} label={cleanDisplayText(w.name)} window={w} />
        ))}
      </div>
    </div>
  );
}

function QuotaRing({ label, window: w }: { label: string; window: { utilization: number | null; status: string | null; reset: number | null } }) {
  const { t } = useTranslation();
  useNowTick();
  const p = pct(w);
  const left = p == null ? null : Math.max(0, 100 - p);
  // A rolled-over window keeps its old utilization until the next probe lands;
  // suppress the verdict badge rather than assert a limit that no longer holds.
  const expired = isWindowExpired(w);
  const statusKind = expired ? 'ok' : rateStatusKind(w.status);
  const resetLabel = resetInLabel(w.reset, t);
  // Color scales with remaining headroom — same thresholds as Sidebar.RateBar
  // so quota signaling reads identically across the app.
  // A rolled-over window's old fill is not just stale, it is wrong: utilization
  // restarts near zero after the reset, so a red 3%-left bar would be the
  // opposite of the truth. Drain it to a neutral track until fresh data lands.
  const barGradient = left == null || expired ? 'from-text-muted/30 to-text-muted/30'
    : left <= 10 ? 'from-rose-400 to-rose-600'
    : left <= 30 ? 'from-amber-400 to-orange-500'
    : 'from-accent to-purple-500';
  // The fill measures what is LEFT, so the scarcer the quota the thinner the
  // bar: the state that most needs attention carries the least ink, and at 0%
  // left there is nothing to colour at all. Move the signal onto the track.
  // Threshold matches the readout's own rounding — anything that prints
  // "0.0% left" gets the depleted hatch, so the number and the bar never
  // disagree about whether the window is spent.
  const depleted = left != null && !expired && left < 0.05;
  const trackClass = left == null || expired ? 'bg-border'
    : depleted ? 'quota-track-depleted'
    : left <= 10 ? 'bg-rose-500/30'
    : left <= 30 ? 'bg-amber-500/25'
    : 'bg-border';
  // Mirror Sidebar.RateBar's Web Animations approach so the bar in the
  // Usage hero animates on mount and on source flip (Claude ↔ Codex)
  // instead of snapping. Driving width via `el.animate(...)` sidesteps
  // React 18's automatic batching, which was collapsing the
  // "render at 0% → setState to target" pair into a single paint with
  // nothing to interpolate.
  // The 2% floor keeps a nearly-empty bar visible, but it must not apply once
  // the window is spent: a sliver of fill under a LIMIT REACHED badge reads as
  // "a little left". Depleted draws no fill at all and lets the hatch speak.
  const targetWidth = left == null || expired || depleted ? 0 : Math.max(left, 2);
  const barRef = useRef<HTMLDivElement | null>(null);
  const prevWidthRef = useRef(0);
  useEffect(() => {
    const el = barRef.current;
    if (!el) return;
    const from = prevWidthRef.current;
    prevWidthRef.current = targetWidth;
    if (Math.abs(from - targetWidth) < 0.01) {
      el.style.width = `${targetWidth}%`;
      return;
    }
    el.style.width = `${targetWidth}%`;
    try {
      el.animate(
        [{ width: `${from}%` }, { width: `${targetWidth}%` }],
        { duration: 700, easing: 'ease-out', fill: 'forwards' },
      );
    } catch {}
  }, [targetWidth]);

  return (
    <div className="bg-surface border border-border-soft rounded-xl p-4">
      <div className="flex items-center justify-between mb-2 min-w-0">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-[10.5px] uppercase tracking-wider font-semibold text-text-muted truncate">{label}</span>
          {statusKind !== 'ok' && (
            <span className={cn('text-[9.5px] uppercase tracking-wider font-bold px-1.5 py-0.5 rounded flex-shrink-0',
              statusKind === 'warning' ? 'bg-amber-100 text-amber-700' : 'bg-rose-100 text-rose-700'
            )}>{statusKind === 'warning' ? t('usage.status.warning') : t('usage.status.limitReached')}</span>
          )}
        </div>
        <div className="text-[15px] font-bold tabular-nums text-text leading-none flex-shrink-0">
          {left != null && !expired ? <>{left.toFixed(1)}<span className="text-[11px] font-semibold text-text-muted ml-0.5">% left</span></> : '—'}
        </div>
      </div>
      <div className={cn('h-[8px] rounded-full overflow-hidden', trackClass)}>
        <div
          ref={barRef}
          className={cn('h-full rounded-full bg-gradient-to-r will-change-[width]', barGradient)}
          style={{ width: '0%' }}
        />
      </div>
      <div className="text-[10.5px] text-text-muted tabular-nums mt-1.5">
        {expired ? t('usage.status.refreshing') : left == null ? 'No data' : resetLabel ? <>resets in {resetLabel}</> : ' '}
      </div>
    </div>
  );
}
