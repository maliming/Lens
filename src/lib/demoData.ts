// Demo data for screenshots / marketing. Only mounted when `import.meta.env.DEV`
// AND the demo-mode flag is set in localStorage — packaged builds can never
// switch this on from the UI (the toggle isn't even rendered there).

import type { SessionMeta, MessageItem, UsageSummary, RateLimits, AuthStatus } from '../types';

const DAY = 86400 * 1000;
const HOUR = 3600 * 1000;
// Demo "now" anchors to the moment the app started so Today / Yesterday / This
// Week groupings are always populated regardless of when the demo is opened.
// Trade-off: side-by-side screenshots taken minutes apart will show slightly
// shifted relative times; for marketing screenshots run with a frozen clock or
// the DEMO_BUILD=1 build flag if you need pixel-stable output.
const NOW = Date.now();

const PROJECTS = [
  { dir: '-Users-jordan-work-pulse-api', cwd: '/Users/jordan/work/pulse-api', short: 'pulse-api', branch: 'feat/auth-refactor' },
  { dir: '-Users-jordan-work-pulse-web', cwd: '/Users/jordan/work/pulse-web', short: 'pulse-web', branch: 'main' },
  { dir: '-Users-jordan-side-photo-lab', cwd: '/Users/jordan/side/photo-lab', short: 'photo-lab', branch: 'dev' },
  { dir: '-Users-jordan-tools-claude-lens', cwd: '/Users/jordan/tools/claude-lens', short: 'claude-lens', branch: 'main' },
  { dir: '-Users-jordan-work-pulse-infra', cwd: '/Users/jordan/work/pulse-infra', short: 'pulse-infra', branch: 'terraform-v2' },
  { dir: '-Users-jordan-work-pulse-mobile', cwd: '/Users/jordan/work/pulse-mobile', short: 'pulse-mobile', branch: 'rn-0.74-bump' },
  { dir: '-Users-jordan-work-billing-engine', cwd: '/Users/jordan/work/billing-engine', short: 'billing-engine', branch: 'rewrite/stripe-v3' },
  { dir: '-Users-jordan-tools-vault-cli', cwd: '/Users/jordan/tools/vault-cli', short: 'vault-cli', branch: 'main' },
  { dir: '-Users-jordan-side-notebook-ai', cwd: '/Users/jordan/side/notebook-ai', short: 'notebook-ai', branch: 'embeddings-v2' },
];

type Seed = {
  hAgo: number;
  proj: number;
  summary: string;
  firstUser: string;
  userMsgs: number;
  asstMsgs: number;
  tokensIn: number;
  tokensOut: number;
  tokensCacheRead: number;
  tokensCacheCreate: number;
  model: string;
  fav?: boolean;
};

const SEEDS: Seed[] = [
  { hAgo: 0.4, proj: 0, summary: 'Why does the refresh token endpoint return 401 on retry?', firstUser: 'Why does my refresh token endpoint return 401 on retry?', userMsgs: 22, asstMsgs: 24, tokensIn: 18_400, tokensOut: 9_120, tokensCacheRead: 2_840_000, tokensCacheCreate: 480_000, model: 'claude-opus-4-7', fav: true },
  { hAgo: 1.2, proj: 1, summary: 'Add skeleton loader to the dashboard cards', firstUser: 'Can you add a skeleton loader to the dashboard cards while data is fetching?', userMsgs: 14, asstMsgs: 16, tokensIn: 9_120, tokensOut: 4_700, tokensCacheRead: 1_180_000, tokensCacheCreate: 260_000, model: 'claude-sonnet-4-6' },
  { hAgo: 3.0, proj: 0, summary: 'Migrate users table to UUID primary keys', firstUser: 'I want to migrate the users table from auto-increment to UUID primary keys.', userMsgs: 31, asstMsgs: 33, tokensIn: 28_200, tokensOut: 14_300, tokensCacheRead: 4_100_000, tokensCacheCreate: 720_000, model: 'claude-opus-4-7' },
  { hAgo: 5.5, proj: 4, summary: 'Terraform module for the new staging cluster', firstUser: 'Write a terraform module for the new staging cluster — Postgres + Redis + 2 worker pools.', userMsgs: 18, asstMsgs: 21, tokensIn: 15_900, tokensOut: 7_400, tokensCacheRead: 2_010_000, tokensCacheCreate: 410_000, model: 'claude-sonnet-4-6', fav: true },
  { hAgo: 9, proj: 2, summary: 'EXIF orientation flips images sideways on iOS upload', firstUser: 'Photos uploaded from iOS appear sideways. EXIF orientation handling broken?', userMsgs: 9, asstMsgs: 10, tokensIn: 6_400, tokensOut: 3_120, tokensCacheRead: 820_000, tokensCacheCreate: 160_000, model: 'claude-sonnet-4-6' },
  { hAgo: 14, proj: 3, summary: 'Add command palette with ⌘K — Radix Dialog + cmdk', firstUser: 'I want a ⌘K command palette like Linear. Use Radix Dialog + cmdk?', userMsgs: 11, asstMsgs: 12, tokensIn: 7_800, tokensOut: 3_900, tokensCacheRead: 990_000, tokensCacheCreate: 210_000, model: 'claude-opus-4-7' },
  { hAgo: 22, proj: 0, summary: 'Email confirmation flow rewrite for SES', firstUser: 'Rewrite the email confirmation flow on top of SES instead of Mailgun.', userMsgs: 19, asstMsgs: 21, tokensIn: 12_400, tokensOut: 6_100, tokensCacheRead: 1_660_000, tokensCacheCreate: 320_000, model: 'claude-sonnet-4-6' },
  { hAgo: 28, proj: 1, summary: 'Dark mode bug — chart colors invert wrong way', firstUser: 'Chart axis colors look bad in dark mode — they invert when they should not.', userMsgs: 7, asstMsgs: 8, tokensIn: 4_900, tokensOut: 2_500, tokensCacheRead: 540_000, tokensCacheCreate: 110_000, model: 'claude-haiku-4-5-20251001' },
  { hAgo: 36, proj: 4, summary: 'Rotate IAM keys without downtime on the worker fleet', firstUser: 'How do I rotate IAM keys for the worker fleet without taking the queue down?', userMsgs: 13, asstMsgs: 14, tokensIn: 8_700, tokensOut: 4_200, tokensCacheRead: 1_120_000, tokensCacheCreate: 240_000, model: 'claude-opus-4-7' },
  { hAgo: 48, proj: 2, summary: 'Add WebP encoder option to the export pipeline', firstUser: 'Add a WebP encoder option to the export pipeline with quality slider.', userMsgs: 8, asstMsgs: 9, tokensIn: 5_400, tokensOut: 2_800, tokensCacheRead: 690_000, tokensCacheCreate: 140_000, model: 'claude-sonnet-4-6' },
  { hAgo: 56, proj: 0, summary: 'Convert dashboard queries from SUM(CASE WHEN) to FILTER', firstUser: 'Rewrite our dashboard aggregates from SUM(CASE WHEN ... THEN 1 END) to FILTER syntax.', userMsgs: 6, asstMsgs: 7, tokensIn: 3_900, tokensOut: 2_100, tokensCacheRead: 510_000, tokensCacheCreate: 95_000, model: 'claude-sonnet-4-6' },
  { hAgo: 70, proj: 3, summary: 'Replace context-drilling with zustand for the editor state', firstUser: 'Drill prop hell is killing the editor. Time to introduce zustand for editor state?', userMsgs: 16, asstMsgs: 18, tokensIn: 10_800, tokensOut: 5_400, tokensCacheRead: 1_390_000, tokensCacheCreate: 290_000, model: 'claude-opus-4-7' },
  { hAgo: 84, proj: 1, summary: 'Onboarding flow A/B test plumbing', firstUser: 'Plumb the new 3-step onboarding through GrowthBook with a 50/50 split.', userMsgs: 12, asstMsgs: 13, tokensIn: 8_100, tokensOut: 4_000, tokensCacheRead: 1_020_000, tokensCacheCreate: 230_000, model: 'claude-sonnet-4-6' },
  { hAgo: 96, proj: 4, summary: 'CloudFront cache invalidation on deploy is too slow', firstUser: 'Our deploys wait 6+ minutes for CloudFront invalidations. Can we batch / parallelize?', userMsgs: 10, asstMsgs: 11, tokensIn: 6_700, tokensOut: 3_300, tokensCacheRead: 870_000, tokensCacheCreate: 180_000, model: 'claude-sonnet-4-6' },
  { hAgo: 110, proj: 2, summary: 'Bulk-edit photo metadata via CSV import', firstUser: 'Need a bulk-edit flow — upload CSV with photo_id, caption, tags — preview diff before commit.', userMsgs: 21, asstMsgs: 23, tokensIn: 14_800, tokensOut: 7_500, tokensCacheRead: 1_910_000, tokensCacheCreate: 390_000, model: 'claude-opus-4-7', fav: true },
  { hAgo: 130, proj: 0, summary: 'Permission system — role inheritance and overrides', firstUser: 'Design a permission system that supports role inheritance plus per-resource overrides.', userMsgs: 24, asstMsgs: 26, tokensIn: 19_200, tokensOut: 9_900, tokensCacheRead: 2_540_000, tokensCacheCreate: 510_000, model: 'claude-opus-4-7' },
  { hAgo: 155, proj: 3, summary: 'Resizable panes with persisted widths', firstUser: 'Make the 3-pane layout resizable, persist widths to localStorage.', userMsgs: 9, asstMsgs: 10, tokensIn: 6_100, tokensOut: 3_100, tokensCacheRead: 790_000, tokensCacheCreate: 160_000, model: 'claude-sonnet-4-6' },
  { hAgo: 180, proj: 1, summary: 'Move from REST to tRPC for the internal API', firstUser: 'Pros / cons of moving the internal API from REST to tRPC?', userMsgs: 15, asstMsgs: 17, tokensIn: 11_100, tokensOut: 5_700, tokensCacheRead: 1_440_000, tokensCacheCreate: 310_000, model: 'claude-opus-4-7' },
  { hAgo: 210, proj: 4, summary: 'Postgres connection pooling — pgbouncer vs RDS Proxy', firstUser: 'Pick between pgbouncer self-hosted vs RDS Proxy for our worker fleet — cost + reliability tradeoffs.', userMsgs: 11, asstMsgs: 12, tokensIn: 7_400, tokensOut: 3_700, tokensCacheRead: 950_000, tokensCacheCreate: 200_000, model: 'claude-sonnet-4-6' },
  { hAgo: 260, proj: 0, summary: 'Soft delete vs hard delete for billing records', firstUser: 'Should billing records be soft-deleted? What does our auditor expect?', userMsgs: 5, asstMsgs: 6, tokensIn: 3_100, tokensOut: 1_700, tokensCacheRead: 410_000, tokensCacheCreate: 85_000, model: 'claude-haiku-4-5-20251001' },
  { hAgo: 2.1, proj: 5, summary: 'RN 0.74 bump breaks Hermes on Android', firstUser: 'After bumping to RN 0.74 the Android Hermes build crashes at startup. iOS is fine.', userMsgs: 20, asstMsgs: 22, tokensIn: 16_200, tokensOut: 8_400, tokensCacheRead: 2_140_000, tokensCacheCreate: 420_000, model: 'claude-opus-4-7' },
  { hAgo: 6.7, proj: 6, summary: 'Stripe webhook signature mismatch in test mode', firstUser: 'Stripe test webhooks fail signature verification — live mode works.', userMsgs: 10, asstMsgs: 11, tokensIn: 6_900, tokensOut: 3_600, tokensCacheRead: 880_000, tokensCacheCreate: 170_000, model: 'claude-sonnet-4-6' },
  { hAgo: 11, proj: 1, summary: 'Chart legend cut off on small viewport', firstUser: 'Legend on the dashboard chart gets cut off below 1024px. Make it wrap or stack.', userMsgs: 6, asstMsgs: 7, tokensIn: 4_200, tokensOut: 2_200, tokensCacheRead: 540_000, tokensCacheCreate: 110_000, model: 'claude-sonnet-4-6' },
  { hAgo: 18, proj: 0, summary: 'GraphQL N+1 on user.workspaces resolver', firstUser: 'Our /me query takes 1.2s — N+1 on user.workspaces. Need a DataLoader.', userMsgs: 15, asstMsgs: 17, tokensIn: 10_400, tokensOut: 5_500, tokensCacheRead: 1_360_000, tokensCacheCreate: 280_000, model: 'claude-opus-4-7', fav: true },
  { hAgo: 25, proj: 7, summary: 'Vault CLI: support OIDC login alongside token', firstUser: 'Add `vault-cli login --oidc` so we can stop pasting raw tokens.', userMsgs: 12, asstMsgs: 13, tokensIn: 7_800, tokensOut: 4_100, tokensCacheRead: 1_010_000, tokensCacheCreate: 220_000, model: 'claude-sonnet-4-6' },
  { hAgo: 40, proj: 8, summary: 'Switching embeddings from ada-002 to text-embedding-3-large', firstUser: 'Migrate the notebook embeddings from ada-002 to text-embedding-3-large. Cost vs recall?', userMsgs: 18, asstMsgs: 20, tokensIn: 13_400, tokensOut: 6_900, tokensCacheRead: 1_740_000, tokensCacheCreate: 360_000, model: 'claude-opus-4-7' },
  { hAgo: 62, proj: 6, summary: 'Idempotency keys for the billing retry path', firstUser: 'Add idempotency keys to charge attempts so retries do not double-bill.', userMsgs: 14, asstMsgs: 15, tokensIn: 9_200, tokensOut: 4_800, tokensCacheRead: 1_190_000, tokensCacheCreate: 250_000, model: 'claude-opus-4-7' },
  { hAgo: 80, proj: 2, summary: 'Photo de-duplication via perceptual hash', firstUser: 'I want to dedupe uploads with phash so re-uploading the same photo merges.', userMsgs: 11, asstMsgs: 12, tokensIn: 6_700, tokensOut: 3_400, tokensCacheRead: 860_000, tokensCacheCreate: 180_000, model: 'claude-sonnet-4-6' },
  { hAgo: 105, proj: 5, summary: 'Add biometric unlock to the mobile app', firstUser: 'Add Face ID / Touch ID unlock for the mobile app. Fallback to PIN if disabled.', userMsgs: 16, asstMsgs: 18, tokensIn: 11_200, tokensOut: 5_800, tokensCacheRead: 1_450_000, tokensCacheCreate: 300_000, model: 'claude-opus-4-7' },
  { hAgo: 140, proj: 0, summary: 'Postgres advisory locks for the migration runner', firstUser: 'Two services run db migrations on boot — needs an advisory lock so only one wins.', userMsgs: 9, asstMsgs: 10, tokensIn: 5_900, tokensOut: 3_000, tokensCacheRead: 760_000, tokensCacheCreate: 160_000, model: 'claude-sonnet-4-6' },
  { hAgo: 175, proj: 1, summary: 'Migrate analytics from Segment to PostHog', firstUser: 'Cost-cutting — move analytics events from Segment to PostHog self-hosted.', userMsgs: 14, asstMsgs: 15, tokensIn: 9_600, tokensOut: 4_900, tokensCacheRead: 1_240_000, tokensCacheCreate: 260_000, model: 'claude-opus-4-7' },
  { hAgo: 230, proj: 8, summary: 'Streaming chat response with partial JSON repair', firstUser: 'Our chat UI breaks on partial JSON streams. Need a tolerant parser.', userMsgs: 10, asstMsgs: 11, tokensIn: 6_400, tokensOut: 3_200, tokensCacheRead: 820_000, tokensCacheCreate: 170_000, model: 'claude-sonnet-4-6' },
  { hAgo: 280, proj: 4, summary: 'Spot instance fallback for the worker fleet', firstUser: 'Half our workers are on spot — need on-demand fallback when spot is reclaimed.', userMsgs: 13, asstMsgs: 14, tokensIn: 8_300, tokensOut: 4_300, tokensCacheRead: 1_080_000, tokensCacheCreate: 230_000, model: 'claude-opus-4-7' },
  { hAgo: 310, proj: 3, summary: 'Replace `useEffect` polling with SWR focus revalidation', firstUser: 'Our list view polls every 5s. Move to SWR with focus revalidation.', userMsgs: 7, asstMsgs: 8, tokensIn: 4_500, tokensOut: 2_400, tokensCacheRead: 590_000, tokensCacheCreate: 120_000, model: 'claude-haiku-4-5-20251001' },
  { hAgo: 360, proj: 6, summary: 'PCI scope — separate card-data service from main API', firstUser: 'Auditor wants card data isolated. How small can the PCI-in-scope service be?', userMsgs: 22, asstMsgs: 24, tokensIn: 16_400, tokensOut: 8_200, tokensCacheRead: 2_080_000, tokensCacheCreate: 430_000, model: 'claude-opus-4-7', fav: true },
];

function makeId(i: number): string {
  // Stable deterministic UUID-ish ids so demo state survives reloads cleanly.
  const hex = (i * 0x9e3779b1 >>> 0).toString(16).padStart(8, '0');
  return `${hex}-demo-4${(i & 0xfff).toString(16).padStart(3, '0')}-9${((i * 7) & 0xfff).toString(16).padStart(3, '0')}-${hex.repeat(3).slice(0, 12)}`;
}

// Codex-flavored seeds. CLI / shell / refactor / pytest jobs — Codex's wheelhouse
// in the real product. Distinct model pool too (gpt-5-codex / gpt-5 / o4-mini)
// so the UI obviously switches when the user flips the source selector.
const CODEX_SEEDS: Seed[] = [
  { hAgo: 0.8, proj: 0, summary: 'Refactor billing handler into smaller services', firstUser: 'Refactor the billing webhook handler — it\'s 600 lines, split by event type.', userMsgs: 17, asstMsgs: 19, tokensIn: 22_400, tokensOut: 11_200, tokensCacheRead: 0, tokensCacheCreate: 0, model: 'gpt-5-codex', fav: true },
  { hAgo: 4.2, proj: 3, summary: 'Port shell scripts from bash to fish', firstUser: 'Convert my ~/bin scripts from bash to fish — keep behavior identical.', userMsgs: 8, asstMsgs: 9, tokensIn: 6_800, tokensOut: 3_400, tokensCacheRead: 0, tokensCacheCreate: 0, model: 'gpt-5' },
  { hAgo: 11, proj: 1, summary: 'Add pytest fixtures for the recommendation pipeline', firstUser: 'Add pytest fixtures + parametrize for the recommendation pipeline tests.', userMsgs: 13, asstMsgs: 15, tokensIn: 9_800, tokensOut: 5_100, tokensCacheRead: 0, tokensCacheCreate: 0, model: 'gpt-5-codex' },
  { hAgo: 19, proj: 4, summary: 'Generate a Makefile that mirrors the GitHub Actions matrix', firstUser: 'Reverse-engineer a Makefile from .github/workflows/ci.yml so I can run locally.', userMsgs: 6, asstMsgs: 7, tokensIn: 4_400, tokensOut: 2_300, tokensCacheRead: 0, tokensCacheCreate: 0, model: 'o4-mini' },
  { hAgo: 32, proj: 0, summary: 'Fix mypy strict errors in the auth package', firstUser: 'Run mypy --strict on src/auth and fix what comes up.', userMsgs: 19, asstMsgs: 21, tokensIn: 14_200, tokensOut: 7_400, tokensCacheRead: 0, tokensCacheCreate: 0, model: 'gpt-5-codex', fav: true },
  { hAgo: 52, proj: 2, summary: 'Vectorize the EXIF batch reader', firstUser: 'Speed up scripts/scan_photos.py — currently 4 min for 12k photos.', userMsgs: 11, asstMsgs: 13, tokensIn: 7_600, tokensOut: 3_900, tokensCacheRead: 0, tokensCacheCreate: 0, model: 'gpt-5' },
  { hAgo: 75, proj: 4, summary: 'Lambda cold start audit — reduce p99 by 40%', firstUser: 'Our payments lambda cold-starts at 2.4s p99. Audit and trim.', userMsgs: 14, asstMsgs: 16, tokensIn: 10_400, tokensOut: 5_300, tokensCacheRead: 0, tokensCacheCreate: 0, model: 'gpt-5-codex' },
  { hAgo: 120, proj: 3, summary: 'Migrate Jest snapshot tests to Vitest inline', firstUser: 'Move from jest --updateSnapshot to vitest expect inline. Keep diffs reviewable.', userMsgs: 9, asstMsgs: 10, tokensIn: 5_800, tokensOut: 3_000, tokensCacheRead: 0, tokensCacheCreate: 0, model: 'gpt-5' },
  { hAgo: 200, proj: 1, summary: 'Codemod removing implicit any in legacy services', firstUser: 'jscodeshift codemod to remove implicit any across services/* — preserve behavior.', userMsgs: 12, asstMsgs: 14, tokensIn: 9_100, tokensOut: 4_700, tokensCacheRead: 0, tokensCacheCreate: 0, model: 'gpt-5-codex' },
  { hAgo: 1.5, proj: 5, summary: 'iOS Hermes crash — pinpoint the offending native module', firstUser: 'Hermes startup crash after RN bump — narrow it to the native module.', userMsgs: 22, asstMsgs: 24, tokensIn: 18_300, tokensOut: 9_400, tokensCacheRead: 0, tokensCacheCreate: 0, model: 'gpt-5-codex' },
  { hAgo: 5.2, proj: 7, summary: 'Generate manpages for vault-cli subcommands', firstUser: 'Generate man pages from the cobra subcommand tree under cmd/.', userMsgs: 9, asstMsgs: 10, tokensIn: 5_800, tokensOut: 3_000, tokensCacheRead: 0, tokensCacheCreate: 0, model: 'gpt-5' },
  { hAgo: 14, proj: 8, summary: 'Async batch driver for the embedding pipeline', firstUser: 'Rewrite embed_batch.py to call OpenAI async with backoff + 50-row batches.', userMsgs: 15, asstMsgs: 17, tokensIn: 11_900, tokensOut: 6_200, tokensCacheRead: 0, tokensCacheCreate: 0, model: 'gpt-5-codex', fav: true },
  { hAgo: 26, proj: 6, summary: 'Stripe v3 → idempotency replay test suite', firstUser: 'Write pytest cases that hammer the new charge handler with replays.', userMsgs: 13, asstMsgs: 15, tokensIn: 9_200, tokensOut: 4_900, tokensCacheRead: 0, tokensCacheCreate: 0, model: 'gpt-5' },
  { hAgo: 42, proj: 1, summary: 'Tighten lint rules: no-floating-promises across web', firstUser: 'Add @typescript-eslint/no-floating-promises in error mode and fix all the bites.', userMsgs: 10, asstMsgs: 12, tokensIn: 7_200, tokensOut: 3_800, tokensCacheRead: 0, tokensCacheCreate: 0, model: 'gpt-5-codex' },
  { hAgo: 64, proj: 4, summary: 'Helm chart for the new sidecar log shipper', firstUser: 'Write a helm chart for the log shipper sidecar — values for image, queue, retries.', userMsgs: 11, asstMsgs: 12, tokensIn: 7_400, tokensOut: 3_700, tokensCacheRead: 0, tokensCacheCreate: 0, model: 'o4-mini' },
  { hAgo: 88, proj: 0, summary: 'Backfill script: rebuild user_search_index', firstUser: 'Script to rebuild user_search_index from users + workspaces in chunked batches.', userMsgs: 8, asstMsgs: 9, tokensIn: 5_400, tokensOut: 2_900, tokensCacheRead: 0, tokensCacheCreate: 0, model: 'gpt-5' },
  { hAgo: 150, proj: 2, summary: 'Add CLI flag to skip EXIF rotate for batch reruns', firstUser: 'Add --no-rotate so re-running scan_photos.py is idempotent on already-rotated files.', userMsgs: 7, asstMsgs: 8, tokensIn: 4_400, tokensOut: 2_300, tokensCacheRead: 0, tokensCacheCreate: 0, model: 'gpt-5-codex' },
  { hAgo: 220, proj: 8, summary: 'Add tracing spans around the embedding cache', firstUser: 'Wrap the embedding cache get/set in OTEL spans with cache_hit attribute.', userMsgs: 10, asstMsgs: 11, tokensIn: 6_800, tokensOut: 3_500, tokensCacheRead: 0, tokensCacheCreate: 0, model: 'gpt-5' },
  { hAgo: 290, proj: 5, summary: 'Detox e2e: cold-start screen recording on iOS sim', firstUser: 'Detox script that boots the app, records the cold start, and uploads to S3.', userMsgs: 9, asstMsgs: 10, tokensIn: 5_700, tokensOut: 3_000, tokensCacheRead: 0, tokensCacheCreate: 0, model: 'gpt-5-codex' },
  { hAgo: 340, proj: 3, summary: 'Migrate ESLint config to flat-config format', firstUser: 'Move .eslintrc.cjs to eslint.config.js (flat config). Preserve every rule.', userMsgs: 6, asstMsgs: 7, tokensIn: 3_900, tokensOut: 2_100, tokensCacheRead: 0, tokensCacheCreate: 0, model: 'o4-mini' },
];

function pad2(n: number) { return n.toString().padStart(2, '0'); }

function buildSession(seed: Seed, i: number, source: 'claude' | 'codex'): SessionMeta {
  const p = PROJECTS[seed.proj];
  const lastTs = new Date(NOW - seed.hAgo * HOUR);
  const firstTs = new Date(lastTs.getTime() - (seed.userMsgs + seed.asstMsgs) * 90 * 1000);
  const id = makeId(source === 'codex' ? i + 1000 : i);
  // Each source writes JSONL into a different on-disk layout.
  const filePath = source === 'codex'
    ? `/Users/jordan/.codex/sessions/${lastTs.getFullYear()}/${pad2(lastTs.getMonth() + 1)}/${pad2(lastTs.getDate())}/rollout-${id}.jsonl`
    : `/Users/jordan/.claude/projects/${p.dir}/${id}.jsonl`;
  return {
    source,
    id,
    projectDir: p.dir,
    projectCwd: p.cwd,
    decodedCwd: p.cwd,
    lastCwd: p.cwd,
    filePath,
    summary: seed.summary,
    firstUser: seed.firstUser,
    firstTs: firstTs.toISOString(),
    lastTs: lastTs.toISOString(),
    userMsgs: seed.userMsgs,
    assistantMsgs: seed.asstMsgs,
    gitBranch: p.branch,
    model: seed.model,
    version: source === 'codex' ? '0.20.0' : '0.4.12',
    tokensIn: seed.tokensIn,
    tokensOut: seed.tokensOut,
    tokensCacheRead: seed.tokensCacheRead,
    tokensCacheCreate: seed.tokensCacheCreate,
    fileSize: 120_000 + i * 4_000,
    mtime: lastTs.getTime(),
    favorite: !!seed.fav,
    excluded: false,
    alias: null,
  };
}

export const DEMO_SESSIONS: SessionMeta[] = [
  ...SEEDS.map((seed, i) => buildSession(seed, i, 'claude')),
  ...CODEX_SEEDS.map((seed, i) => buildSession(seed, i, 'codex')),
];

// One realistic-looking conversation reused for all demo sessions. Markdown body
// shows mixed code / list / quote so screenshots cover the formatting surface.
const DEMO_MSG_TEMPLATE: MessageItem[] = [
  {
    kind: 'user',
    text: 'Why does my refresh token endpoint return 401 on retry? The token still has 30 minutes left on it according to the JWT exp.\n\nHere is the response I am getting:',
    timestamp: new Date(NOW - 25 * 60 * 1000).toISOString(),
    model: null,
    usage: null,
    images: [
      { mediaType: 'url', data: 'https://placehold.co/640x140/0f1729/ef4444/png?text=HTTP+401+Unauthorized' },
    ],
  },
  {
    kind: 'assistant',
    text: `Most likely the **refresh token is being rotated** on each use and your client is still presenting the old one. Two quick checks:

1. Does \`POST /auth/refresh\` issue a new refresh token in its response? Look for a \`set-cookie: refresh_token=...\` or a body field.
2. Is the client retrying with the *previous* refresh token after a partial failure?

If both are yes, the second retry is rejected because the first call already invalidated that token. Standard OAuth2 rotation behavior.

A minimal fix is to mark the request as in-flight and let only one retry win:

\`\`\`ts
let inflight: Promise<Tokens> | null = null;
export function refresh(): Promise<Tokens> {
  if (inflight) return inflight;
  inflight = api.post('/auth/refresh').finally(() => { inflight = null; });
  return inflight;
}
\`\`\`

Want me to look at how the interceptor is wired up?`,
    timestamp: new Date(NOW - 24 * 60 * 1000).toISOString(),
    model: 'claude-opus-4-7',
    usage: { input_tokens: 1840, output_tokens: 412, cache_read_input_tokens: 18400, cache_creation_input_tokens: 0 },
  },
  {
    kind: 'user',
    text: 'Yes, let me show you the axios interceptor.',
    timestamp: new Date(NOW - 23 * 60 * 1000).toISOString(),
    model: null,
    usage: null,
  },
  {
    kind: 'assistant',
    text: 'Drop it in, I\'ll read it and trace the retry path.',
    timestamp: new Date(NOW - 22 * 60 * 1000).toISOString(),
    model: 'claude-opus-4-7',
    usage: { input_tokens: 90, output_tokens: 22, cache_read_input_tokens: 19000, cache_creation_input_tokens: 0 },
  },
  {
    kind: 'assistant',
    isToolUse: true,
    text: '[Tool: Read]\n{\n  "file_path": "/Users/jordan/work/pulse-api/src/auth/interceptor.ts"\n}',
    timestamp: new Date(NOW - 21 * 60 * 1000).toISOString(),
    model: 'claude-opus-4-7',
    usage: null,
  },
  {
    kind: 'user',
    isToolResult: true,
    text: `1  import axios from 'axios';
2  import { getRefresh, storeRefresh } from './storage';
3
4  const http = axios.create({ baseURL: '/api' });
5
6  http.interceptors.response.use(
7    r => r,
8    async error => {
9      if (error.response?.status !== 401) throw error;
10     const old = getRefresh();
11     const { data } = await axios.post('/api/auth/refresh', { token: old });
12     storeRefresh(data.refresh);
13     error.config.headers.Authorization = 'Bearer ' + data.access;
14     return http.request(error.config);
15   }
16 );`,
    timestamp: new Date(NOW - 21 * 60 * 1000 + 5000).toISOString(),
    model: null,
    usage: null,
  },
  {
    kind: 'assistant',
    text: `Found it. The interceptor calls \`/auth/refresh\` directly on every 401 without dedup. Two concurrent 401s race — both read the same \`old\` refresh token, both POST it, the second one comes back 401 because the first already rotated it.

Fix is the in-flight dedup I sketched earlier, applied at the interceptor level:

\`\`\`ts
let inflight: Promise<{ access: string; refresh: string }> | null = null;

http.interceptors.response.use(
  r => r,
  async error => {
    if (error.response?.status !== 401) throw error;
    if (!inflight) {
      const old = getRefresh();
      inflight = axios.post('/api/auth/refresh', { token: old })
        .then(r => r.data)
        .finally(() => { inflight = null; });
    }
    const { access, refresh } = await inflight;
    storeRefresh(refresh);
    error.config.headers.Authorization = 'Bearer ' + access;
    return http.request(error.config);
  },
);
\`\`\`

Three things this gives you:

- **No racing refresh calls** — N parallel 401s collapse into one \`/auth/refresh\` POST
- **All retries share the new access token** — they all await the same promise
- **\`inflight\` clears on success or failure** — next 401 starts a fresh round

> **Note:** if you also have logout-on-refresh-failure behavior, wrap the await in try/catch and clear local state on rejection.

Worth adding a Vitest case that hits the endpoint twice in parallel to lock in the dedup.`,
    timestamp: new Date(NOW - 20 * 60 * 1000).toISOString(),
    model: 'claude-opus-4-7',
    usage: { input_tokens: 2400, output_tokens: 690, cache_read_input_tokens: 28000, cache_creation_input_tokens: 1200 },
  },
  {
    kind: 'user',
    text: 'Beautiful, that explains the intermittent failure pattern QA was seeing. Adding the test now.',
    timestamp: new Date(NOW - 18 * 60 * 1000).toISOString(),
    model: null,
    usage: null,
  },
];

// Three more demo conversations so switching sessions in demo mode shows
// visibly different content. Each session is mapped to one of the templates
// by its seed index — stable, so the same session always shows the same chat.
const TEMPLATE_SKELETON: MessageItem[] = [
  {
    kind: 'user',
    text: 'Can you add a skeleton loader to the dashboard cards while data is fetching? Right now they pop in cold and it feels janky.',
    timestamp: new Date(NOW - 15 * 60 * 1000).toISOString(),
    model: null,
    usage: null,
  },
  {
    kind: 'assistant',
    text: `Sure. The cleanest way is to render a parallel \`<DashboardCardSkeleton />\` while \`isLoading\` is true and crossfade once data lands:

\`\`\`tsx
function DashboardCard({ id }: { id: string }) {
  const { data, isLoading } = useDashboardCard(id);
  return (
    <div className="card">
      {isLoading ? <DashboardCardSkeleton /> : <DashboardCardBody data={data!} />}
    </div>
  );
}
\`\`\`

The skeleton itself: just shaped divs with a shimmer animation. Two tips:

- **Match real dimensions** — same width/height/padding as the real card. Otherwise you get a layout shift when data arrives.
- **No staggered delays.** Skeletons that animate in look fancier but you're showing them for 200ms; the wow factor is wasted.

Want me to wire it through to all 6 dashboard cards?`,
    timestamp: new Date(NOW - 14 * 60 * 1000).toISOString(),
    model: 'claude-sonnet-4-6',
    usage: { input_tokens: 1240, output_tokens: 318, cache_read_input_tokens: 8200, cache_creation_input_tokens: 0 },
  },
  {
    kind: 'user',
    text: 'Yeah, all 6 — and please match the existing border-radius so the transition looks clean.',
    timestamp: new Date(NOW - 13 * 60 * 1000).toISOString(),
    model: null,
    usage: null,
  },
  {
    kind: 'assistant',
    text: 'On it. I\'ll grep for the card border-radius token first, then apply the skeleton uniformly.',
    timestamp: new Date(NOW - 12 * 60 * 1000).toISOString(),
    model: 'claude-sonnet-4-6',
    usage: { input_tokens: 60, output_tokens: 28, cache_read_input_tokens: 9500, cache_creation_input_tokens: 0 },
  },
];

const TEMPLATE_EXIF: MessageItem[] = [
  {
    kind: 'user',
    text: 'Photos uploaded from iOS appear sideways in the gallery. Older Androids look fine. EXIF orientation handling broken?',
    timestamp: new Date(NOW - 9 * 3600 * 1000).toISOString(),
    model: null,
    usage: null,
  },
  {
    kind: 'assistant',
    text: `Almost certainly EXIF orientation. iOS writes the orientation tag (1–8) instead of physically rotating the pixel buffer; browsers don't auto-respect the tag in \`<img>\` unless you set \`image-orientation: from-image\`, and on the server side you need to bake the rotation in before storage.

Two paths:

1. **Display-only fix (quick):** add \`img { image-orientation: from-image; }\` globally. Works in modern browsers. Doesn't fix downstream image processing.
2. **Server-side rotate-and-strip (correct):** use \`sharp(buf).rotate()\` — \`rotate\` with no args reads EXIF and physically rotates, then strips the tag. Do this in the upload pipeline before you write to S3.

Option 2 is the one you want — otherwise every consumer (thumbnailer, ML model, watermark service) has to re-implement this.

\`\`\`ts
import sharp from 'sharp';
const normalized = await sharp(uploadBuffer)
  .rotate()        // EXIF-aware rotate + strip
  .withMetadata({ orientation: 1 })  // belt and braces
  .toBuffer();
await s3.putObject({ Key: key, Body: normalized });
\`\`\`

Want me to backfill the existing S3 objects too?`,
    timestamp: new Date(NOW - 9 * 3600 * 1000 + 60_000).toISOString(),
    model: 'claude-sonnet-4-6',
    usage: { input_tokens: 1620, output_tokens: 412, cache_read_input_tokens: 11400, cache_creation_input_tokens: 850 },
  },
  {
    kind: 'user',
    text: 'Yes please — there are about 80K objects. Cheapest way?',
    timestamp: new Date(NOW - 9 * 3600 * 1000 + 120_000).toISOString(),
    model: null,
    usage: null,
  },
  {
    kind: 'assistant',
    text: `80K objects via SQS + a Lambda doing the sharp rotate is cheapest:

- **Queue:** dump all keys into an SQS queue (one-time script). ~$0.40 for that many messages.
- **Worker:** Lambda triggered by SQS, batch size 10, downloads → \`sharp.rotate\` → uploads back, deletes the SQS message. At 256 MB / 200ms per image, you're looking at ~$3 in compute.
- **Idempotency:** skip if EXIF orientation is already 1 (so re-runs are free).

You don't need Fargate or Batch for this — 80K is a small fleet.

> **Heads-up:** if any object is referenced by a CDN cache, you'll want to invalidate after the rewrite, or use a new object key and update the row in the DB pointing to it. Otherwise the rotated copy won't be visible for hours.`,
    timestamp: new Date(NOW - 9 * 3600 * 1000 + 180_000).toISOString(),
    model: 'claude-sonnet-4-6',
    usage: { input_tokens: 1840, output_tokens: 380, cache_read_input_tokens: 12800, cache_creation_input_tokens: 1100 },
  },
];

const TEMPLATE_TERRAFORM: MessageItem[] = [
  {
    kind: 'user',
    text: 'Write a terraform module for the new staging cluster — Postgres + Redis + 2 worker pools. RDS multi-AZ, ElastiCache single node is fine for staging.',
    timestamp: new Date(NOW - 5 * 3600 * 1000).toISOString(),
    model: null,
    usage: null,
  },
  {
    kind: 'assistant',
    text: `Here's a minimal module layout that keeps env-specific knobs in the caller:

\`\`\`hcl
# modules/cluster/main.tf
module "vpc" {
  source  = "terraform-aws-modules/vpc/aws"
  version = "~> 5.5"
  name    = "\${var.env}-cluster"
  cidr    = var.vpc_cidr
  azs     = var.azs
  private_subnets = var.private_subnets
  public_subnets  = var.public_subnets
  enable_nat_gateway = true
  single_nat_gateway = var.env == "staging"  # save $$ in staging
}

resource "aws_db_instance" "postgres" {
  identifier             = "\${var.env}-postgres"
  engine                 = "postgres"
  engine_version         = "16.4"
  instance_class         = var.db_instance_class
  allocated_storage      = 100
  storage_encrypted      = true
  multi_az               = var.env == "production"
  backup_retention_period = var.env == "production" ? 30 : 7
  vpc_security_group_ids = [aws_security_group.db.id]
  db_subnet_group_name   = aws_db_subnet_group.this.name
  deletion_protection    = var.env == "production"
}

resource "aws_elasticache_cluster" "redis" {
  cluster_id           = "\${var.env}-redis"
  engine               = "redis"
  node_type            = var.cache_node_type
  num_cache_nodes      = 1
  parameter_group_name = "default.redis7"
  port                 = 6379
  subnet_group_name    = aws_elasticache_subnet_group.this.name
  security_group_ids   = [aws_security_group.cache.id]
}
\`\`\`

For the 2 worker pools, use \`aws_ecs_service\` (or EKS \`kubernetes_deployment\`) with separate task definitions per pool so you can scale them independently.

Want me to also stub out the workers + autoscaling, or is that a separate module?`,
    timestamp: new Date(NOW - 5 * 3600 * 1000 + 90_000).toISOString(),
    model: 'claude-sonnet-4-6',
    usage: { input_tokens: 2940, output_tokens: 720, cache_read_input_tokens: 18200, cache_creation_input_tokens: 1800 },
  },
  {
    kind: 'user',
    text: 'Same module. Add worker pools.',
    timestamp: new Date(NOW - 5 * 3600 * 1000 + 240_000).toISOString(),
    model: null,
    usage: null,
  },
];

// Two tiny inline PNGs generated programmatically — show how attached
// screenshots render. 120x80 each, no external assets.
const DEMO_IMG_PURPLE = 'iVBORw0KGgoAAAANSUhEUgAAAHgAAABQCAYAAADSm7GJAAAFAUlEQVR4nO3ZaXNPdwDFca/LUvuuttpqq31XantkKVpLVRWtXUJCQkJCQkJCQkJC0tqXVg+K0lbb13A6/ztzZ+783HvPGE/Pg/MKPs/Ot8vqrv9xTbd/o63t/g/XdX/LdT3e8ssef3P9R38Vhg09/8TGnm+wsdcbfNXrNb7u/Ue0TX1eYXOfl9zc9yW39H3Brf1+j/ZN/+fc1v8Ztw14xm8HPMX2gYj23aDfsGPQE+wY/ATfD/4VO4f8Uhh3DX3M3UMfcfewR/xh2EP++PGDaHuG3+fe4fewd8Q97BtxF/tH3ol2YNRtHBx1CwdH38Kh0T/z8Cc/RSsa08niMR0sHtvBI2Nv8ui4G4WhZHw7Sse3oXRCG45NuI7jn16LVjaxFeUTW1g+qYUnJl3lyclXolVMaWbllCZWTm3iqamXcfqzS9GqpjWieloDqqc34Mz0izg740JhrJlZz9qZdaydVcdzs87z/Oxz0erm1LJ+Tg3q59bgwtyzuDjvTLSG+dVonF+FxgVVuLTgNC8vPBWtaVElmxdVsHlxBa8sPsmrn58oDC1LytG6pAytS8twbelxXP/iWLS2ZaVoX1bC9uUlvLH8KG+uOBKtY2UxO1cWsXNVEbsIYAhgCmAIYApgCGAKYAhgCmAIYApgCGAKYAhgCmDkAUMAUwBDAFMAQwBTAEMAUwBDAFMAQwBTAEMAUwAjDxgCmAIYApgCGAKYAhgCmAIYApgCGAKYApgCGHnAEMAUwBDAFMAQwBTAEMAUwBDAFMAQwBTAEMAUwMgDhgCmAIYApgCGAKYAhgCmAIYApgCGAKYApgCGAEYeMAQwBTAEMAUwBDAFMAQwBTAEMAUwBDAFMAUwBDDygCGAKYAhgCmAIYApgCGAKYAhgCmAIYApgCGAKYCRBwwBTAEMAUwBDAFMAQwBTAEMAUwBDAFMAUwBDAFMAYwPAaYAhgCmAIYApgCGAKYAhgCmAIYApgCGAKYAhgBmHjAFMAQwBTAEMAUwBDAFMAQwBTAEMAUwBDAFMAQw84ApgCGAKYAhgCmAIYApgCGAKYAhgCmAIYApgCGAmQccftEhcPhFh8DhFx0Ch190CBx+0SFw+EWHwOEXHQKHX3QIHH7RIXD4RYfA4RcdAodfdAgcftEhcPhFh8DvfNFJ4LTYkAROiw1J4LTYkAROiw1J4LTYkAROiw1J4LTYkAROiw1J4LTYkAROiw1J4LTYkAROiw1J4LTYkAROiw1J4NTYEANn1aQYOKsmxcBZNSkGzqpJMXBWTYqBs2pSDJxVk2LgrJoUA2fVpBg4qybFwFk1KQbOqkkxcFZNioGzalIMnFmTIHIhRS6EyIUUuRAiF1LkQohcSJELIXIhRS6EyIUUuRAiF1LkQnxILnQPdg92D3YPdg92D3YPdg92D3YPdg92D3YPdg92D3YPdg92D3YPdg92D3YPdg92D3YPdg92D3YPdg92D3YPdg92D3YPdg92D3YPdg92D3YPdg92D3YPdg92D3YPdg92D3YPdg92D3YPdg92D3YPdg92D3YPdg92D3YPdg92D3YPdg92D3YPdg92D3YPdg92D3YPdg92D3YPdg92D3YPdg92D3YPdg92D3YPdg92D3YPdg92D3YPdg92D3YPdg92D3YPdg92D3YPdg92D3YPdg92D3YPdg9+/x78P2xQlZ20DXS4AAAAAElFTkSuQmCC';
const DEMO_IMG_AMBER = 'iVBORw0KGgoAAAANSUhEUgAAAHgAAABQCAYAAADSm7GJAAAA9klEQVR4nO3dsQ1AUABFUb3eBNYxjX2sojSAUUQhBL+ywUt+5BR3gjPAbY6xa5LtUxvtnPto1zpEu7clWhQXMGDAgAEDBgwYMGDAgAEDrhD4SVYQohWEaAUhWkGIBhgwYMCAAQMGDBgwYMCAAQMGDBgwYMCAAQMGDBgwYMCAAQMGDBgwYMCAAQMGDBgwYMCAAQMGDBgwYMCAAQMGDBgwYMCAAQMGDBgwYMCAAQMGDBgwYMCAAQMGDBgwYMCAAQMGDBgwYMCAAQMGDBgwYMCAAQMGDBgwYMCAAQMGDBgw4JqB/YN//g8GDBgwYMCAAQMGDBgwYMBfL/WVF4KiKvHaAAAAAElFTkSuQmCC';

const TEMPLATE_IMAGES: MessageItem[] = [
  {
    kind: 'user',
    text: 'I screenshotted the broken modal — header overlaps the close button. See attached.',
    timestamp: new Date(NOW - 30 * 60 * 1000).toISOString(),
    model: null,
    usage: null,
    images: [
      { mediaType: 'image/png', data: DEMO_IMG_PURPLE },
    ],
  },
  {
    kind: 'assistant',
    text: 'Got it. The header is `position: sticky; top: 0;` but the X button sits at the same z-index. Bump the close button to `z-50` or add `pr-12` to the title row so they never overlap.\n\nWant me to push a fix?',
    timestamp: new Date(NOW - 29 * 60 * 1000).toISOString(),
    model: 'claude-opus-4-7',
    usage: { input_tokens: 1900, output_tokens: 240, cache_read_input_tokens: 14000, cache_creation_input_tokens: 0 },
  },
  {
    kind: 'user',
    text: 'Here are the before / after side by side.',
    timestamp: new Date(NOW - 12 * 60 * 1000).toISOString(),
    model: null,
    usage: null,
    images: [
      { mediaType: 'image/png', data: DEMO_IMG_PURPLE },
      { mediaType: 'image/png', data: DEMO_IMG_AMBER },
    ],
  },
  {
    kind: 'assistant',
    text: 'Nice — the right-side one is the post-fix render. Z-index conflict is gone, padding looks right. Shipping it.',
    timestamp: new Date(NOW - 11 * 60 * 1000).toISOString(),
    model: 'claude-opus-4-7',
    usage: { input_tokens: 2100, output_tokens: 90, cache_read_input_tokens: 14200, cache_creation_input_tokens: 0 },
  },
];

const TEMPLATES = [DEMO_MSG_TEMPLATE, TEMPLATE_SKELETON, TEMPLATE_EXIF, TEMPLATE_TERRAFORM, TEMPLATE_IMAGES];

// Hash session id → one of the templates. Stable so the same session always shows
// the same demo content (re-render-friendly).
function hashIdx(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % TEMPLATES.length;
}

// Shift a template's timestamps so its tail lines up with the session's lastTs.
// The templates were authored against `NOW`, so without shifting, every session
// — whether it's "4 hours ago" or "5 days ago" in the list — would render chat
// messages stamped "just now". This breaks the obvious read that conversation
// time should match list-card time.
function anchorTemplate(template: MessageItem[], sessionLastTs: string | null): MessageItem[] {
  if (!sessionLastTs || template.length === 0) return template;
  // Find the latest timestamp in the template — that's its implicit end anchor.
  let maxTs = 0;
  for (const m of template) {
    if (m.timestamp) {
      const t = new Date(m.timestamp).getTime();
      if (t > maxTs) maxTs = t;
    }
  }
  if (!maxTs) return template;
  const shift = new Date(sessionLastTs).getTime() - maxTs;
  if (shift === 0) return template;
  return template.map(m => m.timestamp
    ? { ...m, timestamp: new Date(new Date(m.timestamp).getTime() + shift).toISOString() }
    : m
  );
}

// The 401 / refresh-token session always gets its themed conversation so the
// title in the list matches what renders in the detail pane. Other sessions
// fall back to the hash-shuffled assignment.
const REFRESH_TOKEN_ID = makeId(0);
export const DEMO_MESSAGES: Record<string, MessageItem[]> = Object.fromEntries(
  DEMO_SESSIONS.map(s => [
    s.id,
    anchorTemplate(s.id === REFRESH_TOKEN_ID ? DEMO_MSG_TEMPLATE : TEMPLATES[hashIdx(s.id)], s.lastTs),
  ])
);

// Aggregated demo usage matching the DEMO_SESSIONS array.
const totalIn = DEMO_SESSIONS.reduce((s, x) => s + x.tokensIn, 0);
const totalOut = DEMO_SESSIONS.reduce((s, x) => s + x.tokensOut, 0);
const totalCR = DEMO_SESSIONS.reduce((s, x) => s + x.tokensCacheRead, 0);
const totalCC = DEMO_SESSIONS.reduce((s, x) => s + x.tokensCacheCreate, 0);
const totalMsgs = DEMO_SESSIONS.reduce((s, x) => s + x.userMsgs + x.assistantMsgs, 0);

function windowOf(maxHoursAgo: number) {
  const cutoff = NOW - maxHoursAgo * HOUR;
  const inWin = DEMO_SESSIONS.filter(s => s.mtime >= cutoff);
  return {
    input: inWin.reduce((s, x) => s + x.tokensIn, 0),
    output: inWin.reduce((s, x) => s + x.tokensOut, 0),
    cacheRead: inWin.reduce((s, x) => s + x.tokensCacheRead, 0),
    cacheCreate: inWin.reduce((s, x) => s + x.tokensCacheCreate, 0),
    msgs: inWin.reduce((s, x) => s + x.userMsgs + x.assistantMsgs, 0),
    sessions: inWin.length,
    oldestTs: inWin.length ? Math.min(...inWin.map(s => s.mtime)) : null,
  };
}

const tnow = new Date(NOW);
const todayStartTs = new Date(tnow.getFullYear(), tnow.getMonth(), tnow.getDate()).getTime();
const todayWin = (() => {
  const inWin = DEMO_SESSIONS.filter(s => s.mtime >= todayStartTs);
  return {
    input: inWin.reduce((s, x) => s + x.tokensIn, 0),
    output: inWin.reduce((s, x) => s + x.tokensOut, 0),
    cacheRead: inWin.reduce((s, x) => s + x.tokensCacheRead, 0),
    cacheCreate: inWin.reduce((s, x) => s + x.tokensCacheCreate, 0),
    msgs: inWin.reduce((s, x) => s + x.userMsgs + x.assistantMsgs, 0),
    sessions: inWin.length,
    oldestTs: inWin.length ? Math.min(...inWin.map(s => s.mtime)) : null,
  };
})();

export const DEMO_USAGE: UsageSummary = {
  buckets: {
    total: { input: totalIn, output: totalOut, cacheRead: totalCR, cacheCreate: totalCC, sessions: DEMO_SESSIONS.length, msgs: totalMsgs },
    last1d: windowOf(24),
    last7d: windowOf(24 * 7),
    last30d: windowOf(24 * 30),
    thisMonth: windowOf(24 * 11),
  },
  currentWindows: {
    last5h: windowOf(5),
    today: todayWin,
    last24h: windowOf(24),
    last3d: windowOf(72),
    last7d: windowOf(168),
    last30d: windowOf(720),
  },
  byModel: (() => {
    const map = new Map<string, { input: number; output: number; cacheRead: number; cacheCreate: number; sessions: number }>();
    for (const s of DEMO_SESSIONS) {
      const cur = map.get(s.model) || { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, sessions: 0 };
      cur.input += s.tokensIn; cur.output += s.tokensOut;
      cur.cacheRead += s.tokensCacheRead; cur.cacheCreate += s.tokensCacheCreate;
      cur.sessions++;
      map.set(s.model, cur);
    }
    return [...map.entries()].map(([model, v]) => ({ model, ...v }));
  })(),
  byProject: (() => {
    const map = new Map<string, { input: number; output: number; cacheRead: number; cacheCreate: number; sessions: number }>();
    for (const s of DEMO_SESSIONS) {
      const cur = map.get(s.decodedCwd) || { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, sessions: 0 };
      cur.input += s.tokensIn; cur.output += s.tokensOut;
      cur.cacheRead += s.tokensCacheRead; cur.cacheCreate += s.tokensCacheCreate;
      cur.sessions++;
      map.set(s.decodedCwd, cur);
    }
    return [...map.entries()].map(([project, v]) => ({ project, ...v }));
  })(),
  byDay: (() => {
    const map = new Map<string, { input: number; output: number; cacheRead: number; cacheCreate: number; sessions: number }>();
    // Seed from the real SEEDS so recent weeks have accurate numbers tied to
    // visible sessions.
    for (const s of DEMO_SESSIONS) {
      const d = new Date(s.mtime);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      const cur = map.get(key) || { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, sessions: 0 };
      cur.input += s.tokensIn; cur.output += s.tokensOut;
      cur.cacheRead += s.tokensCacheRead; cur.cacheCreate += s.tokensCacheCreate;
      cur.sessions++;
      map.set(key, cur);
    }
    // Synthesize ~12 months of historical activity so the calendar heatmap
    // looks lived-in instead of an empty grid with a tiny cluster on the right.
    // Deterministic per-day "hash" so the same heatmap renders on every reload.
    const dayHash = (y: number, m: number, dd: number) => {
      const h = ((y * 397 + m * 31 + dd) * 2654435761) >>> 0;
      return h / 0xffffffff; // 0..1
    };
    const todayKey = (() => { const d = new Date(NOW); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; })();
    for (let daysBack = 1; daysBack <= 365; daysBack++) {
      const d = new Date(NOW - daysBack * DAY);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      if (key === todayKey) continue;
      if (map.has(key)) continue; // real SEED data already covers this day
      const dow = d.getDay();
      const r = dayHash(d.getFullYear(), d.getMonth(), d.getDate());
      // Skip-probabilities are tuned so the heatmap looks like a real engineer's
      // calendar: weekends ~55% empty, weekdays ~30% empty. The two paths use
      // different thresholds against the same hash so the distribution stays
      // deterministic across reloads (no Math.random).
      const isWeekend = dow === 0 || dow === 6;
      const skip = isWeekend ? r > 0.45 : r > 0.7;
      if (skip) continue;
      // Token volume biased by the hash so weeks have visible peaks and lulls.
      const intensity = r; // 0..1
      const base = Math.floor(2_000 + intensity * 38_000);
      map.set(key, {
        input: base,
        output: Math.floor(base * 0.5),
        cacheRead: Math.floor(base * 80),
        cacheCreate: Math.floor(base * 12),
        sessions: 1 + Math.floor(intensity * 5),
      });
    }
    return [...map.entries()].map(([day, v]) => ({ day, ...v })).sort((a, b) => b.day.localeCompare(a.day));
  })(),
  stats: (() => {
    // Recompute stats from the synthesized byDay so the heatmap legend and the
    // "active days / longest streak / most active day" numbers stay in sync.
    return {
      activeDays: 0, // filled below
      totalDays: 365,
      longestStreak: 0,
      currentStreak: 0,
      mostActiveDay: new Date(NOW - 2 * 86400000).toISOString().slice(0, 10),
      longestSessionMs: 4 * 3600 * 1000 + 22 * 60 * 1000,
      favoriteModel: 'claude-opus-4-7',
      firstDay: new Date(NOW - 364 * 86400000).toISOString().slice(0, 10),
      lastDay: new Date(NOW).toISOString().slice(0, 10),
    };
  })(),
};

// Late stats backfill — runs once after DEMO_USAGE.byDay is built, so the
// numbers in the Activity stats card reflect the synthesized heatmap.
(() => {
  const days = new Set(DEMO_USAGE.byDay.map(d => d.day));
  DEMO_USAGE.stats.activeDays = days.size;
  // Longest streak + current streak walking from today backward.
  let cur = 0, longest = 0, curStreak = 0;
  let seenToday = false;
  for (let back = 0; back <= 365; back++) {
    const d = new Date(NOW - back * DAY);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    if (days.has(key)) {
      cur++;
      if (cur > longest) longest = cur;
      if (back === 0 || (seenToday && curStreak === back)) { curStreak = cur; seenToday = true; }
    } else {
      cur = 0;
    }
  }
  DEMO_USAGE.stats.longestStreak = longest;
  DEMO_USAGE.stats.currentStreak = curStreak;
  // Most active day = max-tokens day in byDay.
  let mostDay: string | null = null;
  let mostTotal = -1;
  for (const d of DEMO_USAGE.byDay) {
    const t = d.input + d.output + d.cacheRead + d.cacheCreate;
    if (t > mostTotal) { mostTotal = t; mostDay = d.day; }
  }
  if (mostDay) DEMO_USAGE.stats.mostActiveDay = mostDay;
})();

/* ====================== Workspace (Claude config) ====================== */
// Mirrors the shape returned by `main.cjs::readClaudeConfig` so the demo build
// can populate the Workspace page without any ~/.claude/ on disk.

const DEMO_CLAUDE_HOME = '/Users/jordan/.claude';
const cfgPath = (...parts: string[]) => [DEMO_CLAUDE_HOME, ...parts].join('/');
const t = (daysAgo: number, hoursAgo = 0) => NOW - daysAgo * DAY - hoursAgo * HOUR;

const DEMO_CLAUDE_MD = `# Global Claude Code Instructions

> Personal preferences and conventions applied to every session.

## Workflow

- Default to TypeScript for new web work.
- Prefer composition over inheritance.
- When changing public APIs, also update the matching test in the same commit.

## Reviewer tone

- Keep PR descriptions short. Lead with **why**, not **what**.
- Avoid hedge words ("might", "probably") in factual claims about the codebase.

## Commit style

- Imperative mood, no trailing period.
- Reference an issue when one exists, e.g. \`refs #1042\`.
`;

const DEMO_SKILLS = [
  {
    name: 'code-review',
    title: 'code-review',
    description: 'Read a diff and produce a focused review — correctness, security, style.',
    mtime: t(1, 4),
    content: `---
name: code-review
description: Read a diff and produce a focused review — correctness, security, style.
---

# Code Review Skill

When triggered, Claude should:

1. Identify the most consequential change in the diff first.
2. Flag potential nulls, off-by-ones, leaking secrets, race conditions.
3. Suggest at most three concrete improvements.
`,
  },
  {
    name: 'test-writer',
    title: 'test-writer',
    description: 'Write unit tests around a given function with realistic edge cases.',
    mtime: t(3, 9),
    content: `---
name: test-writer
description: Write unit tests around a given function with realistic edge cases.
---

# Test Writer Skill

For any function provided, generate:

- A happy-path test
- 2-3 edge-case tests (null, empty, boundary)
- Setup/teardown if external state is touched
`,
  },
  {
    name: 'refactor-extract',
    title: 'refactor-extract',
    description: 'Extract helpers from a large function, preserving behavior.',
    mtime: t(5, 2),
    content: `---
name: refactor-extract
description: Extract helpers from a large function, preserving behavior.
---

# Extract-helper Skill

Walk through the function and look for:

- Repeated patterns (3+ similar branches → consolidate)
- Pure computations buried inside imperative loops
- Side-effects mixed with calculation
`,
  },
  {
    name: 'sql-explain',
    title: 'sql-explain',
    description: 'Explain a query plan and propose index/rewrite improvements.',
    mtime: t(7, 18),
    content: `---
name: sql-explain
description: Explain a query plan and propose index/rewrite improvements.
---

# SQL Explainer

Given an EXPLAIN output:

- Identify sequential scans on large tables
- Spot bad join orders
- Suggest covering indexes or query rewrites
`,
  },
  {
    name: 'release-notes',
    title: 'release-notes',
    description: 'Turn a list of merged PRs into a clean changelog entry.',
    mtime: t(12, 1),
    content: `---
name: release-notes
description: Turn a list of merged PRs into a clean changelog entry.
---

# Release Notes Skill

Group merged PRs into:

- ✨ Features
- 🐛 Fixes
- ⚙️  Internal

Lead with user-visible changes. Keep each line ≤ 80 chars.
`,
  },
];

const DEMO_COMMANDS = [
  {
    name: '/review',
    description: 'Run the code-review skill against the current diff and post results inline.',
    mtime: t(0, 6),
    content: `---
description: Run the code-review skill against the current diff and post results inline.
---

Take the current \`git diff\` and pass it through the [[code-review]] skill.
Show findings grouped by severity (critical / major / minor).
`,
  },
  {
    name: '/commit',
    description: 'Generate a conventional commit message for the staged diff.',
    mtime: t(0, 14),
    content: `---
description: Generate a conventional commit message for the staged diff.
---

1. Read \`git diff --staged\`.
2. Choose a type prefix: feat / fix / refactor / docs / test / chore.
3. Return one line, imperative mood, ≤ 72 chars.
`,
  },
  {
    name: '/explain',
    description: 'Explain a selected snippet — line by line, with intent.',
    mtime: t(2, 11),
    content: `---
description: Explain a selected snippet — line by line, with intent.
---

For the given code:

- Summarize the function's purpose in one sentence
- Walk through each non-trivial block with intent
- Note any subtle bugs or risky patterns
`,
  },
  {
    name: '/scaffold',
    description: 'Generate a starter file/module with sensible defaults.',
    mtime: t(4, 22),
    content: `---
description: Generate a starter file/module with sensible defaults.
---

Args: \`<kind> <name>\` where kind ∈ component | service | route | test.

Pick the right template from \`~/.claude/skills/scaffolds/\` and adapt to the project's existing conventions.
`,
  },
  {
    name: '/migrate',
    description: 'Draft a database migration script + rollback.',
    mtime: t(6, 3),
    content: `---
description: Draft a database migration script + rollback.
---

Given a schema change request:

- Produce \`up\` and \`down\` SQL
- Add safety checks (\`IF NOT EXISTS\`, batched updates)
- Note expected lock impact on production tables
`,
  },
  {
    name: '/pr',
    description: 'Open a PR with auto-generated title and body from the branch diff.',
    mtime: t(8, 7),
    content: `---
description: Open a PR with auto-generated title and body from the branch diff.
---

1. Push current branch if needed.
2. \`gh pr create\` with body sections: Summary / Why / Test plan.
3. Skip the AI-generated trailer.
`,
  },
  {
    name: '/loop',
    description: 'Run a task on a schedule, reporting back each iteration.',
    mtime: t(10, 13),
    content: `---
description: Run a task on a schedule, reporting back each iteration.
---

For long-running observable tasks: poll, summarize the change since last tick,
and decide whether to keep going.
`,
  },
  {
    name: '/debug',
    description: 'Drop into a structured debugging loop with hypothesis tracking.',
    mtime: t(11, 8),
    content: `---
description: Drop into a structured debugging loop with hypothesis tracking.
---

Method:

1. State the observed symptom in one line
2. List plausible causes (rank by likelihood × impact)
3. Pick the cheapest experiment first
4. Refine after each result
`,
  },
];

const DEMO_HOOKS = [
  {
    name: 'check-commit-ai-traces.py',
    mtime: t(0, 2),
    content: `#!/usr/bin/env python3
"""Reject commits that leak AI-coauthor / generation trailers."""
import re, subprocess, sys

BAD = re.compile(r'(co-authored-by:.*claude|generated with.*claude code)', re.IGNORECASE)

msg = subprocess.check_output(['git', 'log', '-1', '--format=%B']).decode()
if BAD.search(msg):
    print('Commit message contains AI trace; aborting.', file=sys.stderr)
    sys.exit(1)
`,
  },
  {
    name: 'pre-push-test.sh',
    mtime: t(2, 19),
    content: `#!/usr/bin/env bash
# Run the fast unit tests before allowing a push.
set -euo pipefail
echo "Running fast tests…"
npm run test -- --silent --watchAll=false
`,
  },
  {
    name: 'session-start-context.sh',
    mtime: t(5, 4),
    content: `#!/usr/bin/env bash
# Echo a small project context block on every session start.
set -euo pipefail
echo "## Project"
basename "$(pwd)"
echo
echo "## Recent commits"
git log --oneline -5
`,
  },
];

const DEMO_PLUGINS = [
  { name: 'security-guidance', entries: ['SKILL.md', 'check-secrets.py', 'README.md'], mtime: t(4, 16) },
  { name: 'gh-helpers', entries: ['commands', 'hooks', 'README.md'], mtime: t(9, 5) },
];

const DEMO_SETTINGS_JSON = JSON.stringify({
  $schema: 'https://schemas.anthropic.com/claude-code/settings.schema.json',
  defaultModel: 'claude-opus-4-7',
  permissions: {
    allowedTools: ['Read', 'Edit', 'Write', 'Bash', 'Grep'],
    denyDestructive: true,
  },
  ui: {
    theme: 'system',
    fontSize: 13,
  },
  telemetry: {
    enabled: false,
  },
  hooks: {
    onCommit: '~/.claude/hooks/check-commit-ai-traces.py',
    onPrePush: '~/.claude/hooks/pre-push-test.sh',
    onSessionStart: '~/.claude/hooks/session-start-context.sh',
  },
}, null, 2);

export const DEMO_CONFIG = {
  paths: { home: '/Users/jordan', claudeDir: DEMO_CLAUDE_HOME },
  claudeMd: {
    path: cfgPath('CLAUDE.md'),
    content: DEMO_CLAUDE_MD,
    mtime: t(0, 1),
  },
  skills: DEMO_SKILLS.map(sk => ({
    ...sk,
    path: cfgPath('skills', sk.name, 'SKILL.md'),
  })),
  commands: DEMO_COMMANDS.map(c => ({
    ...c,
    path: cfgPath('commands', c.name.replace(/^\//, '') + '.md'),
  })),
  hooks: DEMO_HOOKS.map(h => ({
    ...h,
    path: cfgPath('hooks', h.name),
  })),
  plugins: DEMO_PLUGINS.map(p => ({
    ...p,
    path: cfgPath('plugins', p.name),
  })),
  settings: {
    path: cfgPath('settings.json'),
    content: DEMO_SETTINGS_JSON,
    mtime: t(1, 22),
  },
};

// Codex workspace demo. Mirrors the Claude shape but with codex paths/content
// so flipping the AI source in demo mode actually swaps what Workspace shows.
const DEMO_CODEX_HOME = '/Users/jordan/.codex';
const codexPath = (...parts: string[]) => [DEMO_CODEX_HOME, ...parts].join('/');

const DEMO_AGENTS_MD = `# Agents instructions

> Loaded into every Codex session as the system bootstrap.

## Personality

You are Codex, a coding agent based on GPT-5. Direct, factual, pragmatic. Keep responses tight.

## Workflow

- Read before editing — never write without grepping for callers first.
- Default to TypeScript / Rust for new work.
- When a tool needs a network egress, ask before calling.

## Style

- Imperative-mood commits, no trailing period.
- Reference issues with refs #N.
`;

const DEMO_CODEX_RULES = `# Tool permission rules

prefix_rule(pattern=["git", "add"], decision="allow")
prefix_rule(pattern=["git", "status"], decision="allow")
prefix_rule(pattern=["npm", "test"], decision="allow")
prefix_rule(pattern=["dotnet", "test"], decision="allow")
prefix_rule(pattern=["rm", "-rf"], decision="deny")
prefix_rule(pattern=["curl", "-sSL"], decision="confirm")
`;

const DEMO_CODEX_CONFIG_TOML = `# ~/.codex/config.toml
default_model = "gpt-5"
default_reasoning = "high"

[ui]
theme = "system"
font_size = 13

[tools]
bash = true
read = true
write = false   # require explicit allow per call
grep = true

[telemetry]
enabled = false

[apps]
search_sessions = true
`;

const DEMO_CODEX_SKILLS = [
  {
    name: 'spec-writer',
    title: 'spec-writer',
    description: 'Draft a tight, testable spec from a feature description.',
    mtime: t(2, 4),
    content: `---
name: spec-writer
description: Draft a tight, testable spec from a feature description.
---

# Spec Writer

Turn a fuzzy feature request into:
- one-sentence goal
- 3-5 acceptance criteria
- non-goals (what's NOT in scope)
- failure modes worth testing
`,
  },
  {
    name: 'sql-tuner',
    title: 'sql-tuner',
    description: 'Take an EXPLAIN output and propose index / rewrite fixes.',
    mtime: t(4, 9),
    content: `---
name: sql-tuner
description: Take an EXPLAIN output and propose index / rewrite fixes.
---

# SQL Tuner Skill
`,
  },
  {
    name: 'pr-summary',
    title: 'pr-summary',
    description: 'Generate a PR body from the diff — Summary + Why + Test plan.',
    mtime: t(6, 1),
    content: `---
name: pr-summary
description: Generate a PR body from the diff — Summary + Why + Test plan.
---

# PR Summary Skill
`,
  },
];

export const DEMO_CONFIG_CODEX = {
  paths: { home: '/Users/jordan', claudeDir: DEMO_CODEX_HOME },
  claudeMd: {
    path: codexPath('AGENTS.md'),
    content: DEMO_AGENTS_MD,
    mtime: t(0, 2),
  },
  skills: DEMO_CODEX_SKILLS.map(sk => ({
    ...sk,
    path: codexPath('skills', sk.name, 'SKILL.md'),
  })),
  commands: [], // codex doesn't expose slash commands yet
  hooks: [
    {
      name: 'default.rules',
      path: codexPath('rules', 'default.rules'),
      content: DEMO_CODEX_RULES,
      mtime: t(1, 4),
    },
  ],
  plugins: [],
  settings: {
    path: codexPath('config.toml'),
    content: DEMO_CODEX_CONFIG_TOML,
    mtime: t(3, 12),
  },
};

// Source → demo config registry. Mirrors lib/sources.ts: adding a new AI tool
// = one new entry, no editing in ConfigView or anywhere else.
export const DEMO_CONFIGS: Record<'claude' | 'codex', typeof DEMO_CONFIG> = {
  claude: DEMO_CONFIG,
  codex: DEMO_CONFIG_CODEX,
};

// Stable demo claude-auth so the Sidebar identity card shows a real-looking
// Pro user instead of "Free" when demo mode is on. Matches the avatar/profile
// expectations (Lens / C).
export const DEMO_AUTH: AuthStatus = {
  loggedIn: true,
  authMethod: 'oauth',
  apiProvider: 'anthropic',
  email: 'lens@maliming.net',
  subscriptionType: 'pro',
};

// Fixed identity used by demo mode — bypasses any stored profile so a
// customised name never leaks into demo screenshots. A stylised person-
// silhouette SVG reads naturally as a chat avatar; the app icon looks
// jarring at this role since users expect a contact-style portrait, not a
// brand glyph. Vite resolves the ?url suffix to a hashed asset URL.
import demoAvatarUrl from '../assets/demo-avatar.svg?url';
export const DEMO_PROFILE = {
  name: 'Lens',
  avatarInitial: 'L',
  avatarGradient: 'from-purple-500 to-blue-500',
  avatarImage: demoAvatarUrl,
};

// Stable demo rate-limit snapshot. Matches the v2 design's numbers (6% / 28%)
// so screenshots stay reproducible. Reset times are anchored to demo NOW so
// the "X / 5h" remaining label looks plausible without ticking real time.
export const DEMO_RATE_LIMITS: RateLimits = {
  status: 'allowed',
  representativeClaim: 'five_hour',
  fiveHour: {
    utilization: 0.06,
    status: 'allowed',
    // ~18 minutes from demo NOW so label reads "18m / 5h"
    reset: Math.floor((NOW + 18 * 60_000) / 1000),
  },
  weekly: {
    utilization: 0.28,
    status: 'allowed',
    // ~9.8 hours from demo NOW so label reads "9h 48m / 7d"
    reset: Math.floor((NOW + 9.8 * 3600_000) / 1000),
  },
  overage: {
    utilization: 0,
    status: 'allowed',
    reset: Math.floor((NOW + 5 * 3600_000) / 1000),
  },
};
