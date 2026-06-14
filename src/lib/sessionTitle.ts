// Smart label extraction for sessions whose first message is a raw URL.
// Returns { label, sub } when a pattern matches; null otherwise (caller falls back to raw title).

import { cleanDisplayText } from './format';

export type SmartTitle = { label: string; sub?: string } | null;

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
  for (const p of PATTERNS) {
    p.test.lastIndex = 0;
    const m = p.test.exec(trimmed);
    if (m) return p.build(m);
  }
  // Generic: extract host/path
  const urlMatch = trimmed.match(/^https?:\/\/([^/\s]+)([^\s]*)/i);
  if (urlMatch) {
    const host = urlMatch[1].replace(/^www\./, '');
    const path = urlMatch[2].split(/[?#]/)[0].replace(/\/$/, '');
    const seg = path.split('/').filter(Boolean).slice(-2).join(' / ');
    return { label: host, sub: seg || undefined };
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
