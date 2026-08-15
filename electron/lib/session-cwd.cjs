// Where should a continued session's agent actually run?
//
// Extracted from the IPC layer so it can be tested: the first cut read
// `meta.lastCwd` / `meta.projectCwd`, which are fields `buildSession` composes
// for the renderer — the parser's own metadata calls them `cwd` and `firstCwd`.
// Neither name existed on the object being read, so every session reported
// "no working directory" and chat could not start at all.
//
// Order matches how buildSession derives the row the UI shows:
//   1. `cwd`      — the last working directory a line recorded.
//   2. `firstCwd` — the launch directory, when later lines never recorded one.
//   3. decoding the project-folder name — lossy, last resort. The encoding
//      replaces every `/` with `-`, so a literal hyphen in a path segment is
//      indistinguishable from a separator and decodes to a directory that does
//      not exist. Callers must confirm the result on disk.

function resolveSessionCwd(meta, projectDir, decodeProjectDir) {
  const pick = (v) => (typeof v === 'string' && v.trim() ? v : null);
  return pick(meta?.cwd)
    || pick(meta?.firstCwd)
    || pick(projectDir ? decodeProjectDir(projectDir) : null)
    || null;
}

module.exports = { resolveSessionCwd };
