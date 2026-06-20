# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Lens is an Electron desktop app that browses, searches, and resumes local Claude Code (`~/.claude/projects/*.jsonl`) and OpenAI Codex (`~/.codex/sessions/**/*.jsonl`) session history. The package name in `package.json` is `lens`.

## Common commands

```bash
npm install
npm run dev          # Vite (http://localhost:5173) + Electron in parallel
npm run typecheck    # tsc --noEmit (run before any commit)
npm run check:i18n   # scripts/check-i18n.mjs — diffs each locale vs en
npm run build        # typecheck + Vite build → dist/  (does NOT package)
npm run preview      # run Electron against built dist/

npm run dist:mac     # release/Lens-<ver>-(arm64|x64).zip
npm run dist:win     # release/Lens-<ver>-win.zip

npm run build:icon   # regenerate build/icon.{icns,ico,png} from icon.svg
DEMO_BUILD=1 npm run dist:mac   # screenshot-ready build with fake data forced on
```

There are no tests and no linter configured. `npm run build` runs `tsc --noEmit && vite build`. **`npm run check:i18n` is NOT in build** — running it reveals real gaps (non-English locales miss ~200 keys each); wire to CI only after you've committed to translating, otherwise it'll fail every build.

Renderer hot-reloads under `npm run dev`. **Main-process edits (`electron/main.cjs`) require a full restart** — there is no main-process reload. Sessions cache (`~/Library/Application Support/Lens/sessions-cache.json` on mac, equivalent on Win/Linux) survives across restarts; when changing the parser, **delete that file** before testing or the old cached meta will mask your changes.

## High-level architecture

### Two-process boundary

- `electron/main.cjs` (Node) — all filesystem IO, JSONL parsing, sub-process spawning (terminal launchers, `claude`/`codex` CLI probes), persistence (`favorites.json` / `excludes.json` / `aliases.json` / `sessions-cache.json` / `app-prefs.json` under `app.getPath('userData')`).
- `src/` (React 18 + TypeScript + Vite + Tailwind) — pure renderer. **No Node access.** Talks to main only via `window.api.*`.
- `electron/preload.cjs` — `contextBridge.exposeInMainWorld('api', ...)`. This is the IPC contract; any new feature that crosses the boundary needs an entry here + a matching `ipcMain.handle` in `main.cjs` + a typed signature in `src/types.ts` under `declare global { interface Window { api: { ... } } }`.

Electron window config in `createWindow()`: `contextIsolation: true`, `nodeIntegration: false`, `sandbox: false`. **Don't relax `contextIsolation` / `nodeIntegration`.** `sandbox: false` is intentional (preload uses `contextBridge` + `ipcRenderer`); flipping to `true` requires preload audit. Any new IPC handler that takes a path from the renderer must funnel through `ensureInside()` / `ensureInsideAny()` to prevent the renderer from reading files outside `~/.claude` / `~/.codex`. **Containment uses `isInsideBase(real, realBase)`** via `path.relative` — not lowercase prefix compare — so case-sensitive APFS volumes route correctly.

Renderer + main also enforce CSP (response-header injected, dev vs prod policies, dev origin derived from `VITE_DEV_SERVER_URL`), `will-navigate` refusing cross-origin, `setWindowOpenHandler` denying all and forwarding http(s)/mailto through `shell.openExternal`. Don't bypass these — add to the allowlist if a legitimate new origin appears.

### Single-instance lock

`app.requestSingleInstanceLock()` runs at startup; if a second Lens process launches, it focuses the existing window and quits. **All startup wiring (`whenReady`, `window-all-closed`, `activate`) lives inside the lock's `else` block** — a second instance must NOT register them, otherwise it briefly runs the full lifecycle before quitting.

### Provider registry — the source-aware pattern

`src/lib/sources.tsx` is **the** seam between "this app supports Claude Code" and "this app supports two AI tools". Every per-source thing — accent color, glyph, workspace blurb, kind labels ("Skills" vs "Rules"), path hints — lives in `SOURCES[id]`. Adding a future provider (Cursor, Gemini CLI, etc.) means one new entry in `SOURCES`, one in `SOURCE_ORDER`, a glyph component, and the main-process readers for that tool's on-disk shape. **Do not** add `source === 'codex' ? X : Y` ternaries inside components — read it off `getSource(currentSource)`.

`useCurrentSource()` is a singleton-backed hook (module-level `_current` + `_subs` set, mirrored to `localStorage['ai-source-v1']`). All views re-scope automatically when the user flips the sidebar provider switcher.

### Composite-key invariant (`source:id`)

Favorites, excludes, and aliases use composite keys `"<source>:<sessionId>"` everywhere on disk and in memory, because Claude and Codex session UUIDs can collide. `srcKey()` in `sources.tsx` and `compositeKey()` in `main.cjs` are the centralised converters. **Never compare bare `s.id` against a favorites/excludes Set** — always go through `srcKey(s)`. The renderer's `activeId` is always the composite form. React `key=` props in result lists also use composite (`${source}:${id}`); `SessionDetail` reset effects + `Message` keys also include source so two sessions with the same UUID across providers don't share React state.

Per-source localStorage keys (used to share renderer state without bleeding between providers):

- `active-id:<source>` — last-selected session in this source
- `session-filters` — keyed by view (`sessions` / `favorites` / `excluded`), each carries `{project, time, sort}`
- `search-recent-v1:<source>` — recent deep-search queries
- `config-collapsed-v1:<source>` — collapsed group state in Workspace view
- `ai-source-v1` — the current source itself

`useCurrentSource()` (in `sources.tsx`) is a module-singleton hook so source flips propagate everywhere atomically.

### Stale-guard pattern (every async IPC)

Every async IPC that can race with source / query / view changes uses this pattern:

```ts
const currentSourceRef = useRef(currentSource);
useEffect(() => { currentSourceRef.current = currentSource; }, [currentSource]);

const seqRef = useRef(0);

async function doThing() {
  const reqSeq = ++seqRef.current;
  const reqSource = currentSource;
  const result = await window.api.something(...);
  if (reqSeq !== seqRef.current) return;          // newer call superseded us
  if (reqSource !== currentSourceRef.current) return;  // source flipped mid-flight
  setState(result);
}
```

Reading the **ref** (not the closure value) is critical — a stale closure would otherwise let a slow call resolve and overwrite the new source's state. Used in `App.tsx:reload`, `SessionsView:runDeepSearch`, `SearchView:submitDeep`, `ConfigView:readConfig`, `useRateLimits:tick`.

### Session listing — SWR push pattern

`listSessions()` in `main.cjs` never blocks on a full scan:

1. First boot with no cache → `refreshSessionsInBackground()` deep-reads `TOP_BATCH` newest files, resolves `firstBatchPromise`, then continues reading the long tail.
2. Subsequent calls → return `cachedSessions` immediately, kick off a background refresh.
3. Background refresh pushes fresh batches via `sessions:updated` IPC; `App.tsx` swaps state silently (no loading skeleton).
4. `fileMetaCache` keyed by `filePath → { mtime, meta }` means unchanged sessions don't re-read at all.
5. `sessions-cache.json` persists the list across launches so the next cold start is instant.

`App.tsx` keeps `reloadSeqRef` and `usageSeqRef` as **separate** monotonic counters: a usage-only refresh from `onSessionsUpdated` must not invalidate an in-flight full reload's session/favorites writes. If you add another background refresher, give it its own counter rather than sharing one.

Filesystem watch is intentionally **disabled** (`main.cjs:2505` comment) — recursive `fs.watch` on `~/.claude/projects` blows up under heavy write traffic on macOS. Manual ⌘R / focus-tick / 5-min poll is the supported model. Don't re-add a naive watcher.

### Demo mode swap

`src/lib/demoData.ts` ships ~1 MB of fake sessions + usage + workspace content for screenshots. In production builds it is **swapped to `demoData.empty.ts` via a Vite alias regex** (`vite.config.ts:36-49`). The regex matches `../lib/demoData` and `./demoData` specifically — don't import demoData via bare `'demoData'` (would collide with a hypothetical npm package) or with paths that contain `node_modules`. `DEMO_BUILD=1` forces demo mode on regardless of the localStorage flag (used for the screenshot-ready artifact).

`useDemoMode()` toggles the runtime flag. When demo mode is on, `App.tsx` overlays `DEMO_SESSIONS` / `DEMO_USAGE` / `DEMO_PROFILE` / `DEMO_RATE_LIMITS` on top of the real state — including a separate `demoAliases` map so renaming in demo never pollutes the real `aliases.json`.

### JSONL parsing — streaming only

Both metadata + detail readers use `forEachJsonlLine(filePath, async (obj) => ...)` rather than `readFile + split('\n')`. The streaming helper:

- Uses `readline` over `createReadStream` so peak memory per file is one line, not the whole file × N concurrent scanners.
- Per-line cap: `MAX_JSONL_LINE_LEN = 16 MB`. Lines exceeding the cap are skipped silently.
- `await onLine(obj)` — the callback may be async (needed by `getSessionMessages` for image-cache lookups).
- **Don't reintroduce `readFile + split`** in new parsers. It bites under 16-concurrent scanning of 100-200 MB JSONLs.

Size caps (constants at the top of `main.cjs`):

| Constant | Value | Used by |
|---|---|---|
| `MAX_SESSION_FILE_SIZE` | 200 MB | metadata + detail + deep search (= one cap) |
| `MAX_USERDATA_FILE_SIZE` | 16 MB | favorites/excludes/aliases/appPrefs/auth/credentials |
| `MAX_CONFIG_FILE_SIZE` | 5 MB | per-file in workspace (`CLAUDE.md`, skill bodies, hook scripts, etc.) |
| `MAX_INLINE_IMAGE_B64` | 8 MB (b64 chars) | one inline image |
| `MAX_IMAGES_PER_MESSAGE` | 32 | inline images per message |
| `MAX_SESSION_IMAGE_TOTAL_B64` | 64 MB (b64 chars) | total across a session — see `capSessionImages` |
| `MAX_JSONL_LINE_LEN` | 16 MB | per line in `forEachJsonlLine` |

`capSessionImages(messages)` runs at the tail of both `getSessionMessages` / `getCodexSessionMessages`. Once the running total exceeds the cap, **all subsequent messages' images are dropped** (don't `break` the outer loop — that's the bug we explicitly fixed; mark every message with `imagesTruncated: true` so the renderer can surface a banner).

### Image extraction

JSONL stores images in many shapes. `extractMessageImages()` / `walkForImages()` handle:

- Claude `{type:'image', source:{type:'base64', data, media_type}}`
- Newer Claude `{type:'image', file:{base64, mimeType}}`
- Claude image-cache markers `[Image: source: /path/to/image-cache/...]` → loaded from `~/.claude/image-cache/` (containment-checked, 12 MB cap)
- Codex `{type:'input_image', image_url}` (string or `{url}`)
- Data URLs vs `https://` URLs

All paths feed through `pushSafeImage()` which whitelists `image/(png|jpe?g|gif|webp|bmp)` mediaTypes, requires a strict base64 alphabet, and **only accepts `https://` (not http)** so the parser matches prod CSP's `img-src https:`. Renderer-side, `<img>` tags are rendered with `referrerPolicy="no-referrer"`. Auto-load defaults to on (`displayPrefs.loadRemoteImages = true`) but Settings exposes a toggle that switches to per-image click-to-load.

### Rate-limits probe

Live subscription quota (`useRateLimits()`) is the **only** network the renderer triggers. Claude probes via `~/.claude/.credentials.json` (file form) or macOS Keychain (`security find-generic-password -s "Claude Code-credentials"`) and hits Anthropic's API; gated behind explicit user consent. Codex spawns a local `codex app-server` JSON-RPC subprocess — no token, no remote network, no consent prompt needed.

**Consent IPC:** `setRateLimitsConsent(v)` is a dedicated handler — `appPrefs:set` explicitly refuses the `rateLimitsConsent` key. Main is the single source of truth (`appPrefs.rateLimitsConsent`); on renderer mount, `useRateLimitsConsent` pulls the persisted value via `getAppPrefs` and only writes back via the dedicated IPC. This is a **UX gate, not a security boundary** — a compromised renderer can call `setRateLimitsConsent('granted')` just like the user can. If you ever need a hard boundary, hook a native confirmation dialog into the consent handler.

**Probe HTTP body cap:** 512 KB with `req.abort()` on overflow; `req.on('aborted'/'close')` both call the same `finish()` that resolves with headers (the only thing the probe consumes — headers are populated on response). 15-second wall-clock timeout fires `req.abort()` so a hanging socket can't pin Usage in "loading".

**Codex app-server subprocess:** `stdout` capped at 4 MB / `stderr` at 1 MB; `proc.on('exit')` rejects any in-flight `waitFor` immediately so a crashed app-server doesn't make the renderer sit through the 15s timeout.

### Display hygiene helpers

Every user-displayed string from JSONL goes through `cleanDisplayText()` (`src/lib/format.ts`) which strips ANSI CSI/OSC escapes, C0/C1 control characters, and Unicode bidi overrides. **Don't render raw `s.summary` / `s.firstUser` / `s.gitBranch` / `s.model` / config name/path/entries / message text / status messages** — go through `cleanDisplayText` (`deriveDisplayTitle`, `meaningfulBranch`, `fmtModel`, `Message.text` already do this). Main also pre-cleans aliases at save time so the on-disk JSON never carries the pathological input.

`sessionTimestamp(s)` (also in `format.ts`) is the canonical "what timestamp does this session represent": prefers `lastTs`, falls back to `mtime`, clamps future timestamps to `now` (clock skew defense), returns 0 for invalid. **Use this for every sort/filter/group on timestamps.** `fmtTime` also clamps future ts to absolute label. The same clamp lives server-side in `usageSummary` for both `lastTs` and per-event `tokenEvents.ts`.

### Persistence — atomic writes

`atomicWriteJson(filePath, value)` (`main.cjs`) is the only allowed write path for `favorites.json` / `excludes.json` / `aliases.json` / `app-prefs.json` / `sessions-cache.json`. It serializes per-path (Promise queue) + writes to `.tmp-<pid>-<seq>` + `fsync` the file + `rename` + `fsync` the parent directory (non-Win). On the quit path (`mainWindow.on('close')` when `closeBehavior='quit'` or `!canHide`), a synchronous variant runs (`openSync` + `writeFileSync` + `fsyncSync` + `renameSync` + dir fsync) because the async pipeline won't finish before Electron tears the process down.

`readJsonFileSafe(path, maxBytes = MAX_USERDATA_FILE_SIZE)` is the reader: `lstat` rejects symlinks (containment defense for tampered userData), size check, then UTF-8 read. **Every persistence loader uses it** (not bare `fs.readFile`).

### Symlink containment in scanners

`statAllJsonl` / `statAllCodexJsonl` / `listSearchTargets` use `fsp.lstat` at each level and reject symbolic links. `~/.claude/projects` and `~/.codex/sessions` are tool-owned dirs; a symlink in there pointing outside is either a misconfiguration or an attack. Same applies to `loadClaudeImageCacheImages` — paths are realpath'd and required to live under `realpath(~/.claude/image-cache)`.

### Tray

Per-platform: macOS uses `setToolTip + popUpContextMenu` on right-click only (left-click opens the window, no menu flash). Windows / Linux keep the platform-default `setContextMenu` behavior. Tray icons use `icon.ico` on Win (multi-size), `icon.png` on Linux, `trayTemplate.png` (with `setTemplateImage(true)`) on macOS — different platforms have different rendering pipelines. **Don't ship the macOS template PNG as the cross-platform default** — it renders solid black on Windows' dark taskbar.

### Fonts + locale UI

Sans stack: SF Pro on macOS (`-apple-system`), Inter Variable on Windows / Linux (`@fontsource-variable/inter` bundled).
Mono stack: SF Mono on macOS (`ui-monospace, SFMono-Regular`), JetBrains Mono Variable on Win / Linux (`@fontsource-variable/jetbrains-mono` bundled).
Ligatures explicitly disabled (`font-variant-ligatures: none; font-feature-settings: 'liga' 0, 'calt' 0;`) on `code, pre, kbd, samp, .font-mono` — JetBrains Mono otherwise renders `!==` as `≠`.
Locale flags: `country-flag-icons` SVGs in `SettingsView` (Windows' Segoe UI Emoji deliberately doesn't render regional indicator sequences, so unicode flag emoji shows as text on Win).
Shortcut hints: `kbdShortcut('K')` returns `⌘K` on macOS, `Ctrl K` elsewhere.

## Build / packaging notes

- `electron-builder` config lives inline in `package.json#build`. `extraMetadata.main` points to `electron/main.cjs`.
- `electronLanguages: ['en']` strips ~80 MB of Chromium locales — Lens does its own i18n in the renderer.
- `compression: maximum` — mac zip sits at ~96 MB.
- `extraResources` ships the tray icon PNGs.
- `dist/` and `release/` are gitignored. Bumping the version in `package.json` shows as `M` until the release commit lands.

## File layout (don't catalogue every file in commits)

```
electron/    main.cjs (Node, IPC, FS, parsers) + preload.cjs
src/         React renderer
  components/   View / panel / modal components
  lib/          State hooks, source registry, i18n, parsers, prefs
                - format.ts       fmt/cleanDisplayText/sessionTimestamp/kbdShortcut
                - sessionTitle.ts deriveDisplayTitle/projectShortName/meaningfulBranch
                - sources.tsx     provider registry + useCurrentSource + srcKey
                - rateLimits.ts   useRateLimits + useRateLimitsConsent + agoLabel
                - displayPrefs.ts renderer-local toggles (per-field validated)
                - appPrefs.ts     main-mirrored prefs (tray/close/launch/consent)
                - i18n.ts         flat dict per locale (en + 9 partial fallbacks)
  types.ts      Shared types + window.api signature
build/       App icons + build-icon.mjs (sharp + png-to-ico)
scripts/     check-i18n.mjs (locale key diff, run via npm run check:i18n)
docs/        README screenshots
website/     Standalone static landing site (lens.maliming.net)
             — no build step, edit index.html directly per memory note
```

`website/` is the standalone marketing site for Lens. It shares no code with the app and has no build step — just edit `index.html` directly. 

## Conventions

- **Comments**: dense in `main.cjs` because the file packs IPC, parsers, and platform quirks together — keep that bar when extending it. Renderer files prefer self-documenting names; only add comments where the *why* is non-obvious.
- **IPC channel names**: `feature:action` (`sessions:list`, `favorites:toggle`, `rateLimits:get`, `appPrefs:set`). Stay consistent.
- **Path containment**: every new IPC that accepts a path from the renderer must use `ensureInside(BASE, p)` or `ensureInsideAny([...], p)`. They use `isInsideBase` (path.relative) — don't fall back to lowercase prefix compare.
- **JSONL parsing**: always `forEachJsonlLine` — never `readFile + split`.
- **JSON persistence**: always `atomicWriteJson` for writes, `readJsonFileSafe` for reads. The quit path uses a sync atomic variant.
- **Source field**: every new on-disk JSON file should key by composite `source:id`, not bare id.
- **Display strings**: every JSONL-derived string shown to the user goes through `cleanDisplayText` (`format.ts`). Every time computation goes through `sessionTimestamp`. Every model display goes through `fmtModel` (already routes through `cleanDisplayText` + filters synthetic/provider names).
- **Stale guards**: every async IPC that can race with source/query/view changes uses `seqRef` + `currentSourceRef`. Compare against the ref, not the closure value.
- **CSS**: Tailwind v3 + HSL CSS variables on `data-theme="light|dark"`. Custom colors live in `tailwind.config.js`. No CSS modules, no styled-components.
- **Icons**: `lucide-react` only.
- **Markdown rendering**: `marked` + `DOMPurify` (sanitised at the renderer in `lib/markdown.ts`). Don't call `marked` without `DOMPurify.sanitize` on the output. ConfigView passes content through `cleanDisplayText` first.
- **DevTools shortcut**: registered only in dev or when `LENS_ENABLE_DEVTOOLS=1`. Don't expose in shipped builds.
- **i18n**: every new user-visible string MUST land in en AND every other locale (`zh-CN/tr/ja/ko/de/fr/es/pt-BR/ru`) in the same change. The fallback machinery exists for `Partial<Record<TKey,string>>` ergonomics during refactors, NOT as license to ship English-only copy and call it "ja falls back gracefully". If a key isn't translated, the Japanese / Russian / etc. user reads English mid-sentence in their otherwise localised UI — a UX bug, not a "gap". Workflow: add the `en` entry, immediately add an entry to every other locale block (translate; don't paste English), then run `npm run check:i18n` and confirm `OK (N/N)` for every locale. Same rule for **deletes**: drop the key from every locale block in the same change so check:i18n stays green. Translated text style: match the locale's existing tone in this file (terse, sentence case where the locale uses it, no machine-translation literalism — read the file's existing keys for that locale before writing). Touched a key + skipped 8 locales = the change is incomplete.
