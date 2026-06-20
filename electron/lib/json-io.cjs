// JSON read/write primitives used by userdata persistence, sessions cache,
// app prefs, auth credentials. Two reliability concerns are centralised here
// so callers don't have to think about them:
//
//   1. Size cap: every JSON file we own (favorites/excludes/aliases/appPrefs/
//      sessions-cache/credentials) normally sits well under a few hundred KB.
//      A 16 MB ceiling protects the main process from a tampered userData dir
//      or a corrupt file pinning hundreds of MB on startup.
//   2. Atomic write: open → write → fsync → rename → fsync(dir). A naive
//      `fs.writeFile` followed by a crash leaves the file empty/partial and
//      the next launch can't parse it. The serialiser (per-path Promise queue)
//      prevents two concurrent writes from interleaving fsyncs.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const MAX_USERDATA_FILE_SIZE = 16 * 1024 * 1024;

async function readJsonFileSafe(filePath, maxBytes = MAX_USERDATA_FILE_SIZE) {
  try {
    const st = await fsp.lstat(filePath);
    if (st.isSymbolicLink()) return null;
    if (st.size > maxBytes) {
      console.warn(`readJsonFileSafe: refusing ${filePath} (${st.size} > ${maxBytes})`);
      return null;
    }
    return await fsp.readFile(filePath, 'utf8');
  } catch { return null; }
}

const _writeQueues = new Map();
async function atomicWriteJson(filePath, value) {
  const prev = _writeQueues.get(filePath) || Promise.resolve();
  const next = prev.catch(() => {}).then(async () => {
    const dir = path.dirname(filePath);
    await fsp.mkdir(dir, { recursive: true });
    const tmp = filePath + '.tmp-' + process.pid + '-' + (++_writeQueues.tmpSeq || (_writeQueues.tmpSeq = 1));
    const fh = await fsp.open(tmp, 'w');
    try {
      await fh.writeFile(JSON.stringify(value, null, 2), 'utf8');
      try { await fh.sync(); } catch {}
    } finally {
      await fh.close();
    }
    await fsp.rename(tmp, filePath);
    if (process.platform !== 'win32') {
      try {
        const dirFh = await fsp.open(dir, 'r');
        try { await dirFh.sync(); } catch {}
        await dirFh.close();
      } catch {}
    }
  });
  _writeQueues.set(filePath, next);
  try { await next; } finally {
    if (_writeQueues.get(filePath) === next) _writeQueues.delete(filePath);
  }
}

async function loadJsonSet(filePath) {
  try {
    const raw = await readJsonFileSafe(filePath);
    if (raw == null) return new Set();
    const obj = JSON.parse(raw);
    const ids = Array.isArray(obj?.ids) ? obj.ids : [];
    return new Set(ids.filter((x) => typeof x === 'string'));
  } catch { return new Set(); }
}

async function saveJsonSet(filePath, set) {
  try {
    await atomicWriteJson(filePath, { ids: [...set] });
  } catch (e) {
    console.error('saveJsonSet failed', filePath, e);
  }
}

module.exports = {
  MAX_USERDATA_FILE_SIZE,
  readJsonFileSafe,
  atomicWriteJson,
  loadJsonSet,
  saveJsonSet,
};
