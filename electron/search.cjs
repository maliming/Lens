// Deep-search backend (full-text over session JSONLs).
//
// Used by the renderer's Search view: walks every JSONL once per query, finds
// the first match line, returns a snippet + match count + per-role hit
// breakdown + coverage (how many of N OR-terms matched). Coverage dominates
// the sort so a 3-term match always beats a 1-term match regardless of hit
// volume.
//
// The walk is streaming (forEachJsonlLine) — peak memory per file is one
// line, not the whole file × 16 concurrent scanners. Files past the
// session-size cap are skipped (not errored); a stat fail also skips.
//
// listSearchTargets() resolves the per-source directory layout (Claude:
// projects/<dir>/<id>.jsonl; Codex: sessions/<year>/<month>/<day>/<id>.jsonl)
// and refuses to follow symlinks at any depth — a stray link inside the
// tool's directory can't redirect the scanner outside it.

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const { PROJECTS_DIR, CODEX_SESSIONS_DIR } = require('./lib/paths.cjs');
const { MAX_SESSION_FILE_SIZE, forEachJsonlLine } = require('./lib/jsonl.cjs');

// Per-level lstat helper — refuse to follow symlinks so a stray link inside
// ~/.claude or ~/.codex can't redirect the scanner outside those roots.
async function isPlainDir(p) {
  try { const st = await fsp.lstat(p); return st.isDirectory() && !st.isSymbolicLink(); }
  catch { return false; }
}
async function isPlainFile(p) {
  try { const st = await fsp.lstat(p); return st.isFile() && !st.isSymbolicLink(); }
  catch { return false; }
}

async function listSearchTargets(source) {
  // Returns [{ filePath, projectDir, parentSessionId? }] for every JSONL the
  // deepSearch should consider. Per-source layout:
  //   • Claude is one level deep (~/.claude/projects/<dir>/<id>.jsonl) PLUS
  //     nested subagent files (~/.claude/projects/<dir>/<id>/subagents/*.jsonl).
  //     Subagent targets carry `parentSessionId` so deepSearch can attribute
  //     hits to the parent conversation — under Claude Code 2.0+ a lot of
  //     real work happens in subagent JSONLs and a top-level-only scan
  //     silently misses every URL / quote / explanation the sidechain wrote.
  //   • Codex is three levels (year/month/day).
  const targets = [];
  if (source === 'codex') {
    // Restrict scanning to the year/month/day shape the Codex parser
    // produces (see `parsers/codex.cjs:191-203`). Without these regex
    // gates we'd happily walk into unrelated 3-level deep directories the
    // user might drop under `~/.codex/sessions` (notes / backups / etc),
    // and end up returning JSONL paths the metadata side never indexed —
    // surfacing search results the renderer can't resolve to a session.
    let years;
    try { years = await fsp.readdir(CODEX_SESSIONS_DIR); } catch { return []; }
    for (const y of years) {
      if (!/^\d{4}$/.test(y)) continue;
      const yp = path.join(CODEX_SESSIONS_DIR, y);
      if (!(await isPlainDir(yp))) continue;
      let months;
      try { months = await fsp.readdir(yp); } catch { continue; }
      for (const m of months) {
        if (!/^\d{2}$/.test(m)) continue;
        const mp = path.join(yp, m);
        if (!(await isPlainDir(mp))) continue;
        let days;
        try { days = await fsp.readdir(mp); } catch { continue; }
        for (const d of days) {
          if (!/^\d{2}$/.test(d)) continue;
          const dayPath = path.join(mp, d);
          if (!(await isPlainDir(dayPath))) continue;
          let files;
          try { files = await fsp.readdir(dayPath); } catch { continue; }
          for (const f of files) {
            if (!f.endsWith('.jsonl')) continue;
            const fp = path.join(dayPath, f);
            if (!(await isPlainFile(fp))) continue;
            targets.push({ filePath: fp, projectDir: `${y}-${m}-${d}` });
          }
        }
      }
    }
    return targets;
  }
  // Claude (default): top-level .jsonl + nested subagents/*.jsonl.
  let projectDirs;
  try { projectDirs = await fsp.readdir(PROJECTS_DIR); } catch { return []; }
  for (const projectDir of projectDirs) {
    const projectPath = path.join(PROJECTS_DIR, projectDir);
    if (!(await isPlainDir(projectPath))) continue;
    let entries;
    try { entries = await fsp.readdir(projectPath); } catch { continue; }
    // Two-pass scan: gather top-level .jsonl files AND record session-id
    // sub-directories that might hold subagents. Conservative regex on the
    // dir name so we don't recurse into unrelated folders (image-cache, etc.).
    const sessionDirs = [];
    for (const entry of entries) {
      const fp = path.join(projectPath, entry);
      let lst;
      try { lst = await fsp.lstat(fp); } catch { continue; }
      if (lst.isSymbolicLink()) continue;
      if (lst.isFile() && entry.endsWith('.jsonl')) {
        targets.push({ filePath: fp, projectDir });
      } else if (lst.isDirectory() && /^[A-Za-z0-9_-]{8,}$/.test(entry)) {
        sessionDirs.push(entry);
      }
    }
    // Pass two: each session dir's `subagents/` children. Attribute back to
    // the parent session id so the renderer sees one hit per conversation,
    // not one per subagent file.
    for (const sid of sessionDirs) {
      const subDir = path.join(projectPath, sid, 'subagents');
      if (!(await isPlainDir(subDir))) continue;
      let subEntries;
      try { subEntries = await fsp.readdir(subDir); } catch { continue; }
      for (const sf of subEntries) {
        if (!sf.endsWith('.jsonl')) continue;
        const fp = path.join(subDir, sf);
        if (!(await isPlainFile(fp))) continue;
        targets.push({ filePath: fp, projectDir, parentSessionId: sid });
      }
    }
  }
  return targets;
}

// Same cap as the metadata reader — a session that's visible in History
// (so it parsed at metadata time within MAX_SESSION_FILE_SIZE) must also be
// reachable from search. Past the cap, skip rather than error.
const DEEP_SEARCH_FILE_SIZE_CAP = MAX_SESSION_FILE_SIZE;

// Snippet ranking for the merge step. Both inputs carry the standalone
// (pre-sum) matchCount, snippet, filePath, and fromSubagent flag. Rules,
// in order:
//   1. A row WITH a snippet beats a row with no snippet.
//   2. Parent-conversation row beats subagent row when both have snippets —
//      the main thread is what the user remembers writing.
//   3. Same provenance: heavier original matchCount wins.
// Stable: returns `a` on ties so the first-iterated rawHit is preserved
// (deterministic for the same scan order).
function chooseSnippet(a, b) {
  const aHas = !!a?.snippet;
  const bHas = !!b?.snippet;
  if (aHas && !bHas) return a;
  if (bHas && !aHas) return b;
  if (a.fromSubagent !== b.fromSubagent) return a.fromSubagent ? b : a;
  return b.matchCount > a.matchCount ? b : a;
}

// Pull the actual rendered text out of a JSONL row: Claude
// `message.content` (string or part array), summary, queued-command
// attachment, or Codex `payload.content`. Returns '' when the row has no
// human-facing text (token-usage-only assistant rows, tool_use without
// text, etc.). Kept aligned with the renderer's text extraction in
// `parsers/claude.cjs` so a row that shows up as visible text in the
// detail pane can also be the source of a search snippet — otherwise
// hits in queued-command prompts (real human text!) fall back to JSON.
function extractHumanText(obj) {
  if (!obj) return '';
  const c = obj.message?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return c.map(p => (typeof p === 'string' ? p : (p?.text || p?.content || ''))).join('\n');
  }
  if (typeof obj.summary === 'string') return obj.summary;
  if (obj.type === 'attachment' && obj.attachment?.type === 'queued_command' && typeof obj.attachment.prompt === 'string') {
    return obj.attachment.prompt;
  }
  if (Array.isArray(obj.payload?.content)) {
    return obj.payload.content
      .filter(p => p && (p.type === 'input_text' || p.type === 'output_text'))
      .map(p => p.text || '').join('\n');
  }
  return '';
}

async function deepSearch(query, source) {
  if (!query || query.length < 2) return [];
  // Split on whitespace → OR semantics. "jwt refresh token" matches any session
  // containing jwt, refresh, OR token; ranked by total count + keyword coverage.
  // Quoted "phrase like this" stays glued. Tokens shorter than 2 chars dropped.
  const terms = tokenizeQuery(query);
  if (terms.length === 0) return [];

  const targets = await listSearchTargets(source === 'codex' ? 'codex' : 'claude');
  // Per-file results land in `rawHits`; we merge by composite source:id at
  // the end so subagent files fold into their parent conversation rather than
  // appearing as separate rows (their ids are subagent filenames, not real
  // session ids — the renderer wouldn't be able to resolve them anyway).
  const rawHits = [];

  for (const { filePath, projectDir, parentSessionId } of targets) {
    const entry = path.basename(filePath);
    // Stat first so a giant log file can't kill the main loop before we even
    // look at content. Files past the cap are skipped (not errored).
    try {
      const st = await fsp.stat(filePath);
      if (st.size > DEEP_SEARCH_FILE_SIZE_CAP) continue;
    } catch { continue; }
    // Streaming pass: walk lines, count per-term hits, find first hit line,
    // and classify by message role — all without holding the full file or
    // a lowercased copy in memory. The old `readFile + toLowerCase + split`
    // created up to 3 copies of every byte; streaming keeps it at ~1.
    const perTerm = Object.create(null);
    for (const t of terms) perTerm[t] = 0;
    let totalCount = 0;
    let coverage = 0;
    let firstHitTerm = null;
    let firstHitLine = null;       // raw obj of the first matched line (any)
    let firstHitLineIdx = -1;       // 0-based line number
    // Promoted-snippet line: term-in-human-text wins over a numeric / JSON-
    // noise match. Without this, an assistant message whose `usage.cache_*`
    // counters happen to contain the query digits as a substring sorts ahead
    // of the message whose body actually mentions the term, and the user
    // sees a useless token-counter snippet for a real match.
    let humanHitLine = null;
    let humanHitTerm = null;
    let codexMetaId = null;
    const sources = { user: 0, assistant: 0, summary: 0, tool: 0 };
    let lineIdx = -1;
    let aborted = false;
    try {
      await forEachJsonlLine(filePath, (obj) => {
        if (aborted) return;
        lineIdx++;
        // Codex session_meta carries the id we need; capture on the first
        // line so we don't have to re-read the file later.
        if (source === 'codex' && codexMetaId == null && obj?.type === 'session_meta' && obj?.payload?.id) {
          codexMetaId = String(obj.payload.id);
        }
        // Walk the line text once. JSON.stringify gives us a single string
        // representation we can lowercase in-place; cheaper than walking
        // every leaf field.
        let lineLower;
        try { lineLower = JSON.stringify(obj).toLowerCase(); } catch { return; }
        let anyHitThisLine = false;
        let anyHitTermThisLine = null;
        for (let i = 0; i < terms.length; i++) {
          const t = terms[i];
          const before = perTerm[t];
          let pos = 0, count = 0;
          while ((pos = lineLower.indexOf(t, pos)) !== -1) { count++; pos += t.length; if (count > 999) break; }
          if (count > 0) {
            perTerm[t] = before + count;
            totalCount += count;
            if (before === 0) coverage++;
            if (!anyHitThisLine) {
              anyHitThisLine = true;
              anyHitTermThisLine = t;
              if (firstHitLineIdx < 0) {
                firstHitLineIdx = lineIdx;
                firstHitLine = obj;
                firstHitTerm = t;
              }
            }
          }
        }
        if (anyHitThisLine) {
          const role = obj?.message?.role;
          const type = obj?.type;
          // Claude `attachment.queued_command` is text the user typed while
          // the model was mid-tool — it's user input, just delivered via the
          // attachment channel. Codex `response_item` carries the actual
          // turn under `payload.type === 'message'` with `payload.role`.
          // Without these two branches the MatchBlock chips read empty for
          // hits that DO have human-text snippets — confusing.
          const codexRole = (type === 'response_item' && obj?.payload?.type === 'message') ? obj.payload.role : null;
          if (
            role === 'user' ||
            type === 'user' ||
            codexRole === 'user' ||
            (type === 'attachment' && obj?.attachment?.type === 'queued_command')
          ) sources.user++;
          else if (role === 'assistant' || type === 'assistant' || codexRole === 'assistant') sources.assistant++;
          else if (type === 'summary') sources.summary++;
          else if (type === 'tool_use' || type === 'tool_result') sources.tool++;
          // First line whose match lands in actually-rendered conversation
          // text gets pinned as the snippet source — preferred over the
          // first raw hit. We test against ALL terms because a multi-term
          // query that hits prose with one term and a numeric field with
          // another still gives a useful prose snippet.
          if (humanHitLine == null) {
            const ht = extractHumanText(obj);
            if (ht) {
              const lower = ht.toLowerCase();
              for (const t of terms) {
                if (lower.indexOf(t) !== -1) {
                  humanHitLine = obj;
                  humanHitTerm = t;
                  break;
                }
              }
            }
          }
        }
      });
    } catch { continue; }
    if (totalCount === 0) continue;

    // Prefer the human-text line if we found one; the raw JSON noise line is
    // only the snippet of last resort. anyHitTermThisLine kept as the hint
    // for `indexOf` below.
    const obj = humanHitLine || firstHitLine;
    const term = humanHitTerm || firstHitTerm || terms[0];
    let humanText = extractHumanText(obj);
    if (!humanText) {
      try { humanText = JSON.stringify(obj); } catch {}
    }
    let snippet;
    if (humanText) {
      const lowerHuman = humanText.toLowerCase();
      const hitIdx = lowerHuman.indexOf(term);
      const start = Math.max(0, (hitIdx >= 0 ? hitIdx : 0) - 80);
      const end = Math.min(humanText.length, (hitIdx >= 0 ? hitIdx : 0) + term.length + 200);
      snippet = humanText.slice(start, end).replace(/\s+/g, ' ').trim();
      if (start > 0) snippet = '… ' + snippet;
      if (end < humanText.length) snippet = snippet + ' …';
    } else {
      snippet = '';
    }

    // Extract session id per source convention.
    let id;
    if (source === 'codex') {
      if (codexMetaId) {
        id = codexMetaId;
      } else {
        const m = entry.match(/^rollout-.*?-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i);
        if (!m) continue;
        id = m[1];
      }
    } else if (parentSessionId) {
      // Subagent .jsonl — credit the hit to the parent conversation, not the
      // synthetic agent-* filename (which the renderer can't resolve to a
      // SessionMeta).
      id = parentSessionId;
    } else {
      id = entry.replace(/\.jsonl$/, '');
    }
    rawHits.push({
      id,
      source: source === 'codex' ? 'codex' : 'claude',
      projectDir,
      filePath,
      snippet,
      matchCount: totalCount,
      coverage,         // how many of N terms hit — strong relevance signal
      termCount: terms.length,
      sources,
      perTerm,           // kept for per-session merge below
      fromSubagent: !!parentSessionId,
    });
  }

  // Merge by `source:id` — a parent .jsonl AND its subagent files can each
  // produce a row; the renderer expects one row per session. Sum match counts
  // and per-source breakdown; OR-merge perTerm to recompute coverage; pick
  // the snippet by an explicit ranking (see chooseSnippet) so the result
  // doesn't depend on rawHits iteration order.
  //
  // Cache each row's ORIGINAL matchCount/snippet on a `_orig` field before
  // summing — the ranking step compares standalone contributions, not the
  // running sum. Without this the "h.matchCount > prev.matchCount - h.matchCount"
  // comparison silently degrades into noise the moment prev.matchCount is
  // mutated, which is the bug codex flagged in #3.
  const byKey = new Map();
  for (const h of rawHits) {
    const key = `${h.source}:${h.id}`;
    const prev = byKey.get(key);
    if (!prev) {
      h._orig = { matchCount: h.matchCount, snippet: h.snippet, filePath: h.filePath, fromSubagent: h.fromSubagent };
      byKey.set(key, h);
      continue;
    }
    // Sum counts and per-role breakdown.
    prev.matchCount += h.matchCount;
    for (const k of Object.keys(prev.sources)) prev.sources[k] += h.sources[k] || 0;
    // OR-merge per-term so coverage reflects "any file in this conversation
    // saw the term", not just one file in isolation.
    for (const t of terms) {
      const before = prev.perTerm[t] || 0;
      const add = h.perTerm[t] || 0;
      prev.perTerm[t] = before + add;
    }
    // Pick the better snippet source between prev._orig and the incoming h —
    // standalone contributions only, never the running sum.
    const winner = chooseSnippet(prev._orig, {
      matchCount: h.matchCount, snippet: h.snippet, filePath: h.filePath, fromSubagent: h.fromSubagent,
    });
    if (winner !== prev._orig) {
      prev.snippet = winner.snippet;
      prev.filePath = winner.filePath;
      prev.fromSubagent = winner.fromSubagent;
      prev._orig = winner;
    }
  }
  // Recompute coverage from the merged perTerm map.
  const hits = [];
  for (const h of byKey.values()) {
    let cov = 0;
    for (const t of terms) if ((h.perTerm[t] || 0) > 0) cov++;
    h.coverage = cov;
    // Drop the internal scratch fields before handing to the renderer — keeps
    // the IPC payload narrow and matches the previous shape.
    delete h.perTerm;
    delete h.fromSubagent;
    delete h._orig;
    hits.push(h);
  }
  // Coverage dominates (a session matching all 3 terms beats one matching 1 term
  // even if the latter has more hits of that single term). Then total count.
  hits.sort((a, b) => (b.coverage - a.coverage) || (b.matchCount - a.matchCount));
  return hits;
}

// Tokenize a query into OR terms. Honors "quoted phrases" so users can pin a
// multi-word expression. Drops single-char tokens (noise). All lowercased.
function tokenizeQuery(query) {
  const out = [];
  const re = /"([^"]+)"|(\S+)/g;
  let m;
  while ((m = re.exec(query)) !== null) {
    const t = (m[1] || m[2] || '').toLowerCase().trim();
    if (t.length >= 2 && !out.includes(t)) out.push(t);
  }
  return out;
}

module.exports = {
  DEEP_SEARCH_FILE_SIZE_CAP,
  listSearchTargets,
  deepSearch,
  tokenizeQuery,
};
