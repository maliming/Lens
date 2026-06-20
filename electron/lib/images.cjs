// Cross-source image extraction + safety + budgeting. Both vendor JSONL
// shapes (Anthropic `{type:'image'}` and OpenAI `{type:'input_image'}`)
// surface through the same walker, so the cap constants and parse-time
// hygiene live here.
//
// Per-source quirks DON'T live here:
//   - The Anthropic image-cache layout (`~/.claude/image-cache/<sessionId>/<n>.png`)
//     belongs to `parsers/claude.cjs` because the lookup depends on
//     `CLAUDE_IMAGE_CACHE_ROOT` and Codex sessions never look at it.
//
// Three layers of cap are applied at parse time so a corrupt or hostile
// JSONL can't pin hundreds of MB into the renderer's IPC reply:
//   - MAX_INLINE_IMAGE_B64       per inline image
//   - MAX_IMAGES_PER_MESSAGE     per message render
//   - MAX_SESSION_IMAGE_TOTAL_B64 per session shipped over IPC
//
// Strict MIME + base64-alphabet checks at parse time also defend against
// a JSONL that smuggles `javascript:` / `data:text/html` URLs into the
// renderer's clickable `<a href>` for images.

const ALLOWED_IMAGE_MIME = /^image\/(png|jpe?g|gif|webp|bmp)$/i;
const BASE64_PAYLOAD = /^[A-Za-z0-9+/]+={0,2}$/;

// Per-image cap for inline base64 payloads. Anything beyond this is
// pathological — a normal screenshot in a JSONL is well under 5 MB.
const MAX_INLINE_IMAGE_B64 = 8 * 1024 * 1024;  // ~6 MB of binary
const MAX_IMAGES_PER_MESSAGE = 32;
// Per-session total cap on inline image payload shipped over IPC. Even
// with the per-image / per-message caps above, a long session with many
// screenshots could otherwise hand the renderer hundreds of MB at once.
const MAX_SESSION_IMAGE_TOTAL_B64 = 64 * 1024 * 1024;  // ~48 MB of binary

function pushSafeImage(out, mediaType, data) {
  if (out.length >= MAX_IMAGES_PER_MESSAGE) return;
  if (mediaType === 'url') {
    // Match the production CSP (`img-src ... https:`) — http URLs would
    // load in dev but be silently dropped by Chromium in prod, leading
    // to "works for me" inconsistencies. Refuse them at the parser layer.
    if (typeof data === 'string' && /^https:\/\//i.test(data)) out.push({ mediaType, data });
    return;
  }
  if (typeof data !== 'string') return;
  if (!ALLOWED_IMAGE_MIME.test(mediaType || '')) return;
  if (!BASE64_PAYLOAD.test(data)) return;
  if (data.length > MAX_INLINE_IMAGE_B64) return;
  out.push({ mediaType, data });
}

// Inline base64 data: URLs get split into (mime, payload); plain http(s)
// URLs are pushed through as-is so the renderer can <img src=...> them.
function pushImageFromUrl(out, url) {
  const dataUrlMatch = url.match(/^data:([^;]+);base64,(.+)$/);
  if (dataUrlMatch) pushSafeImage(out, dataUrlMatch[1], dataUrlMatch[2]);
  else pushSafeImage(out, 'url', url);
}

// Recurse into the content tree picking up image blocks wherever they
// sit. Real-world JSONL nests them under `tool_result.content` (Claude
// Code's Read tool returning a screenshot) or as direct siblings of text
// blocks (Codex puts an `input_image` next to an `input_text` describing
// the upload). Handles both vendor shapes:
//   Claude → { type: 'image', source: { type:'base64', data, media_type } }
//            { type: 'image', file:   { base64, mimeType } }
//            { type: 'image', image_url: 'http(s)://...' }
//   Codex  → { type: 'input_image', image_url: 'data:image/png;base64,...' }
//            { type: 'input_image', image_url: { url: 'data:...' } }
function walkForImages(node, out, depth = 0) {
  if (depth > 6) return; // belt-and-suspenders against pathological structures
  if (!node) return;
  if (Array.isArray(node)) {
    for (const x of node) walkForImages(x, out, depth + 1);
    return;
  }
  if (typeof node !== 'object') return;

  if (node.type === 'image') {
    if (node.source && node.source.type === 'base64' && typeof node.source.data === 'string') {
      pushSafeImage(out, node.source.media_type || node.source.mediaType || 'image/png', node.source.data);
    } else if (node.file && typeof node.file.base64 === 'string') {
      pushSafeImage(out, node.file.mimeType || node.file.media_type || 'image/png', node.file.base64);
    } else if (typeof node.image_url === 'string') {
      pushImageFromUrl(out, node.image_url);
    }
    return;
  }

  if (node.type === 'input_image') {
    const url = typeof node.image_url === 'string'
      ? node.image_url
      : (node.image_url && typeof node.image_url.url === 'string' ? node.image_url.url : null);
    if (url) pushImageFromUrl(out, url);
    return;
  }

  // tool_result / attachment / similar wrappers hold images inside .content
  if (node.content) walkForImages(node.content, out, depth + 1);
}

function extractMessageImages(message) {
  const out = [];
  if (!message) return out;
  walkForImages(message.content, out);
  return out;
}

// Strip image-attachment placeholder text that gets injected next to the
// real image content. Without this the renderer prints raw `<image name>`
// / `[Image #1]` / `[Image: source: /path]` next to the rendered image.
function stripImagePlaceholders(text) {
  if (!text) return text;
  return text
    .replace(/<image\s+name=[^>]*?>/g, '')
    .replace(/\[Image:\s*source:\s*[^\]]+\]/g, '')
    .replace(/^\s*\[Image\s*#\d+\]\s*$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Walk the rendered message list and enforce MAX_SESSION_IMAGE_TOTAL_B64.
// Once the running total exceeds the cap, drop images on every subsequent
// message so nothing past the cap reaches the IPC channel; flag every
// message so the UI can surface a banner regardless of which one the
// user is currently looking at.
function capSessionImages(messages) {
  let total = 0;
  let truncated = false;
  for (const m of messages) {
    if (!m.images) continue;
    if (truncated) {
      m.images = undefined;
      continue;
    }
    const kept = [];
    for (const img of m.images) {
      const size = typeof img.data === 'string' ? img.data.length : 0;
      if (total + size > MAX_SESSION_IMAGE_TOTAL_B64) { truncated = true; break; }
      kept.push(img);
      total += size;
    }
    m.images = kept.length ? kept : undefined;
  }
  if (truncated) {
    for (const m of messages) m.imagesTruncated = true;
  }
  return messages;
}

module.exports = {
  ALLOWED_IMAGE_MIME,
  BASE64_PAYLOAD,
  MAX_INLINE_IMAGE_B64,
  MAX_IMAGES_PER_MESSAGE,
  MAX_SESSION_IMAGE_TOTAL_B64,
  pushSafeImage,
  pushImageFromUrl,
  walkForImages,
  extractMessageImages,
  stripImagePlaceholders,
  capSessionImages,
};
