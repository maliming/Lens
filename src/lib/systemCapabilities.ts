import { useEffect, useState } from 'react';
import type { SystemCapabilities, TerminalAvailability } from '../types';

// Read once at app startup, cached. Falls back to assuming nothing is available
// so the UI errs on the side of hiding instead of lying.
const FALLBACK: SystemCapabilities = {
  platform: 'unknown',
  terminals: { terminal: false, iterm: false, wt: false, powershell: false, cmd: false },
};

let cache: SystemCapabilities | null = null;
let inflight: Promise<SystemCapabilities> | null = null;

async function load(): Promise<SystemCapabilities> {
  if (cache) return cache;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const r = await window.api.getSystemCapabilities();
      cache = r;
      return r;
    } catch {
      cache = FALLBACK;
      return FALLBACK;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

export function useSystemCapabilities(): SystemCapabilities | null {
  const [caps, setCaps] = useState<SystemCapabilities | null>(cache);
  useEffect(() => {
    if (cache) { setCaps(cache); return; }
    load().then(setCaps);
  }, []);
  return caps;
}

export type TerminalKey = keyof TerminalAvailability;
export type TerminalOption = { id: TerminalKey; label: string };

// Convenience helper for components that only care about terminal availability.
export function availableTerminals(caps: SystemCapabilities | null): TerminalOption[] {
  if (!caps) return [];
  const t = caps.terminals;
  const out: TerminalOption[] = [];
  if (caps.platform === 'darwin') {
    if (t.terminal) out.push({ id: 'terminal', label: 'Terminal' });
    if (t.iterm) out.push({ id: 'iterm', label: 'iTerm' });
  } else if (caps.platform === 'win32') {
    if (t.wt) out.push({ id: 'wt', label: 'Windows Terminal' });
    if (t.powershell) out.push({ id: 'powershell', label: 'PowerShell' });
    if (t.cmd) out.push({ id: 'cmd', label: 'Command Prompt' });
  }
  return out;
}
