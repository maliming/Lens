// Path-containment + realpath-resolved safety helpers. Every IPC handler
// that takes a file path from the renderer goes through `ensureInside` or
// `ensureInsideAny` so a compromised / malicious renderer can't read or
// write outside `~/.claude`, `~/.codex` and the userData dir.
//
// Containment uses `path.relative(realBase, real)` — that's correct on
// case-insensitive AND case-sensitive volumes. A previous lowercase-prefix
// implementation conflated `~/.Claude/...` and `~/.claude/...` on a
// case-sensitive APFS volume. Don't go back to startsWith.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

// macOS HFS+/APFS (default) and Windows NTFS treat path components as
// case-insensitive. We expand realpath-resolved paths via this flag when
// the caller wants a pure-string equality compare instead of going through
// realpath again.
const PATH_CASE_INSENSITIVE = process.platform === 'win32' || process.platform === 'darwin';

function pathEq(a, b) {
  return PATH_CASE_INSENSITIVE ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function pathStartsWith(child, parent) {
  return PATH_CASE_INSENSITIVE
    ? child.toLowerCase().startsWith(parent.toLowerCase())
    : child.startsWith(parent);
}

// `path.relative(realBase, real)` returns "" when equal, a non-`..`-prefixed
// string when inside, or a `..`-prefixed string when outside. Strict, exact
// and correct on every filesystem.
function isInsideBase(real, realBase) {
  if (real === realBase) return true;
  const rel = path.relative(realBase, real);
  if (!rel) return true;
  if (rel.startsWith('..')) return false;
  if (path.isAbsolute(rel)) return false;
  return true;
}

async function ensureInside(baseDir, p) {
  if (typeof p !== 'string') throw new Error('Invalid path');
  const realBase = await fsp.realpath(baseDir);
  const real = await fsp.realpath(path.resolve(p));
  if (!isInsideBase(real, realBase)) {
    throw new Error('Path outside ' + baseDir);
  }
  return real;
}

async function ensureInsideAny(baseDirs, p) {
  if (typeof p !== 'string') throw new Error('Invalid path');
  const real = await fsp.realpath(path.resolve(p));
  for (const base of baseDirs) {
    try {
      const realBase = await fsp.realpath(base);
      if (isInsideBase(real, realBase)) return real;
    } catch {}
  }
  throw new Error('Path outside allowed roots');
}

module.exports = {
  PATH_CASE_INSENSITIVE,
  pathEq,
  pathStartsWith,
  isInsideBase,
  ensureInside,
  ensureInsideAny,
};
