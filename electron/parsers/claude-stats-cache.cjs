// Reader for `~/.claude/stats-cache.json` — Claude Code's own pre-computed
// stats blob, written by the CLI and consumed by the `/stats` command.
//
// Why we use it: Claude Code 2.0+ aggregates conversation activity into this
// cache and (sometimes) prunes the underlying JSONLs from
// `~/.claude/projects/`. The result is that the local JSONL inventory often
// only covers the last 1–2 months, but the stats cache retains daily
// activity all the way back to first use (~6 months on a heavy user). Lens'
// activity heatmap and per-month totals look dramatically more sparse than
// the official `/stats` output without this augmentation.
//
// Shape (truncated to the fields we use — schema is owned by Claude Code,
// keep the reader tolerant to extra/missing keys):
//   {
//     version: 3,
//     lastComputedDate: "2026-06-16",
//     firstSessionDate: "2026-01-20T02:28:33.375Z",
//     totalSessions: 801,
//     totalMessages: 239513,
//     longestSession: { sessionId, duration, messageCount, timestamp },
//     dailyActivity:     [{ date: "YYYY-MM-DD", messageCount, sessionCount, toolCallCount }],
//     dailyModelTokens:  [{ date: "YYYY-MM-DD", tokensByModel: { "<model>": <number> } }],
//     modelUsage:        { "<model>": { inputTokens, outputTokens, cacheReadInputTokens, cacheCreationInputTokens } }
//   }
//
// Note: dailyModelTokens gives ONE total number per model per day (not split
// into input/output/cacheRead/cacheCreate). When we synthesise a byDay row
// from this cache, we land the whole bucket in `input` so the heatmap
// colouring + per-day tokens still work, but per-token-kind breakdowns
// (cache hit rate, output ratio) won't be meaningful for synthesised days.
// usage.cjs uses these rows ONLY to fill days the JSONL parse didn't reach.

const path = require('path');
const fsp = require('fs').promises;

const { CLAUDE_DIR } = require('../lib/paths.cjs');
const { readJsonFileSafe } = require('../lib/json-io.cjs');

const STATS_CACHE_PATH = path.join(CLAUDE_DIR, 'stats-cache.json');
// stats-cache.json is a few hundred KB in practice; reserve some headroom
// for heavy users. Anything above this is almost certainly corrupted.
const MAX_STATS_FILE_SIZE = 16 * 1024 * 1024;

// In-memory cache keyed by mtime so usage:summary calls in tight succession
// (renderer triggers two — one before background scan, one after — and the
// 5-min Sidebar refresh tick) don't re-parse a 300KB JSON.
let cached = null; // { mtime, data }

async function readClaudeStatsCache() {
  let stat;
  try { stat = await fsp.stat(STATS_CACHE_PATH); } catch { return null; }
  if (cached && cached.mtime === stat.mtimeMs) return cached.data;
  let raw;
  try { raw = await readJsonFileSafe(STATS_CACHE_PATH, MAX_STATS_FILE_SIZE); } catch { return null; }
  if (raw == null) return null;
  let obj;
  try { obj = JSON.parse(raw); } catch { return null; }
  // Defensive shape check — refuse anything that doesn't look like the
  // Claude Code stats cache so we don't crash usageSummary if a third-party
  // tool ever drops a different JSON at this path.
  if (!obj || typeof obj !== 'object') return null;
  if (!Array.isArray(obj.dailyActivity)) return null;
  cached = { mtime: stat.mtimeMs, data: obj };
  return obj;
}

module.exports = {
  readClaudeStatsCache,
  STATS_CACHE_PATH,
};
