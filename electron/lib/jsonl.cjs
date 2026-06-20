// JSONL streaming utilities. Both Claude and Codex parsers walk their
// session files line-by-line; we stream instead of readFile + split('\n')
// so peak memory per file is one line, not the whole file × N concurrent
// scanners. A 200 MB file ceiling and a 16 MB per-line ceiling cover the
// pathological "tool output ate the JSONL" cases without exposing the main
// process to corrupt input.
const fs = require('fs');

// Real long-running sessions hit 50-150 MB once tool outputs and pasted
// logs accumulate; 200 MB still keeps the main process well under any
// modern RAM ceiling while blocking the truly pathological cases
// (corrupted JSONL, accidental log dump) that would otherwise OOM.
const MAX_SESSION_FILE_SIZE = 200 * 1024 * 1024;

// Single-line size cap. The file may be 200MB, but if any individual line
// approaches that size (one pathological tool result with a huge JSON
// dump), JSON.parse + the per-line scan stalls the main process for
// seconds. Skip such lines rather than blocking.
const MAX_JSONL_LINE_LEN = 16 * 1024 * 1024;

function safeJson(line) {
  try { return JSON.parse(line); } catch { return null; }
}

// Stream a JSONL file line by line, parsing each row and invoking `onLine`
// for every successfully-parsed object. `onLine` may be async; we await it
// so callers that need per-line I/O (image-cache lookup, etc.) work
// correctly without buffering everything.
async function forEachJsonlLine(filePath, onLine) {
  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const rl = require('node:readline').createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (!line) continue;
      if (line.length > MAX_JSONL_LINE_LEN) continue;
      const obj = safeJson(line);
      if (obj) await onLine(obj);
    }
  } finally {
    try { rl.close(); } catch {}
    try { stream.destroy(); } catch {}
  }
}

module.exports = {
  MAX_SESSION_FILE_SIZE,
  MAX_JSONL_LINE_LEN,
  safeJson,
  forEachJsonlLine,
};
