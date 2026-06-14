import { useEffect, useState } from 'react';

export type TerminalApp = 'terminal' | 'iterm';

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
    return out;
  } catch { return DEFAULTS; }
}

export function useDisplayPrefs(): [DisplayPrefs, (patch: Partial<DisplayPrefs>) => void] {
  const [prefs, setPrefs] = useState<DisplayPrefs>(() => parsePrefs(localStorage.getItem(STORAGE_KEY)));

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  }, [prefs]);

  return [prefs, (patch: Partial<DisplayPrefs>) => setPrefs(p => ({ ...p, ...patch }))];
}
