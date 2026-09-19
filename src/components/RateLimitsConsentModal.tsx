import { useEffect, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Activity, X } from 'lucide-react';
import { useTranslation } from '../lib/I18nProvider';
import type { CredentialsLocation } from '../types';
import { Button, Surface, useSkinClass } from '../ui';

type Props = {
  open: boolean;
  onAccept: () => void;
  onDeny: () => void;
};

// Fixed-width emoji column so the text edges align no matter how wide the
// glyph renders — emoji metrics vary a lot between platforms.
function Bullet({ emoji, children }: { emoji: string; children: React.ReactNode }) {
  return (
    <li className="flex gap-2.5 items-start">
      <span className="w-4 flex-shrink-0 text-[13px] leading-[1.45] text-center" aria-hidden>{emoji}</span>
      <span className="flex-1 min-w-0">{children}</span>
    </li>
  );
}

export function RateLimitsConsentModal({ open, onAccept, onDeny }: Props) {
  const { t } = useTranslation();
  const skinClass = useSkinClass();
  const [loc, setLoc] = useState<CredentialsLocation | null>(null);

  useEffect(() => {
    if (!open) return;
    window.api.getCredentialsLocation().then(setLoc).catch(() => setLoc({ source: 'none' }));
  }, [open]);

  const isMac = navigator.platform.toLowerCase().includes('mac');
  const willPromptKeychain = loc?.source === 'keychain';
  const noCreds = loc?.source === 'none';

  return (
    <Dialog.Root open={open} onOpenChange={(v) => { if (!v) onDeny(); }}>
      <Dialog.Portal>
        <Dialog.Overlay data-ui="dialog-overlay" className={skinClass('dialog-overlay', 'fixed inset-0 bg-black/30 backdrop-blur-sm z-50 animate-fade-in')} />
        <Dialog.Content data-ui="dialog" className={skinClass('dialog', 'fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[480px] max-w-[92vw] bg-surface border border-border rounded-2xl shadow-pop z-50 overflow-hidden animate-modal-in')}>
          <Surface kind="dialog-header" className="px-5 py-4 border-b border-border-soft flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-accent to-purple-500 flex items-center justify-center">
              <Activity className="w-4 h-4 text-on-accent" />
            </div>
            <Dialog.Title data-ui="dialog-title" className={skinClass('dialog-title', 'text-[14px] font-semibold text-text flex-1')}>
              {t('rlConsent.title')}
            </Dialog.Title>
            <Button variant="icon" onClick={onDeny} className="p-1 rounded hover:bg-muted text-text-muted">
              <X className="w-4 h-4" />
            </Button>
          </Surface>

          <div className="px-5 py-4">
            <p className="text-[13px] text-text leading-relaxed">
              {t('rlConsent.intro1')} <strong className="text-text">{t('rlConsent.introBold')}</strong> {t('rlConsent.intro2')} <code className="bg-muted px-1 rounded text-[11.5px] font-mono">{t('rlConsent.introCli')}</code> {t('rlConsent.intro3')} <code className="bg-muted px-1 rounded text-[11.5px] font-mono">{t('rlConsent.introHost')}</code> {t('rlConsent.intro4')}
            </p>

            <ul className="mt-4 pt-4 border-t border-border-soft/60 space-y-2.5 text-[12px] text-text-dim leading-relaxed">
              <Bullet emoji="💻">{t('rlConsent.bulletLocal')}</Bullet>
              <Bullet emoji="🆓">{t('rlConsent.bulletCost')}</Bullet>
              {willPromptKeychain && <Bullet emoji="🔑">{t('rlConsent.bulletKeychain')}</Bullet>}
              {isMac && <Bullet emoji="⚠️">{t('settings.cliPrompts.note')}</Bullet>}
              {noCreds && <Bullet emoji="🚫">{t('rlConsent.bulletNoCreds')}</Bullet>}
              <Bullet emoji="🔄">{t('rlConsent.bulletToggle')}</Bullet>
            </ul>

            <p className="mt-4 pt-3 border-t border-border-soft/60 text-[11px] text-text-muted leading-relaxed">
              {t('rlConsent.declineFootnote')}
            </p>
          </div>

          <Surface kind="dialog-footer" className="px-5 py-3 border-t border-border-soft flex justify-end gap-2 bg-muted/30">
            <Button variant="ghost" onClick={onDeny} className="px-3 py-1.5 text-[12.5px] rounded-md text-text-dim hover:bg-muted">
              {t('rlConsent.notNow')}
            </Button>
            <Button
              variant="primary"
              onClick={onAccept}
              disabled={noCreds}
              className="px-3 py-1.5 text-[12.5px] font-medium rounded-md bg-accent text-on-accent hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {t('rlConsent.enable')}
            </Button>
          </Surface>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
