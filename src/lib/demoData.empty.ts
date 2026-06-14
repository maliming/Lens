// Production stub for demoData. Vite's resolve.alias swaps `./demoData` to this
// file in production builds so the ~1 MB of fake sessions / chat templates /
// fake workspace content never ships. In dev (and DEMO_BUILD=1 forced demo
// artifacts) the real demoData.ts is used instead.
//
// Every export here is a zero-value placeholder that matches the shape of the
// real export but contains no PII / fake user content. None of these values
// are ever READ at runtime in production because the demo-mode flag is hard-
// gated off (see demoMode.ts), but they must still satisfy the type so static
// imports compile.

import type {
  SessionMeta, MessageItem, UsageSummary, RateLimits, AuthStatus,
} from '../types';

export const DEMO_SESSIONS: SessionMeta[] = [];
export const DEMO_MESSAGES: Record<string, MessageItem[]> = {};

const emptyBucket = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, sessions: 0, msgs: 0 };
const emptyWindow = { ...emptyBucket, oldestTs: null as number | null };

export const DEMO_USAGE: UsageSummary = {
  buckets: {
    total: { ...emptyBucket },
    last1d: { ...emptyBucket },
    last7d: { ...emptyBucket },
    last30d: { ...emptyBucket },
    thisMonth: { ...emptyBucket },
  },
  currentWindows: {
    last5h: { ...emptyWindow },
    today: { ...emptyWindow },
    last24h: { ...emptyWindow },
    last3d: { ...emptyWindow },
    last7d: { ...emptyWindow },
  },
  byModel: [],
  byProject: [],
  byDay: [],
  stats: {
    activeDays: 0,
    totalDays: 0,
    longestStreak: 0,
    currentStreak: 0,
    mostActiveDay: null,
    longestSessionMs: 0,
    favoriteModel: null,
    firstDay: null,
    lastDay: null,
  },
};

export const DEMO_AUTH: AuthStatus = { loggedIn: false };

export const DEMO_PROFILE = {
  name: '',
  avatarInitial: '',
  avatarGradient: 'from-purple-500 to-blue-500',
};

export const DEMO_RATE_LIMITS: RateLimits = {
  status: null,
  representativeClaim: null,
  fiveHour:  { utilization: null, status: null, reset: null },
  weekly:    { utilization: null, status: null, reset: null },
  overage:   { utilization: null, status: null, reset: null },
};

const emptyConfig = {
  paths: { home: '', claudeDir: '' },
  claudeMd: null as null | { path: string; content: string; mtime: number },
  skills: [] as Array<{ name: string; title: string; description: string; mtime: number; content: string; path: string }>,
  commands: [] as Array<{ name: string; description: string; mtime: number; content: string; path: string }>,
  hooks: [] as Array<{ name: string; mtime: number; content: string; path: string }>,
  plugins: [] as Array<{ name: string; entries: string[]; mtime: number; path: string }>,
  settings: null as null | { path: string; content: string; mtime: number },
};

export const DEMO_CONFIG = emptyConfig;
export const DEMO_CONFIG_CODEX = emptyConfig;
export const DEMO_CONFIGS = {
  claude: emptyConfig,
  codex: emptyConfig,
};
