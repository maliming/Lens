// Where should a continued session's agent actually run?
//
// Extracted from the IPC layer so it can be tested: the first cut read
// `meta.lastCwd` / `meta.projectCwd`, which are fields `buildSession` composes
// for the renderer — the parser's own metadata calls them `cwd` and `firstCwd`.
// Neither name existed on the object being read, so every session reported
// "no working directory" and chat could not start at all.
//
// Candidates, best first. The caller runs in the first one still on disk:
//   1. `firstCwd` — the launch directory. It is the project `claude --resume`
//      is scoped to, and what the Terminal button resumes into (`projectCwd`
//      in ipc.cjs), so both ways of continuing a session land in one place.
//   2. `cwd`      — the last working directory a line recorded. Usually one a
//      tool `cd`'d into, and often one that has since been deleted (a removed
//      worktree, a temp dir). Trying it first made such a session impossible
//      to open here while the Terminal button opened it fine, so it is only a
//      fallback for when the launch directory itself is gone.
//   3. decoding the project-folder name — lossy, last resort. The encoding
//      replaces every `/` with `-`, so a literal hyphen in a path segment is
//      indistinguishable from a separator and decodes to a directory that does
//      not exist.

function sessionCwdCandidates(meta, projectDir, decodeProjectDir) {
  const out = [];
  for (const v of [meta?.firstCwd, meta?.cwd, projectDir ? decodeProjectDir(projectDir) : null]) {
    if (typeof v === 'string' && v.trim() && !out.includes(v)) out.push(v);
  }
  return out;
}

module.exports = { sessionCwdCandidates };
