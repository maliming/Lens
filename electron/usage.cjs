// Usage aggregation — turns the in-memory session list into the buckets the
// Usage view consumes.
//
// Produces (per source):
//   buckets      — total / last 1d / 7d / 30d / this calendar month
//   currentWindows — fine-grained rolling windows (5h / today / 24h / 3d / 7d)
//                    computed from exact recent `tokenEvents`. Events older
//                    than 30 days are stored as daily `tokenDays` aggregates,
//                    keeping historical heatmaps accurate with bounded growth.
//   byModel      — per-model tokens + session count
//   byProject    — top 20 projects by total tokens
//   byDay        — newest first, up to 400 days (covers ~52-week heatmap)
//   stats        — streaks / active days / longest session / favorite model
//
// Designed to be called per-source — the renderer flips the active source
// and refetches. Composite session ids (`<source>:<id>`) are used in
// rolling-window session sets so a future all-sources Usage view can't
// accidentally merge Claude / Codex sessions that share a UUID.
//
// `listSessions` is injected via the factory so this module doesn't have to
// know how main.cjs caches the session list — pass `({ noRefresh: true })`
// to avoid kicking off another scan from inside the usage path (the renderer
// already refetches usage after a `sessions:updated` push; doubling up made
// the scan loop indefinitely under heavy use).

const { isUsableModel } = require('./parsers/shared.cjs');

// `getRepoIndex` is a getter, not the index itself: createUsage runs at module
// load, and the index can't exist until `app.whenReady` has produced a
// userData dir to persist into.
function createUsage({ listSessions, readClaudeStatsCache, getRepoIndex }) {
  async function usageSummary(source) {
    // Pass noRefresh: a fresh sessions push will trigger the renderer to call
    // getUsage again. If usageSummary itself starts another scan, that scan
    // pushes again, the renderer reacts again — sustained loop that hammers
    // disk and grows memory until OOM. Just read the latest cached snapshot.
    const all = await listSessions({ noRefresh: true });
    // Filter by AI source so Usage shows just the current tool's stats.
    const sessions = source ? all.filter(s => s.source === source) : all;
    const now = Date.now();
    const HOUR = 3600 * 1000;
    const DAY = 86400 * 1000;

    const buckets = {
      total: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, sessions: 0, msgs: 0 },
      last1d: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, sessions: 0 },
      last7d: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, sessions: 0 },
      last30d: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, sessions: 0 },
      thisMonth: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, sessions: 0 },
    };

    // Per-message rolling windows (accurate via tokenEvents).
    // `today` is calendar-aligned (since local midnight); the rest are rolling N hours/days.
    const tnow = new Date();
    const todayStartTs = new Date(tnow.getFullYear(), tnow.getMonth(), tnow.getDate()).getTime();
    const mkBucket = () => ({ input: 0, output: 0, cacheRead: 0, cacheCreate: 0, msgs: 0, sessions: new Set(), oldestTs: null });
    const rolling = {
      last5h: mkBucket(),
      today: mkBucket(),
      last24h: mkBucket(),
      last3d: mkBucket(),
      last7d: mkBucket(),
      last30d: mkBucket(),
    };
    const cutoff5h = now - 5 * HOUR;
    const cutoff24h = now - 24 * HOUR;
    const cutoff3d = now - 3 * DAY;
    const cutoff7d = now - 7 * DAY;
    const cutoff30d = now - 30 * DAY;

    const add = (b, ev, sid) => {
      b.input += ev.i; b.output += ev.o; b.cacheRead += ev.cr; b.cacheCreate += ev.cc;
      b.msgs++; b.sessions.add(sid);
      if (!b.oldestTs || ev.ts < b.oldestTs) b.oldestTs = ev.ts;
    };

    for (const s of sessions) {
      for (const ev of (s.tokenEvents || [])) {
        // Same clock-skew clamp as `lastTs` below: never let a future ts land
        // in a recent bucket; just treat it as "now" instead.
        const ts = Math.min(ev.ts, now);
        if (ts > cutoff30d) {
          const evc = ts === ev.ts ? ev : { ...ev, ts };
          // Composite key so a future all-sources Usage view can't accidentally
          // merge Claude / Codex sessions that share a UUID. usageSummary is
          // currently per-source but defending here keeps the invariant intact.
          const sid = `${s.source}:${s.id}`;
          add(rolling.last30d, evc, sid);
          if (ts > cutoff7d) {
            add(rolling.last7d, evc, sid);
            if (ts > cutoff3d) add(rolling.last3d, evc, sid);
            if (ts > cutoff24h) add(rolling.last24h, evc, sid);
            if (ts >= todayStartTs) add(rolling.today, evc, sid);
            if (ts > cutoff5h) add(rolling.last5h, evc, sid);
          }
        }
      }
    }
    const flatten = (b) => ({ ...b, sessions: b.sessions.size });
    const currentWindows = {
      last5h: flatten(rolling.last5h),
      today: flatten(rolling.today),
      last24h: flatten(rolling.last24h),
      last3d: flatten(rolling.last3d),
      last7d: flatten(rolling.last7d),
      last30d: flatten(rolling.last30d),
    };

    const byModel = new Map();
    const byProject = new Map();
    // Sessions that named their own repository, keyed by that name.
    const repoDirect = new Map();
    // Sessions that didn't, parked under their working directory until the
    // filesystem can say what repository it belongs to.
    const repoByDir = new Map();
    const byDay = new Map();

    const tm = new Date();
    const monthStart = new Date(tm.getFullYear(), tm.getMonth(), 1).getTime();

    for (const s of sessions) {
      // Pick a usable timestamp: lastTs preferred, mtime fallback, future-clamped
      // to now. Mirrors the renderer's sessionTimestamp() helper so server-side
      // aggregates and client-side filters agree on what counts as recent.
      let lastTs = 0;
      if (s.lastTs) {
        const t = new Date(s.lastTs).getTime();
        if (Number.isFinite(t) && t > 0) lastTs = t;
      }
      if (!lastTs && s.mtime && Number.isFinite(s.mtime)) lastTs = s.mtime;
      if (lastTs > now) lastTs = now;
      const inT = s.tokensIn || 0;
      const outT = s.tokensOut || 0;
      const cr = s.tokensCacheRead || 0;
      const cc = s.tokensCacheCreate || 0;

      buckets.total.input += inT;
      buckets.total.output += outT;
      buckets.total.cacheRead += cr;
      buckets.total.cacheCreate += cc;
      buckets.total.sessions++;
      buckets.total.msgs += (s.userMsgs || 0) + (s.assistantMsgs || 0);

      const ago = now - lastTs;
      if (ago <= DAY) { buckets.last1d.input += inT; buckets.last1d.output += outT; buckets.last1d.cacheRead += cr; buckets.last1d.cacheCreate += cc; buckets.last1d.sessions++; }
      if (ago <= DAY * 7) { buckets.last7d.input += inT; buckets.last7d.output += outT; buckets.last7d.cacheRead += cr; buckets.last7d.cacheCreate += cc; buckets.last7d.sessions++; }
      if (ago <= DAY * 30) { buckets.last30d.input += inT; buckets.last30d.output += outT; buckets.last30d.cacheRead += cr; buckets.last30d.cacheCreate += cc; buckets.last30d.sessions++; }
      if (lastTs >= monthStart) { buckets.thisMonth.input += inT; buckets.thisMonth.output += outT; buckets.thisMonth.cacheRead += cr; buckets.thisMonth.cacheCreate += cc; buckets.thisMonth.sessions++; }

      // Cached sessions from before the parser cleanup may still carry
      // "synthetic" / "<synthetic>" (Claude) or just a provider name like
      // "openai" (Codex pre-turn_context). Coerce both to "unknown" so the
      // by-model breakdown isn't polluted until the next fresh re-parse.
      const model = isUsableModel(s.model) ? s.model : 'unknown';
      const cur = byModel.get(model) || { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, sessions: 0 };
      cur.input += inT; cur.output += outT; cur.cacheRead += cr; cur.cacheCreate += cc; cur.sessions++;
      byModel.set(model, cur);

      const proj = s.decodedCwd || s.projectDir;
      const pcur = byProject.get(proj) || { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, sessions: 0 };
      pcur.input += inT; pcur.output += outT; pcur.cacheRead += cr; pcur.cacheCreate += cc; pcur.sessions++;
      byProject.set(proj, pcur);

      // Repository grouping accumulates per session, not by re-folding the
      // per-directory rows: a session carries its own repository identity, and
      // one directory can legitimately host sessions from several (`~` is the
      // extreme case). Sessions the CLI stamped with a repository are keyed on
      // it straight away; the rest are parked under their directory for the
      // filesystem pass after the loop.
      const repoBucket = s.repoUrl ? repoDirect : repoByDir;
      const repoKey = s.repoUrl || proj;
      const rcur = repoBucket.get(repoKey) || { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, sessions: 0, dirs: new Set() };
      rcur.input += inT; rcur.output += outT; rcur.cacheRead += cr; rcur.cacheCreate += cc; rcur.sessions++;
      if (proj) rcur.dirs.add(proj);
      repoBucket.set(repoKey, rcur);

      // byDay (heatmap + calendar): scatter tokens across the days they
      // actually happened, not the session-end day. Previously we lumped a
      // session's entire token sum into the lastTs bucket — for a session
      // that ran across multiple days (or one that pulled in subagent
      // activity from weeks earlier, post-Claude Code 2.0), the heatmap
      // would show nothing on the real active days and one fat blob on
      // the last day. Use tokenEvents so each timestamp lands in its own
      // calendar bucket. Sessions count still counts once per session per
      // unique day touched, so "Active days" / streaks stay meaningful.
      const events = s.tokenEvents || [];
      const compactDays = s.tokenDays || [];
      if (events.length || compactDays.length) {
        const daysTouched = new Set();
        for (const usageDay of compactDays) {
          if (!usageDay || typeof usageDay.day !== 'string') continue;
          const key = usageDay.day;
          const dcur = byDay.get(key) || { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, sessions: 0 };
          dcur.input += usageDay.i || 0;
          dcur.output += usageDay.o || 0;
          dcur.cacheRead += usageDay.cr || 0;
          dcur.cacheCreate += usageDay.cc || 0;
          if (!daysTouched.has(key)) { dcur.sessions++; daysTouched.add(key); }
          byDay.set(key, dcur);
        }
        for (const ev of events) {
          const ts = Math.min(ev.ts, now);
          const d = new Date(ts);
          const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
          const dcur = byDay.get(key) || { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, sessions: 0 };
          dcur.input += ev.i; dcur.output += ev.o; dcur.cacheRead += ev.cr; dcur.cacheCreate += ev.cc;
          if (!daysTouched.has(key)) { dcur.sessions++; daysTouched.add(key); }
          byDay.set(key, dcur);
        }
      } else if (lastTs) {
        // Fallback for sessions without tokenEvents (older cache entries,
        // or sessions that recorded no assistant `usage` block). Keep the
        // old session-end attribution — better than dropping the day.
        const d = new Date(lastTs);
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        const dcur = byDay.get(key) || { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, sessions: 0 };
        dcur.input += inT; dcur.output += outT; dcur.cacheRead += cr; dcur.cacheCreate += cc; dcur.sessions++;
        byDay.set(key, dcur);
      }
    }

    // Augment Claude byDay + byModel with `~/.claude/stats-cache.json`.
    // Claude Code 2.0+ aggregates older conversations into that file and
    // (sometimes) prunes the underlying JSONLs. So our JSONL-derived
    // byDay typically only reaches back 1–2 months — even though the user
    // has been active for far longer. The CLI's own `/stats` reads
    // stats-cache.json, which is why its numbers look much fuller than
    // ours. We trust JSONL data wherever we have it (it carries full
    // input/output/cache breakdowns + per-event timestamps); we only fill
    // days the JSONL parse didn't reach. Same for the by-model bar.
    if (source === 'claude' && readClaudeStatsCache) {
      try {
        const stats = await readClaudeStatsCache();
        if (stats) {
          // Index dailyModelTokens by date so we can attach token totals
          // to each day in dailyActivity. dailyModelTokens is a flat
          // number per model per day — no input/output/cache breakdown
          // is available from this source. We park the whole bucket in
          // `input` so heatmap colouring + day totals stay correct;
          // breakdown rings (cache hit rate etc.) on those rows will
          // read as 100% input but that's preferable to the day being
          // invisible.
          const tokensByDay = new Map();
          for (const dt of (stats.dailyModelTokens || [])) {
            const total = Object.values(dt.tokensByModel || {})
              .reduce((s, v) => s + (typeof v === 'number' && Number.isFinite(v) ? v : 0), 0);
            tokensByDay.set(dt.date, total);
          }
          let synthesised = 0;
          for (const da of (stats.dailyActivity || [])) {
            if (!da || typeof da.date !== 'string') continue;
            if (byDay.has(da.date)) continue; // JSONL covered this day → keep its richer data
            const tokens = tokensByDay.get(da.date) || 0;
            const sessionCount = (typeof da.sessionCount === 'number' && da.sessionCount > 0) ? da.sessionCount : 1;
            byDay.set(da.date, {
              input: tokens, output: 0, cacheRead: 0, cacheCreate: 0,
              sessions: sessionCount,
            });
            synthesised++;
          }
          if (synthesised > 0) {
            console.log(`[usage] augmented ${synthesised} days from ~/.claude/stats-cache.json`);
          }
          // byModel: stats-cache holds an authoritative grand-total
          // (modelUsage) per model that includes activity older than
          // anything we have JSONL for. Replace per-model entries when
          // the cached aggregate is larger than what we computed — that
          // way the by-model bar chart matches what `/stats` shows
          // instead of under-reporting models the user no longer uses
          // or whose old sessions have been pruned.
          if (stats.modelUsage && typeof stats.modelUsage === 'object') {
            for (const [model, u] of Object.entries(stats.modelUsage)) {
              if (!u || typeof u !== 'object') continue;
              const cur = byModel.get(model) || { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, sessions: 0 };
              // Only overwrite if stats-cache reports more activity.
              // Sums match within a few percent on overlapping ranges;
              // larger means we're missing JSONL coverage for that model.
              const curTotal = cur.input + cur.output + cur.cacheRead + cur.cacheCreate;
              const cacheTotal = (u.inputTokens || 0) + (u.outputTokens || 0)
                + (u.cacheReadInputTokens || 0) + (u.cacheCreationInputTokens || 0);
              if (cacheTotal > curTotal) {
                byModel.set(model, {
                  input: u.inputTokens || 0,
                  output: u.outputTokens || 0,
                  cacheRead: u.cacheReadInputTokens || 0,
                  cacheCreate: u.cacheCreationInputTokens || 0,
                  sessions: cur.sessions, // keep our session count — stats-cache only has model-totals
                });
              }
            }
          }
          // Mirror the byModel augmentation into `buckets.total` so the
          // hero "Total tokens" card matches Claude Code's `/stats` rather
          // than under-reporting by whatever the JSONL parse couldn't
          // reach. Without this, the hero showed JSONL-only tokens (e.g.
          // 97M) while the by-model bars showed the full grand total
          // (e.g. 128M from stats-cache). The two now stay in sync. We
          // re-derive bucket totals from the (post-augmentation) byModel
          // since that's the freshest aggregate and ensures consistency
          // with the chart below it.
          let mInput = 0, mOutput = 0, mCacheR = 0, mCacheC = 0;
          for (const [, m] of byModel.entries()) {
            mInput += m.input; mOutput += m.output; mCacheR += m.cacheRead; mCacheC += m.cacheCreate;
          }
          if (mInput + mOutput + mCacheR + mCacheC > buckets.total.input + buckets.total.output + buckets.total.cacheRead + buckets.total.cacheCreate) {
            buckets.total.input = mInput;
            buckets.total.output = mOutput;
            buckets.total.cacheRead = mCacheR;
            buckets.total.cacheCreate = mCacheC;
          }
          // Total session count: stats-cache knows about historic sessions
          // we've lost the JSONLs for. Pull the higher number so the
          // "Total sessions" hero matches /stats too.
          if (typeof stats.totalSessions === 'number' && stats.totalSessions > buckets.total.sessions) {
            buckets.total.sessions = stats.totalSessions;
          }
          if (typeof stats.totalMessages === 'number' && stats.totalMessages > buckets.total.msgs) {
            buckets.total.msgs = stats.totalMessages;
          }
        }
      } catch (e) { console.log('[usage] stats-cache augmentation failed:', e.message); }
    }

    // Build a sorted full byDay list (newest first) so we can derive streaks +
    // activity stats from it without re-walking sessions.
    const byDayAll = [...byDay.entries()]
      .map(([k, v]) => ({ day: k, ...v }))
      .sort((a, b) => b.day.localeCompare(a.day));

    const stats = computeStats(sessions, byDayAll, byModel);

    // Same tokens, grouped by repository instead of by directory. Worth its own
    // list rather than a renderer-side regroup because the folder list is
    // already capped at 20: folding the top 20 folders would miss a repo whose
    // worktrees each rank 21st but together rank first — exactly the case this
    // is for. Fold everything, then cap.
    const byRepo = await groupByRepo(repoDirect, repoByDir, getRepoIndex && getRepoIndex());

    const billedSort = (a, b) => (b.input + b.output + b.cacheRead) - (a.input + a.output + a.cacheRead);

    return {
      buckets,
      currentWindows,
      byModel: [...byModel.entries()].map(([k, v]) => ({ model: k, ...v })).sort((a, b) => (b.input + b.output) - (a.input + a.output)),
      byProject: [...byProject.entries()]
        .map(([k, v]) => ({ project: k, input: v.input, output: v.output, cacheRead: v.cacheRead, cacheCreate: v.cacheCreate, sessions: v.sessions }))
        .sort(billedSort).slice(0, 20),
      byRepo: byRepo.sort(billedSort).slice(0, 20),
      // Newest first; keep up to 400 days so the heatmap can show ~52 weeks.
      byDay: byDayAll.slice(0, 400),
      stats,
    };
  }

  return { usageSummary };
}

// "git@github.com:volosoft/taskever.git" / "https://github.com/foo/bar" →
// "volosoft/taskever". The row is about a project; the transport, host and
// .git suffix are identical noise on every one of them. Anything that doesn't
// parse is shown as-is rather than mangled.
function repoLabel(url) {
  const m = String(url).match(/^(?:[a-z+]+:\/\/)?(?:[^@\s]+@)?[^/:\s]+[:/](.+?)(?:\.git)?\/?$/i);
  return m ? m[1] : String(url);
}

// Merges the two accumulations into one list of repositories.
//
// `direct` is keyed by the repository the CLI recorded inside the session
// itself — authoritative, and the only key that still resolves once the
// directory it ran in has been deleted. Codex writes it into session_meta;
// Claude records no remote at all, so every Claude session lands in `byDir`
// and is resolved from the filesystem instead.
//
// A directory that resolves to nothing — not under git, or a worktree deleted
// before Lens ever saw it — keeps its own row under its own path. The two lists
// therefore always account for exactly the same tokens: grouping moves rows
// together, it never drops them.
//
// The two halves can name the same repository by different keys (a remote URL
// on one side, a checkout path on the other) and are deliberately not
// reconciled: turning a path into a remote means reading `config` out of a
// directory that may be gone, which is the guesswork this exists to avoid. In
// practice a source populates one side or the other, not both.
async function groupByRepo(direct, byDir, repoIndex) {
  // No index yet (a usage call that beat startup): directory-keyed sessions
  // stand alone, which is what the folder view already shows.
  const roots = repoIndex && byDir.size
    ? await repoIndex.resolveRepoRoots([...byDir.keys()])
    : new Map();

  const out = new Map();
  const add = (key, label, v) => {
    const cur = out.get(key) || { repo: label, input: 0, output: 0, cacheRead: 0, cacheCreate: 0, sessions: 0, dirs: new Set() };
    cur.input += v.input;
    cur.output += v.output;
    cur.cacheRead += v.cacheRead;
    cur.cacheCreate += v.cacheCreate;
    cur.sessions += v.sessions;
    for (const d of v.dirs) cur.dirs.add(d);
    out.set(key, cur);
  };

  for (const [url, v] of direct) add(url, repoLabel(url), v);
  for (const [dir, v] of byDir) {
    const root = roots.get(dir) || dir;
    add(root, root, v);
  }

  // `dirCount` is how many distinct working directories folded into the row —
  // what explains to the reader why a repository outweighs any single folder
  // they recognise. Deliberately not called "worktrees": the directories behind
  // one repository are a mix of worktrees, separate clones and subdirectories,
  // and naming them after only the first kind is what sent an earlier version
  // of this down the wrong path. 1 means nothing was folded.
  return [...out.values()].map(({ dirs, ...v }) => ({ ...v, dirCount: dirs.size || 1 }));
}

// Derived activity stats: streaks, active days, longest session, favorite model.
// All cheap to compute since we already have byDay + sessions in memory.
function computeStats(sessions, byDayAll, byModel) {
  const DAY = 86400 * 1000;
  // Active days = number of distinct days with any session activity.
  const activeDays = byDayAll.length;
  const firstDay = byDayAll.length ? byDayAll[byDayAll.length - 1].day : null;
  const lastDay = byDayAll.length ? byDayAll[0].day : null;
  // Total days = span from first activity to today, inclusive.
  let totalDays = 0;
  if (firstDay) {
    const ms = Date.now() - parseLocalDay(firstDay).getTime();
    totalDays = Math.max(1, Math.floor(ms / DAY) + 1);
  }
  // Streaks: walk the days ascending. Need a Set of active days for quick lookup.
  const daySet = new Set(byDayAll.map(d => d.day));
  let longestStreak = 0, currentStreak = 0;
  if (firstDay) {
    let streak = 0;
    // Walk day-by-day from firstDay to today.
    const start = parseLocalDay(firstDay).getTime();
    const todayKey = dayKey(new Date());
    for (let t = start; t <= Date.now(); t += DAY) {
      const k = dayKey(new Date(t));
      if (daySet.has(k)) {
        streak++;
        if (streak > longestStreak) longestStreak = streak;
      } else {
        streak = 0;
      }
      if (k === todayKey) currentStreak = streak;
    }
  }
  // Most active day (by total tokens).
  let mostActive = null;
  let mostActiveTokens = -1;
  for (const d of byDayAll) {
    const total = d.input + d.output + d.cacheRead + d.cacheCreate;
    if (total > mostActiveTokens) { mostActiveTokens = total; mostActive = d.day; }
  }
  // Longest single session: max(lastTs - firstTs).
  let longestSessionMs = 0;
  for (const s of sessions) {
    if (!s.firstTs || !s.lastTs) continue;
    const span = new Date(s.lastTs).getTime() - new Date(s.firstTs).getTime();
    if (span > longestSessionMs) longestSessionMs = span;
  }
  // Favorite model (by total tokens, excluding 'unknown').
  let favoriteModel = null;
  let favTokens = 0;
  for (const [model, v] of byModel.entries()) {
    if (model === 'unknown') continue;
    const t = v.input + v.output + v.cacheRead + v.cacheCreate;
    if (t > favTokens) { favTokens = t; favoriteModel = model; }
  }
  return {
    activeDays, totalDays,
    longestStreak, currentStreak,
    mostActiveDay: mostActive,
    longestSessionMs,
    favoriteModel,
    firstDay, lastDay,
  };
}

function dayKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function parseLocalDay(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

module.exports = {
  createUsage,
  computeStats,
  dayKey,
  parseLocalDay,
};
