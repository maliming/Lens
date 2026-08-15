import { useEffect, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { ArrowRight, TerminalSquare, X } from 'lucide-react';
import { useTranslation } from '../lib/I18nProvider';
import { resolveSessionTitle } from '../lib/sessionTitle';
import { shortCwd } from '../lib/format';
import { atHardLimit, liveTerminals } from '../lib/terminals';
import type { SessionMeta } from '../types';

// Shown when opening one more terminal would pass the user's own threshold.
//
// It is a warning, not a wall: the ceiling in main is a runaway-process
// backstop, and how many terminals are reasonable is a judgement about the
// machine, not something Lens should decide. What Lens owes the user is the
// information they cannot otherwise see — each terminal is a whole CLI process,
// the dominant cost of the feature, and terminals stay alive across session
// switches, so the ones from an hour ago are still there.
//
// Selecting rather than only "close all" matters: one of them is usually an
// agent mid-task, and that one is exactly what a blunt cleanup would kill.

type Props = {
  open: boolean;
  onCancel: () => void;
  // Close the chosen terminals, then proceed with opening the new one.
  onConfirm: (keysToClose: string[]) => void;
  // Switch to that session instead. With several agents running, going to the
  // one that is working is usually what you came here for — closing is the
  // secondary action, not the primary one.
  onGoToSession?: (session: SessionMeta) => void;
};

export function TerminalLimitModal({ open, onCancel, onConfirm, onGoToSession }: Props) {
  const { t } = useTranslation();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const terminals = open ? liveTerminals() : [];

  useEffect(() => {
    if (!open) return;
    // Pre-select the idle ones: those are the safe candidates, and a working
    // agent should never be closed by a default.
    setSelected(new Set(liveTerminals().filter(x => !x.busy).map(x => x.key)));
  }, [open]);

  const toggle = (key: string) => setSelected(prev => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });

  return (
    <Dialog.Root open={open} onOpenChange={(v) => { if (!v) onCancel(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/30 backdrop-blur-sm z-50 animate-fade-in" />
        <Dialog.Content className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[520px] max-w-[92vw] bg-surface border border-border rounded-2xl shadow-pop z-50 overflow-hidden animate-modal-in">
          <div className="px-5 py-4 border-b border-border-soft flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-accent flex items-center justify-center">
              <TerminalSquare className="w-4 h-4 text-white" />
            </div>
            <Dialog.Title className="text-[14px] font-semibold text-text flex-1">
              {t('termLimit.title', { n: String(terminals.length) })}
            </Dialog.Title>
            <button onClick={onCancel} className="p-1 rounded hover:bg-muted text-text-muted">
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="px-5 py-3">
            <p className="text-[12.5px] text-text-dim leading-relaxed mb-3">
              {t('termLimit.body')}
            </p>

            <div className="max-h-56 overflow-y-auto space-y-1 mb-3">
              {terminals.map(({ key, session, label, cwd, busy }) => {
                // A terminal recovered from main after a renderer reload has no
                // session object here — only the file it belongs to.
                const title = session
                  ? resolveSessionTitle(session, { fallback: t('list.noTitle') }).primary
                  : label;
                return (
                  <div
                    key={key}
                    className="flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-muted"
                  >
                    <input
                      type="checkbox"
                      checked={selected.has(key)}
                      onChange={() => toggle(key)}
                      title={t('termLimit.selectToClose')}
                      className="accent-accent flex-shrink-0"
                    />
                    <span className="flex-1 min-w-0">
                      <span className="block text-[12.5px] text-text truncate">{title}</span>
                      <span className="block text-[11px] text-text-muted truncate">
                        {shortCwd(cwd)}
                      </span>
                    </span>
                    {busy && (
                      <span className="text-[11px] text-accent flex-shrink-0">
                        {t('termLimit.working')}
                      </span>
                    )}
                    {/* Recovered terminals have no session object to navigate
                        to — only the file they belong to. */}
                    {session && onGoToSession && (
                      <button
                        onClick={() => onGoToSession(session)}
                        title={t('termLimit.goTo')}
                        className="p-1 rounded text-text-muted hover:text-accent hover:bg-surface transition flex-shrink-0"
                      >
                        <ArrowRight size={14} />
                      </button>
                    )}
                  </div>
                );
              })}
            </div>

            <div className="flex items-center gap-2">
              <button
                onClick={() => setSelected(new Set(terminals.map(x => x.key)))}
                className="text-[11.5px] text-text-muted hover:text-text-dim underline underline-offset-2"
              >
                {t('termLimit.selectAll')}
              </button>
              <button
                onClick={() => setSelected(new Set())}
                className="text-[11.5px] text-text-muted hover:text-text-dim underline underline-offset-2"
              >
                {t('termLimit.selectNone')}
              </button>
            </div>
          </div>

          <div className="px-5 py-3 border-t border-border-soft flex items-center gap-2">
            <span className="text-[11.5px] text-text-muted flex-1">
              {t('termLimit.configurable')}
            </span>
            <button
              onClick={onCancel}
              className="px-3 py-1.5 rounded-lg border border-border text-[12.5px] text-text hover:bg-muted transition"
            >
              {t('common.cancel')}
            </button>
            {/* At main's hard ceiling, opening without closing something is
                guaranteed to be refused — offering it would just produce an
                empty, failed terminal panel. */}
            <button
              onClick={() => onConfirm([...selected])}
              disabled={selected.size === 0 && atHardLimit()}
              className="px-3 py-1.5 rounded-lg bg-accent text-white text-[12.5px] font-medium hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed transition"
            >
              {selected.size > 0
                ? t('termLimit.closeAndOpen', { n: String(selected.size) })
                : t('termLimit.openAnyway')}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
