import { useCallback, useEffect, useRef, useState } from 'react';
import { Maximize2, Minimize2, Moon, RotateCw, Sun, TerminalSquare, X, ZoomIn, ZoomOut } from 'lucide-react';
import '@xterm/xterm/css/xterm.css';
import { useTranslation } from '../lib/I18nProvider';
import { getSource } from '../lib/sources';
import {
  MAX_TERMINAL_HEIGHT, MIN_TERMINAL_HEIGHT, TERMINAL_FONTS,
  closeTerminal, getTerminal, getTerminalBackground, getTerminalFontId, hasOrphanFor, openTerminal,
  getTerminalFontSize, getTerminalHeight, getTerminalTheme, restartTerminal,
  parkTerminal, sessionKeyOf, setTerminalFont, setTerminalHeight, setTerminalTheme,
  stepTerminalFontSize, subscribeTerminalActivity, subscribeTerminals,
} from '../lib/terminals';
import type { TerminalFontId } from '../lib/terminals';
import type { SessionMeta } from '../types';

// A real `claude --resume` in a PTY, pinned under the transcript.
//
// The terminal itself lives in lib/terminals — this component only parents its
// DOM node while the session is on screen. Switching sessions detaches the
// node; it does not kill the process, because a running agent with scrollback
// and a half-typed command in it is not something a stray click should destroy.
// Only the close button ends it.

type Props = {
  session: SessionMeta | null;
  // Terminal fills the pane and the transcript is hidden. Owned by the parent
  // because hiding the transcript is the parent's layout to change.
  maximized?: boolean;
  onToggleMaximize?: () => void;
  // Called once the terminal's output has been quiet for a moment. The CLI
  // appends to the same JSONL the transcript renders, so this is the cue to
  // reload it.
  onActivity?: () => void;
  // Restarting has to know whether to spawn or replay.
  demoMode?: boolean;
};

export function TerminalPanel({ session, onActivity, maximized, onToggleMaximize, demoMode }: Props) {
  const { t } = useTranslation();
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [, forceRender] = useState(0);
  const height = getTerminalHeight();
  const onActivityRef = useRef(onActivity);
  useEffect(() => { onActivityRef.current = onActivity; }, [onActivity]);
  // Last known {mtime,size} of the session file. Terminal output is a hint
  // that something *may* have been written, not proof — a TUI redraws while
  // idle, so acting on output alone reloaded the transcript every few seconds
  // indefinitely, which is what made the refresh button pulse on its own.
  const lastStatRef = useRef<string | null>(null);
  // Stale guard, per the repo's rule for every async IPC that can race a
  // session change: a stat issued for the old session must not overwrite the
  // new session's baseline or trigger a sync against it.
  const statSeqRef = useRef(0);
  const sessionKeyRef = useRef<string | null>(null);

  const sessionKey = session ? sessionKeyOf(session) : null;
  const entry = sessionKey ? getTerminal(sessionKey) : null;
  const open = !!entry;
  // A terminal for this session that main is still running but this renderer
  // has forgotten — which is the state after the renderer reloads, and the
  // renderer does reload on things as ordinary as hiding and showing the
  // window. The process is alive and was never closed, so the panel showing
  // nothing is wrong; it looked like the terminal had quietly disappeared,
  // and clicking Terminal "reopened" it instantly because there was nothing
  // to start.
  const orphaned = !!session && !entry && hasOrphanFor(session);

  useEffect(() => subscribeTerminals(() => forceRender((n) => n + 1)), []);

  // Re-adopt it. openTerminal re-attaches to the running process rather than
  // starting a second one, and main replays what it buffered, so this restores
  // the panel with its output instead of a fresh prompt. Demo terminals are
  // scripted playback with no process behind them, so they never apply.
  useEffect(() => {
    if (!orphaned || !session || demoMode) return;
    void openTerminal(session);
    // Keyed on the path, not the session object: SWR pushes hand down a new
    // object for the same session, and re-running on identity would fire this
    // again while the first adoption is still in flight.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orphaned, session?.filePath, demoMode]);

  useEffect(() => {
    statSeqRef.current += 1;
    sessionKeyRef.current = sessionKey;
    // Seed the baseline from what the session list already knows, rather than
    // from the first stat after activity. Establishing it on first activity
    // meant the first real write was consumed as "this is the baseline" and
    // never triggered a reload.
    lastStatRef.current = session ? `${session.mtime}:${session.fileSize}` : null;
    // Keyed on sessionKey alone. SWR hands down a new SessionMeta object on
    // every push, and re-seeding from a pushed mtime/fileSize swallows the next
    // reload: if the push lands after the CLI appended but before the
    // activity-driven stat returns, the stamp already matches and onActivity
    // never fires, leaving the transcript stale until a manual refresh. The
    // re-run would also bump statSeqRef and cancel the stat in flight.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionKey]);

  useEffect(() => subscribeTerminalActivity(async (key) => {
    if (key !== sessionKey || !session) return;
    const seq = statSeqRef.current;
    const st = await window.api.statSession(session.filePath);
    // Compare against the refs, not the closure: a slow stat for a session the
    // user has already left must not land.
    if (seq !== statSeqRef.current || sessionKeyRef.current !== sessionKey) return;
    if (!st.ok) return;
    const stamp = `${st.mtime}:${st.size}`;
    if (lastStatRef.current === stamp) return;
    lastStatRef.current = stamp;
    onActivityRef.current?.();
  }), [sessionKey, session]);

  // Parent the cached node while this session is showing; hand it back when it
  // isn't. Never dispose here — that is closeTerminal's job alone.
  useEffect(() => {
    const host = hostRef.current;
    if (!host || !entry) return;
    host.appendChild(entry.el);

    // Fit after layout, not during it. ResizeObserver fires mid-layout, so
    // measuring there can read a width the browser is about to change — which
    // showed up as text clipped against the right edge at some window sizes.
    let raf = 0;
    const refit = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const w = host.clientWidth;
        const h = host.clientHeight;
        if (w < 20 || h < 20) return;
        try { entry.fit.fit(); } catch {}
        if (entry.termId) void window.api.ptyResize(entry.termId, entry.term.cols, entry.term.rows);
      });
    };
    refit();
    entry.term.focus();
    // Re-parenting moves the hidden textarea the OS has an input context for,
    // and macOS does not always follow it — the terminal takes keystrokes but
    // an input method refuses to engage, so Latin letters go through and
    // Chinese does not. Dropping focus and taking it again makes the browser
    // rebuild that context against the element's current position. This is the
    // manual fix (resize the panel, and it starts working) done automatically;
    // see the parking lot in lib/terminals for why the position went stale.
    requestAnimationFrame(() => {
      const ta = entry.term.textarea;
      if (!ta || document.activeElement !== ta) return;
      ta.blur();
      ta.focus();
    });
    const ro = new ResizeObserver(refit);
    ro.observe(host);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      // Back to the off-screen host rather than out of the document: xterm
      // keeps its geometry and mouse wiring intact between showings.
      if (entry.el.parentNode === host) parkTerminal(entry);
    };
  }, [entry, sessionKey]);

  // Drag the top edge. Height is shared by every session's terminal — it is a
  // property of the layout, not of any one conversation.
  const startDrag = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = height;
    const onMove = (ev: MouseEvent) => {
      const next = Math.max(
        MIN_TERMINAL_HEIGHT,
        Math.min(MAX_TERMINAL_HEIGHT, startH + (startY - ev.clientY)),
      );
      setTerminalHeight(next);
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [height]);

  if (!session) return null;
  if (!getSource(session.source).terminal.supported) return null;

  // Closed: render nothing at all. Opening is the toolbar's job, so an empty
  // strip here would just be a second control for the same thing plus a band
  // of wasted vertical space under every transcript.
  if (!open) return null;

  return (
    <div
      className={`border-t border-border-soft bg-bg/95 flex flex-col min-w-0 ${
        maximized ? 'flex-1 min-h-0' : 'flex-shrink-0'
      }`}
      style={maximized ? undefined : { height }}
    >
      {/* Dragging the edge is meaningless once the terminal owns the pane. */}
      {!maximized && (
        <div
          onMouseDown={startDrag}
          title={t('term.resize')}
          className="h-1.5 cursor-row-resize flex-shrink-0 hover:bg-accent/30 transition"
        />
      )}
      <div className="flex items-center gap-2 px-3 py-1 border-b border-border-soft flex-shrink-0">
        <TerminalSquare
          size={12}
          className={`flex-shrink-0 ${entry.busy ? 'text-accent animate-pulse' : 'text-text-muted'}`}
        />
        {/* The CLI reports what it is doing through the OSC title sequence —
            live status for free, and more useful than a static command line. */}
        <span className="text-[11px] text-text-muted font-mono truncate" title={entry.title || undefined}>
          {/* Before the CLI sets a title, show the command that is actually
              running — which is not the same one for both providers. */}
          {entry.title || (session.source === 'codex' ? 'codex resume' : 'claude --resume')}
        </span>
        {entry.error && <span className="text-[11px] text-text-dim">{t('term.failed')}</span>}
        {entry.exitCode !== null && (
          <span className="text-[11px] text-text-dim">
            {t('term.exited', { code: String(entry.exitCode) })}
          </span>
        )}
        <button
          onClick={() => stepTerminalFontSize(-1)}
          title={t('term.zoomOut')}
          className="ml-auto p-1 rounded text-text-muted hover:text-text-dim hover:bg-muted transition"
        >
          <ZoomOut size={12} />
        </button>
        <span className="text-[11px] text-text-muted tabular-nums w-5 text-center">
          {getTerminalFontSize()}
        </span>
        <button
          onClick={() => stepTerminalFontSize(1)}
          title={t('term.zoomIn')}
          className="p-1 rounded text-text-muted hover:text-text-dim hover:bg-muted transition"
        >
          <ZoomIn size={12} />
        </button>
        <select
          value={getTerminalFontId()}
          onChange={(e) => setTerminalFont(e.target.value as TerminalFontId)}
          title={t('term.font')}
          className="text-[11px] bg-transparent text-text-muted hover:text-text-dim outline-none cursor-pointer max-w-[7rem] truncate"
        >
          {TERMINAL_FONTS.map(f => (
            <option key={f.id} value={f.id}>{f.label}</option>
          ))}
        </select>
        <button
          onClick={() => setTerminalTheme(getTerminalTheme() === 'dark' ? 'light' : 'dark')}
          title={getTerminalTheme() === 'dark' ? t('term.themeLight') : t('term.themeDark')}
          className="p-1 rounded text-text-muted hover:text-text-dim hover:bg-muted transition"
        >
          {getTerminalTheme() === 'dark' ? <Sun size={12} /> : <Moon size={12} />}
        </button>
        <button
          onClick={onToggleMaximize}
          title={maximized ? t('term.restore') : t('term.maximize')}
          className="p-1 rounded text-text-muted hover:text-text-dim hover:bg-muted transition"
        >
          {maximized ? <Minimize2 size={12} /> : <Maximize2 size={12} />}
        </button>
        <button
          onClick={() => void restartTerminal(session, { demo: demoMode })}
          title={t('term.restart')}
          className="p-1 rounded text-text-muted hover:text-text-dim hover:bg-muted transition"
        >
          <RotateCw size={12} />
        </button>
        <button
          onClick={() => void closeTerminal(sessionKey!)}
          title={t('term.close')}
          className="p-1 rounded text-text-muted hover:text-text-dim hover:bg-muted transition"
        >
          <X size={13} />
        </button>
      </div>
      {entry.spawnTheme !== getTerminalTheme() && (
        // The CLI paints its own chrome with colours fixed at launch, so the
        // palette flip leaves its fills inverted until it restarts. This used
        // to be a small chip in the header and went unnoticed — people just saw
        // a broken-looking terminal. A full-width bar states the cause and puts
        // the fix next to it.
        <div className="flex items-center gap-2 px-3 py-1.5 bg-accent-soft border-b border-accent/30 flex-shrink-0">
          <span className="text-[11.5px] text-accent flex-1 truncate">
            {t('term.themeMismatch')}
          </span>
          <button
            onClick={() => void restartTerminal(session, { demo: demoMode })}
            className="text-[11.5px] px-2 py-0.5 rounded bg-accent text-white hover:opacity-90 transition whitespace-nowrap flex-shrink-0"
          >
            {t('term.restart')}
          </button>
        </div>
      )}
      {/* Breathing room around the grid. The background matches xterm's own so
          the padding reads as part of the terminal rather than a seam, and the
          fit runs against this padded box — so the columns account for it
          instead of sitting under the edge. */}
      <div
        ref={hostRef}
        className="flex-1 min-h-0 px-3 py-2"
        style={{ background: getTerminalBackground() }}
      />
    </div>
  );
}
