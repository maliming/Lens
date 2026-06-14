import { useMemo } from 'react';
import type { UsageSummary } from '../types';
import { fmtTokens, fmtModel, shortCwd } from '../lib/format';
import { useCurrentSource, getSource } from '../lib/sources';
import { Coins, TrendingUp, Zap, Database, Activity, Hourglass, RefreshCw, AlertCircle, Wifi, Flame, Calendar as CalendarIcon, Trophy } from 'lucide-react';
import { cn } from '../lib/utils';
import { useTranslation } from '../lib/I18nProvider';
import { pct, resetInLabel, type RateLimitsState } from '../lib/rateLimits';

type Props = {
  usage: UsageSummary | null;
  demoMode: boolean;
  rlConsent: 'pending' | 'granted' | 'denied';
  rateLimits: RateLimitsState;
  loading?: boolean;
  onOpenRlPrompt: () => void;
  onRefreshRateLimits: () => void;
};

export function UsageView({ usage, demoMode, rlConsent, rateLimits, onOpenRlPrompt, onRefreshRateLimits }: Props) {
  const { t } = useTranslation();
  const [currentSource] = useCurrentSource();
  const sourceDef = getSource(currentSource);
  const Glyph = sourceDef.Glyph;
  if (!usage) {
    return <UsageSkeleton />;
  }
  const total = usage.buckets.total;
  const totalSum = total.input + total.output + total.cacheRead + total.cacheCreate;
  const cacheHit = total.input + total.cacheRead > 0
    ? (total.cacheRead / (total.input + total.cacheRead)) * 100
    : 0;

  return (
    <main data-pane="detail" className="flex-1 min-w-0 overflow-y-auto overflow-x-hidden bg-surface border border-border rounded-2xl">
      <div className="px-8 py-8">
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
        <InsightCards usage={usage} />

        {/* 1. Activity — the only "how much have I used" view */}
        <SectionHeading icon={Hourglass}>{t('usage.activity')}</SectionHeading>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-8">
          <RollingWindow label={t('usage.today')} sub={t('usage.sinceMidnight')} highlight bucket={usage.currentWindows.today} />
          <RollingWindow label={t('usage.last3d')} sub={t('usage.rolling72h')} bucket={usage.currentWindows.last3d} />
          <RollingWindow label={t('usage.last7d')} sub={t('usage.weeklyRolling')} bucket={usage.currentWindows.last7d} />
        </div>

        {/* 1.5 Heatmap + activity stats */}
        <SectionHeading icon={Flame}>{t('usage.activityHeatmap')}</SectionHeading>
        <div className="grid grid-cols-1 lg:grid-cols-[1fr_auto] gap-5 mb-8 items-stretch">
          <ActivityHeatmap byDay={usage.byDay} />
          <ActivityStats stats={usage.stats} sessions={total.sessions} />
        </div>

        {/* 2. Daily trend */}
        <SectionHeading icon={TrendingUp}>{t('usage.dailyTrend')}</SectionHeading>
        <DailyChart byDay={usage.byDay} />

        {/* 3. Drill-down: model + project in two columns */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 mb-6">
          <div>
            <SectionHeading icon={Zap}>By model</SectionHeading>
            <div className="bg-surface border border-border-soft rounded-xl p-4 shadow-soft">
              <ModelList models={usage.byModel} />
            </div>
          </div>
          <div>
            <SectionHeading icon={Database}>{t('usage.topProjects')}</SectionHeading>
            <div className="bg-surface border border-border-soft rounded-xl p-4 shadow-soft">
              <ProjectList projects={usage.byProject.slice(0, 10)} />
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
            in {fmtTokens(total.input)} · out {fmtTokens(total.output)} · cache r {fmtTokens(total.cacheRead)} · cache w {fmtTokens(total.cacheCreate)}
          </span>
        </div>
      </div>
    </main>
  );
}

function SectionHeading({ icon: Icon, children }: { icon: any; children: React.ReactNode }) {
  return (
    <h2 className="text-[12.5px] font-semibold text-text mb-3 flex items-center gap-2 uppercase tracking-wider text-text-muted">
      <Icon className="w-3.5 h-3.5 text-accent" />
      {children}
    </h2>
  );
}

function RollingWindow({ label, sub, bucket, highlight, compact }: {
  label: string;
  sub: string;
  bucket: { input: number; output: number; cacheRead: number; cacheCreate: number; msgs: number; sessions: number; oldestTs: number | null };
  highlight?: boolean;
  compact?: boolean;
}) {
  const tokens = bucket.input + bucket.output + bucket.cacheRead + bucket.cacheCreate;
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
      {!compact && tokens > 0 && (
        <div className="mt-2.5 pt-2.5 border-t border-border-soft/60 grid grid-cols-4 gap-1.5 text-[10px] tabular-nums">
          <MiniStat label="in" value={bucket.input} color="text-blue-600 dark:text-blue-400" />
          <MiniStat label="out" value={bucket.output} color="text-pink-600 dark:text-pink-400" />
          <MiniStat label="c·r" value={bucket.cacheRead} color="text-amber-600 dark:text-amber-400" />
          <MiniStat label="c·w" value={bucket.cacheCreate} color="text-orange-600 dark:text-orange-400" />
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
  const max = Math.max(1, ...days.map(d => d.input + d.output + d.cacheRead + d.cacheCreate));
  const peakDay = days.reduce((peak, d) => {
    const t = d.input + d.output + d.cacheRead + d.cacheCreate;
    const pt = peak.input + peak.output + peak.cacheRead + peak.cacheCreate;
    return t > pt ? d : peak;
  }, days[0]);
  const peakTotal = peakDay ? peakDay.input + peakDay.output + peakDay.cacheRead + peakDay.cacheCreate : 0;

  return (
    <div className="bg-surface border border-border-soft rounded-xl p-5 mb-8 shadow-soft">
      <div className="flex items-stretch justify-between gap-1 h-32 mb-3">
        {days.map(d => {
          const t = d.input + d.output + d.cacheRead + d.cacheCreate;
          const h = Math.max(2, (t / max) * 100);
          const isPeak = d === peakDay;
          return (
            <div key={d.day} className="flex-1 group relative flex flex-col justify-end min-w-0" title={`${d.day}\n${fmtTokens(t)} tokens · ${d.sessions} sessions`}>
              <div
                className={cn(
                  'w-full rounded-t transition-all',
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

function ModelList({ models }: { models: UsageSummary['byModel'] }) {
  const filtered = models.filter(m => m.model !== 'unknown');
  const sumAll = filtered.reduce((s, m) => s + m.input + m.output + m.cacheRead + m.cacheCreate, 0);
  const max = Math.max(1, ...filtered.map(m => m.input + m.output + m.cacheRead + m.cacheCreate));

  if (!filtered.length) return <div className="text-text-muted text-[12px] py-4 text-center">No model data</div>;

  return (
    <div className="space-y-3">
      {filtered.map(m => {
        const t = m.input + m.output + m.cacheRead + m.cacheCreate;
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
              <span>cache w {fmtTokens(m.cacheCreate)}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function ProjectList({ projects }: { projects: UsageSummary['byProject'] }) {
  const max = Math.max(1, ...projects.map(p => p.input + p.output + p.cacheRead + p.cacheCreate));
  if (!projects.length) return <div className="text-text-muted text-[12px] py-4 text-center">No project data</div>;
  return (
    <div className="space-y-2">
      {projects.map(p => {
        const t = p.input + p.output + p.cacheRead + p.cacheCreate;
        const w = (t / max) * 100;
        return (
          <div key={p.project} className="grid grid-cols-[1fr_auto] gap-3 items-center min-w-0 group">
            <div className="min-w-0">
              <div className="font-mono text-[11px] truncate text-text" title={p.project}>{shortCwd(p.project)}</div>
              <div className="mt-1 h-1.5 bg-border rounded-full overflow-hidden">
                <div className="h-full bg-gradient-to-r from-accent to-purple-400 rounded-full group-hover:from-pink-500 group-hover:to-purple-500 transition-colors" style={{ width: `${w}%` }} />
              </div>
            </div>
            <div className="text-[11px] tabular-nums text-text-muted flex-shrink-0 text-right">
              <div className="text-text font-semibold">{fmtTokens(t)}</div>
              <div className="text-[10px]">{p.sessions} session{p.sessions !== 1 ? 's' : ''}</div>
            </div>
          </div>
        );
      })}
    </div>
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
          <div className="text-[12px] text-text-muted mt-0.5">Probe Anthropic's API with your Claude Code OAuth token to see real 5h / 7d remaining quota. ~1 token per probe, every 5 min.</div>
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
              <div>
                <div className="text-[10.5px] uppercase tracking-wider font-semibold text-text-muted mb-1">Headers</div>
                <pre className="bg-bg border border-border-soft rounded-md p-2 overflow-x-auto text-[11px] text-text-dim">
{JSON.stringify(rateLimits.debug.headers, null, 2)}
                </pre>
              </div>
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
  for (const d of byDay) map.set(d.day, d.input + d.output + d.cacheRead + d.cacheCreate);

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
    'bg-accent/20',
    'bg-accent/40',
    'bg-accent/65',
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
    <div className="bg-surface border border-border-soft rounded-xl p-4 shadow-soft min-w-[240px] flex flex-col justify-between gap-3 h-full">
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
    <div className="flex items-center justify-between gap-3 text-[12px]">
      <span className="flex items-center gap-1.5 text-text-muted">{icon}{label}</span>
      <span className="font-semibold text-text tabular-nums truncate" title={value}>{value}</span>
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
  const totalTokens = total.input + total.output + total.cacheRead + total.cacheCreate;
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
function InsightCards({ usage }: { usage: UsageSummary }) {
  const topProject = usage.byProject[0];
  // Most-productive day from byDay (already token-sorted? no — sort by total here).
  const topDay = useMemo(() => {
    let best: typeof usage.byDay[number] | null = null;
    let bestTotal = -1;
    for (const d of usage.byDay) {
      const t = d.input + d.output + d.cacheRead + d.cacheCreate;
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
          title={shortCwd(topProject.project)}
          metric={fmtTokens(topProject.input + topProject.output + topProject.cacheRead + topProject.cacheCreate) + ' tokens'}
          sub={`${topProject.sessions} session${topProject.sessions !== 1 ? 's' : ''}`}
          tint="from-purple-500 to-fuchsia-500"
        />
      )}
      {topDay && (
        <InsightCard
          eyebrow="Most productive day"
          title={topDay.day}
          metric={fmtTokens(topDay.input + topDay.output + topDay.cacheRead + topDay.cacheCreate) + ' tokens'}
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
              {demoMode ? 'demo data · for screenshots only' : `Updated ${rateLimits.fetchedAt ? humanAgo(Date.now() - rateLimits.fetchedAt) : '—'}`}
            </div>
          </div>
        </div>
        {!demoMode && (
          <button onClick={onRefresh} disabled={rateLimits.loading} title="Refresh now (probes 1 token)" className="p-2 rounded-md border border-border-soft hover:bg-muted text-text-muted hover:text-text disabled:opacity-50">
            <RefreshCw className={cn('w-3.5 h-3.5', rateLimits.loading && 'animate-spin')} />
          </button>
        )}
      </div>

      <div className="grid grid-cols-2 gap-4">
        <QuotaRing label={t('usage.fiveHourWindow')} window={rateLimits.limits!.fiveHour} />
        <QuotaRing label={t('usage.weeklyWindow')} window={rateLimits.limits!.weekly} />
      </div>
    </div>
  );
}

function QuotaRing({ label, window: w }: { label: string; window: { utilization: number | null; status: string | null; reset: number | null } }) {
  const { t } = useTranslation();
  const p = pct(w);
  const left = p == null ? null : Math.max(0, 100 - p);
  const resetLabel = resetInLabel(w.reset, t);
  // Color scales with remaining headroom — same thresholds as Sidebar.RateBar
  // so quota signaling reads identically across the app.
  const barGradient = left == null ? 'from-text-muted/30 to-text-muted/30'
    : left <= 10 ? 'from-rose-400 to-rose-600'
    : left <= 30 ? 'from-amber-400 to-orange-500'
    : 'from-accent to-purple-500';

  return (
    <div className="bg-surface border border-border-soft rounded-xl p-4">
      <div className="flex items-center justify-between mb-2 min-w-0">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-[10.5px] uppercase tracking-wider font-semibold text-text-muted truncate">{label}</span>
          {w.status && w.status !== 'allowed' && (
            <span className={cn('text-[9.5px] uppercase tracking-wider font-bold px-1.5 py-0.5 rounded flex-shrink-0',
              w.status === 'warning' ? 'bg-amber-100 text-amber-700' : 'bg-rose-100 text-rose-700'
            )}>{w.status}</span>
          )}
        </div>
        <div className="text-[15px] font-bold tabular-nums text-text leading-none flex-shrink-0">
          {left != null ? <>{left.toFixed(1)}<span className="text-[11px] font-semibold text-text-muted ml-0.5">% left</span></> : '—'}
        </div>
      </div>
      <div className="h-[8px] bg-border rounded-full overflow-hidden">
        <div
          className={cn('h-full rounded-full bg-gradient-to-r transition-[width] duration-500', barGradient)}
          style={{ width: `${Math.max(left ?? 0, left === 0 ? 0 : 2)}%` }}
        />
      </div>
      <div className="text-[10.5px] text-text-muted tabular-nums mt-1.5">
        {left == null ? 'No data' : resetLabel ? <>resets in {resetLabel}</> : ' '}
      </div>
    </div>
  );
}
