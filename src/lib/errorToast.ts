// Errors surface as floating toasts, not in the status bar. The status bar is
// one fixed-height row, and an error message there (often a full IPC error
// string) pushed the build chip off the edge and stayed until something else
// overwrote it. A toast floats above the layout, so nothing moves.
//
// Module-level store rather than a context: errors come from views that sit at
// different depths, and none of them should need a prop threaded down just to
// report a failure.

import { useSyncExternalStore } from 'react';

export type ErrorToast = { id: number; message: string };

const AUTO_DISMISS_MS = 8000;
// A burst of failures (every row of a list failing the same way) would
// otherwise stack toasts down the whole window.
const MAX_TOASTS = 3;

let _toasts: ErrorToast[] = [];
let _seq = 0;
const _timers = new Map<number, number>();
const _subs = new Set<() => void>();

function emit() {
  for (const fn of _subs) fn();
}

function arm(id: number) {
  const prev = _timers.get(id);
  if (prev != null) clearTimeout(prev);
  _timers.set(id, window.setTimeout(() => dismissError(id), AUTO_DISMISS_MS));
}

export function showError(message: string) {
  if (!message) return;
  // A background refresh that keeps failing reports the same text on every
  // attempt; restart the existing toast's clock instead of stacking copies.
  const same = _toasts.find(x => x.message === message);
  if (same) {
    arm(same.id);
    return;
  }
  const toast = { id: ++_seq, message };
  const next = [..._toasts, toast];
  for (const dropped of next.slice(0, Math.max(0, next.length - MAX_TOASTS))) {
    const timer = _timers.get(dropped.id);
    if (timer != null) clearTimeout(timer);
    _timers.delete(dropped.id);
  }
  _toasts = next.slice(-MAX_TOASTS);
  arm(toast.id);
  emit();
}

// Paused while the pointer is over a toast, so a long message can't vanish
// halfway through being read or selected for copying.
export function holdError(id: number) {
  const timer = _timers.get(id);
  if (timer != null) clearTimeout(timer);
  _timers.delete(id);
}

export function releaseError(id: number) {
  if (_toasts.some(x => x.id === id)) arm(id);
}

export function dismissError(id: number) {
  const timer = _timers.get(id);
  if (timer != null) clearTimeout(timer);
  _timers.delete(id);
  if (!_toasts.some(x => x.id === id)) return;
  _toasts = _toasts.filter(x => x.id !== id);
  emit();
}

function subscribe(fn: () => void) {
  _subs.add(fn);
  return () => { _subs.delete(fn); };
}

export function useErrorToasts(): ErrorToast[] {
  return useSyncExternalStore(subscribe, () => _toasts);
}
