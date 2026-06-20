// Tiny concurrency utilities used by the session scanners. No third-party
// dependency — both Claude and Codex scanners fan out to fsp.stat across
// hundreds of files; capping the parallelism here keeps OS file-handle
// limits comfortable and avoids fs.open throttling on macOS.
async function mapPool(items, concurrency, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  }
  const workers = [];
  for (let i = 0; i < Math.min(concurrency, items.length); i++) workers.push(worker());
  await Promise.all(workers);
  return out;
}

module.exports = { mapPool };
