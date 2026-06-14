import * as Dialog from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { cn } from '../lib/utils';
import { AVATAR_GRADIENTS, type Profile } from '../lib/profile';
import { useTranslation } from '../lib/I18nProvider';
import { useCurrentSource } from '../lib/sources';

type Props = {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  profile: Profile;
  onChange: (patch: Partial<Profile>) => void;
};

export function AccountModal({ open, onOpenChange, profile, onChange }: Props) {
  const [source] = useCurrentSource();
  const markCustomized = () => {
    try { localStorage.setItem(`profile-customized:${source}`, '1'); } catch {}
  };
  const { t } = useTranslation();
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/40 backdrop-blur-sm z-50 animate-fade-in" />
        <Dialog.Content className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[440px] max-w-[92vw] max-h-[88vh] overflow-y-auto bg-surface border border-border rounded-2xl shadow-pop z-50 animate-modal-in">
          <div className="flex items-center justify-between px-5 py-4 border-b border-border-soft">
            <Dialog.Title className="text-[15px] font-semibold text-text">{t('profile.editProfile')}</Dialog.Title>
            <Dialog.Close className="p-1.5 rounded hover:bg-muted text-text-muted">
              <X className="w-4 h-4" />
            </Dialog.Close>
          </div>

          <div className="p-5 space-y-4">
            {/* Live preview */}
            <div className="flex items-center gap-3 p-3 rounded-xl bg-bg border border-border-soft">
              <div className={cn('w-12 h-12 rounded-full flex items-center justify-center text-white font-semibold text-[18px] shadow-soft bg-gradient-to-br', profile.avatarGradient)}>
                {profile.avatarInitial || '?'}
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-[14px] font-semibold text-text truncate">{profile.name || t('profile.noName')}</div>
                <div className="text-[11px] text-text-muted">{t('profile.preview')}</div>
              </div>
            </div>

            <Field label={t('account.displayName')}>
              <input
                type="text"
                value={profile.name}
                onChange={e => { onChange({ name: e.target.value }); markCustomized(); }}
                className="w-full px-3 py-2 bg-bg border border-border rounded-lg text-[13px] outline-none focus:border-accent focus:ring-1 focus:ring-accent"
                placeholder={t('account.namePlaceholder')}
              />
            </Field>

            <div className="grid grid-cols-[80px_1fr] gap-4">
              <Field label={t('account.initial')}>
                <input
                  type="text"
                  maxLength={2}
                  value={profile.avatarInitial}
                  onChange={e => { onChange({ avatarInitial: e.target.value.toUpperCase() }); markCustomized(); }}
                  className="w-full px-3 py-2 bg-bg border border-border rounded-lg text-[13px] outline-none focus:border-accent focus:ring-1 focus:ring-accent text-center font-semibold"
                />
              </Field>
              <Field label={t('account.avatarColor')}>
                <div className="flex flex-wrap gap-1.5">
                  {AVATAR_GRADIENTS.map(g => (
                    <button
                      key={g}
                      onClick={() => { onChange({ avatarGradient: g }); markCustomized(); }}
                      className={cn(
                        'w-8 h-8 rounded-full bg-gradient-to-br shadow-sm border-2 transition',
                        g,
                        profile.avatarGradient === g ? 'border-text scale-110' : 'border-transparent'
                      )}
                    />
                  ))}
                </div>
              </Field>
            </div>
          </div>

          <div className="px-5 py-3 border-t border-border-soft flex justify-end">
            <button
              onClick={() => onOpenChange(false)}
              className="px-4 py-2 bg-accent text-white rounded-lg text-[13px] font-medium hover:opacity-90"
            >
              Done
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-[11px] font-semibold text-text uppercase tracking-wider mb-1.5">{label}</label>
      {children}
    </div>
  );
}
