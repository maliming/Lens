import { useEffect, useState, useCallback, useRef } from 'react';
import type { AuthStatus } from '../types';
import type { SessionSource } from './sources';

export type { AuthStatus };

// ===========================================================================
//  Source-agnostic auth hook
//
//  Each AI tool (Claude, Codex, future ones) exposes its login state in a
//  different file under a different format. We hide all of that behind a
//  single window.api.getAuthStatus(source) IPC and a SourceAuthAdapter on the
//  renderer side. Add a new AI by extending the registry — no branching here.
//
//  Identity may differ across tools, so cache, inflight tracking, profile
//  defaults, "customised" sticky flags etc are keyed on `source`.
// ===========================================================================

// ---------------------------------------------------------------------------
//  Adapter registry — the only place per-source behaviour lives. fetch()
//  forwards to whatever IPC channel the source advertises; planLabel /
//  planBadgeClass can be overridden per-source if we ever want vendor-specific
//  badge styling. For now they share the global maps below.
// ---------------------------------------------------------------------------

type SourceAuthAdapter = {
  fetch: () => Promise<AuthStatus>;
};

const ADAPTERS: Record<SessionSource, SourceAuthAdapter> = {
  claude: { fetch: () => window.api.getAuthStatus('claude') },
  codex:  { fetch: () => window.api.getAuthStatus('codex') },
};

// ---------------------------------------------------------------------------
//  Cache + inflight, keyed by source so a fetch for codex never overwrites the
//  cached claude entry and vice versa.
// ---------------------------------------------------------------------------

// v3: introduced because v2 may have cached null subscriptionType from the
// pre-codex-JWT-decode era; bumping invalidates those stale entries.
function storageKey(source: SessionSource) { return `auth-status-v3:${source}`; }
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

type Cached = { data: AuthStatus; cachedAt: number };
const inflight: Partial<Record<SessionSource, Promise<AuthStatus>>> = {};

async function doFetch(source: SessionSource): Promise<AuthStatus> {
  if (inflight[source]) return inflight[source]!;
  inflight[source] = (async () => {
    try {
      const data = await ADAPTERS[source].fetch();
      const cache: Cached = { data, cachedAt: Date.now() };
      try { localStorage.setItem(storageKey(source), JSON.stringify(cache)); } catch {}
      return data;
    } finally {
      inflight[source] = undefined;
    }
  })();
  return inflight[source]!;
}

function readCached(source: SessionSource): AuthStatus | null {
  try {
    const raw = localStorage.getItem(storageKey(source));
    if (raw) return (JSON.parse(raw) as Cached).data;
  } catch {}
  return null;
}

// ---------------------------------------------------------------------------
//  Hook. `source` is required; pass the current AI selection.
// ---------------------------------------------------------------------------

export function useSourceAuth(source: SessionSource): {
  auth: AuthStatus | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
} {
  const [auth, setAuth] = useState<AuthStatus | null>(() => readCached(source));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);
  // Two-layer staleness guard:
  // 1. activeSourceRef — drop results that belong to a source the user has
  //    flipped away from.
  // 2. seqRef — monotonically increasing per-call counter so two concurrent
  //    refreshes of the same source can't have the slower one overwrite the
  //    faster one's result.
  const activeSourceRef = useRef<SessionSource>(source);
  const seqRef = useRef(0);

  const refresh = useCallback(async () => {
    const fetchSource = source;
    const seq = ++seqRef.current;
    setLoading(true);
    setError(null);
    try {
      const data = await doFetch(fetchSource);
      if (!mountedRef.current) return;
      if (activeSourceRef.current !== fetchSource) return;
      if (seq !== seqRef.current) return;
      setAuth(data);
    } catch (e: any) {
      if (!mountedRef.current) return;
      if (activeSourceRef.current !== fetchSource) return;
      if (seq !== seqRef.current) return;
      setError(e?.message || String(e));
    } finally {
      if (!mountedRef.current) return;
      if (activeSourceRef.current === fetchSource && seq === seqRef.current) setLoading(false);
    }
  }, [source]);

  useEffect(() => {
    mountedRef.current = true;
    activeSourceRef.current = source;
    const cached = readCached(source);
    setAuth(cached);
    let cachedAt = 0;
    try {
      const raw = localStorage.getItem(storageKey(source));
      if (raw) cachedAt = (JSON.parse(raw) as Cached).cachedAt || 0;
    } catch {}
    if (!cached || Date.now() - cachedAt > CACHE_TTL_MS) refresh();
    return () => { mountedRef.current = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source]);

  return { auth, loading, error, refresh };
}

// ---------------------------------------------------------------------------
//  Plan label + badge style — shared across sources (Anthropic's "Max" and
//  OpenAI's "Pro" both go through the same map).
// ---------------------------------------------------------------------------

const PLAN_LABEL_MAP: Record<string, string> = {
  max: 'Max',
  max5x: 'Max 5×',
  max20x: 'Max 20×',
  pro: 'Pro',
  plus: 'Plus',
  team: 'Team',
  enterprise: 'Enterprise',
  free: 'Free',
};

export function planLabel(s?: string): string {
  if (!s) return '';
  // Unknown plans get a humanized title-case version ("chatgpt_pro" → "ChatGPT
  // Pro") rather than shouting in ALL_CAPS — looks less like an error sentinel
  // and is what users actually read.
  const known = PLAN_LABEL_MAP[s.toLowerCase()];
  if (known) return known;
  return s.split(/[_-]+/).filter(Boolean)
    .map(w => w.length <= 3 ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
}

export function planBadgeClass(s?: string): string {
  // Account-card refinement — even quieter than v8. The plan label is metadata,
  // not branding: muted bg, low-contrast text, no decorative tint per category
  // beyond a single soft purple for paid plans.
  switch ((s || '').toLowerCase()) {
    case 'max':
    case 'max20x':
    case 'max5x':
    case 'pro':
    case 'plus':
      return 'bg-purple-100/70 text-purple-700/90 dark:bg-purple-900/25 dark:text-purple-300/90';
    case 'team':
      return 'bg-amber-100/70 text-amber-700/90 dark:bg-amber-900/25 dark:text-amber-300/90';
    case 'enterprise':
      return 'bg-emerald-100/70 text-emerald-700/90 dark:bg-emerald-900/25 dark:text-emerald-300/90';
    case 'free':
      return 'bg-muted text-text-muted';
    default:
      return 'bg-muted text-text-muted';
  }
}

export function deriveName(email?: string): string {
  if (!email) return '';
  return email.split('@')[0];
}
