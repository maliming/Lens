import { useEffect, useState } from 'react';
import type { SessionSource } from './sources';

export type Profile = {
  name: string;
  avatarInitial: string;
  avatarGradient: string;
  // Optional user-uploaded avatar as a data URL (JPEG, resized to 256×256
  // before save — see AccountModal). When set, renderers prefer this over
  // the initial + gradient fallback.
  avatarImage?: string;
};

export const AVATAR_GRADIENTS = [
  'from-purple-500 to-blue-500',
  'from-pink-500 to-purple-500',
  'from-amber-500 to-pink-500',
  'from-emerald-500 to-cyan-500',
  'from-indigo-500 to-purple-500',
  'from-rose-500 to-orange-500',
  'from-sky-500 to-violet-500',
  'from-slate-600 to-slate-400',
];

const DEFAULTS: Record<SessionSource, Profile> = {
  claude: { name: 'Lens', avatarInitial: 'L', avatarGradient: 'from-purple-500 to-blue-500' },
  codex:  { name: 'Lens', avatarInitial: 'L', avatarGradient: 'from-slate-600 to-slate-400' },
};

// Per-source storage so a user signed in as different accounts to Claude
// and Codex sees their actual identity flip when they swap sources.
function storageKey(source: SessionSource) {
  return `profile-v2:${source}`;
}

export function useProfile(source: SessionSource): [Profile, (patch: Partial<Profile>) => void] {
  const [profile, setProfile] = useState<Profile>(() => readProfile(source));

  // When source changes, swap in that source's persisted profile.
  useEffect(() => {
    setProfile(readProfile(source));
  }, [source]);

  // Persist whenever the active profile changes — under the current source's key.
  useEffect(() => {
    try { localStorage.setItem(storageKey(source), JSON.stringify(profile)); } catch {}
  }, [profile, source]);

  return [profile, (patch: Partial<Profile>) => setProfile(p => ({ ...p, ...patch }))];
}

function readProfile(source: SessionSource): Profile {
  try {
    const raw = localStorage.getItem(storageKey(source));
    if (raw) return { ...DEFAULTS[source], ...JSON.parse(raw) };
  } catch {}
  return DEFAULTS[source];
}
