import { useEffect, useRef } from 'react';

type Props = {
  cssVar: '--list-width' | '--info-width' | '--sidebar-width' | '--workspace-list-width';
  storageKey: string;
  min?: number;
  max?: number;
  side?: 'left' | 'right';
};

// Dev mode (`npm run dev`) intentionally skips pane-width persistence so every
// restart lands on the fresh-install default layout — useful for matching what
// a first-time user sees. Production keeps the saved value.
const IS_DEV: boolean = !!(import.meta as any).env?.DEV;

export function Resizer({ cssVar, storageKey, min = 240, max = 600, side = 'left' }: Props) {
  const dragging = useRef(false);
  const startX = useRef(0);
  const startW = useRef(0);

  useEffect(() => {
    if (IS_DEV) return;
    const saved = localStorage.getItem(storageKey);
    if (saved) {
      // Clamp the persisted value against the current min/max — otherwise a
      // historical value (e.g. saved at the old max=560) survives forever and
      // can push the detail pane past the window's right edge.
      const v = parseFloat(saved);
      if (!Number.isNaN(v)) {
        const clamped = Math.max(min, Math.min(max, v));
        document.documentElement.style.setProperty(cssVar, clamped + 'px');
        if (clamped !== v) localStorage.setItem(storageKey, String(Math.round(clamped)));
      }
    }
  }, [cssVar, storageKey, min, max]);

  const onDown = (e: React.MouseEvent) => {
    dragging.current = true;
    startX.current = e.clientX;
    const cur = parseFloat(getComputedStyle(document.documentElement).getPropertyValue(cssVar)) || (cssVar === '--list-width' ? 420 : cssVar === '--sidebar-width' ? 220 : 280);
    startW.current = cur;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    e.preventDefault();
  };

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragging.current) return;
      const delta = e.clientX - startX.current;
      const w = side === 'left' ? startW.current + delta : startW.current - delta;
      const clamped = Math.max(min, Math.min(max, w));
      document.documentElement.style.setProperty(cssVar, clamped + 'px');
    };
    const onUp = () => {
      if (!dragging.current) return;
      dragging.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      const cur = parseFloat(getComputedStyle(document.documentElement).getPropertyValue(cssVar));
      if (!isNaN(cur) && !IS_DEV) localStorage.setItem(storageKey, String(Math.round(cur)));
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    return () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
  }, [cssVar, storageKey, min, max, side]);

  return (
    <div
      onMouseDown={onDown}
      className="relative w-1 hover:bg-accent/40 active:bg-accent/60 transition-colors flex-shrink-0 cursor-col-resize group rounded-full -mx-0.5 z-10"
    >
      <div className="absolute -inset-x-1 inset-y-0" />
    </div>
  );
}
