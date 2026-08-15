// Freshness test for the per-file metadata cache.
//
// mtimeMs is compared at full precision, so same-second writes were never the
// problem. Size is the addition: a filesystem with coarse timestamps, or a
// write that preserves mtime, would otherwise let a grown session look
// unchanged. Chat appends to sessions while Lens is watching them, so this
// went from theoretical to reachable.
//
// A legacy entry written before `size` was recorded is treated as stale — one
// extra read per file after upgrade, then it self-heals.
function cacheEntryFresh(cached, stat) {
  if (!cached || !stat) return false;
  if (typeof cached.size !== 'number') return false;
  return cached.mtime === stat.mtimeMs && cached.size === stat.size;
}

module.exports = { cacheEntryFresh };
