import { useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { X, Upload, Trash2 } from 'lucide-react';
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

// Resize-and-encode the user-picked image to a center-cropped 256×256 JPEG.
// Done in the renderer with a 2D canvas so EXIF is dropped and the size stays
// well under localStorage's per-origin budget (typical output ~10-30 KB).
const AVATAR_PX = 256;
const MAX_INPUT_BYTES = 8 * 1024 * 1024; // 8 MB raw input cap before we even decode

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new AvatarUploadError('decodeFailed'));
    img.src = src;
  });
}

// Stable error codes — the caller maps them through i18n. Throwing raw
// English strings here would surface untranslated text in the modal for
// non-English users.
type AvatarErrorCode = 'notAnImage' | 'tooLarge' | 'readFailed' | 'decodeFailed' | 'canvasUnavailable';
class AvatarUploadError extends Error {
  code: AvatarErrorCode;
  constructor(code: AvatarErrorCode) { super(code); this.code = code; }
}

async function fileToAvatarDataUrl(file: File): Promise<string> {
  if (!file.type.startsWith('image/')) throw new AvatarUploadError('notAnImage');
  if (file.size > MAX_INPUT_BYTES) throw new AvatarUploadError('tooLarge');
  const dataUrl: string = await new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result));
    fr.onerror = () => reject(new AvatarUploadError('readFailed'));
    fr.readAsDataURL(file);
  });
  const img = await loadImage(dataUrl);
  const side = Math.min(img.naturalWidth, img.naturalHeight);
  const sx = (img.naturalWidth - side) / 2;
  const sy = (img.naturalHeight - side) / 2;
  const canvas = document.createElement('canvas');
  canvas.width = AVATAR_PX;
  canvas.height = AVATAR_PX;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new AvatarUploadError('canvasUnavailable');
  ctx.drawImage(img, sx, sy, side, side, 0, 0, AVATAR_PX, AVATAR_PX);
  return canvas.toDataURL('image/jpeg', 0.85);
}

export function AccountModal({ open, onOpenChange, profile, onChange }: Props) {
  const [source] = useCurrentSource();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const markCustomized = () => {
    try { localStorage.setItem(`profile-customized:${source}`, '1'); } catch {}
  };
  const { t } = useTranslation();
  const onPickImage = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    // Reset the input so picking the same file twice still fires `change`.
    e.target.value = '';
    if (!file) return;
    try {
      setUploadError(null);
      const dataUrl = await fileToAvatarDataUrl(file);
      onChange({ avatarImage: dataUrl });
      markCustomized();
    } catch (err) {
      // Map stable error codes through i18n. Unknown error → generic fallback
      // (still translated). Throwing raw English strings from upload helpers
      // would otherwise surface untranslated text mid-modal for non-en users.
      const code = err instanceof AvatarUploadError ? err.code : null;
      setUploadError(
        code === 'notAnImage'        ? t('account.upload.error.notAnImage')
        : code === 'tooLarge'        ? t('account.upload.error.tooLarge')
        : code === 'readFailed'      ? t('account.upload.error.readFailed')
        : code === 'decodeFailed'    ? t('account.upload.error.decodeFailed')
        : code === 'canvasUnavailable' ? t('account.upload.error.canvasUnavailable')
        : t('account.upload.error.generic')
      );
    }
  };
  const onClearImage = () => {
    onChange({ avatarImage: undefined });
    markCustomized();
  };
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
              {profile.avatarImage ? (
                <img
                  src={profile.avatarImage}
                  alt=""
                  referrerPolicy="no-referrer"
                  className="w-12 h-12 rounded-full object-cover shadow-soft"
                />
              ) : (
                <div className={cn('w-12 h-12 rounded-full flex items-center justify-center text-white font-semibold text-[18px] shadow-soft bg-gradient-to-br', profile.avatarGradient)}>
                  {profile.avatarInitial || '?'}
                </div>
              )}
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

            {/* Avatar image — when set, hides the initial / gradient pickers
                because they're irrelevant. Cropped + resized to 256×256 JPEG
                before save (see fileToAvatarDataUrl). */}
            <Field label={t('account.avatarImage')}>
              <div className="flex items-center gap-3">
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/png,image/jpeg,image/webp,image/gif"
                  onChange={onPickImage}
                  className="hidden"
                />
                <button
                  onClick={() => fileInputRef.current?.click()}
                  className="px-3 py-1.5 bg-bg border border-border-soft rounded-md text-[12px] hover:bg-muted flex items-center gap-1.5"
                >
                  <Upload className="w-3 h-3" />
                  {profile.avatarImage ? t('account.replaceImage') : t('account.uploadImage')}
                </button>
                {profile.avatarImage && (
                  <button
                    onClick={onClearImage}
                    className="px-3 py-1.5 bg-bg border border-border-soft rounded-md text-[12px] hover:bg-muted flex items-center gap-1.5 text-text-muted"
                  >
                    <Trash2 className="w-3 h-3" />
                    {t('account.removeImage')}
                  </button>
                )}
              </div>
              {uploadError && (
                <div className="text-[11px] text-rose-500 mt-1.5">{uploadError}</div>
              )}
              <div className="text-[11px] text-text-muted mt-1.5">{t('account.avatarImage.hint')}</div>
            </Field>

            {!profile.avatarImage && (
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
            )}
          </div>

          <div className="px-5 py-3 border-t border-border-soft flex justify-end">
            <button
              onClick={() => onOpenChange(false)}
              className="px-4 py-2 bg-accent text-white rounded-lg text-[13px] font-medium hover:opacity-90"
            >
              {t('common.done')}
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
