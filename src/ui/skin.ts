import { useThemeFamily, type ThemeFamily } from '../themes';

// What a shared element is, independent of how any family draws it.
export type ButtonVariant =
  | 'primary'
  | 'secondary'
  | 'ghost'
  | 'icon'
  | 'link'
  | 'danger'
  | 'chip'
  | 'segment'
  | 'tab'
  | 'nav'
  | 'option'
  | 'switch'
  // The row that heads a card and opens something — the source switcher on the
  // identity card. No family styles it: chrome of its own would cut it out of
  // the card it belongs to, which is the whole point of the shape.
  | 'card-header';

export type SurfaceKind =
  | 'pane'
  | 'card'
  | 'row'
  | 'panel'
  | 'banner'
  | 'segmented'
  | 'tablist'
  | 'counter'
  | 'kbd'
  | 'badge'
  | 'eyebrow'
  | 'input'
  | 'select'
  | 'popover'
  | 'menu'
  | 'menu-item'
  | 'menu-separator'
  | 'dialog-overlay'
  | 'dialog'
  | 'dialog-header'
  | 'dialog-title'
  | 'dialog-footer'
  | 'drawer'
  | 'tooltip';

// Classes a theme family layers onto the primitives. Call sites keep the
// classes that belong to where an element sits and how Lens draws it; a skin
// carries what makes an element look like another family and is applied last,
// so it wins any conflict. Lens has no entry: its look stays written at the call
// sites, which is what keeps the default theme identical as families are added.
export type Skin = {
  button?: Partial<Record<ButtonVariant, string>>;
  buttonActive?: Partial<Record<ButtonVariant, string>>;
  surface?: Partial<Record<SurfaceKind, string>>;
};

// GitHub, after Primer's components. Colours are the --gh-* variables that
// github.css takes from @primer/primitives; shadows, radii and type already
// follow the family's own tokens, so these classes only restyle what Lens's
// call sites decide for themselves.
const github: Skin = {
  button: {
    primary: 'bg-[var(--gh-btn-primary-bg)] hover:bg-[var(--gh-btn-primary-bg-hover)] hover:opacity-100 text-[var(--gh-btn-primary-fg)] border border-[var(--gh-btn-primary-border)] rounded-md font-medium',
    secondary: 'bg-[var(--gh-btn-bg)] hover:bg-[var(--gh-btn-bg-hover)] active:bg-[var(--gh-btn-bg-active)] text-[var(--gh-btn-fg)] hover:text-[var(--gh-btn-fg)] border border-[var(--gh-btn-border)] hover:border-[var(--gh-btn-border)] rounded-md font-medium shadow-none',
    ghost: 'bg-transparent hover:bg-[var(--gh-btn-invisible-hover)] active:bg-[var(--gh-btn-invisible-active)] text-[var(--gh-btn-fg)] hover:text-[var(--gh-btn-fg)] rounded-md',
    icon: 'bg-transparent hover:bg-[var(--gh-btn-invisible-hover)] active:bg-[var(--gh-btn-invisible-active)] text-[var(--gh-fg-muted)] hover:text-[var(--gh-fg)] rounded-md',
    link: 'text-[var(--gh-accent)] hover:text-[var(--gh-accent)] hover:underline',
    danger: 'bg-[var(--gh-btn-bg)] border border-[var(--gh-btn-border)] text-[var(--gh-btn-danger-fg)] hover:bg-[var(--gh-btn-danger-bg-hover)] hover:text-[var(--gh-btn-danger-fg-hover)] rounded-md font-medium',
    chip: 'bg-[var(--gh-btn-bg)] hover:bg-[var(--gh-btn-bg-hover)] text-[var(--gh-btn-fg)] hover:text-[var(--gh-btn-fg)] border border-[var(--gh-btn-border)] hover:border-[var(--gh-btn-border)] rounded-md',
    segment: 'bg-transparent hover:bg-[var(--gh-btn-invisible-hover)] text-[var(--gh-fg-muted)] hover:text-[var(--gh-fg)] rounded-md shadow-none',
    tab: 'relative bg-transparent hover:bg-[var(--gh-btn-invisible-hover)] text-[var(--gh-fg)] hover:text-[var(--gh-fg)] rounded-md text-sm',
    nav: 'text-[14px] font-normal bg-transparent hover:bg-[var(--gh-btn-invisible-hover)] text-[var(--gh-fg)] hover:text-[var(--gh-fg)] rounded-md active:scale-100',
    option: 'hover:bg-[var(--gh-btn-invisible-hover)] rounded-md',
    // The track's edge is an inset shadow, not a border: a border would push the
    // absolutely placed knob in by a pixel and send it past the end when on.
    switch: 'bg-[var(--gh-track-bg)] shadow-[inset_0_0_0_1px_var(--gh-track-border)]',
  },
  buttonActive: {
    secondary: 'bg-[var(--gh-btn-bg-active)]',
    chip: 'bg-[var(--gh-accent-muted)] text-[var(--gh-accent)] border-[var(--gh-accent-emphasis)]',
    segment: 'bg-[var(--gh-knob-bg)] text-[var(--gh-fg)] border border-[var(--gh-knob-border)] font-semibold',
    // UnderlineNav: the bar ends half a rem plus a pixel below the tab, which
    // is the bottom of a tab list's `pb-2` and its one-pixel border.
    tab: "font-semibold after:content-[''] after:absolute after:inset-x-0 after:-bottom-[calc(0.5rem+1px)] after:h-0.5 after:rounded-md after:bg-[var(--gh-underline-active)]",
    nav: 'bg-[var(--gh-selected-bg)] font-semibold',
    option: 'bg-[var(--gh-selected-bg)] text-[var(--gh-fg)]',
    switch: 'bg-[var(--gh-accent-emphasis)] shadow-none',
  },
  surface: {
    pane: 'rounded-md border-[var(--gh-border)]',
    card: 'rounded-md border-[var(--gh-border)]',
    panel: 'rounded-md border-[var(--gh-border)]',
    banner: 'rounded-md',
    segmented: 'bg-[var(--gh-track-bg)] border border-[var(--gh-track-border)] rounded-md',
    tablist: 'gap-2 border-[var(--gh-border-muted)]',
    counter: 'rounded-full bg-[var(--gh-counter-bg)] text-[var(--gh-fg)]',
    kbd: 'rounded-md bg-[var(--gh-btn-bg)] border-[var(--gh-border)] text-[var(--gh-fg-muted)]',
    badge: 'rounded-full',
    eyebrow: 'normal-case tracking-normal text-xs text-[var(--gh-fg)]',
    input: 'rounded-md bg-[var(--gh-input-bg)] border-[var(--gh-border)] focus:border-[var(--gh-accent-emphasis)] focus:ring-[var(--gh-accent-emphasis)]',
    select: 'rounded-md bg-[var(--gh-btn-bg)] border-[var(--gh-border)] text-[var(--gh-btn-fg)]',
    popover: 'rounded-md bg-[var(--gh-overlay-bg)] border-[var(--gh-overlay-border)]',
    menu: 'rounded-md bg-[var(--gh-overlay-bg)] border-[var(--gh-overlay-border)]',
    'menu-item': 'rounded-md data-[highlighted]:bg-[var(--gh-btn-invisible-hover)] data-[highlighted]:text-[var(--gh-fg)]',
    'menu-separator': 'bg-[var(--gh-border-muted)]',
    'dialog-overlay': 'bg-[var(--gh-backdrop)] backdrop-blur-none',
    dialog: 'rounded-[12px] bg-[var(--gh-overlay-bg)] border-[var(--gh-overlay-border)]',
    drawer: 'rounded-[12px] bg-[var(--gh-overlay-bg)] border-[var(--gh-overlay-border)]',
    'dialog-header': 'border-[var(--gh-border-muted)]',
    'dialog-title': 'text-[var(--gh-fg)] font-semibold',
    'dialog-footer': 'border-[var(--gh-border-muted)] bg-transparent',
    tooltip: 'rounded-md bg-[var(--gh-tooltip-bg)] text-[var(--gh-tooltip-fg)] border-transparent',
  },
};

// The families below take their component-specific colours from --fx-* in their
// theme file, next to the tokens the rest of the app already uses.

// Claude, after claude.ai: dark primary buttons, warm grey fills for hover and
// the current item (no accent), 8px controls and a 14px-rounded composer.
const claude: Skin = {
  button: {
    primary: 'bg-[hsl(var(--text))] hover:bg-[hsl(var(--text)/0.88)] hover:opacity-100 text-[hsl(var(--surface))] hover:text-[hsl(var(--surface))] border-transparent rounded-lg font-medium shadow-none',
    secondary: 'bg-[hsl(var(--elevated))] hover:bg-[var(--fx-hover)] text-[hsl(var(--text))] hover:text-[hsl(var(--text))] border border-[hsl(var(--border))] hover:border-[hsl(var(--border))] rounded-lg shadow-none',
    ghost: 'rounded-lg hover:bg-[var(--fx-hover)]',
    icon: 'rounded-lg hover:bg-[var(--fx-hover)]',
    chip: 'rounded-lg bg-[hsl(var(--elevated))] hover:bg-[var(--fx-hover)] border-[hsl(var(--border))] hover:border-[hsl(var(--border))]',
    segment: 'rounded-md shadow-none',
    tab: 'rounded-lg hover:bg-[var(--fx-hover)]',
    nav: 'rounded-lg font-normal text-[var(--fx-nav-fg)] hover:bg-[var(--fx-hover)] hover:text-[hsl(var(--text))] active:scale-100',
    option: 'rounded-lg hover:bg-[var(--fx-hover)]',
  },
  buttonActive: {
    nav: 'bg-[var(--fx-selected)] text-[hsl(var(--text))]',
    segment: 'bg-[hsl(var(--elevated))] text-[hsl(var(--text))] shadow-[0_0_0_0.5px_hsl(var(--border)),0_1px_2px_rgba(0,0,0,0.06)]',
    tab: 'bg-[var(--fx-selected)] text-[hsl(var(--text))]',
    chip: 'bg-[var(--fx-selected)] text-[hsl(var(--text))]',
    option: 'bg-[var(--fx-selected)]',
    switch: 'bg-[hsl(var(--ring))]',
  },
  surface: {
    pane: 'rounded-[14px]',
    card: 'rounded-xl',
    panel: 'rounded-xl',
    segmented: 'rounded-lg',
    counter: 'rounded-md bg-[var(--fx-selected)] text-[hsl(var(--text-dim))]',
    kbd: 'rounded-md',
    eyebrow: 'normal-case tracking-normal text-xs font-medium text-[hsl(var(--text-muted))]',
    input: 'rounded-[10px] bg-[hsl(var(--elevated))] border-[hsl(var(--border))] focus:border-[hsl(var(--ring))]',
    select: 'rounded-lg',
    popover: 'rounded-xl bg-[hsl(var(--elevated))] border-[hsl(var(--border))]',
    menu: 'rounded-xl bg-[hsl(var(--elevated))] border-[hsl(var(--border))]',
    'menu-item': 'rounded-lg data-[highlighted]:bg-[var(--fx-hover)] data-[highlighted]:text-[hsl(var(--text))]',
    dialog: 'rounded-2xl',
    drawer: 'rounded-2xl',
    tooltip: 'rounded-lg',
  },
};

// OpenAI, after chatgpt.com: monochrome pill buttons (filled, or outlined at 20%
// of the text colour), translucent fills for hover and the current item, 10px
// list items and generously rounded surfaces.
const openai: Skin = {
  button: {
    primary: 'bg-[hsl(var(--accent))] hover:bg-[hsl(var(--accent)/0.85)] hover:opacity-100 text-on-accent hover:text-on-accent border-transparent rounded-full font-semibold shadow-none',
    secondary: 'bg-[hsl(var(--surface))] hover:bg-[var(--fx-hover)] text-[hsl(var(--text))] hover:text-[hsl(var(--text))] border border-[var(--fx-outline)] hover:border-[var(--fx-outline)] rounded-full font-semibold shadow-none',
    ghost: 'rounded-[10px] hover:bg-[var(--fx-hover)]',
    icon: 'rounded-lg hover:bg-[var(--fx-hover)]',
    link: 'text-[hsl(var(--text))] hover:text-[hsl(var(--text))] underline-offset-2 hover:underline',
    danger: 'rounded-full',
    chip: 'rounded-full bg-[hsl(var(--surface))] hover:bg-[var(--fx-hover)] border-[var(--fx-outline)] hover:border-[var(--fx-outline)] text-[hsl(var(--text))]',
    segment: 'rounded-full shadow-none',
    tab: 'rounded-full hover:bg-[var(--fx-hover)]',
    nav: 'rounded-[10px] font-normal text-[hsl(var(--text))] hover:bg-[var(--fx-hover)] hover:text-[hsl(var(--text))] active:scale-100',
    option: 'rounded-[10px] hover:bg-[var(--fx-hover)]',
  },
  buttonActive: {
    nav: 'bg-[var(--fx-selected)] text-[hsl(var(--text))]',
    segment: 'bg-[var(--fx-knob)] text-[hsl(var(--text))] shadow-[0_1px_2px_rgba(0,0,0,0.08)]',
    tab: 'bg-[var(--fx-selected)] text-[hsl(var(--text))]',
    chip: 'bg-[var(--fx-selected)] border-transparent',
    option: 'bg-[var(--fx-selected)]',
  },
  surface: {
    pane: 'rounded-[20px]',
    card: 'rounded-2xl',
    panel: 'rounded-2xl',
    segmented: 'rounded-full',
    counter: 'rounded-full bg-[var(--fx-selected)] text-[hsl(var(--text-dim))]',
    badge: 'rounded-full',
    eyebrow: 'normal-case tracking-normal text-xs font-medium text-[hsl(var(--text-muted))]',
    input: 'rounded-full bg-[hsl(var(--surface))] border-[var(--fx-outline-soft)] focus:border-[var(--fx-outline)]',
    select: 'rounded-full',
    popover: 'rounded-2xl bg-[hsl(var(--elevated))] border-[var(--fx-outline-soft)]',
    menu: 'rounded-2xl bg-[hsl(var(--elevated))] border-[var(--fx-outline-soft)]',
    'menu-item': 'rounded-[10px] data-[highlighted]:bg-[var(--fx-hover)] data-[highlighted]:text-[hsl(var(--text))]',
    dialog: 'rounded-3xl',
    drawer: 'rounded-3xl',
    tooltip: 'rounded-lg',
  },
};

const SKINS: Partial<Record<ThemeFamily, Skin>> = { claude, openai, github };
const NO_SKIN: Skin = {};

export function useSkin(): Skin {
  return SKINS[useThemeFamily()] ?? NO_SKIN;
}
