// Group sessions by relative date for a timeline-style list.

import { sessionTimestamp } from './format';

const ORDER = ['Today', 'Yesterday', 'This week', 'This month', 'Earlier'] as const;
export type GroupKey = typeof ORDER[number];

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

export function groupKey(ts: number | null | undefined): GroupKey {
  if (!ts) return 'Earlier';
  const now = startOfDay(new Date());
  const dayMs = 86400_000;
  const day = startOfDay(new Date(ts));
  const diff = Math.floor((now.getTime() - day.getTime()) / dayMs);
  if (diff <= 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  if (diff < 7) return 'This week';
  if (diff < 30) return 'This month';
  return 'Earlier';
}

export function groupSessions<T extends { lastTs?: string | null; mtime?: number }>(items: T[]): Array<{ key: GroupKey; items: T[] }> {
  const buckets: Record<GroupKey, T[]> = {
    Today: [], Yesterday: [], 'This week': [], 'This month': [], Earlier: [],
  };
  for (const s of items) {
    buckets[groupKey(sessionTimestamp(s))].push(s);
  }
  return ORDER.filter(k => buckets[k].length > 0).map(k => ({ key: k, items: buckets[k] }));
}
