// Maps a session's working directory to the git repository it belongs to.
//
// The Usage view groups by `decodedCwd`, which is the directory the CLI was
// launched in. That's one row per worktree — and per subdirectory, since
// `~/proj` and `~/proj/src` are different strings — so anyone who works out of
// git worktrees (Codex creates them under `~/.codex/worktrees/<hash>/<name>`)
// reads their own totals scattered across a dozen rows that are really one
// project. Resolving each cwd to its repository root collapses them.
//
// Resolution is pure filesystem, no `git` subprocess:
//
//   • `<dir>/.git` is a directory  → `<dir>` is the repository root.
//   • `<dir>/.git` is a file       → it holds `gitdir: <path>`, the worktree's
//     private git dir. `<path>/commondir` then points (usually relatively) at
//     the shared git dir, whose parent is the main checkout.
//   • neither, and not at the root → try the parent.
//
// Spawning `git rev-parse --git-common-dir` would answer the same question,
// but this runs for every distinct cwd on every usage refresh — dozens of
// processes for something that is two small reads.
//
// ── This is the fallback, not the primary path ─────────────────────────────
//
// Where a session records the repository it ran against, Usage keys on that
// instead: Codex stamps `git.repository_url` into session_meta, which is
// authoritative, survives the directory being deleted, and names the repository
// rather than one checkout of it (so two clones of the same project answer the
// same). Only sessions without that stamp reach this module — every Claude
// session, since Claude records no remote, plus the Codex sessions started
// outside a repository.
//
// One consequence of resolving a path rather than a remote: two independent
// clones of the same repository stay separate rows here. Merging them would
// mean reading `config` out of a directory that may be gone, which is exactly
// the guesswork the recorded URL makes unnecessary.
//
// ── Why this is persisted ──────────────────────────────────────────────────
//
// Worktrees are temporary by nature: you create one, finish the branch, delete
// it. The sessions you ran inside it stay in the history forever. Once the
// directory is gone there is no `.git` left to read, so a purely live
// resolution loses exactly the directories this feature exists to group — on a
// real machine most historical cwds no longer exist at all.
//
// So every answer found while the directory was still there is written to
// `repo-roots.json` and reused after it disappears. That's a fact recorded at a
// moment it could be verified, not a guess: no name matching, no heuristics. A
// directory Lens never saw alive stays ungrouped, which is the honest result.
//
// A live directory always re-resolves from disk and its fresh answer wins, so a
// worktree that gets recreated pointing somewhere else corrects itself.

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { mapPool } = require('./concurrency.cjs');
const { readJsonFileSafe, atomicWriteJson } = require('./json-io.cjs');

// A `.git` file is one short line. Anything larger isn't one, and reading it
// would be someone pointing us at a big file on purpose.
const MAX_GIT_POINTER_SIZE = 64 * 1024;
// Depth guard for the walk up. Real trees are nowhere near this; the bound is
// here so a pathological path can't spin.
const MAX_WALK_DEPTH = 64;

// Live resolution is stable for as long as a worktree exists, but "exists" can
// change while the app is open. A short TTL re-checks often enough to notice a
// new or removed worktree without re-walking on every usage refresh.
const LIVE_TTL = 5 * 60 * 1000;
const LIVE_MAX = 500;

// Remembered entries are the whole point of the file, so the cap is generous —
// one line per directory the user has ever worked in. Eviction is by last-seen
// so the directories still showing up in the history outlive the ones that
// stopped appearing.
const REMEMBERED_MAX = 5000;
const CACHE_VERSION = 1;

// Reads the `gitdir:` line out of a worktree's `.git` file and follows
// `commondir` to the shared git dir. Returns the main checkout's path, or null
// if the file isn't shaped like a git pointer.
async function followWorktreePointer(dir, dotGit) {
  let raw;
  try {
    const st = await fsp.stat(dotGit);
    if (st.size > MAX_GIT_POINTER_SIZE) return null;
    raw = await fsp.readFile(dotGit, 'utf8');
  } catch { return null; }

  const m = raw.match(/^gitdir:\s*(.+?)\s*$/m);
  if (!m) return null;
  // Relative pointers resolve against the worktree, not the process cwd.
  const gitDir = path.resolve(dir, m[1]);

  // `commondir` is what makes this a worktree rather than a detached git dir:
  // it names the git dir the worktree shares with its main checkout. Without
  // one (a plain `--separate-git-dir` repo) the pointer target is itself the
  // git dir, so the answer is the directory holding the pointer.
  let common;
  try {
    const cd = (await fsp.readFile(path.join(gitDir, 'commondir'), 'utf8')).trim();
    if (!cd) return dir;
    common = path.resolve(gitDir, cd);
  } catch { return dir; }

  // `<main>/.git` → `<main>`. A bare repo has no checkout to attribute the
  // sessions to, so fall back to the worktree itself.
  if (path.basename(common) !== '.git') return dir;
  return path.dirname(common);
}

// Walks up from `cwd` looking for a repository. Returns `{ root, exists }`:
// `exists` says whether `cwd` itself is still on disk, which is what decides
// whether a null `root` means "not a repository" (trust it) or "the directory
// is gone" (fall back to what we remember).
async function walkForRepoRoot(cwd) {
  let exists = true;
  try { await fsp.stat(cwd); } catch { exists = false; }

  // The walk runs even when `cwd` itself is gone: a deleted subdirectory of a
  // repository that still exists (`~/proj/feature` under `~/proj`) resolves
  // perfectly well by climbing to the ancestor that does exist. Only a walk
  // that finds nothing needs `exists` to decide what the null means.
  let dir = path.resolve(cwd);
  for (let depth = 0; depth < MAX_WALK_DEPTH; depth++) {
    const dotGit = path.join(dir, '.git');
    let st = null;
    try { st = await fsp.lstat(dotGit); } catch { st = null; }
    if (st) {
      if (st.isDirectory()) return { root: dir, exists };
      if (st.isFile()) return { root: await followWorktreePointer(dir, dotGit), exists };
      // A symlinked `.git` is not something the CLIs produce. Treating it as
      // "not a repository" keeps this from following a link out of the tree.
      return { root: null, exists };
    }
    const up = path.dirname(dir);
    if (up === dir) return { root: null, exists };
    dir = up;
  }
  return { root: null, exists };
}

function createRepoIndex({ userDataDir }) {
  const filePath = path.join(userDataDir, 'repo-roots.json');

  // cwd → { root, at } for this process run. Bounded and short-lived; purely a
  // way to avoid re-walking the same paths on every usage refresh.
  const live = new Map();
  // cwd → { root, seen } persisted across launches. This is the part that
  // survives a worktree being deleted.
  let remembered = new Map();
  let dirty = false;
  let saving = null;

  async function load() {
    try {
      const raw = await readJsonFileSafe(filePath);
      if (raw == null) return;
      const obj = JSON.parse(raw);
      // An unknown (newer) version is left alone rather than parsed on
      // assumption — the file is a cache, so starting empty costs nothing and
      // is safer than misreading a schema this build doesn't know.
      if (!obj || obj.version !== CACHE_VERSION || !obj.roots || typeof obj.roots !== 'object') return;
      const next = new Map();
      for (const [cwd, entry] of Object.entries(obj.roots)) {
        if (typeof cwd !== 'string' || !cwd) continue;
        if (!entry || typeof entry.root !== 'string' || !entry.root) continue;
        const seen = Number.isFinite(entry.seen) ? entry.seen : 0;
        next.set(cwd, { root: entry.root, seen });
      }
      remembered = next;
    } catch { /* unreadable cache is an empty cache */ }
  }

  function remember(cwd, root) {
    const prev = remembered.get(cwd);
    if (prev && prev.root === root) {
      // Same answer — still refresh `seen` so an actively used directory isn't
      // the one evicted, but that alone isn't worth a disk write.
      prev.seen = Date.now();
      return;
    }
    remembered.set(cwd, { root, seen: Date.now() });
    dirty = true;
  }

  function evict() {
    if (remembered.size <= REMEMBERED_MAX) return;
    const byAge = [...remembered.entries()].sort((a, b) => a[1].seen - b[1].seen);
    for (const [cwd] of byAge.slice(0, remembered.size - REMEMBERED_MAX)) remembered.delete(cwd);
    dirty = true;
  }

  // Serialised so two overlapping usage refreshes can't interleave writes.
  function save() {
    if (!dirty) return Promise.resolve();
    dirty = false;
    evict();
    const roots = {};
    for (const [cwd, entry] of remembered) roots[cwd] = { root: entry.root, seen: entry.seen };
    saving = (saving || Promise.resolve())
      .then(() => atomicWriteJson(filePath, { version: CACHE_VERSION, roots }, { pretty: false }))
      .catch(e => console.error('[repo-index] save failed', e && e.message));
    return saving;
  }

  async function resolveRepoRoot(cwd) {
    if (!cwd || typeof cwd !== 'string' || !path.isAbsolute(cwd)) return null;

    const hit = live.get(cwd);
    if (hit && Date.now() - hit.at <= LIVE_TTL) return hit.root;
    live.delete(cwd);

    const { root, exists } = await walkForRepoRoot(cwd);
    // A walk that found a repository is the truth regardless of whether `cwd`
    // itself survives, so it always wins and is always worth recording.
    // Otherwise `exists` decides what the empty result means: the directory is
    // there and simply isn't in a repository (trust that), or it's gone and the
    // only thing left is what we saw back when it wasn't.
    const answer = root || (exists ? null : (remembered.get(cwd)?.root ?? null));
    if (root) remember(cwd, root);

    if (live.size >= LIVE_MAX) {
      const oldest = live.keys().next();
      if (!oldest.done) live.delete(oldest.value);
    }
    live.set(cwd, { root: answer, at: Date.now() });
    return answer;
  }

  // Batch form for the usage aggregator: resolves a set of cwds and returns
  // `cwd → repoRoot | null`. Bounded concurrency because a cold cache on a
  // machine with a hundred projects is a hundred independent walks.
  async function resolveRepoRoots(cwds) {
    const unique = [...new Set(cwds)];
    const out = new Map();
    await mapPool(unique, 8, async cwd => {
      out.set(cwd, await resolveRepoRoot(cwd));
    });
    // Fire-and-forget: the grouping already has its answers, and nothing reads
    // the file again until the next launch.
    save();
    return out;
  }

  return { load, resolveRepoRoot, resolveRepoRoots };
}

module.exports = { createRepoIndex };
