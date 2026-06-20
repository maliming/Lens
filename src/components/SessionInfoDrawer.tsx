import * as Dialog from '@radix-ui/react-dialog';
import { X, Copy, GitBranch, Calendar, MessageSquare, FileText, Cpu } from 'lucide-react';
import { fmtBytes, fmtModel, fmtTime, fmtTokens, shortCwd, isUsableModel, visibleMessageCount } from '../lib/format';
import { meaningfulBranch } from '../lib/sessionTitle';
import { cn } from '../lib/utils';
import { useTranslation } from '../lib/I18nProvider';
import type { SessionMeta } from '../types';

type Props = {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  session: SessionMeta | null;
};

export function SessionInfoDrawer({ open, onOpenChange, session }: Props) {
  const { t } = useTranslation();
  if (!session) return null;
  const tIn = session.tokensIn || 0;
  const tOut = session.tokensOut || 0;
  const tCr = session.tokensCacheRead || 0;
  const tCc = session.tokensCacheCreate || 0;
  const total = tIn + tOut + tCr + tCc;
  const userVisible = session.userMsgs || 0;
  const assistantVisible = session.assistantMsgs || 0;
  const totalVisible = visibleMessageCount(session);

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/30 z-50 animate-fade-in" />
        <Dialog.Content className="no-drag fixed top-11 right-1.5 bottom-8 w-[360px] max-w-[92vw] bg-surface border border-border-soft rounded-2xl z-50 animate-drawer-in shadow-pop flex flex-col overflow-hidden">
          <div className="px-5 py-3 border-b border-border-soft flex items-center justify-between flex-shrink-0 relative z-10">
            <Dialog.Title className="text-[14px] font-semibold text-text">{t('detail.tip.sessionDetails')}</Dialog.Title>
            <Dialog.Close
              aria-label={t('detail.tip.sessionDetails')}
              className="w-9 h-9 -mr-2 rounded-md hover:bg-muted text-text-muted hover:text-text flex items-center justify-center transition cursor-pointer"
            >
              <X className="w-4 h-4" />
            </Dialog.Close>
          </div>

          <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
            {/* Tokens */}
            {total > 0 && (
              <section>
                <h3 className="text-[10.5px] font-semibold uppercase tracking-wider text-text-muted mb-2">{t('info.section.tokens')}</h3>
                <div className="text-[28px] font-bold tabular-nums leading-none text-text mb-1">{fmtTokens(total)}</div>
                <div className="text-[11px] text-text-muted mb-3">{t('info.tokens.across', { n: totalVisible })}</div>
                <div className="grid grid-cols-2 gap-2">
                  <TokenRow label={t('info.tokens.in')} value={tIn} accent="bg-blue-400" />
                  <TokenRow label={t('info.tokens.out')} value={tOut} accent="bg-pink-400" />
                  <TokenRow label={t('info.tokens.cacheRead')} value={tCr} accent="bg-amber-400" />
                  <TokenRow label={t('info.tokens.cacheWrite')} value={tCc} accent="bg-orange-400" />
                </div>
              </section>
            )}

            {/* Identity */}
            <section>
              <h3 className="text-[10.5px] font-semibold uppercase tracking-wider text-text-muted mb-2">{t('info.section.identity')}</h3>
              <dl className="space-y-1.5 text-[12.5px]">
                <Row label={t('info.row.sessionId')} mono copyable={session.id}>{session.id.slice(0, 8)}</Row>
                <Row label={t('info.row.project')} mono>{shortCwd(session.projectCwd || session.decodedCwd)}</Row>
                {meaningfulBranch(session.gitBranch) && (
                  <Row label={<><GitBranch className="w-3 h-3 inline mr-1 -mt-0.5" />{t('info.row.branch')}</>}>
                    <span className="text-amber-600 dark:text-amber-400">{meaningfulBranch(session.gitBranch)}</span>
                  </Row>
                )}
                {session.gitBranch && !meaningfulBranch(session.gitBranch) && (
                  <Row label={<><GitBranch className="w-3 h-3 inline mr-1 -mt-0.5" />{t('info.row.branch')}</>}>
                    <span className="text-text-muted italic">{t('info.row.detachedHead')}</span>
                  </Row>
                )}
                {session.lastCwd && session.lastCwd !== session.projectCwd && (
                  <Row label={t('info.row.lastCwd')} mono>{shortCwd(session.lastCwd)}</Row>
                )}
              </dl>
            </section>

            {/* Activity */}
            <section>
              <h3 className="text-[10.5px] font-semibold uppercase tracking-wider text-text-muted mb-2">{t('info.section.activity')}</h3>
              <dl className="space-y-1.5 text-[12.5px]">
                {session.firstTs && (
                  <Row label={<><Calendar className="w-3 h-3 inline mr-1 -mt-0.5" />{t('info.row.created')}</>}>{fmtTime(session.firstTs)}</Row>
                )}
                {session.lastTs && (
                  <Row label={t('info.row.lastActivity')}>{fmtTime(session.lastTs)}</Row>
                )}
                <Row label={<><MessageSquare className="w-3 h-3 inline mr-1 -mt-0.5" />{t('info.row.messages')}</>}>
                  {totalVisible} ({userVisible} / {assistantVisible})
                </Row>
                <Row label={<><FileText className="w-3 h-3 inline mr-1 -mt-0.5" />{t('info.row.fileSize')}</>}>{fmtBytes(session.fileSize)}</Row>
              </dl>
            </section>

            {/* Model */}
            {(isUsableModel(session.model) || session.version) && (
              <section>
                <h3 className="text-[10.5px] font-semibold uppercase tracking-wider text-text-muted mb-2">{t('info.section.runtime')}</h3>
                <dl className="space-y-1.5 text-[12.5px]">
                  {isUsableModel(session.model) && (
                    <Row label={<><Cpu className="w-3 h-3 inline mr-1 -mt-0.5" />{t('info.row.model')}</>}>{fmtModel(session.model)}</Row>
                  )}
                  {session.version && (
                    <Row label={t('info.row.ccVersion')}>v{session.version}</Row>
                  )}
                </dl>
              </section>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function Row({ label, children, mono, copyable }: { label: React.ReactNode; children: React.ReactNode; mono?: boolean; copyable?: string }) {
  const { t } = useTranslation();
  return (
    <div className="flex items-center justify-between gap-3 min-w-0">
      <dt className="text-text-muted flex-shrink-0">{label}</dt>
      <dd className={cn('text-text min-w-0 truncate flex items-center gap-1.5', mono && 'font-mono text-[11.5px]')}>
        {children}
        {copyable && (
          <button onClick={() => navigator.clipboard.writeText(copyable)} className="text-text-muted hover:text-accent flex-shrink-0" title={t('common.copy')}>
            <Copy className="w-3 h-3" />
          </button>
        )}
      </dd>
    </div>
  );
}

function TokenRow({ label, value, accent }: { label: string; value: number; accent: string }) {
  return (
    <div className="flex items-center justify-between px-2.5 py-1.5 rounded-md bg-bg border border-border-soft min-w-0">
      <div className="flex items-center gap-1.5 min-w-0">
        <span className={cn('w-1.5 h-1.5 rounded-full flex-shrink-0', accent)} />
        <span className="text-text-muted text-[10.5px] truncate">{label}</span>
      </div>
      <span className="font-semibold text-text tabular-nums text-[12px] flex-shrink-0">{fmtTokens(value)}</span>
    </div>
  );
}
