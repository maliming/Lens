import { useEffect, useRef, useState } from 'react';
import { ChevronDown, Check, AlertCircle } from 'lucide-react';
import { cn } from '../lib/utils';
import { SOURCES, SOURCE_ORDER, getSource, type SessionSource, type SourceDef } from '../lib/sources';
import { useSystemCapabilities } from '../lib/systemCapabilities';
import { useTranslation } from '../lib/I18nProvider';
import { Button, Surface } from '../ui';

type Props = {
  value: SessionSource;
  onChange: (next: SessionSource) => void;
  demoMode?: boolean;
};

// Minimal monochrome badge — soft tinted square with the provider's glyph in
// its own brand color. Reads quieter than a saturated solid square and the
// glyphs themselves carry the identity (Claude burst vs OpenAI knot). Linear /
// Raycast style.
function SourceBadge({ source, size }: { source: SourceDef; size: number }) {
  const radius = Math.round(size * 0.3);
  const Glyph = source.Glyph;
  return (
    <div
      data-ui="source-badge"
      className="flex-shrink-0 flex items-center justify-center border border-border-soft"
      style={{
        width: size,
        height: size,
        borderRadius: radius,
        // A theme family can tint the badge from its own palette so the switcher
        // belongs to the identity card it sits in; Lens keeps the brand colours.
        background: `var(--fx-badge-bg, ${source.accentSoft})`,
        color: `var(--fx-badge-fg, ${source.accent})`,
      }}
    >
      <Glyph className="w-[58%] h-[58%]" />
    </div>
  );
}

export function AISourceSelector({ value, onChange, demoMode = false }: Props) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const caps = useSystemCapabilities();
  const { t } = useTranslation();

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    if (open) document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  // Single source of truth for "is this tool usable?":
  // demo overrides everything; otherwise consult the OS capability probe.
  const isInstalled = (id: SessionSource) => {
    if (demoMode) return true;
    return caps?.aiTools?.[id]?.installed ?? false;
  };

  // Driven entirely by SOURCE_ORDER — no hardcoded list of ids in this file.
  const allDefs = SOURCE_ORDER.map(id => SOURCES[id]);
  const enabledDefs = allDefs.filter(s => isInstalled(s.id));

  // If the persisted current source can't run (e.g. user uninstalled claude),
  // fall back to whichever IS enabled. Never leaves the dropdown showing
  // something unselectable.
  const effectiveId = enabledDefs.find(s => s.id === value)?.id ?? enabledDefs[0]?.id ?? value;
  const current = getSource(effectiveId);

  // Empty state — no AI CLI detected anywhere. Surface a single guidance card.
  if (enabledDefs.length === 0 && caps) {
    return (
      <Surface kind="banner" className="no-drag rounded-2xl bg-amber-50/70 dark:bg-amber-900/15 px-3 py-2.5">
        <div className="flex items-start gap-2 text-amber-800 dark:text-amber-300">
          <AlertCircle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
          <div className="text-[11.5px] leading-snug">
            <div className="font-semibold">{t('aitool.noneTitle')}</div>
            <div className="text-amber-700/80 dark:text-amber-300/80 mt-0.5">{t('aitool.noneHint')}</div>
          </div>
        </div>
      </Surface>
    );
  }

  return (
    <div className="no-drag relative" ref={wrapRef}>
      <Button
        variant="card-header"
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-2.5 px-3 py-2.5 rounded-t-2xl hover:bg-muted/30 transition text-left"
      >
        <SourceBadge source={current} size={24} />
        <span className="text-[13px] font-semibold text-text flex-1 truncate">{current.label}</span>
        <ChevronDown className={cn('w-3.5 h-3.5 text-text-muted transition-transform', open && 'rotate-180')} />
      </Button>

      {open && (
        <Surface kind="popover" className="absolute left-1 right-1 top-full mt-1 z-30 rounded-xl border border-border bg-elevated shadow-pop p-1 animate-in">
          {allDefs.map(def => {
            const installed = isInstalled(def.id);
            const active = def.id === effectiveId;
            return (
              <Button
                key={def.id}
                variant="option"
                active={active && installed}
                onClick={() => { if (!installed) return; onChange(def.id); setOpen(false); }}
                disabled={!installed}
                className={cn(
                  'w-full flex items-center gap-2.5 px-2 py-2 rounded-lg text-left transition',
                  !installed ? 'opacity-55 cursor-not-allowed' : 'hover:bg-muted/40',
                  active && installed && 'bg-accent-soft/30'
                )}
                title={!installed ? t('aitool.notInstalled') : ''}
              >
                <SourceBadge source={def} size={26} />
                <span className="text-[13.5px] font-semibold text-text flex-1 truncate">{def.label}</span>
                {!installed && (
                  <Surface kind="eyebrow" as="span" className="text-[9.5px] uppercase tracking-wider font-semibold text-text-muted">
                    {t('aitool.notInstalled')}
                  </Surface>
                )}
                {active && installed && <Check className="w-3.5 h-3.5 text-accent" />}
              </Button>
            );
          })}
        </Surface>
      )}
    </div>
  );
}
