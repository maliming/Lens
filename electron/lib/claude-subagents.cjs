// Shared enumerator for a Claude session's subagent transcript files. One
// source of truth so deep search (search.cjs) and the Usage/metadata scan
// (parsers/claude.cjs statAllJsonl) agree on which on-disk shapes count as
// subagent transcripts — otherwise the two drift (search finds workflow agents
// but Usage doesn't, or vice versa).
//
// Two known shapes only — no unbounded recursion, so `workflows/scripts`, image
// caches, or anything hand-dropped under a session dir never get walked:
//   <sessionDir>/subagents/agent-*.jsonl                    (Task/Agent subagents)
//   <sessionDir>/subagents/workflows/<runId>/agent-*.jsonl  (Workflow-tool agents)
//
// lstat (never stat) at every level refuses to follow symlinks — `~/.claude`
// is tool-owned, a link inside it pointing out is misconfig or attack.

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const AGENT_JSONL_RE = /^agent-.+\.jsonl$/;

async function isRealDir(p) {
  try { const st = await fsp.lstat(p); return !st.isSymbolicLink() && st.isDirectory(); } catch { return false; }
}
async function isRealFile(p) {
  try { const st = await fsp.lstat(p); return !st.isSymbolicLink() && st.isFile(); } catch { return false; }
}
async function safeReaddir(p) {
  try { return await fsp.readdir(p); } catch { return []; }
}

// Returns [{ filePath, kind: 'task' | 'workflow', runId? }], deduped by
// filePath. `journal.jsonl` is excluded naturally (doesn't match agent-*.jsonl).
async function listClaudeSubagentTranscriptFiles(sessionDir) {
  const out = [];
  const seen = new Set();
  const subagentsDir = path.join(sessionDir, 'subagents');
  if (!(await isRealDir(subagentsDir))) return out;

  // Task agents — directly under subagents/.
  for (const name of await safeReaddir(subagentsDir)) {
    if (!AGENT_JSONL_RE.test(name)) continue;
    const fp = path.join(subagentsDir, name);
    if (seen.has(fp) || !(await isRealFile(fp))) continue;
    seen.add(fp);
    out.push({ filePath: fp, kind: 'task' });
  }

  // Workflow agents — one level deeper, under subagents/workflows/<runId>/.
  const workflowsDir = path.join(subagentsDir, 'workflows');
  if (await isRealDir(workflowsDir)) {
    for (const runId of await safeReaddir(workflowsDir)) {
      const runDir = path.join(workflowsDir, runId);
      if (!(await isRealDir(runDir))) continue;
      for (const name of await safeReaddir(runDir)) {
        if (!AGENT_JSONL_RE.test(name)) continue;
        const fp = path.join(runDir, name);
        if (seen.has(fp) || !(await isRealFile(fp))) continue;
        seen.add(fp);
        out.push({ filePath: fp, kind: 'workflow', runId });
      }
    }
  }

  return out;
}

module.exports = { listClaudeSubagentTranscriptFiles };
