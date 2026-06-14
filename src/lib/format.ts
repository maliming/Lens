// Shared "what timestamp does this session represent" parser. Used by every
// view that needs to filter / sort / group by recency:
//   - lastTs (ISO string from JSONL) is preferred.
//   - Falls back to mtime (file mtime, ms epoch from main process).
//   - Invalid Date / undefined / 0 returns 0 — sorts to the bottom, filters
//     out of any time window. Centralising avoids the bug where one view
//     bucketed Invalid Date as "now" and another as "0".
//
// Also clamps future timestamps (forward clock skew between the user's
// machine and whoever wrote the JSONL) to now — otherwise the "just now"
// branch would catch them and the recent buckets would over-report.
export function sessionTimestamp(s: { lastTs?: string | null; mtime?: number }): number {
  if (s.lastTs) {
    const t = Date.parse(s.lastTs);
    if (Number.isFinite(t) && t > 0) return Math.min(t, Date.now());
  }
  return s.mtime && Number.isFinite(s.mtime) ? Math.min(s.mtime, Date.now()) : 0;
}

// Relative time formatter. Pass the i18n translator (`t` from useTranslation)
// to localise the unit suffixes — "just now" / "5m ago" / "2h ago" / "3d ago".
// Without t, falls back to English for non-React callers (debug logs, IPC
// status strings) so the function can still be called from anywhere.
export function fmtTime(iso: string | null | undefined, t?: (key: any, vars?: Record<string, string | number>) => string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const now = Date.now();
  // Future timestamps (clock skew between the JSONL writer and Lens) used to
  // render as "just now" — misleading. Show the absolute timestamp instead;
  // the caller can also normalise via `sessionTimestamp` when sorting.
  if (d.getTime() > now) {
    return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  const diff = (now - d.getTime()) / 1000;
  if (diff < 60) return t ? t('time.justNow') : 'just now';
  if (diff < 3600) {
    const n = Math.floor(diff / 60);
    return t ? t('time.minAgo', { n }) : `${n}m ago`;
  }
  if (diff < 86400) {
    const n = Math.floor(diff / 3600);
    return t ? t('time.hAgo', { n }) : `${n}h ago`;
  }
  if (diff < 86400 * 7) {
    const n = Math.floor(diff / 86400);
    return t ? t('time.dAgo', { n }) : `${n}d ago`;
  }
  return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function fmtBytes(n: number): string {
  if (!n) return '0B';
  if (n < 1024) return n + 'B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + 'KB';
  return (n / 1024 / 1024).toFixed(1) + 'MB';
}

// Strip vendor prefix so model names render short. Works across providers:
// claude-opus-4-7 → opus-4-7 / openai-gpt-5 → gpt-5 / gpt-4 stays as gpt-4.
// Claude Code stamps system / auto-summary turns with "<synthetic>" or
// "synthetic"; Codex sometimes leaks the provider name ("openai", "anthropic")
// into model when turn_context never landed. Neither represents a real model
// the user picked, so treat them as no-model rather than displaying them.
const PROVIDER_NAMES = new Set(['openai', 'anthropic', 'azure', 'bedrock']);
function isUsableModel(model: string | null | undefined): model is string {
  if (!model) return false;
  if (/^<?synthetic>?$/i.test(model)) return false;
  if (PROVIDER_NAMES.has(model.toLowerCase())) return false;
  return true;
}

// Render-friendly model name with the "claude-/openai-/anthropic-" prefix
// stripped. Returns '' for synthetic/provider placeholders so the caller can
// fall back to '—' / hide the chip rather than displaying noise.
export function fmtModel(model: string | null | undefined): string {
  if (!isUsableModel(model)) return '';
  // Clean control/bidi chars from the model name before stripping vendor
  // prefixes — corrupt JSONL could otherwise let a model chip reorder its
  // own glyphs and visually masquerade as a different model.
  return cleanDisplayText(model)
    .replace(/^claude-/, '')
    .replace(/^openai-/, '')
    .replace(/^anthropic-/, '');
}

export { isUsableModel };

// Humanize a snake_case / kebab-case plan type so an unrecognised string from
// the CLI ("chatgpt_pro" → "ChatGPT Pro") reads cleanly instead of shouting
// in all-caps after toUpperCase().
export function humanizePlanType(s: string): string {
  return s
    .split(/[_-]+/)
    .filter(Boolean)
    .map(w => w.length <= 3 ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
}

// Platform-aware "modifier + key" label for kbd hints. macOS users expect ⌘K;
// Windows/Linux expect Ctrl K. Renderer has no Node access so we sniff the UA
// at runtime (covers Win/Mac/Linux; falls through to Ctrl for anything else).
const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent || '');
export function kbdShortcut(key: string): string {
  return IS_MAC ? `⌘${key}` : `Ctrl ${key}`;
}

// Strip C0/C1 control characters, ANSI escape sequences (CSI + OSC), and
// Unicode bidi override codepoints from a free-text string before it lands in
// the DOM. React already HTML-escapes, but bidi overrides and stray nulls can
// still reorder visible characters or truncate at unexpected places — clean
// them before they hit a list row / title / drawer.
// CSI: ESC [ ... letter (e.g. \x1b[31m for red)
// OSC: ESC ] ... BEL / ESC \ (e.g. xterm title set)
// eslint-disable-next-line no-control-regex
const ANSI_CSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
// eslint-disable-next-line no-control-regex
const ANSI_OSC_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
// C0 (\x00-\x1F minus TAB/LF/CR) + DEL (\x7F) + C1 (\x80-\x9F).
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g;
// Unicode bidi overrides: U+202A-U+202E + U+2066-U+2069.
const BIDI_RE = /[‪-‮⁦-⁩]/g;
export function cleanDisplayText(s: string | null | undefined): string {
  if (!s) return '';
  return s
    .replace(ANSI_OSC_RE, '')
    .replace(ANSI_CSI_RE, '')
    .replace(CONTROL_RE, '')
    .replace(BIDI_RE, '');
}

export function fmtTokens(n: number): string {
  if (!n) return '0';
  if (n < 1000) return String(n);
  if (n < 1_000_000) return (n / 1000).toFixed(n < 10_000 ? 1 : 0) + 'K';
  if (n < 1_000_000_000) return (n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0) + 'M';
  return (n / 1_000_000_000).toFixed(1) + 'B';
}

export function shortCwd(cwd: string | null | undefined): string {
  if (!cwd) return '';
  // Replace any platform's home dir with ~. macOS: /Users/<u>, Linux: /home/<u>,
  // Windows: C:\Users\<u>. Renderer has no Node access so we match on shape.
  // Clean first so a path with embedded control chars / bidi can't reorder
  // the visible string after the substitution.
  const safe = cleanDisplayText(cwd);
  // Windows drive letter is case-insensitive (`c:\Users\...` is valid). The
  // old regex anchored on uppercase only, so lowercase drives stayed as the
  // full absolute path. Match both.
  const m = safe.match(/^(\/Users\/[^/]+|\/home\/[^/]+|[A-Za-z]:[\/\\]Users[\/\\][^\/\\]+)([\/\\].*)?$/);
  if (m) return '~' + (m[2] || '');
  return safe;
}

// Deterministic color for a project string
const PROJECT_PALETTE = [
  { bg: 'bg-blue-500', text: 'text-white' },
  { bg: 'bg-purple-500', text: 'text-white' },
  { bg: 'bg-pink-500', text: 'text-white' },
  { bg: 'bg-orange-500', text: 'text-white' },
  { bg: 'bg-emerald-500', text: 'text-white' },
  { bg: 'bg-amber-500', text: 'text-white' },
  { bg: 'bg-cyan-500', text: 'text-white' },
  { bg: 'bg-rose-500', text: 'text-white' },
  { bg: 'bg-indigo-500', text: 'text-white' },
  { bg: 'bg-teal-500', text: 'text-white' },
];

function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

export function projectColor(project: string) {
  return PROJECT_PALETTE[hashStr(project) % PROJECT_PALETTE.length];
}

// Tailwind text-color variant per project, for inline labels (e.g. list row meta).
const PROJECT_TEXT_PALETTE = [
  'text-blue-600 dark:text-blue-400',
  'text-purple-600 dark:text-purple-400',
  'text-pink-600 dark:text-pink-400',
  'text-orange-600 dark:text-orange-400',
  'text-emerald-600 dark:text-emerald-400',
  'text-amber-600 dark:text-amber-400',
  'text-cyan-600 dark:text-cyan-400',
  'text-rose-600 dark:text-rose-400',
  'text-indigo-600 dark:text-indigo-400',
  'text-teal-600 dark:text-teal-400',
];
export function projectTextColor(project: string): string {
  return PROJECT_TEXT_PALETTE[hashStr(project) % PROJECT_TEXT_PALETTE.length];
}

export function projectInitial(project: string): string {
  // Split on both POSIX and Windows separators so a path like `C:\Users\me\proj`
  // surfaces "P" rather than "C". Run twice (regex + replace) is fine on these
  // short strings.
  const base = project.replace(/^.*[\/\\]/, '').replace(/^[-_.]+/, '');
  return (base[0] || '?').toUpperCase();
}
