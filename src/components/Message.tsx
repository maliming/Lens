import { useLayoutEffect, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useTranslation } from '../lib/I18nProvider';
import { cn } from '../lib/utils';
import { renderMarkdown, escapeHtml } from '../lib/markdown';
import { highlightDom } from '../lib/highlight';
import { fmtTokens, fmtModel, cleanDisplayText } from '../lib/format';
import { ChevronDown, ChevronUp, Copy, Check, X, CornerDownRight } from 'lucide-react';
import { getSource } from '../lib/sources';
import { useProfile } from '../lib/profile';
import { useDemoMode } from '../lib/demoMode';
import { DEMO_PROFILE } from '../lib/demoData';
import { CodeBlock } from './CodeBlock';
import { SubagentSection } from './SubagentTranscript';
import type { MessageItem } from '../types';
import type { LinkedSubagents } from '../lib/subagents';
import type { DisplayPrefs } from '../lib/displayPrefs';

const COLLAPSE_THRESHOLD = 1500;

// Detect a JSON payload inside tool-use / tool-result text and pretty-print it.
// Tool messages typically look like `[Tool: Read]\n{...}` or `1  import ...\n2 ...`
// — we only reformat when the WHOLE content after the bracket header parses as
// valid JSON. Anything else (file contents, plain text results) is left alone.
function prettyPrintJsonIfAny(raw: string): string {
  if (!raw) return raw;
  // Strip the [Tool: NAME] header so we can try to parse the rest.
  const lines = raw.split('\n');
  const headerMatch = lines[0]?.match(/^\[Tool:\s*[^\]]+\]\s*$/);
  const bodyStart = headerMatch ? 1 : 0;
  const body = lines.slice(bodyStart).join('\n').trim();
  if (!body || (body[0] !== '{' && body[0] !== '[')) return raw;
  try {
    const parsed = JSON.parse(body);
    const pretty = JSON.stringify(parsed, null, 2);
    return headerMatch ? `${lines[0]}\n${pretty}` : pretty;
  } catch {
    return raw;
  }
}

// URL-scheme allowlist for inline images. Defending against a corrupted /
// attacker-supplied JSONL that embeds `javascript:` or `data:text/html`
// payloads — those would execute when the user clicks an "image" anchor.
// SVG is excluded too because SVG documents can carry scripts when opened
// via target=_blank.
const ALLOWED_IMAGE_MIME = /^image\/(png|jpe?g|gif|webp|bmp)$/i;
// Returns { src, remote } — `remote === true` means the URL is http(s) and
// we should render a click-to-load placeholder instead of auto-fetching it.
// Auto-loading remote images leaks the user's IP + UA + open-time to whoever
// the JSONL points at; a one-click confirmation is the privacy default.
type ResolvedImage = { src: string; remote: boolean } | null;
function safeImageSrc(img: { mediaType: string; data: string }): ResolvedImage {
  if (img.mediaType === 'url') {
    // Production CSP only allows `img-src https:`; matching that here means
    // a JSONL that points at an http URL is rejected uniformly (no "works in
    // dev, blocked in prod" surprise) and we never load over plaintext.
    if (!/^https:\/\//i.test(img.data)) return null;
    return { src: img.data, remote: true };
  }
  if (!ALLOWED_IMAGE_MIME.test(img.mediaType)) return null;
  // Strict base64 alphabet — no whitespace, no embedded `,` (which could end
  // the data: URL and start a new attribute when used as href).
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(img.data)) return null;
  return { src: `data:${img.mediaType};base64,${img.data}`, remote: false };
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

// Click-to-cycle timestamp chip. Default = short time-of-day ("1:46:00 PM"),
// click = full local date+time ("6/2/2026, 12:00 AM"), click again = back to
// short. State is per-message — each message tracks its own preference so
// clicking one timestamp doesn't expand all of them.
function MessageTimestamp({ iso }: { iso: string }) {
  const [long, setLong] = useState(false);
  const d = new Date(iso);
  // JSONL timestamps come straight from the CLIs untouched — defending against
  // a corrupt / partial line that leaves `timestamp` as a malformed string so
  // the chip doesn't render literal "Invalid Date".
  if (Number.isNaN(d.getTime())) return null;
  const label = long ? d.toLocaleString() : d.toLocaleTimeString();
  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); setLong(v => !v); }}
      title={long ? 'Show short time' : 'Show full date'}
      aria-label={`Message time ${label}. Click to ${long ? 'show short time' : 'show full date'}.`}
      aria-pressed={long}
      className="text-[10px] text-text-muted tabular-nums hover:text-text cursor-pointer"
    >
      {label}
    </button>
  );
}

export function Message({ message, defaultMode, query, prefs, source = 'claude', linked, promptStyle = false }: { message: MessageItem; defaultMode: 'markdown' | 'raw'; query: string; prefs: DisplayPrefs; source?: 'claude' | 'codex'; linked?: LinkedSubagents | null; promptStyle?: boolean }) {
  const { t } = useTranslation();
  // Read the per-source profile so a USER message renders the operator's
  // uploaded avatar image (if any) instead of the hardcoded "M" letter, and
  // the fallback initial honours their configured profile initial. In demo
  // mode swap in DEMO_PROFILE so the operator's real uploaded avatar never
  // leaks into demo screenshots (the sidebar already does this swap in App).
  const [realProfile] = useProfile(source);
  const [demoMode] = useDemoMode();
  const profile = demoMode ? DEMO_PROFILE : realProfile;
  const [mode, setMode] = useState<'markdown' | 'raw' | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const [viewerSrc, setViewerSrc] = useState<string | null>(null);
  // Track which remote (http/https) images the user has explicitly OK'd to
  // load. Defaulting to "don't fetch" preserves IP / UA / open-time privacy
  // until they click — JSONL with attacker-controlled URLs can't beacon home.
  const [loadedRemote, setLoadedRemote] = useState<Set<number>>(() => new Set());
  const effective = mode ?? defaultMode;
  // Body container ref — after each render we walk its text nodes and wrap
  // query matches in <mark> so SessionDetail can index every match in the
  // conversation for prev/next nav. Doing this in the live DOM (vs. mutating
  // the marked HTML string) keeps MD / RAW paths uniform and avoids accidental
  // wrapping into tag attributes.
  const bodyRef = useRef<HTMLDivElement>(null);
  // Defensive clean at the message boundary: ANSI escapes, C0/C1 control chars,
  // and bidi overrides slipped through JSONL would otherwise reorder visible
  // characters or hide content. Keep tab + newline so code blocks stay
  // structurally intact (cleanDisplayText already preserves both).
  const rawText = cleanDisplayText(message.text || '');
  const isTool = message.isToolUse || message.isToolResult;
  // Tool messages: surface JSON arguments / results in pretty-printed form.
  // Plain (user / assistant) messages render as-is — markdown renderer handles
  // their formatting.
  const text = isTool ? prettyPrintJsonIfAny(rawText) : rawText;
  const tooLong = text.length > COLLAPSE_THRESHOLD;
  // If a search match lives inside a long message, force the truncation off so
  // the user can actually see what they searched for. Otherwise the <mark>
  // ends up in the clipped/hidden tail and prev/next navigation jumps to an
  // off-screen position the user can't read.
  const queryHit = !!query.trim() && text.toLowerCase().includes(query.trim().toLowerCase());
  const showTrunc = tooLong && !expanded && !queryHit;

  // Re-highlight the body whenever the query, the displayed text, or the
  // markdown/raw mode changes. dangerouslySetInnerHTML replaces children on
  // every render, so wrapping <mark>s only stays consistent if we re-run
  // here. useLayoutEffect ensures the marks are in the DOM before paint so
  // SessionDetail's match collector (also useLayoutEffect) sees them on the
  // same frame the user types.
  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    highlightDom(el, query);
  }, [query, text, effective, expanded]);

  const onCopy = async () => {
    const ok = await copyText(text);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  };

  // Skip messages with no visible content. Common case: assistant turns that
  // only emitted tool_use blocks — the text part is empty so the card would
  // render as just a header sitting on a tinted bg, which looks broken.
  // Exception: if the message has attached images, we still render — pasted
  // screenshots / file uploads frequently arrive with no accompanying text.
  const hasImages = !!(message.images && message.images.length > 0);
  if (!isTool && !text.trim() && !hasImages) return null;

  if (isTool) {
    const truncText = showTrunc ? text.slice(0, 2000) + '\n…' : text;
    // When tools are hidden but this card is kept visible only because it spawned
    // a subagent (SessionDetail's carve-out), show just the header + subagent
    // section, not the raw tool_use JSON — otherwise "Show tools: off" leaks the
    // body for these cards. A query hit inside the body keeps it visible so the
    // match stays reachable.
    const showToolBody = prefs.showTools || !linked || queryHit;
    return (
      <div ref={bodyRef} className={cn('group relative rounded-lg bg-emerald-50 dark:bg-emerald-950/30 overflow-hidden pl-3.5', prefs.compact ? 'p-2 pl-3.5' : 'p-3 pl-3.5')}>
        <span className="absolute left-0 top-0 bottom-0 w-1 bg-gradient-to-b from-emerald-400 to-teal-600" />
        <div className="flex items-center justify-between mb-2">
          <span className="text-[10px] uppercase tracking-wider font-semibold text-emerald-700 dark:text-emerald-400">
            {message.isToolUse ? 'Tool use' : 'Tool result'}
          </span>
          <div className="flex items-center gap-2">
            <CopyChip copied={copied} onClick={onCopy} />
            {prefs.showTimestamps && message.timestamp && <MessageTimestamp iso={message.timestamp} />}
          </div>
        </div>
        {showToolBody && text.trim() && <CodeBlock text={truncText} maxHeight={showTrunc ? 180 : undefined} />}
        {/* Screenshots and image attachments live inside tool_result content
           on the Claude side — render them under the codeblock so they aren't
           swallowed by the text-only path. */}
        {hasImages && (
          <div className="flex flex-wrap gap-2 mt-3">
            {message.images!.map((img, i) => {
              const resolved = safeImageSrc(img);
              if (!resolved) return null;
              if (resolved.remote && !prefs.loadRemoteImages && !loadedRemote.has(i)) {
                return (
                  <button
                    key={i}
                    onClick={() => setLoadedRemote(prev => { const n = new Set(prev); n.add(i); return n; })}
                    className="px-3 py-2 rounded-lg border border-border-soft text-[11.5px] text-text-muted hover:text-text hover:border-border bg-bg/30"
                    title={(() => { try { return new URL(resolved.src).hostname; } catch { return 'remote image'; } })()}
                  >
                    {t('msg.loadRemoteImage')}
                  </button>
                );
              }
              return (
                <button key={i} onClick={() => setViewerSrc(resolved.src)} className="block rounded-lg border border-border-soft overflow-hidden hover:border-border bg-bg/30 cursor-zoom-in">
                  <img src={resolved.src} alt={`Tool image ${i + 1}`} className="max-w-[480px] max-h-[360px] object-contain" referrerPolicy="no-referrer" />
                </button>
              );
            })}
          </div>
        )}
        <ImageLightbox src={viewerSrc} onClose={() => setViewerSrc(null)} />
        {showToolBody && tooLong && (
          <button onClick={() => setExpanded(!expanded)} className="mt-2 text-[11px] text-accent flex items-center gap-1 hover:underline">
            {expanded ? <><ChevronUp className="w-3 h-3" /> Collapse</> : <><ChevronDown className="w-3 h-3" /> Show full ({text.length} chars)</>}
          </button>
        )}
        {linked && <SubagentSection linked={linked} source={source} prefs={prefs} query={query} />}
      </div>
    );
  }

  const isUser = message.kind === 'user';
  const isSummary = message.kind === 'summary';
  // Inside a subagent transcript every "user" turn is the prompt the parent /
  // orchestrator handed the agent — never the human operator. Render it as a
  // left-aligned PROMPT card (emerald, no operator avatar) so it doesn't read
  // as the user talking.
  const promptMode = promptStyle && isUser;

  // User stays as a tinted bubble (right-aligned, easy to scan).
  // Assistant goes flat — no card bg, just the orange Claude mark + body text, so
  // long answers read like a doc rather than a chat balloon.
  // Summary keeps a subtle amber wash so it still stands out.
  // Conversation entries: subtle tinted bg + thin left stripe in role color.
  // Calm, neutral — closer to GitHub PR threads than chat bubbles.
  const cardClass = promptMode
    ? 'bg-emerald-50/50 dark:bg-emerald-950/15 border border-emerald-200/60 dark:border-emerald-900/40 pl-4'
    : isUser
    ? 'bg-violet-50/50 dark:bg-violet-950/15 border border-violet-100 dark:border-violet-900/40 pl-4'
    : isSummary
    ? 'bg-amber-100/70 dark:bg-amber-900/30 border border-amber-200 dark:border-amber-900/50 pl-4'
    : 'bg-surface dark:bg-[hsl(var(--surface))] border border-border-soft pl-4';

  const stripeGradient = promptMode
    ? 'bg-emerald-500'
    : isUser
    ? 'bg-violet-500'
    : isSummary
    ? 'bg-gradient-to-b from-amber-400 to-orange-500'
    : 'bg-[#d97757]';

  const usageTotal = message.usage ? (message.usage.input_tokens || 0) + (message.usage.cache_read_input_tokens || 0) + (message.usage.cache_creation_input_tokens || 0) : 0;

  // Layout split:
  //   User      → right-aligned chat bubble capped at ~78% width
  //   Assistant → left-aligned full-width card (reads like a doc, not a
  //               cramped bubble — answers can be very long)
  //   Summary   → full-width amber strip
  // Cards retain padding + rounding + overflow-hidden so code blocks and
  // long text are properly contained either way.
  return (
    <div className={cn(
      'group relative rounded-xl overflow-hidden',
      isSummary && 'pl-4',
      cardClass,
      prefs.compact ? 'p-3' : 'p-4',
      isUser && !promptMode ? 'max-w-[78%] ml-auto' : 'w-full',
    )}>
      <span className={cn('absolute left-0 top-0 bottom-0 w-1', stripeGradient)} />
      {/* msg-head: chrome only — name, model, token counts, timestamp, MD/Raw
          toggle. Marked select-none so ctrl+A doesn't sweep these badges along
          with the actual conversation body. */}
      {/* gap-6 forces a minimum 24px breathing space between the left identity
         group (USER / avatar / model) and the right action group (Copy / MD /
         RAW), even when the title row is short — looked cramped before. */}
      <div className="flex items-center justify-between gap-6 mb-2.5 min-w-0 select-none">
        <div className="flex items-center gap-2 min-w-0">
          {prefs.showAvatars && (() => {
            // Registry-driven so a new AI provider plugs in via lib/sources.ts.
            const def = getSource(source);
            const Glyph = def.Glyph;
            // USER lane shows the operator's uploaded avatar image when set,
            // otherwise falls back to their configured profile initial on the
            // accent purple chip. Assistant + summary lanes are unchanged.
            if (isUser && !promptMode && profile.avatarImage) {
              return (
                <img
                  src={profile.avatarImage}
                  alt=""
                  referrerPolicy="no-referrer"
                  className="w-5 h-5 rounded-md object-cover flex-shrink-0"
                />
              );
            }
            const bg = promptMode ? '#10b981' : isUser ? '#7c5cff' : isSummary ? '#f59e0b' : def.accent;
            const initial = (profile.avatarInitial || 'M').slice(0, 2).toUpperCase();
            return (
              <div
                className="w-5 h-5 rounded-md flex items-center justify-center flex-shrink-0 text-white text-[10px] font-bold"
                style={{ background: bg }}
              >
                {promptMode ? <CornerDownRight color="#ffffff" className="w-3 h-3" /> : isUser ? initial : isSummary ? 'S' : <Glyph color="#ffffff" className="w-3 h-3" />}
              </div>
            );
          })()}
          <span className="text-[10.5px] uppercase tracking-[0.08em] font-bold text-text-muted truncate">
            {promptMode ? t('subagent.promptLabel') : isUser ? t('msg.role.user') : isSummary ? t('msg.role.summary') : t('msg.role.assistant')}
          </span>
          {(() => {
            const m = fmtModel(message.model);
            return m ? <span className="text-[10.5px] text-text-muted/70 truncate">{m}</span> : null;
          })()}
          {prefs.showMsgTokens && usageTotal > 0 && (
            <span className="text-[10px] text-text-muted tabular-nums flex-shrink-0">{fmtTokens(usageTotal)} → {fmtTokens(message.usage?.output_tokens || 0)}</span>
          )}
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <CopyChip copied={copied} onClick={onCopy} />
          <div className="inline-flex p-0.5 bg-white/60 dark:bg-black/30 rounded opacity-0 group-hover:opacity-100 transition-opacity">
            <button onClick={() => setMode('markdown')} className={cn('px-1.5 py-0.5 rounded text-[9px] font-semibold uppercase', effective === 'markdown' ? 'bg-accent text-white' : 'text-text-muted hover:text-text')}>MD</button>
            <button onClick={() => setMode('raw')} className={cn('px-1.5 py-0.5 rounded text-[9px] font-semibold uppercase', effective === 'raw' ? 'bg-accent text-white' : 'text-text-muted hover:text-text')}>RAW</button>
          </div>
          {prefs.showTimestamps && message.timestamp && <MessageTimestamp iso={message.timestamp} />}
        </div>
      </div>

      <div className={cn('text-[13px] text-text', showTrunc && 'max-h-[260px] overflow-hidden')}>
        {text.trim() && (effective === 'markdown' ? (
          <div ref={bodyRef} className="markdown-body" dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }} />
        ) : (
          <div ref={bodyRef} className="raw-body whitespace-pre-wrap break-words font-mono text-[12px]" dangerouslySetInnerHTML={{ __html: escapeHtml(text) }} />
        ))}
        {/* Inline images attached to the message — pasted screenshots / file
           uploads. Capped at 480px wide so they don't blow out the column;
           click to open the in-app lightbox at full resolution. */}
        {message.images && message.images.length > 0 && (
          <div className="flex flex-wrap gap-2 mt-3">
            {message.images.map((img, i) => {
              const resolved = safeImageSrc(img);
              if (!resolved) return null;
              if (resolved.remote && !prefs.loadRemoteImages && !loadedRemote.has(i)) {
                return (
                  <button
                    key={i}
                    onClick={() => setLoadedRemote(prev => { const n = new Set(prev); n.add(i); return n; })}
                    className="px-3 py-2 rounded-lg border border-border-soft text-[11.5px] text-text-muted hover:text-text hover:border-border bg-bg/30"
                    title={(() => { try { return new URL(resolved.src).hostname; } catch { return 'remote image'; } })()}
                  >
                    {t('msg.loadRemoteImage')}
                  </button>
                );
              }
              return (
                <button key={i} onClick={() => setViewerSrc(resolved.src)} className="block rounded-lg border border-border-soft overflow-hidden hover:border-border bg-bg/30 cursor-zoom-in">
                  <img src={resolved.src} alt={`Attached image ${i + 1}`} className="max-w-[480px] max-h-[360px] object-contain" referrerPolicy="no-referrer" />
                </button>
              );
            })}
          </div>
        )}
        <ImageLightbox src={viewerSrc} onClose={() => setViewerSrc(null)} />
      </div>
      {tooLong && (
        <button onClick={() => setExpanded(!expanded)} className="mt-3 text-[11.5px] text-accent flex items-center gap-1 hover:underline font-medium">
          {expanded ? <><ChevronUp className="w-3.5 h-3.5" /> Collapse</> : <><ChevronDown className="w-3.5 h-3.5" /> Show full message ({text.length.toLocaleString()} chars)</>}
        </button>
      )}
    </div>
  );
}

// Small ghost-style copy button. Hidden until the user hovers the message card
// so it doesn't compete with the content; flips to a green check + "Copied"
// label for 1.5s after a successful clipboard write.
function CopyChip({ copied, onClick }: { copied: boolean; onClick: () => void }) {
  const { t } = useTranslation();
  return (
    <button
      onClick={onClick}
      title={copied ? t('common.copied') : t('msg.copyTooltip')}
      className={cn(
        'inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wider transition',
        copied
          ? 'text-emerald-600 dark:text-emerald-400 opacity-100'
          : 'text-text-muted hover:text-text opacity-0 group-hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent',
      )}
    >
      {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
      <span className="hidden sm:inline">{copied ? t('common.copied') : t('common.copy')}</span>
    </button>
  );
}

// Fullscreen image preview — clicking a thumbnail opens this. Uses Radix
// Dialog so Esc + click-outside close for free; staying in-app avoids
// Electron's blank-popup behavior when target=_blank fires on a data: URL.
function ImageLightbox({ src, onClose }: { src: string | null; onClose: () => void }) {
  const { t } = useTranslation();
  if (!src) return null;
  return (
    <Dialog.Root open onOpenChange={open => { if (!open) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/85 backdrop-blur-sm z-[100] animate-fade-in" />
        <Dialog.Content className="fixed inset-0 z-[100] flex items-center justify-center p-8 outline-none" onClick={onClose}>
          <Dialog.Title className="sr-only">{t('image.previewSr')}</Dialog.Title>
          <img
            src={src}
            alt="Full-size preview"
            className="max-w-full max-h-full object-contain rounded-lg shadow-2xl"
            onClick={e => e.stopPropagation()}
            referrerPolicy="no-referrer"
          />
          <Dialog.Close className="fixed top-4 right-4 p-2 rounded-full bg-white/10 hover:bg-white/20 text-white outline-none">
            <X className="w-5 h-5" />
          </Dialog.Close>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}


