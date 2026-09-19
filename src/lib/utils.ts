import { clsx, type ClassValue } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

// tailwind-merge only knows Tailwind's stock scales. The shadow names below are
// this app's own (tailwind.config.js); without them a theme skin's
// `shadow-none` would sit beside a call site's `shadow-pop` instead of
// replacing it.
const twMerge = extendTailwindMerge({
  extend: { classGroups: { shadow: [{ shadow: ['soft', 'card', 'pop'] }] } },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
