import { AlertCircle, X } from 'lucide-react';
import { cleanDisplayText } from '../lib/format';
import { useTranslation } from '../lib/I18nProvider';
import { dismissError, holdError, releaseError, useErrorToasts } from '../lib/errorToast';
import { Button, Surface } from '../ui';

// Fixed to the top-right corner, below the title bar: out of the document flow,
// so an error never resizes or shifts anything under it.
export function ErrorToasts() {
  const { t } = useTranslation();
  const toasts = useErrorToasts();
  if (toasts.length === 0) return null;
  return (
    <div className="no-drag fixed top-11 right-3 z-[60] flex flex-col gap-2 w-[360px] max-w-[calc(100vw-24px)] pointer-events-none">
      {toasts.map(toast => (
        <Surface
          kind="popover"
          key={toast.id}
          role="alert"
          onMouseEnter={() => holdError(toast.id)}
          onMouseLeave={() => releaseError(toast.id)}
          className="pointer-events-auto flex items-start gap-2.5 rounded-lg border border-border bg-elevated shadow-pop px-3 py-2.5 animate-fade-in"
        >
          <AlertCircle className="w-4 h-4 text-rose-500 flex-shrink-0 mt-px" aria-hidden />
          <div className="selectable min-w-0 flex-1 text-[12px] leading-snug text-text break-words line-clamp-6">
            {cleanDisplayText(toast.message)}
          </div>
          <Button
            variant="icon"
            onClick={() => dismissError(toast.id)}
            title={t('common.dismiss')}
            aria-label={t('common.dismiss')}
            className="p-0.5 -m-0.5 rounded text-text-muted hover:text-text flex-shrink-0 transition"
          >
            <X className="w-3.5 h-3.5" />
          </Button>
        </Surface>
      ))}
    </div>
  );
}
