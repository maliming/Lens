import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { WebglAddon } from '@xterm/addon-webgl';
import { cleanDisplayText } from './format';
import { DEMO_TERMINAL_SCRIPT } from './demoData';
import { SOURCES } from './sources';
import type { SessionMeta } from '../types';

// Live terminals, owned above the component tree.
//
// A terminal is a running process with scrollback and a half-typed command in
// it — closing it because the user clicked another session in the list would
// be indefensible. So the xterm instance AND its DOM node live here, detached
// from the React tree; the panel just parents the node when that session is on
// screen and lets go of it when it isn't. Nothing is disposed until the user
// explicitly closes it.
//
// Keeping the element (rather than re-running term.open on a fresh div) is
// what preserves scrollback, selection and cursor state exactly.

export type TerminalEntry = {
  sessionKey: string;
  termId: string | null;
  term: XTerm;
  fit: FitAddon;
  // Detached host. Parented into the panel on mount, removed on unmount.
  el: HTMLDivElement;
  exitCode: number | null;
  error: string | null;
  // The OSC title with its spinner prefix removed. Claude Code animates the
  // title — measured at roughly fifteen updates a second, cycling ✳ ⠂ ⠐ in
  // front of a constant "Claude Code" — so the raw value is useless as a label
  // and ruinous as a render trigger.
  title: string;
  // Highest data sequence written to this terminal. Chunks at or below it are
  // already on screen via the start response's replay.
  lastSeq: number;
  // Input typed before the process existed — see `sendInput`.
  pendingInput: string;
  // ...but the churn is a reliable "the agent is working" signal, which the TUI
  // otherwise only expresses as pixels. True while titles keep arriving.
  busy: boolean;
  // Theme this process was spawned with. The CLI paints its own chrome with
  // truecolor fills fixed at launch, so toggling the palette afterwards leaves
  // a light bar on a dark terminal (or the reverse) until it restarts. Keeping
  // the spawn value lets the UI say so instead of just looking broken.
  spawnTheme: TerminalTheme;
  // Kept so a theme change can relaunch this terminal without the component
  // tree having to hand the session back in.
  session: SessionMeta;
  // Scripted playback rather than a process. Demo sessions point at paths that
  // do not exist, so a real spawn is refused at the containment check — but the
  // terminal is the headline feature and has to appear in screenshots.
  demo?: boolean;
  demoTimers?: Array<ReturnType<typeof setTimeout>>;
};

// Terminals that are not currently on screen park here rather than being
// detached from the document entirely.
//
// xterm measures its host when `open()` is called and wires mouse hit-testing
// against real geometry. Opening onto an element that is in no document means
// it measures zero, which breaks link clicks and leaves the grid sized against
// nothing until the next refit. Keeping every terminal inside a laid-out,
// off-screen host means geometry is always real, and showing one is a move
// between parents rather than an attach.
let parkingLot: HTMLDivElement | null = null;
function parking(): HTMLDivElement {
  if (parkingLot) return parkingLot;
  const el = document.createElement('div');
  el.setAttribute('aria-hidden', 'true');
  // Invisible, but inside the viewport — NOT pushed off to a large negative
  // coordinate, which is what an earlier version did.
  //
  // xterm positions its hidden textarea at the cursor and that position is what
  // the browser reports to the OS as "where the text input is"; macOS needs it
  // to place an input method's candidate window. The sync only runs on cursor
  // movement (CoreBrowserTerminal._syncTextArea, called from onCursorMove), so a
  // terminal that was opened or parked off-screen keeps coordinates from that
  // time — and the textarea's own stylesheet starts it at left:-9999em. Stacked
  // on a parking lot at -100000px, the input ends up so far outside the window
  // that macOS stops offering it to the input method: you could type Latin
  // letters but no Chinese, until a resize forced a re-sync and fixed it.
  //
  // Keeping the lot at the origin means a parked terminal's coordinates stay
  // sane, so nothing has to be repaired when it comes back. opacity + z-index
  // hide it; pointer-events keeps it out of hit-testing.
  el.style.cssText = 'position:fixed;left:0;top:0;width:900px;height:500px;'
    + 'overflow:hidden;opacity:0;z-index:-1;pointer-events:none;';
  document.body.appendChild(el);
  parkingLot = el;
  return el;
}

const entries = new Map<string, TerminalEntry>();
const subs = new Set<() => void>();
// Fires a short while after a terminal's output stops, so the transcript above
// can pick up whatever the CLI just wrote. Debounced rather than per-chunk:
// re-reading a large JSONL on every keystroke of output would be ruinous.
const activitySubs = new Set<(sessionKey: string) => void>();
const activityTimers = new Map<string, ReturnType<typeof setTimeout>>();
const lastActivityFire = new Map<string, number>();
// Title updates stop arriving when the agent goes idle; this is how long we
// wait before believing it.
const busyTimers = new Map<string, ReturnType<typeof setTimeout>>();
// Output can arrive before the renderer has finished recording which terminal
// the id belongs to: main starts streaming the moment the process is spawned,
// while the id only reaches here when the IPC call returns. Dropping those
// bytes loses the CLI's opening screen and its setup control sequences, so
// they wait here until someone claims the id.
const orphanData = new Map<string, Array<{ seq: number; data: string }>>();
const ORPHAN_CAP = 512;
// Exits for terminals nobody has claimed yet. The process can die while its
// pty:start response is still in flight; without this the entry adopts a
// termId whose exit was already dropped and shows a live terminal forever.
const orphanExits = new Map<string, number>();

// Processes main is holding that this module has no entry for — the state after
// a renderer reload, which destroys everything here while leaving the CLI
// processes running. Tracked so they still count toward the open-terminal
// warning and can still be closed; opening their session converts them back
// into full entries through the normal re-attach path.
export type OrphanTerminal = {
  termId: string;
  source: string;
  filePath: string;
  // The spelling the renderer started this terminal with. `filePath` is the
  // resolved one — see `matchesOrphan`.
  requestedPath?: string;
  cwd: string;
};
let orphans: OrphanTerminal[] = [];

// Does this orphan belong to this session?
//
// Main resolves every path it is handed (ensureInside realpaths it) and reports
// that, while SessionMeta.filePath is the scanner's unresolved walk of
// ~/.claude. Under a symlinked projects directory the two spellings differ, and
// comparing only the resolved one silently missed every orphan: no list marker,
// no auto-adopt. Main reports the requested spelling alongside it for exactly
// this comparison — it is never used to reach the filesystem.
function matchesOrphan(o: OrphanTerminal, session: SessionMeta): boolean {
  return o.filePath === session.filePath || o.requestedPath === session.filePath;
}
// Main's hard ceiling, learned from pty:list. Only used to stop the UI from
// offering an action that is guaranteed to fail.
let hardMax = Infinity;

export function atHardLimit(): boolean {
  return terminalCount() >= hardMax;
}
const BUSY_IDLE_MS = 900;
// Fire once output has been quiet this long — the common case, at the end of a
// reply.
const ACTIVITY_SETTLE_MS = 1200;
// ...but a TUI redraws its spinner continuously, so "quiet" may never arrive
// during a long tool run. Fire on this cadence too, or the transcript sits
// stale for the whole turn. Quiet-only debouncing was the original bug: the
// timer was reset by every spinner frame and never elapsed.
const ACTIVITY_MAX_INTERVAL_MS = 5000;
let wired = false;

// Two hand-picked palettes rather than the app's CSS variables.
//
// The first attempt derived terminal colours from the UI tokens and produced a
// light theme nobody could read: ANSI yellow and cyan are chosen for dark
// backgrounds and wash out completely on white. A terminal palette has to be
// designed against its own background, so these are explicit — the light set
// pushes yellow to a dark amber and cyan to a deep teal, which is what makes
// CLI output legible on paper-coloured backgrounds.
const DARK_THEME = {
  background: '#1a1a1e',
  foreground: '#e4e4e7',
  cursor: '#d97757',
  cursorAccent: '#1a1a1e',
  selectionBackground: 'rgba(217, 119, 87, 0.35)',
  black: '#27272a',
  red: '#f87171',
  green: '#4ade80',
  yellow: '#fbbf24',
  blue: '#60a5fa',
  magenta: '#c084fc',
  cyan: '#22d3ee',
  white: '#d4d4d8',
  brightBlack: '#52525b',
  brightRed: '#fca5a5',
  brightGreen: '#86efac',
  brightYellow: '#fcd34d',
  brightBlue: '#93c5fd',
  brightMagenta: '#d8b4fe',
  brightCyan: '#67e8f9',
  brightWhite: '#fafafa',
};

const LIGHT_THEME = {
  background: '#fbfbfa',
  foreground: '#24292f',
  cursor: '#d97757',
  cursorAccent: '#fbfbfa',
  selectionBackground: 'rgba(217, 119, 87, 0.25)',
  black: '#24292f',
  red: '#cf222e',
  green: '#116329',
  // Amber, not yellow: plain yellow on white is the single worst offender.
  yellow: '#7d4e00',
  blue: '#0969da',
  magenta: '#8250df',
  cyan: '#1b7c83',
  white: '#6e7781',
  brightBlack: '#57606a',
  brightRed: '#a40e26',
  brightGreen: '#1a7f37',
  brightYellow: '#633c01',
  brightBlue: '#218bff',
  brightMagenta: '#8250df',
  brightCyan: '#3192aa',
  brightWhite: '#8c959f',
};

export type TerminalTheme = 'dark' | 'light';

// One validated record instead of a handful of loose keys, matching how
// displayPrefs already stores renderer-local settings. Per-field validation
// matters for the same reason it does there: a corrupted entry that puts a
// string where a number belongs would otherwise reach xterm's options and
// break rendering in ways that look like a bug in the terminal.
// Bundled families only. A free-text font name would silently fall back to
// whatever the platform picks when it is missing, and a terminal rendering in
// a proportional font is unusable — so the choice is a closed set that is
// known to ship with the app or the OS.
// Every stack ends with the same CJK fallbacks.
//
// None of the Latin monospace families cover Chinese, Japanese or Korean, and
// the CLIs emit plenty of all three — plus the spinner and status glyphs Claude
// Code draws. Left to pick on its own the browser can land on a different
// fallback per run, and a proportional one breaks column alignment in a TUI.
// Naming them keeps rendering predictable. (Checked on this machine: no
// dedicated monospace CJK family is installed — Sarasa Mono, Noto Sans Mono CJK
// and Source Han Mono are all absent — so PingFang and Hiragino are what there
// is, and their ideographs are uniform full-width, which is what alignment
// actually needs.)
//
// Apple Color Emoji is deliberately NOT listed. Naming it made Chromium prefer
// it for characters that merely *default* to emoji presentation — the CLI's
// turn marker is U+23FA BLACK CIRCLE FOR RECORD, which came out as a colour
// emoji in a rounded square instead of the plain dot a real terminal draws, and
// the wider emoji glyph made the cells around it look padded. Real emoji still
// render: Chromium falls back to the system emoji font on its own, it just no
// longer wins the ambiguous cases.
const CJK_FALLBACK = '"PingFang SC", "Hiragino Sans", "Heiti SC", monospace';

// Labels are font names, not prose — they stay identical in every language.
export const TERMINAL_FONTS = [
  { id: 'system', label: 'SF Mono', stack: `ui-monospace, SFMono-Regular, Menlo, Consolas, ${CJK_FALLBACK}` },
  { id: 'jetbrains', label: 'JetBrains Mono', stack: `"JetBrains Mono Variable", "JetBrains Mono", ui-monospace, ${CJK_FALLBACK}` },
  { id: 'menlo', label: 'Menlo / Consolas', stack: `Menlo, Consolas, "DejaVu Sans Mono", ${CJK_FALLBACK}` },
] as const;

export type TerminalFontId = typeof TERMINAL_FONTS[number]['id'];

export type TerminalPrefs = {
  theme: TerminalTheme;
  // Warn once this many terminals are already open. Each one is a whole CLI
  // process — the dominant memory cost of this feature by a wide margin — and
  // they deliberately outlive session switches, so it is easy to accumulate
  // several without noticing. Off by choice for anyone who would rather manage
  // it themselves.
  warnEnabled: boolean;
  warnThreshold: number;
  fontFamily: TerminalFontId;
  fontSize: number;
  // Pane height in pixels when not maximized, and whether it is maximized.
  // Both are global: the terminal is one surface, and per-session geometry
  // would mean the layout jumping every time the user changes sessions.
  height: number;
  maximized: boolean;
  // What the CLI is told about how freely it may act, per source. Empty string
  // means "pass nothing", leaving the CLI on whatever its own settings say —
  // which is the default here, because overriding someone's CLI configuration
  // is not something an app should start doing uninvited.
  //
  // Per source because the two CLIs do not share a vocabulary: Claude has
  // permission modes, Codex has approval policies. The values themselves come
  // from the source registry.
  startMode: Record<string, string>;
};

const PREFS_KEY = 'terminal-prefs-v1';
const MIN_FONT = 9;
const MAX_FONT = 22;
export const MIN_TERMINAL_HEIGHT = 160;
export const MAX_TERMINAL_HEIGHT = 900;

export const MIN_WARN_THRESHOLD = 2;
export const MAX_WARN_THRESHOLD = 12;

const PREF_DEFAULTS: TerminalPrefs = {
  theme: 'dark',
  warnEnabled: true,
  warnThreshold: 5,
  fontFamily: 'system',
  fontSize: 12,
  height: 420,
  maximized: true,
  startMode: {},
};

function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n));
}

function parsePrefs(raw: string | null): TerminalPrefs {
  if (!raw) return { ...PREF_DEFAULTS };
  try {
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== 'object') return { ...PREF_DEFAULTS };
    const out: TerminalPrefs = { ...PREF_DEFAULTS };
    if (obj.theme === 'light' || obj.theme === 'dark') out.theme = obj.theme;
    if (TERMINAL_FONTS.some(f => f.id === obj.fontFamily)) out.fontFamily = obj.fontFamily;
    if (typeof obj.warnEnabled === 'boolean') out.warnEnabled = obj.warnEnabled;
    if (typeof obj.warnThreshold === 'number' && Number.isFinite(obj.warnThreshold)) {
      out.warnThreshold = clamp(Math.round(obj.warnThreshold), MIN_WARN_THRESHOLD, MAX_WARN_THRESHOLD);
    }
    if (typeof obj.fontSize === 'number' && Number.isFinite(obj.fontSize)) {
      out.fontSize = clamp(Math.round(obj.fontSize), MIN_FONT, MAX_FONT);
    }
    if (typeof obj.height === 'number' && Number.isFinite(obj.height)) {
      out.height = clamp(Math.round(obj.height), MIN_TERMINAL_HEIGHT, MAX_TERMINAL_HEIGHT);
    }
    if (typeof obj.maximized === 'boolean') out.maximized = obj.maximized;
    if (obj.startMode && typeof obj.startMode === 'object') {
      // Only keep values the registry still offers. A mode dropped from a CLI
      // (or edited into storage by hand) must not survive into argv — main
      // rejects it anyway, but silently keeping a dead value in the menu would
      // show a selection that does nothing.
      for (const [src, mode] of Object.entries(obj.startMode)) {
        const def = SOURCES[src as keyof typeof SOURCES];
        if (def && typeof mode === 'string' && def.terminal.modes.some(m => m.value === mode)) {
          out.startMode[src] = mode;
        }
      }
    }
    return out;
  } catch { return { ...PREF_DEFAULTS }; }
}

let prefs: TerminalPrefs = parsePrefs(
  (() => { try { return localStorage.getItem(PREFS_KEY); } catch { return null; } })(),
);

function savePrefs() {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch {}
}

export function getTerminalPrefs(): TerminalPrefs { return prefs; }

function palette() {
  return prefs.theme === 'light' ? LIGHT_THEME : DARK_THEME;
}

export function getTerminalTheme(): TerminalTheme { return prefs.theme; }
export function getTerminalBackground(): string { return palette().background; }
export function getTerminalFontSize(): number { return prefs.fontSize; }
export function getTerminalFontId(): TerminalFontId { return prefs.fontFamily; }

export function getTerminalStartMode(source: string): string {
  return prefs.startMode[source] || '';
}

// Takes effect on the next terminal for that source — the flag is an argument
// to a process that is already running, so live ones keep the mode they were
// started with. Restarting one picks up the change.
export function setTerminalStartMode(source: string, mode: string) {
  const next = { ...prefs.startMode };
  if (mode) next[source] = mode; else delete next[source];
  prefs = { ...prefs, startMode: next };
  savePrefs();
  notify();
}

function fontStack() {
  return (TERMINAL_FONTS.find(f => f.id === prefs.fontFamily) || TERMINAL_FONTS[0]).stack;
}

export function setTerminalFont(next: TerminalFontId) {
  if (next === prefs.fontFamily) return;
  prefs = { ...prefs, fontFamily: next };
  savePrefs();
  for (const e of entries.values()) {
    e.term.options.fontFamily = fontStack();
    // Glyph width changed, so the grid did too.
    refitVisible(e);
  }
  notify();
}
export function getTerminalHeight(): number { return prefs.height; }
export function isTerminalMaximized(): boolean { return prefs.maximized; }

export function setTerminalHeight(next: number) {
  prefs = { ...prefs, height: clamp(Math.round(next), MIN_TERMINAL_HEIGHT, MAX_TERMINAL_HEIGHT) };
  savePrefs();
  notify();
}

export function setTerminalWarn(patch: { enabled?: boolean; threshold?: number }) {
  prefs = {
    ...prefs,
    warnEnabled: patch.enabled ?? prefs.warnEnabled,
    warnThreshold: patch.threshold === undefined
      ? prefs.warnThreshold
      : clamp(Math.round(patch.threshold), MIN_WARN_THRESHOLD, MAX_WARN_THRESHOLD),
  };
  savePrefs();
  notify();
}

// True when opening one more would put the user past their own threshold.
export function shouldWarnBeforeOpening(session?: SessionMeta): boolean {
  // Re-opening a session that already has a terminal just re-attaches, so
  // warning about the count is noise about something that is not about to
  // happen. That includes one recovered from main after a reload — otherwise
  // the chooser opens with the very terminal being re-opened pre-selected for
  // closing.
  if (session) {
    const key = sessionKeyOf(session);
    const owned = entries.get(key);
    if (owned && isLive(owned)) return false;
    if (orphans.some(o => matchesOrphan(o, session))) return false;
  }
  return prefs.warnEnabled && terminalCount() >= prefs.warnThreshold;
}

export function setTerminalMaximized(next: boolean) {
  prefs = { ...prefs, maximized: next };
  savePrefs();
  notify();
}

// Applied to every live terminal at once: they are one surface with one
// appearance, and per-session themes would just be confusing.
// Both CLIs decide their own colours once, at launch — Claude from the `theme`
// it is started with, Codex from whatever it detects then. Repainting the
// palette underneath a running one leaves its own fills inverted, which is the
// black-bar-on-light and white-bar-on-dark this kept producing. Nothing short
// of relaunching makes them agree.
//
// Restarting is left to the user. An earlier version relaunched terminals it
// judged idle, but the only idle signal available is "no OSC title update for
// ~900ms", and a CLI that goes quiet while still working looks identical to one
// that has finished. Killing an agent mid-task to correct a colour is not a
// trade worth making on a guess — the header offers the restart instead, and
// the mismatch is visible until then.
export function setTerminalTheme(next: TerminalTheme) {
  if (next === prefs.theme) return;
  prefs = { ...prefs, theme: next };
  savePrefs();
  for (const e of entries.values()) {
    e.term.options.theme = palette();
    // Two levels of staleness, and both need addressing:
    //
    //   xterm  — assigning the theme affects future writes; already-rendered
    //            rows keep their old colours until repainted.
    //   the app — a full-screen TUI owns the alternate buffer and redraws only
    //            when it chooses to. Codex emits no background sequences at
    //            all, so its whole surface is terminal background and simply
    //            never gets rewritten. Nudging the PTY size makes it redraw.
    try { e.term.refresh(0, e.term.rows - 1); } catch {}
  }
  notify();
}

export function setTerminalFontSize(next: number) {
  prefs = { ...prefs, fontSize: clamp(Math.round(next), MIN_FONT, MAX_FONT) };
  savePrefs();
  for (const e of entries.values()) {
    e.term.options.fontSize = prefs.fontSize;
    // Cell size changed, so the row/column count did too — refit or the PTY
    // keeps wrapping to the old geometry.
    refitVisible(e);
  }
  notify();
}

export function stepTerminalFontSize(delta: number) {
  setTerminalFontSize(prefs.fontSize + delta);
}

export function sessionKeyOf(session: SessionMeta) {
  return `${session.source}:${session.id}:${session.filePath}`;
}

function notify() {
  for (const fn of subs) fn();
}

export function subscribeTerminals(fn: () => void) {
  subs.add(fn);
  return () => { subs.delete(fn); };
}

// Notified once output for a session has been quiet for a moment — the cue to
// reload the transcript, since the CLI has been appending to the same JSONL
// the view above is rendering.
export function subscribeTerminalActivity(fn: (sessionKey: string) => void) {
  activitySubs.add(fn);
  return () => { activitySubs.delete(fn); };
}

function fireActivity(sessionKey: string) {
  lastActivityFire.set(sessionKey, Date.now());
  for (const fn of activitySubs) fn(sessionKey);
}

function markActivity(sessionKey: string) {
  const since = Date.now() - (lastActivityFire.get(sessionKey) || 0);
  if (since >= ACTIVITY_MAX_INTERVAL_MS) {
    fireActivity(sessionKey);
    return;
  }
  const existing = activityTimers.get(sessionKey);
  if (existing) clearTimeout(existing);
  activityTimers.set(sessionKey, setTimeout(() => {
    activityTimers.delete(sessionKey);
    fireActivity(sessionKey);
  }, ACTIVITY_SETTLE_MS));
}

// Move a terminal back to the off-screen host. Never removes it from the
// document — see `parking()`.
export function parkTerminal(entry: TerminalEntry) {
  parking().appendChild(entry.el);
}

// Fitting a parked terminal measures the off-screen host, not the panel, and
// then tells the CLI to wrap at that width. When the terminal is shown again in
// a narrower pane the lines are already too long and run off the right edge —
// which is exactly the clipping that appeared after a font or size change.
// Parked terminals refit when they are next shown.
function isParked(entry: TerminalEntry): boolean {
  return !!parkingLot && entry.el.parentElement === parkingLot;
}

function refitVisible(entry: TerminalEntry) {
  if (isParked(entry)) return;
  try { entry.fit.fit(); } catch {}
  if (entry.termId) void window.api.ptyResize(entry.termId, entry.term.cols, entry.term.rows);
}

export function getTerminal(sessionKey: string): TerminalEntry | null {
  return entries.get(sessionKey) || null;
}

// Does this session have a process running right now? Includes ones recovered
// from main after a reload: they are just as live, and just as easy to forget.
export function hasLiveTerminal(session: SessionMeta): { live: boolean; busy: boolean } {
  const owned = entries.get(sessionKeyOf(session));
  if (owned && isLive(owned)) return { live: true, busy: owned.busy };
  if (orphans.some(o => matchesOrphan(o, session))) return { live: true, busy: false };
  return { live: false, busy: false };
}

// The most recently opened terminal that is still running.
//
// `entries` is insertion-ordered, so the last live one is the newest — which is
// what the terminals view falls back to when the terminal being shown ends and
// others are still going. Orphans are excluded on purpose: they are processes a
// renderer reload left behind, with no opening order to speak of, and the
// caller can fall back to list order for those.
export function newestLiveTerminal(): TerminalEntry | null {
  let found: TerminalEntry | null = null;
  for (const e of entries.values()) if (isLive(e)) found = e;
  return found;
}

// A value that changes only when something a list or a filter can see has
// changed.
//
// `notify()` fires for everything, and the loudest thing by far is the CLI's
// OSC title: Claude Code animates it at roughly fifteen updates a second while
// it works. Subscribers that bumped a counter therefore re-rendered fifteen
// times a second — and because every view stays mounted behind ViewSlot, that
// meant re-running the session filter, the transcript's message filter and the
// whole Usage page on each of those, which is what made Usage stutter whenever
// an agent was busy.
//
// Storing this string instead lets React bail out: a title change produces the
// same signature, so nothing re-renders. Deliberately excluded is the title
// itself — TerminalPanel displays it, so that one still subscribes raw.
export function terminalsSignature(): string {
  const parts: string[] = [];
  for (const e of entries.values()) {
    // busy flips at most twice per turn (see BUSY_IDLE_MS), unlike the title
    // it is derived from, so the row indicator still updates.
    parts.push(`${e.sessionKey}|${isLive(e) ? 1 : 0}|${e.busy ? 1 : 0}|${e.exitCode ?? ''}|${e.error ? 1 : 0}`);
  }
  for (const o of orphans) parts.push(`orphan|${o.filePath}`);
  parts.sort();
  // Prefs ride along: theme, font and geometry all reach the panel through the
  // same notify, and they change at human speed.
  return `${prefs.theme}|${prefs.fontFamily}|${prefs.fontSize}|${prefs.height}|${prefs.maximized}|${parts.join(',')}`;
}

// A process main is still holding for this session that this module has no
// entry for. The state after a renderer reload: the CLI is alive, its output is
// buffered in main, but nothing here knows about it.
export function hasOrphanFor(session: SessionMeta): boolean {
  return orphans.some(o => matchesOrphan(o, session));
}

export function terminalCount() {
  return [...entries.values()].filter(isLive).length + orphans.length;
}

// Ask main what it is still holding, and drop anything this module already
// owns. Cheap, and the only way a reloaded renderer learns what is running.
export async function refreshOrphans() {
  const res = await window.api.ptyList();
  if (!res.ok || !res.terminals) return;
  if (typeof res.max === 'number') hardMax = res.max;
  const owned = new Set([...entries.values()].map(e => e.termId).filter(Boolean));
  const next = res.terminals.filter(t => !owned.has(t.termId));
  const changed = next.length !== orphans.length
    || next.some((t, i) => t.termId !== orphans[i]?.termId);
  orphans = next;
  if (changed) notify();
}

export function liveTerminalKeys(): string[] {
  return [...entries.keys()];
}

// Enough for a chooser to identify each one without the caller reaching into
// terminal internals.
export type TerminalRow = {
  key: string;
  // Present for terminals this renderer owns; null for ones recovered from
  // main after a reload, where only the file path is known.
  session: SessionMeta | null;
  label: string;
  cwd: string;
  busy: boolean;
};

export function liveTerminals(): TerminalRow[] {
  const owned: TerminalRow[] = [...entries.values()].filter(isLive).map(e => ({
    key: e.sessionKey,
    session: e.session,
    label: '',
    cwd: e.session.lastCwd || e.session.projectCwd || '',
    busy: e.busy,
  }));
  const recovered: TerminalRow[] = orphans.map(o => ({
    key: `orphan:${o.termId}`,
    session: null,
    label: cleanDisplayText(o.filePath.split('/').pop() || o.filePath),
    cwd: o.cwd,
    busy: false,
  }));
  return [...owned, ...recovered];
}

export async function closeTerminals(keys: string[]) {
  for (const key of keys) {
    if (key.startsWith('orphan:')) {
      const termId = key.slice('orphan:'.length);
      // Drop the row only once main confirms the process is gone. pty:stop
      // refuses a terminal whose owning webContents is not the caller
      // ('unknown-terminal'), and removing it here regardless hid a process
      // that kept running and kept counting toward the ceiling — invisible,
      // so unclosable. On refusal, resync from main instead of guessing.
      const res = await window.api.ptyStop(termId);
      if (res.ok) {
        orphans = orphans.filter(o => o.termId !== termId);
        notify();
      } else {
        await refreshOrphans();
      }
      continue;
    }
    await closeTerminal(key);
  }
}

// Each live terminal holds a whole CLI process, so "close the ones I'm not
// using" needs to be one click, not a hunt through the session list.
export async function closeOtherTerminals(keepKey: string) {
  await closeTerminals(liveTerminals().map(r => r.key).filter(k => k !== keepKey));
}

// One data/exit subscription for every terminal, wired once. Per-mount
// listeners would stop routing output the moment a panel unmounted, which is
// exactly the case this module exists to survive.
function wireOnce() {
  if (wired) return;
  wired = true;
  window.api.onPtyData(({ termId, data, seq }) => {
    for (const e of entries.values()) {
      if (e.termId !== termId) continue;
      // The response's replay already contained everything up to lastSeq.
      if (typeof seq === 'number' && seq <= e.lastSeq) return;
      if (typeof seq === 'number') e.lastSeq = seq;
      e.term.write(data);
      markActivity(e.sessionKey);
      return;
    }
    const buf = orphanData.get(termId) || [];
    buf.push({ seq: typeof seq === 'number' ? seq : 0, data });
    orphanData.set(termId, buf.slice(-ORPHAN_CAP));
  });
  window.api.onPtyExit(({ termId, exitCode }) => {
    for (const e of entries.values()) {
      if (e.termId !== termId) continue;
      e.termId = null;
      e.exitCode = exitCode;
      markActivity(e.sessionKey);
      notify();
      return;
    }
    // Either a terminal recovered from main, or one whose start response has
    // not landed yet. Both need the exit remembered rather than dropped.
    orphanExits.set(termId, exitCode);
    orphanData.delete(termId);
    if (orphans.some(o => o.termId === termId)) {
      orphans = orphans.filter(o => o.termId !== termId);
      notify();
    }
  });
}

// A terminal whose process is gone is scrollback, not a running thing. It must
// not count toward the open-terminal warning, and it must not be offered as
// something to close in the chooser.
export function isLive(e: TerminalEntry): boolean {
  return e.termId !== null || !!e.demo;
}

// Main refuses a single write over 64 KB, and xterm hands a paste over as one
// onData chunk — so a large paste was rejected whole, with nothing echoed and
// no error, because the result was never checked. Split it instead. The bound
// is in UTF-16 code units and deliberately conservative: UTF-8 never needs more
// than three bytes per unit, so this cannot cross the byte limit.
const WRITE_CHUNK = 16 * 1024;
// Input typed before the process exists. `pty:start` reads the session's
// metadata, which on a large JSONL takes seconds, and the terminal takes
// keystrokes for that whole time — dropping them lost what the user typed into
// something that looked like a working terminal. Bounded to what one person can
// produce while a single start lands.
const MAX_PENDING_INPUT = 64 * 1024;

function writeToPty(termId: string, data: string) {
  for (let i = 0; i < data.length;) {
    let end = Math.min(i + WRITE_CHUNK, data.length);
    // Never split a surrogate pair — each half alone encodes as U+FFFD.
    const last = data.charCodeAt(end - 1);
    if (end < data.length && last >= 0xd800 && last <= 0xdbff) end -= 1;
    void window.api.ptyWrite(termId, data.slice(i, end));
    i = end;
  }
}

// Everything the user types goes through here, whether the process is up yet or
// not. A terminal with no start coming — one whose process is already gone, or
// a scripted demo that never had one — is scrollback, so its input is dropped
// rather than queued forever.
function sendInput(entry: TerminalEntry, data: string) {
  if (entry.termId) { writeToPty(entry.termId, data); return; }
  if (entry.demo || entry.exitCode !== null || entry.error) return;
  const next = entry.pendingInput + data;
  if (next.length <= MAX_PENDING_INPUT) { entry.pendingInput = next; return; }
  // Dropping the oldest input is the right trade at this bound, but the cut
  // must not land between a surrogate pair: a lone trailing half encodes as
  // U+FFFD, so the first character the CLI receives would be a replacement
  // glyph rather than the text that was typed.
  let cut = next.length - MAX_PENDING_INPUT;
  const first = next.charCodeAt(cut);
  if (first >= 0xdc00 && first <= 0xdfff) cut += 1;
  entry.pendingInput = next.slice(cut);
}

// Starts that have not answered yet, by session key. `pty:start` reads the
// session's metadata, which on a large JSONL takes seconds, and for that whole
// window the entry exists with `termId` still null — so `isLive()` is false and
// a second click fell through to the `closeTerminal` branch below: it disposed
// the pending terminal, then started its own, which main refused as
// 'already-starting'. The user got a failed panel, and the first response then
// set `termId` on an entry no longer in the map — a live CLI process nothing
// tracked. Double-clicking Terminal was enough.
const starting = new Map<string, Promise<TerminalEntry>>();

export function openTerminal(
  session: SessionMeta,
  opts: { demo?: boolean } = {},
): Promise<TerminalEntry> {
  const sessionKey = sessionKeyOf(session);
  const pending = starting.get(sessionKey);
  if (pending) return pending;
  const started = startTerminal(session, opts)
    .finally(() => { starting.delete(sessionKey); });
  starting.set(sessionKey, started);
  return started;
}

async function startTerminal(
  session: SessionMeta,
  opts: { demo?: boolean } = {},
): Promise<TerminalEntry> {
  wireOnce();
  if (!opts.demo) void refreshOrphans();
  const sessionKey = sessionKeyOf(session);
  const existing = entries.get(sessionKey);
  // A dead entry is scrollback, not a terminal. Handing it back made the
  // toolbar button do nothing, and kept its xterm, DOM node and 10k-line
  // buffer alive for as long as the app ran.
  if (existing && isLive(existing)) return existing;
  if (existing) await disposeTerminal(sessionKey);

  const el = document.createElement('div');
  el.style.width = '100%';
  el.style.height = '100%';
  // In the document before open(), so xterm measures something real.
  parking().appendChild(el);

  const term = new XTerm({
    fontFamily: fontStack(),
    fontSize: prefs.fontSize,
    cursorBlink: true,
    scrollback: 10000,
    theme: palette(),
    allowProposedApi: true,
    // OSC 8 hyperlinks — the escape sequence a program uses to mark text as a
    // link — are handled by xterm's core, not by the web-links addon. Both
    // CLIs emit them, and without a handler here xterm falls back to a
    // `confirm()` dialog warning that the link "could potentially be
    // dangerous", then window.open. Routing them through the same IPC as every
    // other outbound link replaces that with the user's actual browser.
    linkHandler: {
      activate: (event, uri) => {
        event.preventDefault();
        void window.api.openExternal(uri);
      },
    },
  });
  // xterm's built-in character-width table is Unicode 6. Anything the standard
  // widened since then — a great many CJK blocks and symbols — gets one cell
  // when the program that wrote it allocated two, which is what left text
  // running under the right edge of the pane at some widths: the CLI wrapped
  // for the width it believed it had while xterm laid the same run out shorter.
  // The addon supplies the Unicode 11 tables; registering is not enough, the
  // version has to be made active.
  term.loadAddon(new Unicode11Addon());
  term.unicode.activeVersion = '11';

  const fit = new FitAddon();
  term.loadAddon(fit);
  // URLs in terminal output are just text until something detects them. The
  // click goes through the same IPC every other outbound link in the app uses,
  // which whitelists http/https/mailto in main — the renderer never gets to
  // hand an arbitrary scheme to the OS.
  term.loadAddon(new WebLinksAddon((event, uri) => {
    event.preventDefault();
    void window.api.openExternal(uri);
  }));
  term.open(el);

  // Render on the GPU rather than through the DOM. xterm's default renderer
  // builds every row out of spans, so a glyph the font draws wider than its
  // cell is cut off by the span's box — visible on CJK, where the fallback
  // family has no relationship to the cell width measured from the Latin font.
  // The WebGL renderer draws from a glyph atlas and is also what keeps a busy
  // agent's output from costing a layout pass per frame.
  //
  // Must come after open(): the addon needs the terminal's canvas.
  //
  // A WebGL context is not guaranteed for the life of the app — the GPU process
  // can restart, and a renderer holds a limited number of contexts at once — so
  // losing it has to be survivable. Disposing the addon drops the terminal back
  // to the DOM renderer, which looks worse on CJK but keeps working.
  try {
    const webgl = new WebglAddon();
    webgl.onContextLoss(() => webgl.dispose());
    term.loadAddon(webgl);
  } catch {
    // No WebGL at all (software rendering, a stripped-down GPU stack). The DOM
    // renderer stays in place; nothing else here depends on the addon.
  }

  const entry: TerminalEntry = {
    sessionKey, termId: null, term, fit, el, exitCode: null, error: null,
    title: '', busy: false, spawnTheme: prefs.theme, session, lastSeq: 0,
    pendingInput: '', demo: !!opts.demo, demoTimers: [],
  };
  entries.set(sessionKey, entry);

  term.onTitleChange((raw) => {
    // Drop a leading spinner glyph (and any braille/dingbat frame) plus the
    // space after it. What remains is the part worth showing.
    // Subprocess output on its way to the DOM: strip ANSI/control/bidi the
    // same way every other externally-sourced string in the app is, and bound
    // the length so a hostile or broken title cannot stretch the header.
    const clean = cleanDisplayText(raw)
      .replace(/^[^\p{L}\p{N}]+\s*/u, '')
      .trim()
      .slice(0, 120);
    const titleChanged = clean !== entry.title;
    if (titleChanged) entry.title = clean;

    const wasBusy = entry.busy;
    entry.busy = true;
    if (busyTimers.has(sessionKey)) clearTimeout(busyTimers.get(sessionKey));
    busyTimers.set(sessionKey, setTimeout(() => {
      busyTimers.delete(sessionKey);
      entry.busy = false;
      notify();
    }, BUSY_IDLE_MS));

    // Only re-render when something a human can see actually changed —
    // otherwise the animation would repaint the pane fifteen times a second.
    if (titleChanged || !wasBusy) notify();
  });

  // Shift+Enter must insert a newline, not submit.
  //
  // xterm.js sends a bare CR for both Enter and Shift+Enter, so the CLI cannot
  // tell them apart and treats the second as "send". iTerm2 avoids this by
  // speaking a keyboard protocol that reports the modifier — xterm.js does not
  // implement one. Measured against the real CLI: ESC+CR inserts a newline,
  // CSI 13;2u also works, and a bare LF submits. ESC+CR is what Claude Code's
  // own `/terminal-setup` installs for iTerm2, so it is the sequence to send.
  term.attachCustomKeyEventHandler((ev) => {
    if (ev.type !== 'keydown') return true;
    if (ev.key !== 'Enter' || !ev.shiftKey || ev.altKey || ev.ctrlKey || ev.metaKey) return true;
    // preventDefault is the load-bearing part, not the return value. xterm's
    // _keyDown does `if (handler(e) === false) return false;` and returns
    // without preventing the default — so the browser still inserts a newline
    // into the hidden textarea, which xterm then forwards as ordinary input.
    // That bare newline is exactly the byte the CLI treats as "send", so the
    // message was submitted despite xterm's own handling being cancelled.
    ev.preventDefault();
    ev.stopPropagation();
    sendInput(entry, '\u001b\r');
    return false;
  });

  term.onData((data) => {
    sendInput(entry, data);
  });

  if (opts.demo) {
    playDemoScript(entry);
    notify();
    return entry;
  }

  // The CLI's own chrome colour is fixed at spawn from this, so a later theme
  // toggle repaints the palette immediately but the CLI's fills only follow on
  // the next restart.
  const res = await window.api.ptyStart(
    session.source, session.filePath, term.cols || 80, term.rows || 24, prefs.theme,
    getTerminalStartMode(session.source) || null,
  );
  // closeTerminal can land while the start is in flight: it disposes the
  // terminal and drops it from the map without knowing a process is on its way.
  // Writing the id onto that entry would leave the CLI running with nothing
  // tracking it, so stop what we just started instead.
  if (entries.get(sessionKey) !== entry) {
    if (res.ok && res.termId) void window.api.ptyStop(res.termId);
    return entry;
  }
  if (!res.ok || !res.termId) {
    entry.error = res.error || 'pty-failed';
  } else {
    entry.termId = res.termId;
    // Reattaching hands back a process launched earlier, possibly under the
    // other theme. Trusting our own request here is what hid the mismatch and
    // left the user with a black bar and no explanation.
    if (res.spawnTheme) entry.spawnTheme = res.spawnTheme;

    // Replay first, then only the chunks it did not already contain. Writing
    // both unconditionally duplicated everything that arrived while the
    // response was in flight — and duplicated control sequences corrupt a
    // full-screen TUI, they do not just repeat text.
    if (res.replay) term.write(res.replay);
    entry.lastSeq = typeof res.replaySeq === 'number' ? res.replaySeq : 0;
    const early = orphanData.get(res.termId) || [];
    orphanData.delete(res.termId);
    for (const chunk of early) {
      if (chunk.seq && chunk.seq <= entry.lastSeq) continue;
      if (chunk.seq) entry.lastSeq = chunk.seq;
      term.write(chunk.data);
    }

    orphans = orphans.filter(o => o.termId !== res.termId);

    // The process may have died before this response arrived: the exit event
    // reaches this module while the id is still unknown here, so it is parked
    // in orphanExits rather than dropped.
    const exitedWith = orphanExits.get(res.termId);
    if (typeof exitedWith === 'number') {
      orphanExits.delete(res.termId);
      entry.termId = null;
      entry.exitCode = exitedWith;
    }

    // Whatever was typed while the start was in flight. Sent in one go so it
    // reaches the CLI in the order it was typed, and only if the process is
    // still there to receive it.
    if (entry.termId && entry.pendingInput) {
      const queued = entry.pendingInput;
      entry.pendingInput = '';
      writeToPty(entry.termId, queued);
    }
  }
  entry.pendingInput = '';
  notify();
  return entry;
}

// Replays the canned session at a readable pace. `busy` is driven from the
// script the same way it is from OSC title churn on a real terminal, so the
// list indicator animates in screenshots too.
function playDemoScript(entry: TerminalEntry) {
  let at = 0;
  entry.busy = true;
  for (const chunk of DEMO_TERMINAL_SCRIPT) {
    at += chunk.delay;
    entry.demoTimers!.push(setTimeout(() => {
      // Width is read at write time, not when the script was authored: rules,
      // the highlight bars behind user turns and the right-aligned token count
      // all have to span whatever the pane happens to be.
      const data = typeof chunk.data === 'function'
        ? chunk.data(entry.term.cols)
        : chunk.data;
      entry.term.write(data);
    }, at));
  }
  entry.demoTimers!.push(setTimeout(() => {
    entry.busy = false;
    notify();
  }, at + 400));
}

// The only thing that tears a terminal down. Nothing else — not unmounting,
// not switching sessions, not closing the panel — may call this.
export async function closeTerminal(sessionKey: string) {
  // A start still in flight holds this session in main as well as here, and
  // restart is close-then-open: tearing down now would have the reopen refused
  // as 'already-starting', while the start landing afterwards found its entry
  // gone and stopped the process it had just spawned — leaving no terminal at
  // all and a blank panel. Let it land, then close what it actually produced.
  const pending = starting.get(sessionKey);
  if (pending) { try { await pending; } catch {} }
  await disposeTerminal(sessionKey);
}

// The teardown itself, without waiting on a start in flight. Only startTerminal
// may call this directly: it runs *inside* the one pending start a key can
// have, so going through closeTerminal there would deadlock on itself.
async function disposeTerminal(sessionKey: string) {
  const entry = entries.get(sessionKey);
  if (!entry) return;
  entries.delete(sessionKey);
  const timer = activityTimers.get(sessionKey);
  if (timer) { clearTimeout(timer); activityTimers.delete(sessionKey); }
  lastActivityFire.delete(sessionKey);
  const busyTimer = busyTimers.get(sessionKey);
  if (busyTimer) { clearTimeout(busyTimer); busyTimers.delete(sessionKey); }
  const id = entry.termId;
  entry.termId = null;
  try { entry.term.dispose(); } catch {}
  try { entry.el.remove(); } catch {}

  // Tell the UI now: this module's state is already correct, and the terminal
  // is gone from the user's point of view. `pty:stop` waits for the process to
  // actually exit — up to a few seconds while the signal escalates — and
  // notifying only after it left the list and the detail pane frozen for that
  // whole time, which read as the app hanging on a close click.
  for (const timer of entry.demoTimers || []) clearTimeout(timer);
  notify();
  if (id) await window.api.ptyStop(id);
}

export async function restartTerminal(session: SessionMeta, opts: { demo?: boolean } = {}) {
  await closeTerminal(sessionKeyOf(session));
  return openTerminal(session, opts);
}
