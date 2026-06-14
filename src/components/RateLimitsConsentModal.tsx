import { useEffect, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Activity, ShieldAlert, X } from 'lucide-react';
import { useTranslation } from '../lib/I18nProvider';
import type { CredentialsLocation } from '../types';

type Props = {
  open: boolean;
  onAccept: () => void;
  onDeny: () => void;
};

export function RateLimitsConsentModal({ open, onAccept, onDeny }: Props) {
  const { t } = useTranslation();
  const [loc, setLoc] = useState<CredentialsLocation | null>(null);

  useEffect(() => {
    if (!open) return;
    window.api.getCredentialsLocation().then(setLoc).catch(() => setLoc({ source: 'none' }));
  }, [open]);

  const willPromptKeychain = loc?.source === 'keychain';
  const noCreds = loc?.source === 'none';

  return (
    <Dialog.Root open={open} onOpenChange={(v) => { if (!v) onDeny(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/30 backdrop-blur-sm z-50 animate-fade-in" />
        <Dialog.Content className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[480px] max-w-[92vw] bg-surface border border-border rounded-2xl shadow-pop z-50 overflow-hidden animate-modal-in">
          <div className="px-5 py-4 border-b border-border-soft flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-accent to-purple-500 flex items-center justify-center">
              <Activity className="w-4 h-4 text-white" />
            </div>
            <Dialog.Title className="text-[14px] font-semibold text-text flex-1">
              {t('rlConsent.title')}
            </Dialog.Title>
            <button onClick={onDeny} className="p-1 rounded hover:bg-muted text-text-muted">
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="px-5 py-4 text-[12.5px] text-text-dim leading-relaxed space-y-3">
            <p>
              {t('rlConsent.intro1')} <strong className="text-text">{t('rlConsent.introBold')}</strong> {t('rlConsent.intro2')} <code className="bg-muted px-1 rounded text-[11.5px] font-mono">{t('rlConsent.introCli')}</code> {t('rlConsent.intro3')} <code className="bg-muted px-1 rounded text-[11.5px] font-mono">{t('rlConsent.introHost')}</code> {t('rlConsent.intro4')}
            </p>

            <ul className="space-y-1.5 text-[12px]">
              <li className="flex gap-2">
                <span className="text-emerald-500">·</span>
                <span>{t('rlConsent.bulletLocal')}</span>
              </li>
              <li className="flex gap-2">
                <span className="text-emerald-500">·</span>
                <span>{t('rlConsent.bulletCost')}</span>
              </li>
              {willPromptKeychain && (
                <li className="flex gap-2">
                  <span className="text-amber-500"><ShieldAlert className="w-3 h-3 mt-0.5" /></span>
                  <span>{t('rlConsent.bulletKeychain')}</span>
                </li>
              )}
              {noCreds && (
                <li className="flex gap-2">
                  <span className="text-rose-500"><ShieldAlert className="w-3 h-3 mt-0.5" /></span>
                  <span>{t('rlConsent.bulletNoCreds')}</span>
                </li>
              )}
              <li className="flex gap-2">
                <span className="text-text-muted">·</span>
                <span>{t('rlConsent.bulletToggle')}</span>
              </li>
            </ul>

            <p className="text-[11.5px] text-text-muted pt-1">
              {t('rlConsent.declineFootnote')}
            </p>
          </div>

          <div className="px-5 py-3 border-t border-border-soft flex justify-end gap-2 bg-muted/30">
            <button onClick={onDeny} className="px-3 py-1.5 text-[12.5px] rounded-md text-text-dim hover:bg-muted">
              {t('rlConsent.notNow')}
            </button>
            <button
              onClick={onAccept}
              disabled={noCreds}
              className="px-3 py-1.5 text-[12.5px] font-medium rounded-md bg-accent text-white hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {t('rlConsent.enable')}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
