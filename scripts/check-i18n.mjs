#!/usr/bin/env node
// i18n key completeness check. Walks src/lib/i18n.ts, extracts each locale's
// dictionary as a flat list of keys, and compares against `en`. Exit non-zero
// if any locale is missing a key — used in CI so a key added to en without
// the matching translation can't slip into a release.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const I18N_PATH = join(__dirname, '..', 'src', 'lib', 'i18n.ts');
const src = readFileSync(I18N_PATH, 'utf8');

// Match every top-level locale block. The structure is:
//   const en = { 'key': 'val', ... };
//   const dicts: ... = { en, 'zh-CN': { 'key': 'val' }, tr: { ... }, ... };
// Pull keys per locale by their first occurrence of a {-...-} block following
// the locale name. Cheap-and-correct parse for this very specific file.

const LOCALES = ['en', 'zh-CN', 'tr', 'ja', 'ko', 'de', 'fr', 'es', 'pt-BR', 'ru'];

function extractBlock(src, locale) {
  // Match either `const en = {` (top-level en) or `'zh-CN': {` / `tr: {`
  // inside the dicts object.
  const pat = locale === 'en'
    ? /const en = \{([\s\S]*?)^\};/m
    : new RegExp(`^\\s*['\"]?${locale.replace(/[-]/g, '\\$&')}['\"]?:\\s*\\{([\\s\\S]*?)^\\s*\\},`, 'm');
  const m = src.match(pat);
  return m ? m[1] : null;
}

function extractKeys(block) {
  if (!block) return new Set();
  const out = new Set();
  // Match 'key': or "key": at start of a line (after whitespace).
  for (const m of block.matchAll(/^\s*['"]([^'"]+)['"]\s*:/gm)) {
    out.add(m[1]);
  }
  return out;
}

const enKeys = extractKeys(extractBlock(src, 'en'));
if (enKeys.size === 0) {
  console.error('check-i18n: failed to extract en keys (regex needs an update)');
  process.exit(2);
}

let failed = false;
for (const locale of LOCALES) {
  if (locale === 'en') continue;
  const block = extractBlock(src, locale);
  if (!block) {
    console.error(`check-i18n: could not locate ${locale} block`);
    failed = true;
    continue;
  }
  const keys = extractKeys(block);
  const missing = [...enKeys].filter(k => !keys.has(k));
  const extra = [...keys].filter(k => !enKeys.has(k));
  if (missing.length === 0 && extra.length === 0) {
    console.log(`check-i18n: ${locale} OK (${keys.size}/${enKeys.size})`);
    continue;
  }
  failed = true;
  console.error(`check-i18n: ${locale} has ${missing.length} missing, ${extra.length} extra (have ${keys.size}/${enKeys.size})`);
  if (missing.length > 0) {
    console.error('  missing keys:');
    for (const k of missing.slice(0, 20)) console.error('    - ' + k);
    if (missing.length > 20) console.error(`    ... and ${missing.length - 20} more`);
  }
  if (extra.length > 0) {
    console.error('  extra keys (not in en):');
    for (const k of extra.slice(0, 10)) console.error('    - ' + k);
  }
}

process.exit(failed ? 1 : 0);
