import { useCallback, useEffect, useState } from 'react';

export type TerminalApp = 'terminal' | 'iterm';

// How the Usage view's project breakdown is grouped. 'folder' is one row per
// working directory (what the numbers have always been); 'repo' folds every
// worktree and subdirectory of a git repository into one row.
export type ProjectGrouping = 'folder' | 'repo';

export type DisplayPrefs = {
  showTools: boolean;
  showTimestamps: boolean;
  showMsgTokens: boolean;
  showAvatars: boolean;
  compact: boolean;
  preferredTerminal: TerminalApp;
  toolbarLabels: boolean;
  // When true (default) any http(s) image referenced in a session JSONL is
  // fetched automatically. Privacy-conscious users can flip this off so each
  // remote image surfaces as a click-to-load placeholder instead — useful
  // when a JSONL came from someone else and might point at tracking URLs.
  loadRemoteImages: boolean;
  projectGrouping: ProjectGrouping;
};

const DEFAULTS: DisplayPrefs = {
  showTools: false,
  showTimestamps: true,
  showMsgTokens: true,
  showAvatars: true,
  compact: false,
  preferredTerminal: 'iterm',
  toolbarLabels: false,
  loadRemoteImages: true,
  // Folder-based by default: it's what existing users' numbers already mean,
  // and anyone who doesn't use worktrees sees the same list either way.
  projectGrouping: 'folder',
};

const STORAGE_KEY = 'display-prefs-v1';

function parsePrefs(raw: string | null): DisplayPrefs {
  if (!raw) return DEFAULTS;
  try {
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== 'object') return DEFAULTS;
    // Per-field validation: a corrupted localStorage entry that puts a
    // string where a boolean belongs would otherwise leak into UI conditions
    // and switch state. Round-trip every field through its known type.
    const out: DisplayPrefs = { ...DEFAULTS };
    if (typeof obj.showTools === 'boolean') out.showTools = obj.showTools;
    if (typeof obj.showTimestamps === 'boolean') out.showTimestamps = obj.showTimestamps;
    if (typeof obj.showMsgTokens === 'boolean') out.showMsgTokens = obj.showMsgTokens;
    if (typeof obj.showAvatars === 'boolean') out.showAvatars = obj.showAvatars;
    if (typeof obj.compact === 'boolean') out.compact = obj.compact;
    if (typeof obj.toolbarLabels === 'boolean') out.toolbarLabels = obj.toolbarLabels;
    if (typeof obj.loadRemoteImages === 'boolean') out.loadRemoteImages = obj.loadRemoteImages;
    if (obj.preferredTerminal === 'terminal' || obj.preferredTerminal === 'iterm') out.preferredTerminal = obj.preferredTerminal;
    if (obj.projectGrouping === 'folder' || obj.projectGrouping === 'repo') out.projectGrouping = obj.projectGrouping;
    return out;
  } catch { return DEFAULTS; }
}

// Module-level singleton. Per-hook `useState` gave every component its own copy
// of what is one setting: flipping "Show toolbar button labels" in Settings
// changed Settings' copy and nothing else, and the detail pane kept rendering
// from a copy that never heard about it. Worse, each copy also wrote itself
// back to localStorage, so whichever component re-rendered last could overwrite
// a change it never saw. One store, one writer, all subscribers re-render.
let _prefs: DisplayPrefs = readStored();
const _subs = new Set<() => void>();

function readStored(): DisplayPrefs {
  // Private windows and blocked site data throw on access, and a preview or
  // thumbnail capture can hand us an empty store — defaults have to survive
  // both without taking the page down.
  try { return parsePrefs(localStorage.getItem(STORAGE_KEY)); } catch { return DEFAULTS; }
}

export function useDisplayPrefs(): [DisplayPrefs, (patch: Partial<DisplayPrefs>) => void] {
  const [, bump] = useState(0);

  useEffect(() => {
    const fn = () => bump(n => n + 1);
    _subs.add(fn);
    return () => { _subs.delete(fn); };
  }, []);

  const update = useCallback((patch: Partial<DisplayPrefs>) => {
    _prefs = { ..._prefs, ...patch };
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(_prefs)); } catch { /* not worth failing the toggle */ }
    for (const fn of _subs) fn();
  }, []);

  return [_prefs, update];
}
