export type SessionMeta = {
  source: 'claude' | 'codex';
  id: string;
  projectDir: string;
  projectCwd: string;
  decodedCwd: string;
  lastCwd: string;
  filePath: string;
  summary: string;
  firstUser: string;
  firstTs: string | null;
  lastTs: string | null;
  userMsgs: number;
  assistantMsgs: number;
  gitBranch: string;
  model: string;
  version: string;
  tokensIn: number;
  tokensOut: number;
  tokensCacheRead: number;
  tokensCacheCreate: number;
  fileSize: number;
  mtime: number;
  favorite: boolean;
  excluded: boolean;
  alias: string | null;
  // Codex sessions can carry the user's plan tier (pro / free / chatgpt_pro)
  // extracted from session_meta. Claude sessions don't populate this; the
  // field stays undefined.
  planType?: string | null;
  // Set by readSessionMetadataFromDisk when the file exceeds MAX_SESSION_FILE_SIZE
  // so the UI can label the row "too large" rather than empty.
  tooLarge?: boolean;
  error?: string;
};

export type MessageImage = {
  // 'image/png', 'image/jpeg', etc — or the literal 'url' when data is an http(s) URL.
  mediaType: string;
  // Bare base64 payload (no `data:` prefix) for image/* mediaTypes, or the URL
  // string itself when mediaType is 'url'.
  data: string;
};

export type MessageItem = {
  kind: 'user' | 'assistant' | 'summary';
  text: string;
  isToolResult?: boolean;
  isToolUse?: boolean;
  timestamp: string | null;
  model?: string | null;
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } | null;
  // Inline images attached to the message (pasted screenshots, file uploads).
  // Renderer shows them under the text block.
  images?: MessageImage[];
  // Set by the main process when the session's total inline-image payload
  // exceeded the per-session cap and some images were dropped from this or
  // later messages. UI surfaces a banner so the user knows what's missing.
  imagesTruncated?: boolean;
};

export type View = 'sessions' | 'favorites' | 'excluded' | 'usage' | 'config' | 'settings' | 'search';

export type WindowBucket = {
  input: number; output: number; cacheRead: number; cacheCreate: number;
  msgs: number; sessions: number; oldestTs: number | null;
};

export type UsageStats = {
  activeDays: number;
  totalDays: number;
  longestStreak: number;
  currentStreak: number;
  mostActiveDay: string | null;
  longestSessionMs: number;
  favoriteModel: string | null;
  firstDay: string | null;
  lastDay: string | null;
};

export type UsageSummary = {
  buckets: Record<'total' | 'last1d' | 'last7d' | 'last30d' | 'thisMonth', {
    input: number; output: number; cacheRead: number; cacheCreate: number; sessions: number; msgs?: number;
  }>;
  currentWindows: {
    last5h: WindowBucket;
    today: WindowBucket;
    last24h: WindowBucket;
    last3d: WindowBucket;
    last7d: WindowBucket;
  };
  byModel: Array<{ model: string; input: number; output: number; cacheRead: number; cacheCreate: number; sessions: number }>;
  byProject: Array<{ project: string; input: number; output: number; cacheRead: number; cacheCreate: number; sessions: number }>;
  byDay: Array<{ day: string; input: number; output: number; cacheRead: number; cacheCreate: number; sessions: number }>;
  stats: UsageStats;
};

export type ConfigItem = {
  key: string;
  kind: string;
  name: string;
  description: string;
  path: string;
  content: string;
  contentKind: 'md' | 'json' | 'code' | 'dir';
  entries?: string[];
  mtime?: number;
};

// Source-agnostic auth payload. Both Claude (~/.claude/.credentials.json) and Codex
// (~/.codex/auth.json) IPCs map their on-disk shape into this. Don't add
// vendor-specific fields here — surface those through a separate adapter if
// the day comes when one tool exposes data the other can't.
export type AuthStatus = {
  loggedIn: boolean;
  authMethod?: string;
  apiProvider?: string;
  email?: string;
  name?: string | null;
  orgId?: string;
  orgName?: string;
  subscriptionType?: string;
};

export type RateWindow = {
  utilization: number | null;  // 0.0 - 1.0; multiply by 100 for percent
  status: string | null;        // 'allowed' | 'warning' | 'exceeded'
  reset: number | null;         // Unix epoch seconds
};
export type RateLimits = {
  status: string | null;
  representativeClaim: string | null;  // 'five_hour' | 'seven_day' — which window is binding
  fiveHour: RateWindow;
  weekly: RateWindow;
  overage: RateWindow;
};
export type RateLimitsResult =
  | { ok: true; cached: boolean; limits: RateLimits; fetchedAt: number; debug?: unknown }
  | { ok: false; error: 'no-token' | 'unauthorized' | 'no-headers' | 'network' | 'no-data' | 'codex-probe-failed' | 'no-consent'; status?: number; message: string; debug?: unknown };

export type CredentialsLocation = { source: 'file'; path: string } | { source: 'keychain' } | { source: 'none' };

// Workspace / config payload returned by `readConfig` IPC. Both Claude and
// Codex sessions surface roughly the same kinds of resources (root file,
// skills/rules, commands/agents, hooks, plugins, settings), so the shape is
// shared and the source-specific naming lives in the source registry.
export type ConfigEntry = {
  name: string;
  path: string;
  content?: string;
  title?: string;
  description?: string;
  entries?: string[];
  mtime?: number;
};
export type ConfigPayload = {
  paths?: { home?: string; claudeDir?: string };
  claudeMd?: { path: string; content: string; mtime?: number } | null;
  skills?: ConfigEntry[];
  commands?: ConfigEntry[];
  hooks?: ConfigEntry[];
  plugins?: ConfigEntry[];
  settings?: { path: string; content: string; mtime?: number } | null;
};

declare global {
  // Build-time constants injected by Vite's `define`.
  const __APP_VERSION__: string;
  const __GIT_COMMIT__: string;
  const __GIT_BRANCH__: string;
  const __GIT_DATE__: string;

  interface Window {
    api: {
      listSessions: (opts?: { force?: boolean }) => Promise<SessionMeta[]>;
      onSessionsUpdated: (cb: (sessions: SessionMeta[]) => void) => () => void;
      getSession: (filePath: string) => Promise<MessageItem[]>;
      deepSearch: (query: string, source?: 'claude' | 'codex') => Promise<Array<{
        id: string;
        source: 'claude' | 'codex';
        projectDir: string;
        filePath: string;
        snippet: string;
        matchCount: number;
        // Number of distinct query terms this hit matched. Higher = a stronger
        // signal of relevance than raw matchCount (one term matched many times
        // is weaker than three different terms each matched once).
        coverage?: number;
        termCount?: number;
        sources?: { user: number; assistant: number; summary: number; tool: number };
      }>>;
      copyResumeCommand: (cwd: string, id: string, filePath?: string, source?: 'claude' | 'codex') => Promise<string>;
      revealInFinder: (filePath: string) => Promise<void>;
      revealSourceDir: (source: 'claude' | 'codex') => Promise<void>;
      openInVSCode: (cwd: string) => Promise<void>;
      openInTerminal: (cwd: string, id: string, filePath?: string, source?: 'claude' | 'codex') => Promise<void>;
      openInITerm: (cwd: string, id: string, filePath?: string, source?: 'claude' | 'codex') => Promise<void>;
      listFavorites: () => Promise<string[]>;
      toggleFavorite: (source: 'claude' | 'codex', id: string) => Promise<boolean>;
      listExcludes: () => Promise<string[]>;
      toggleExclude: (source: 'claude' | 'codex', id: string) => Promise<boolean>;
      getAliases: () => Promise<Record<string, string>>;
      setAlias: (source: 'claude' | 'codex', id: string, alias: string | null) => Promise<string | null>;
      readConfig: (source?: 'claude' | 'codex') => Promise<ConfigPayload>;
      openConfigFile: (filePath: string) => Promise<void>;
      getUsage: (source?: 'claude' | 'codex') => Promise<UsageSummary>;
      getAuthStatus: (source: 'claude' | 'codex') => Promise<AuthStatus>;
      getRateLimits: (opts?: { force?: boolean; source?: 'claude' | 'codex' }) => Promise<RateLimitsResult>;
      getCredentialsLocation: () => Promise<CredentialsLocation>;
      openExternal: (url: string) => Promise<void>;
      getSystemCapabilities: () => Promise<SystemCapabilities>;
      getAppPrefs: () => Promise<AppPrefs>;
      setAppPrefs: (patch: Partial<Omit<AppPrefs, 'rateLimitsConsent'>>) => Promise<AppPrefs>;
      setRateLimitsConsent: (v: 'pending' | 'granted' | 'denied') => Promise<'pending' | 'granted' | 'denied'>;
      openLogsFolder: () => Promise<string>;
      setTitleBarTheme: (theme: 'light' | 'dark') => Promise<void>;
    };
  }
}

export type TerminalAvailability = {
  terminal: boolean;
  iterm: boolean;
  wt: boolean;
  powershell: boolean;
  cmd: boolean;
};

export type SystemCapabilities = {
  platform: 'darwin' | 'win32' | 'linux' | string;
  terminals: TerminalAvailability;
  aiTools?: {
    claude: { installed: boolean; hasHistory: boolean; hasBinary: boolean };
    codex:  { installed: boolean; hasHistory: boolean; hasBinary: boolean };
  };
};

export type AppPrefs = {
  showTrayIcon: boolean;
  closeBehavior: 'quit' | 'hide';
  launchAtLogin: boolean;
  // Mirrored from renderer's useRateLimitsConsent so main.cjs's IPC gate can
  // refuse Anthropic probes when the user hasn't granted consent yet.
  rateLimitsConsent: 'pending' | 'granted' | 'denied';
};
