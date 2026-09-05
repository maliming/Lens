import * as Dialog from '@radix-ui/react-dialog';
import { Search, X } from 'lucide-react';
import { useTranslation } from '../lib/I18nProvider';
import { cleanDisplayText } from '../lib/format';
import { getSource, type SessionSource } from '../lib/sources';

// Asked when the user flips providers while a deep search is still walking
// the corpus. The flip wipes the Search page, so without this the scan they
// may have waited seconds for just vanishes with no way back.

type Props = {
  open: boolean;
  target: SessionSource | null;
  query: string;
  onKeep: () => void;
  onSwitch: () => void;
};

export function SourceSwitchConfirmModal({ open, target, query, onKeep, onSwitch }: Props) {
  const { t } = useTranslation();
  const targetLabel = target ? getSource(target).label : '';
  return (
    <Dialog.Root open={open} onOpenChange={(v) => { if (!v) onKeep(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/30 backdrop-blur-sm z-50 animate-fade-in" />
        <Dialog.Content className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[420px] max-w-[92vw] bg-surface border border-border rounded-2xl shadow-pop z-50 overflow-hidden animate-modal-in">
          <div className="px-5 py-4 border-b border-border-soft flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-accent flex items-center justify-center">
              <Search className="w-4 h-4 text-white" />
            </div>
            <Dialog.Title className="text-[14px] font-semibold text-text flex-1">
              {t('search.switchConfirm.title')}
            </Dialog.Title>
            <button onClick={onKeep} className="p-1 rounded hover:bg-muted text-text-muted">
              <X className="w-4 h-4" />
            </button>
          </div>
          <div className="px-5 py-4">
            <Dialog.Description className="text-[12.5px] text-text-dim leading-relaxed">
              {t('search.switchConfirm.body', { source: targetLabel, q: cleanDisplayText(query) })}
            </Dialog.Description>
          </div>
          <div className="px-5 py-3 border-t border-border-soft flex items-center justify-end gap-2">
            <button
              onClick={onKeep}
              className="px-3 py-1.5 rounded-lg border border-border text-[12.5px] text-text hover:bg-muted transition"
            >
              {t('search.switchConfirm.keep')}
            </button>
            <button
              onClick={onSwitch}
              className="px-3 py-1.5 rounded-lg bg-accent text-white text-[12.5px] font-medium hover:opacity-90 transition"
            >
              {t('search.switchConfirm.switch')}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
