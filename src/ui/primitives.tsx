import {
  forwardRef,
  type ButtonHTMLAttributes,
  type ElementType,
  type HTMLAttributes,
  type InputHTMLAttributes,
  type LabelHTMLAttributes,
  type SelectHTMLAttributes,
} from 'react';
import { cn } from '../lib/utils';
import { useSkin, type ButtonVariant, type SurfaceKind } from './skin';

function skinned(className: string | undefined, ...skinClasses: Array<string | false | undefined>): string {
  const extra = skinClasses.filter(Boolean).join(' ');
  // With nothing to add, hand back the call site's string untouched. Running it
  // through tailwind-merge anyway would start resolving conflicts inside it that
  // the browser has always resolved by stylesheet order.
  return extra ? cn(className, extra) : (className ?? '');
}

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant: ButtonVariant;
  // Selected / pressed / current, for variants that have such a state.
  active?: boolean;
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button({ variant, active, className, ...rest }, ref) {
  const skin = useSkin();
  return (
    <button
      ref={ref}
      {...rest}
      data-ui="button"
      data-variant={variant}
      data-active={active ? '' : undefined}
      className={skinned(className, skin.button?.[variant], active && skin.buttonActive?.[variant])}
    />
  );
});

type SurfaceTag =
  | 'div' | 'span' | 'section' | 'aside' | 'main' | 'nav' | 'header' | 'footer'
  | 'ul' | 'li' | 'kbd' | 'code' | 'p' | 'h2' | 'h3' | 'mark';

export type SurfaceProps = HTMLAttributes<HTMLElement> & {
  kind: SurfaceKind;
  as?: SurfaceTag;
};

// A non-interactive element with a role in the design: a pane, a card, a badge.
// Renders the given tag unchanged, so swapping one in never alters layout.
export const Surface = forwardRef<HTMLElement, SurfaceProps>(function Surface({ kind, as = 'div', className, ...rest }, ref) {
  const skin = useSkin();
  const Tag = as as ElementType;
  return <Tag ref={ref} {...rest} data-ui={kind} className={skinned(className, skin.surface?.[kind])} />;
});

export const TextInput = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function TextInput({ className, ...rest }, ref) {
  const skin = useSkin();
  return <input ref={ref} {...rest} data-ui="input" className={skinned(className, skin.surface?.input)} />;
});

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select({ className, ...rest }, ref) {
  const skin = useSkin();
  return <select ref={ref} {...rest} data-ui="select" className={skinned(className, skin.surface?.select)} />;
});

export const Label = forwardRef<HTMLLabelElement, LabelHTMLAttributes<HTMLLabelElement>>(function Label({ className, ...rest }, ref) {
  const skin = useSkin();
  return <label ref={ref} {...rest} data-ui="eyebrow" className={skinned(className, skin.surface?.eyebrow)} />;
});

// For parts rendered by a library component (Radix menu, dialog, tooltip):
// the component keeps rendering its own element, and this supplies the class
// string with the family's additions. Pair it with the matching `data-ui`.
export function useSkinClass(): (kind: SurfaceKind, className?: string) => string {
  const skin = useSkin();
  return (kind, className) => skinned(className, skin.surface?.[kind]);
}

export function useButtonClass(): (variant: ButtonVariant, className?: string, active?: boolean) => string {
  const skin = useSkin();
  return (variant, className, active) => skinned(className, skin.button?.[variant], active && skin.buttonActive?.[variant]);
}
