// True cross-source parser helpers. Anything that's specific to one
// vendor's JSONL shape (Claude or Codex) lives in `parsers/claude.cjs` or
// `parsers/codex.cjs`; this module is only the helpers that make sense for
// BOTH sources.
//
// What lives here today:
//   - Model-name filters that protect Usage's by-model breakdown against
//     synthetic / provider-only labels.
//   - The composite-key helper that prefixes every favorites / excludes /
//     aliases entry with its source so a UUID collision across providers
//     can't lift a row out of the wrong source.

// Claude Code stamps assistant turns it generated locally (auto-summary,
// session restore, internal error messages) with a placeholder model name
// — usually "<synthetic>" or "synthetic". These turns don't consume
// Anthropic API tokens, so attributing the rest of the session's tokens
// to them in Usage's by-model breakdown is misleading. Skip them when
// tracking `model` so the field reflects the last REAL model invoked.
const SYNTHETIC_MODEL_RE = /^<?synthetic>?$/i;
function isSyntheticModel(m) {
  return typeof m === 'string' && SYNTHETIC_MODEL_RE.test(m);
}

// Provider-name leak filter: older Lens cached sessions where Codex's
// turn_context never appeared sometimes stored just the provider string
// ("openai", "anthropic") in s.model instead of a real model name. Treat
// those as unknown in Usage so the by-model breakdown isn't misleading.
const PROVIDER_NAMES = new Set(['openai', 'anthropic', 'azure', 'bedrock']);
function looksLikeProvider(m) {
  return typeof m === 'string' && PROVIDER_NAMES.has(m.toLowerCase());
}
function isUsableModel(m) {
  return typeof m === 'string' && m.length > 0 && !isSyntheticModel(m) && !looksLikeProvider(m);
}

// Composite key = "<source>:<sessionId>" so favorites / excludes / aliases
// can't collide across providers. Reject invalid sources hard — silently
// defaulting to 'claude' could mask a caller bug (renderer-side enum
// drift, copy-paste typo) and store the wrong row under a Claude key for
// a Codex session.
const VALID_SOURCES = new Set(['claude', 'codex']);
function compositeKey(source, id) {
  if (!source || !VALID_SOURCES.has(source)) {
    throw new Error(`Invalid source: ${JSON.stringify(source)}`);
  }
  if (typeof id !== 'string') throw new Error('id must be string');
  return `${source}:${id}`;
}

module.exports = {
  SYNTHETIC_MODEL_RE,
  isSyntheticModel,
  PROVIDER_NAMES,
  looksLikeProvider,
  isUsableModel,
  VALID_SOURCES,
  compositeKey,
};
