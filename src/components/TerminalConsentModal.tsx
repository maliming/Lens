import * as Dialog from '@radix-ui/react-dialog';
import { TerminalSquare, X } from 'lucide-react';
import { useTranslation } from '../lib/I18nProvider';

type Props = {
  open: boolean;
  onAccept: () => void;
  onDeny: () => void;
};

// Fixed-width emoji column so the text edges align regardless of how wide the
// glyph renders — emoji metrics vary a lot between platforms.
function Bullet({ emoji, children }: { emoji: string; children: React.ReactNode }) {
  return (
    <li className="flex gap-2.5 items-start">
      <span className="w-4 flex-shrink-0 text-[13px] leading-[1.45] text-center" aria-hidden>{emoji}</span>
      <span className="flex-1 min-w-0">{children}</span>
    </li>
  );
}

// Shown when the user turns the embedded terminal on, never on its own. Two
// things are worth saying at that moment and nowhere else: this spawns a real
// shell, and the macOS prompts that follow belong to the CLI rather than to
// Lens. The second one matters because the prompt names Lens — without this
// the app looks like it is asking for a user's music library.
export function TerminalConsentModal({ open, onAccept, onDeny }: Props) {
  const { t } = useTranslation();
  const isMac = navigator.platform.toLowerCase().includes('mac');

  return (
    <Dialog.Root open={open} onOpenChange={(v) => { if (!v) onDeny(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/30 backdrop-blur-sm z-50 animate-fade-in" />
        <Dialog.Content className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[480px] max-w-[92vw] bg-surface border border-border rounded-2xl shadow-pop z-50 overflow-hidden animate-modal-in">
          <div className="px-5 py-4 border-b border-border-soft flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-accent to-purple-500 flex items-center justify-center">
              <TerminalSquare className="w-4 h-4 text-white" />
            </div>
            <Dialog.Title className="text-[14px] font-semibold text-text flex-1">
              {t('termConsent.title')}
            </Dialog.Title>
            <button onClick={onDeny} className="p-1 rounded hover:bg-muted text-text-muted">
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="px-5 py-4">
            <p className="text-[13px] text-text leading-relaxed">
              {t('termConsent.intro')}
            </p>
            <ul className="mt-4 pt-4 border-t border-border-soft/60 space-y-2.5 text-[12px] text-text-dim leading-relaxed">
              <Bullet emoji="⌨️">{t('termConsent.bulletReal')}</Bullet>
              {isMac && <Bullet emoji="⚠️">{t('termConsent.bulletPrompts')}</Bullet>}
              <Bullet emoji="🔄">{t('rlConsent.bulletToggle')}</Bullet>
            </ul>
          </div>

          <div className="px-5 py-3 border-t border-border-soft flex justify-end gap-2 bg-muted/30">
            <button onClick={onDeny} className="px-3 py-1.5 text-[12.5px] rounded-md text-text-dim hover:bg-muted">
              {t('rlConsent.notNow')}
            </button>
            <button onClick={onAccept} className="px-3.5 py-1.5 text-[12.5px] rounded-md bg-accent text-white font-medium hover:opacity-90">
              {t('rlConsent.enable')}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
