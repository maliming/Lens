// Persistent userdata: favorites / excludes / aliases.
//
// Each surface is keyed by `<source>:<sessionId>` (composite key) so Claude
// and Codex sessions sharing the same UUID can't accidentally lift each
// other's mark. The store is mutated in-process on every IPC toggle and
// flushed atomically to disk so a partial write can never leave the next
// launch reading an unparseable JSON.
//
// State lives inside the factory return — the main process holds one
// instance via `createUserData({ userDataDir })`, so favoriteSet etc. are
// no longer module-level globals in main.cjs.
const path = require('path');

const { readJsonFileSafe, atomicWriteJson, loadJsonSet, saveJsonSet } = require('./json-io.cjs');

function createUserData({ userDataDir }) {
  const favoritesPath = path.join(userDataDir, 'favorites.json');
  const excludesPath = path.join(userDataDir, 'excludes.json');
  const aliasesPath = path.join(userDataDir, 'aliases.json');

  let favoriteSet = new Set();
  let excludeSet = new Set();
  let aliasMap = {}; // { [compositeKey]: alias }

  async function load() {
    favoriteSet = await loadJsonSet(favoritesPath);
    excludeSet = await loadJsonSet(excludesPath);
    try {
      const raw = await readJsonFileSafe(aliasesPath);
      if (raw == null) { aliasMap = {}; return; }
      const obj = JSON.parse(raw);
      aliasMap = (obj && typeof obj === 'object' && obj.aliases && typeof obj.aliases === 'object')
        ? obj.aliases : {};
    } catch { aliasMap = {}; }
  }

  // Favorites + excludes — Set semantics, persisted atomically per change.
  function isFavorite(k) { return favoriteSet.has(k); }
  function isExcluded(k) { return excludeSet.has(k); }
  function favorites() { return [...favoriteSet]; }
  function excludes() { return [...excludeSet]; }
  async function toggleFavorite(k) {
    if (favoriteSet.has(k)) favoriteSet.delete(k); else favoriteSet.add(k);
    await saveJsonSet(favoritesPath, favoriteSet);
    return favoriteSet.has(k);
  }
  async function toggleExclude(k) {
    if (excludeSet.has(k)) excludeSet.delete(k); else excludeSet.add(k);
    await saveJsonSet(excludesPath, excludeSet);
    return excludeSet.has(k);
  }

  // Aliases — keyed string → string map. `null`/empty alias removes the
  // entry rather than storing an empty string so the renderer can `Boolean(alias)`
  // to detect "user has set a custom name".
  function getAlias(k) { return aliasMap[k] || null; }
  function aliases() { return { ...aliasMap }; }
  async function setAlias(k, alias) {
    if (alias) aliasMap[k] = alias;
    else delete aliasMap[k];
    await saveAliases();
    return aliasMap[k] || null;
  }
  async function saveAliases() {
    try { await atomicWriteJson(aliasesPath, { aliases: aliasMap }); }
    catch (e) { console.error('saveAliases failed', aliasesPath, e); }
  }

  return {
    favoritesPath,
    excludesPath,
    aliasesPath,
    load,
    // favorites
    isFavorite, favorites, toggleFavorite,
    // excludes
    isExcluded, excludes, toggleExclude,
    // aliases
    getAlias, aliases, setAlias, saveAliases,
    // Underlying mutable state — exposed so main.cjs can still reach for
    // `favoriteSet.has(k)` / `aliasMap[k] = x` / `favoriteSet.size` style
    // without having to wrap every read. The getter-style methods above
    // are preferred for new call sites.
    get favoritesSet() { return favoriteSet; },
    get excludesSet() { return excludeSet; },
    get aliasesMap()  { return aliasMap; },
  };
}

module.exports = { createUserData };
