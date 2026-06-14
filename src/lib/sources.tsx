import { useEffect, useState } from 'react';
import type { ReactNode, ComponentType } from 'react';

// ===========================================================================
//  Provider registry
//
//  Each AI tool the app supports — Claude Code, OpenAI Codex, future ones —
//  exposes a SourceDef describing its branding (colors, glyph) AND the labels
//  it wants surfaced wherever something is "source-aware": Workspace overview
//  blurb, KIND meta for the resource sections, Settings copy, etc.
//
//  Anything that used to be a ternary (`source === 'codex' ? X : Y`) inside a
//  component should be a field on this def. New components read it via
//  `getSource(currentSource)` — no branching needed.
// ===========================================================================

export type SessionSource = 'claude' | 'codex';

// Kind discriminators are intentionally vendor-neutral. `rootInstructions`
// covers Claude's `CLAUDE.md` and Codex's `AGENTS.md`; per-source label text
// (the chip / group header) comes from `kindMeta[kind].pluralLabel`.
export type ResourceKindKey = 'rootInstructions' | 'Skill' | 'Command' | 'Hook' | 'Plugin' | 'Settings';

export type KindMeta = {
  short: string;
  hint: string;
  pluralLabel: string;
};

export type SourceDef = {
  id: SessionSource;
  label: string;
  pathHint: string;            // displayed in Manage Tools / about pages
  // Visual identity for chips, dropdowns, message-avatar backgrounds.
  accent: string;
  accentSoft: string;
  // Built-in glyph component — pre-baked so renderers don't if/else.
  // Two consumers: AISourceSelector dropdown row, Sidebar Workspace nav icon,
  // Message avatar. Each consumer sizes via className.
  Glyph: ComponentType<{ className?: string; color?: string }>;
  beta?: boolean;
  // Workspace strings — used by ConfigView's overview header so the page
  // adapts without per-source branching inside the component.
  workspaceRoot: string;       // e.g. "~/.claude" — header title
  workspaceBlurb: string;      // tagline under header
  // Per-kind descriptions for the Workspace sidebar groups + overview cards.
  // Same keys across sources so the layout is identical; only the text shifts.
  kindMeta: Record<ResourceKindKey, KindMeta>;
};

// ---------------------------------------------------------------------------
//  Glyph components — Claude asterisk and OpenAI mark, exposed here so they
//  can be referenced both from this registry AND directly (e.g. Message.tsx).
// ---------------------------------------------------------------------------

function ClaudeGlyph({ className = '', color = 'currentColor' }: { className?: string; color?: string }) {
  // Real Anthropic / Claude brand mark. Scales fine down to small icon sizes
  // because the path uses thick strokes.
  return (
    <svg viewBox="0 0 100 100" className={className} aria-hidden>
      <path fill={color} d="m19.6 66.5 19.7-11 .3-1-.3-.5h-1l-3.3-.2-11.2-.3L14 53l-9.5-.5-2.4-.5L0 49l.2-1.5 2-1.3 2.9.2 6.3.5 9.5.6 6.9.4L38 49.1h1.6l.2-.7-.5-.4-.4-.4L29 41l-10.6-7-5.6-4.1-3-2-1.5-2-.6-4.2 2.7-3 3.7.3.9.2 3.7 2.9 8 6.1L37 36l1.5 1.2.6-.4.1-.3-.7-1.1L33 25l-6-10.4-2.7-4.3-.7-2.6c-.3-1-.4-2-.4-3l3-4.2L28 0l4.2.6L33.8 2l2.6 6 4.1 9.3L47 29.9l2 3.8 1 3.4.3 1h.7v-.5l.5-7.2 1-8.7 1-11.2.3-3.2 1.6-3.8 3-2L61 2.6l2 2.9-.3 1.8-1.1 7.7L59 27.1l-1.5 8.2h.9l1-1.1 4.1-5.4 6.9-8.6 3-3.5L77 13l2.3-1.8h4.3l3.1 4.7-1.4 4.9-4.4 5.6-3.7 4.7-5.3 7.1-3.2 5.7.3.4h.7l12-2.6 6.4-1.1 7.6-1.3 3.5 1.6.4 1.6-1.4 3.4-8.2 2-9.6 2-14.3 3.3-.2.1.2.3 6.4.6 2.8.2h6.8l12.6 1 3.3 2 1.9 2.7-.3 2-5.1 2.6-6.8-1.6-16-3.8-5.4-1.3h-.8v.4l4.6 4.5 8.3 7.5L89 80.1l.5 2.4-1.3 2-1.4-.2-9.2-7-3.6-3-8-6.8h-.5v.7l1.8 2.7 9.8 14.7.5 4.5-.7 1.4-2.6 1-2.7-.6-5.8-8-6-9-4.7-8.2-.5.4-2.9 30.2-1.3 1.5-3 1.2-2.5-2-1.4-3 1.4-6.2 1.6-8 1.3-6.4 1.2-7.9.7-2.6v-.2H49L43 72l-9 12.3-7.2 7.6-1.7.7-3-1.5.3-2.8L24 86l10-12.8 6-7.9 4-4.6-.1-.5h-.3L17.2 77.4l-4.7.6-2-2 .2-3 1-1 8-5.5Z" />
    </svg>
  );
}

function OpenAIGlyph({ className = '', color = 'currentColor' }: { className?: string; color?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill={color} aria-hidden>
      <path d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
//  Per-source KIND meta
// ---------------------------------------------------------------------------

const CLAUDE_KIND_META: Record<ResourceKindKey, KindMeta> = {
  'rootInstructions': {
    short: 'Global instructions loaded into every Claude Code session.',
    hint: 'Workspace-wide context applied automatically at session start.',
    pluralLabel: 'CLAUDE.md',
  },
  'Skill': {
    short: 'Reusable capabilities Claude can activate when needed.',
    hint: 'Defined under ~/.claude/skills/, each with its own SKILL.md.',
    pluralLabel: 'Skills',
  },
  'Command': {
    short: 'Custom slash commands you can invoke inside any session.',
    hint: 'Markdown files under ~/.claude/commands/ — call with /name.',
    pluralLabel: 'Commands',
  },
  'Hook': {
    short: 'Scripts that automatically run during lifecycle events.',
    hint: 'Fire on pre-commit, pre-tool, post-message and similar triggers.',
    pluralLabel: 'Hooks',
  },
  'Plugin': {
    short: 'Packages that bundle commands, hooks, and skills together.',
    hint: 'Each plugin lives in its own directory under ~/.claude/plugins/.',
    pluralLabel: 'Plugins',
  },
  'Settings': {
    short: 'Workspace-wide preferences and behavior controls.',
    hint: 'Stored in ~/.claude/settings.json. Read once at startup.',
    pluralLabel: 'Settings',
  },
};

const CODEX_KIND_META: Record<ResourceKindKey, KindMeta> = {
  'rootInstructions': {
    short: 'Agent instructions loaded into every Codex session.',
    hint: '~/.codex/AGENTS.md — global Codex bootstrap context.',
    pluralLabel: 'AGENTS.md',
  },
  'Skill': {
    short: 'Reusable capabilities Codex can activate when needed.',
    hint: 'Defined under ~/.codex/skills/, each with its own SKILL.md.',
    pluralLabel: 'Skills',
  },
  'Command': {
    short: 'Slash commands Codex exposes inside any session.',
    hint: 'Codex does not surface custom slash commands yet.',
    pluralLabel: 'Commands',
  },
  'Hook': {
    short: 'Tool permission rules applied to every tool call.',
    hint: 'Stored under ~/.codex/rules/*.rules — allow/deny prefixes per command.',
    pluralLabel: 'Rules',
  },
  'Plugin': {
    short: 'External packages registered with Codex.',
    hint: 'Each plugin lives under ~/.codex/plugins/.',
    pluralLabel: 'Plugins',
  },
  'Settings': {
    short: 'Codex preferences and behavior controls.',
    hint: 'Stored in ~/.codex/config.toml. Read once at startup.',
    pluralLabel: 'Config',
  },
};

// ---------------------------------------------------------------------------
//  Provider registry (Record keyed by SessionSource — O(1) lookup, no list scan).
// ---------------------------------------------------------------------------

export const SOURCES: Record<SessionSource, SourceDef> = {
  claude: {
    id: 'claude',
    label: 'Claude Code',
    pathHint: '~/.claude/projects/',
    accent: '#D97757',
    accentSoft: '#fde6da',
    Glyph: ClaudeGlyph,
    workspaceRoot: '~/.claude',
    workspaceBlurb: 'A map of your Claude Code environment — instructions, capabilities, and automations available across every session.',
    kindMeta: CLAUDE_KIND_META,
  },
  codex: {
    id: 'codex',
    label: 'Codex',
    pathHint: '~/.codex/sessions/',
    accent: '#1f1f24',
    accentSoft: '#e8e8ec',
    Glyph: OpenAIGlyph,
    workspaceRoot: '~/.codex',
    workspaceBlurb: 'A map of your Codex environment — instructions, capabilities, and tool-permission rules picked up by every session.',
    kindMeta: CODEX_KIND_META,
  },
};

// Order to iterate / display in dropdowns and overviews.
export const SOURCE_ORDER: SessionSource[] = ['claude', 'codex'];

export function getSource(id: SessionSource | string | null | undefined): SourceDef {
  return (id && SOURCES[id as SessionSource]) || SOURCES.claude;
}

// Composite key used by favorites / excludes / aliases so two sessions with
// the same UUID across different AI tools can't trample each other.
export function srcKey(s: { source?: string; id: string } | string, source?: string): string {
  if (typeof s === 'string') return `${source || 'claude'}:${s}`;
  return `${s.source || 'claude'}:${s.id}`;
}

// ---------------------------------------------------------------------------
//  Current-source store (singleton + React hook)
// ---------------------------------------------------------------------------

const KEY = 'ai-source-v1';

function readInitial(): SessionSource {
  try {
    const v = localStorage.getItem(KEY) as SessionSource | null;
    if (v && SOURCES[v]) return v;
  } catch {}
  return 'claude';
}

let _current: SessionSource = readInitial();
const _subs = new Set<(s: SessionSource) => void>();
function setSourceGlobal(next: SessionSource) {
  if (next === _current) return;
  _current = next;
  try { localStorage.setItem(KEY, next); } catch {}
  _subs.forEach(fn => fn(next));
}

export function useCurrentSource(): [SessionSource, (next: SessionSource) => void] {
  const [src, setSrc] = useState<SessionSource>(_current);
  useEffect(() => {
    _subs.add(setSrc);
    return () => { _subs.delete(setSrc); };
  }, []);
  return [src, setSourceGlobal];
}
