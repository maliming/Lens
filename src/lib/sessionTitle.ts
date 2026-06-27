// Smart label extraction for sessions whose first message is a raw URL.
// Returns { label, sub } when a pattern matches; null otherwise (caller falls back to raw title).

import { cleanDisplayText } from './format';

// `generic` marks the host/path fallback (any URL) as opposed to a named
// pattern (GitHub / abp.io / claude.ai). Callers that weigh a smart label
// against a summary use it to keep generic labels from outranking a real
// summary / ai-title.
export type SmartTitle = { label: string; sub?: string; generic?: boolean } | null;

const PATTERNS: Array<{ test: RegExp; build: (m: RegExpExecArray) => { label: string; sub?: string } }> = [
  // abp.io support questions
  {
    test: /abp\.io\/support\/questions\/(\d+)(?:[/?#-]([^/?#\s]+))?/i,
    build: (m) => ({ label: `ABP QA: ${m[1]}`, sub: m[2] ? prettifySlug(m[2]) : undefined }),
  },
  // github issue / pull
  {
    test: /github\.com\/([\w.-]+)\/([\w.-]+)\/(issues|pull)\/(\d+)/i,
    build: (m) => ({ label: `${m[2]} ${m[3] === 'pull' ? 'PR' : '#'}${m[4]}`, sub: m[1] }),
  },
  // github commit
  {
    test: /github\.com\/([\w.-]+)\/([\w.-]+)\/commit\/([0-9a-f]{7,40})/i,
    build: (m) => ({ label: `${m[2]} ${m[3].slice(0, 7)}`, sub: m[1] }),
  },
  // github repo
  {
    test: /github\.com\/([\w.-]+)\/([\w.-]+)\/?$/i,
    build: (m) => ({ label: `${m[1]}/${m[2]}`, sub: 'GitHub' }),
  },
  // claude.ai conversation
  {
    test: /claude\.ai\/(chat|share)\/([\w-]+)/i,
    build: (m) => ({ label: `Claude ${m[1] === 'share' ? 'shared' : 'chat'}`, sub: m[2].slice(0, 8) }),
  },
];

function prettifySlug(s: string): string {
  return s
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
}

export function smartTitle(raw: string): SmartTitle {
  if (!raw) return null;
  const trimmed = raw.replace(/\s+/g, ' ').trim();
  // Only match if the message LOOKS like it leads with a URL
  if (!/^https?:\/\//i.test(trimmed) && !/^[a-z]+\.(io|com|dev|ai|net|org)/i.test(trimmed)) return null;
  // Match named patterns against the LEADING URL token ONLY. A message that
  // opens with a plain URL must not inherit a GitHub/abp label from a link
  // buried later in the same prompt — the title reflects the URL the user
  // actually led with.
  const head = trimmed.split(' ')[0];
  for (const p of PATTERNS) {
    p.test.lastIndex = 0;
    const m = p.test.exec(head);
    if (m) return p.build(m);
  }
  // Generic: extract host/path
  const urlMatch = head.match(/^https?:\/\/([^/\s]+)([^\s]*)/i);
  if (urlMatch) {
    const host = urlMatch[1].replace(/^www\./, '');
    const path = urlMatch[2].split(/[?#]/)[0].replace(/\/$/, '');
    const seg = path.split('/').filter(Boolean).slice(-2).join(' / ');
    return { label: host, sub: seg || undefined, generic: true };
  }
  return null;
}

export function deriveDisplayTitle(raw: string | null | undefined): { primary: string; sub?: string; isSmart: boolean } {
  // Strip ANSI escapes, C0/C1 control chars, and Unicode bidi overrides before
  // any other processing so a stray escape sequence in the first user message
  // can't reorder/hide the rendered title.
  const cleaned = cleanDisplayText(raw);
  const r = cleaned.replace(/\s+/g, ' ').trim();
  if (!r) return { primary: '(no title)', isSmart: false };
  const smart = smartTitle(r);
  if (smart) return { primary: smart.label, sub: smart.sub, isSmart: true };
  const truncated = r.length > 140 ? r.slice(0, 140) + '…' : r;
  return { primary: truncated, isSmart: false };
}

// Resolve a session's displayed title with the precedence the UI wants:
//   alias (verbatim)
//     → NAMED URL pattern in first message (GitHub / abp.io / claude.ai)
//     → summary / ai-title
//     → GENERIC host/path label from first message
//     → first message
// A NAMED pattern formats into a precise label the user pasted, so it beats an
// auto-generated summary / ai-title (pasted-link sessions keep their smart
// label — regressed when ai-title started filling the summary slot). A GENERIC
// host/path label (any other URL) isn't necessarily better than a summary, so
// it ranks below it. Pass includeAlias:false for the title a session WOULD show
// without its alias (the "original" sub-line on renamed rows). `fallback` is the
// localized string shown when the session carries no usable text at all.
export function resolveSessionTitle(
  s: { alias?: string | null; summary?: string | null; firstUser?: string | null },
  opts: { includeAlias?: boolean; fallback?: string } = {},
): { primary: string; sub?: string; isSmart: boolean; full: string } {
  const { includeAlias = true, fallback } = opts;
  // `full` is the untruncated source the title was derived from — used for the
  // row hover tooltip so it always reflects the visible title's origin (a smart
  // URL row shows the full URL on hover, not the unrelated ai-title).
  if (includeAlias) {
    const alias = cleanDisplayText(s.alias).replace(/\s+/g, ' ').trim();
    if (alias) return { primary: alias, isSmart: false, full: alias };
  }
  const fu = cleanDisplayText(s.firstUser).replace(/\s+/g, ' ').trim();
  const smart = fu ? smartTitle(fu) : null;
  if (smart && !smart.generic) return { primary: smart.label, sub: smart.sub, isSmart: true, full: fu };
  const summary = cleanDisplayText(s.summary).replace(/\s+/g, ' ').trim();
  if (summary) return { ...deriveDisplayTitle(summary), full: summary };
  if (smart) return { primary: smart.label, sub: smart.sub, isSmart: true, full: fu };
  if (fu) return { ...deriveDisplayTitle(fu), full: fu };
  return { primary: fallback || '(no title)', isSmart: false, full: fallback || '' };
}

// Just the last meaningful path segment of a cwd. Handles both POSIX and
// Windows separators so `C:\Users\me\Repos\abp` and `/Users/me/Repos/abp` both
// surface "abp". Clean first so a path with embedded control chars / bidi
// can't reorder the final segment.
export function projectShortName(cwd: string | null | undefined): string {
  if (!cwd) return '';
  const safe = cleanDisplayText(cwd);
  const parts = safe.split(/[\/\\]+/).filter(Boolean);
  return parts[parts.length - 1] || '';
}

// Filter out values that aren't useful as displayed branches.
// Claude Code records the literal "HEAD" when the cwd is in detached-HEAD state
// (e.g. after `git checkout <sha>`). That's a valid git state but noisy in lists.
export function meaningfulBranch(b: string | null | undefined): string | null {
  if (!b) return null;
  // Branch names should never carry control or bidi chars; if they do (corrupt
  // JSONL, attacker-supplied repo), clean before any UI consumption.
  const t = cleanDisplayText(b).trim();
  if (!t) return null;
  if (t.toUpperCase() === 'HEAD') return null;
  return t;
}
