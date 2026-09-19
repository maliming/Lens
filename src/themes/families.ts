// The theme families the Style setting offers, in the order it lists them.
// Labels are product names, so they stay untranslated. index.html's pre-paint
// script repeats the ids to set the attribute before the bundle loads — keep
// the two in step.
export const THEME_FAMILIES = [
  { id: 'lens', label: 'Lens' },
  { id: 'claude', label: 'Claude' },
  { id: 'openai', label: 'OpenAI' },
  { id: 'github', label: 'GitHub' },
] as const;

export type ThemeFamily = (typeof THEME_FAMILIES)[number]['id'];

export function isThemeFamily(value: unknown): value is ThemeFamily {
  return THEME_FAMILIES.some(f => f.id === value);
}
