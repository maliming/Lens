import { useEffect, useState } from 'react';
import type { SessionMeta } from '../types';
import { resolveSessionTitle, smartTitle, projectShortName, meaningfulBranch } from './sessionTitle';
import { cleanDisplayText } from './format';
import { useCurrentSource } from './sources';

const keyFor = (source: string) => `exclude-rules-v1:${source}`;

function loadRules(source: string): string[] {
  try {
    const raw = localStorage.getItem(keyFor(source));
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr.filter((x: unknown): x is string => typeof x === 'string' && x.length > 0) : [];
  } catch { return []; }
}

export function useExcludeRules(): [string[], (next: string[]) => void] {
  const [source] = useCurrentSource();
  const [rules, setRules] = useState<string[]>(() => loadRules(source));
  // Sidebar source switch → swap to that source's saved filters. Save effect
  // intentionally omits `source` from its deps to avoid writing pre-switch
  // rules under the new source's key during the transition render.
  useEffect(() => { setRules(loadRules(source)); }, [source]);
  useEffect(() => {
    try { localStorage.setItem(keyFor(source), JSON.stringify(rules)); } catch {}
  }, [rules]); // eslint-disable-line react-hooks/exhaustive-deps
  return [rules, setRules];
}

// Narrow match surface — title (derived display title from summary or firstUser's
// FIRST LINE only), summary, project short name, git branch. We deliberately do NOT
// match against full firstUser body or arbitrary cwd path because slash-command
// prefaces like <command-message> would otherwise nuke unrelated real conversations.
function ruleHaystack(s: SessionMeta): string {
  const title = resolveSessionTitle(s, { includeAlias: false });
  // Fold in the leading-URL label/host even when it lost the title slot to a
  // summary — a rule saved against a host (e.g. "docs.foo.com") must keep
  // matching regardless of which candidate currently wins the visible title.
  const smart = smartTitle(cleanDisplayText(s.firstUser));
  return [
    title.primary,
    title.sub,
    smart?.label,
    smart?.sub,
    s.summary,
    projectShortName(s.projectCwd || s.decodedCwd),
    meaningfulBranch(s.gitBranch),
  ].filter(Boolean).join(' ').toLowerCase();
}

export function matchesExcludeRule(s: SessionMeta, rule: string): boolean {
  const r = rule.trim().toLowerCase();
  if (!r) return false;
  return ruleHaystack(s).includes(r);
}

export function matchesAnyExcludeRule(s: SessionMeta, rules: string[]): boolean {
  return rules.some(r => matchesExcludeRule(s, r));
}

export function computeEffectiveExcluded(
  sessions: SessionMeta[],
  manual: Set<string>,
  rules: string[]
): Set<string> {
  if (!rules.length) return manual;
  const out = new Set(manual);
  // Stored keys are composite "<source>:<id>" — keep that shape when
  // adding rule-derived excludes too.
  for (const s of sessions) {
    if (matchesAnyExcludeRule(s, rules)) out.add(`${s.source}:${s.id}`);
  }
  return out;
}
