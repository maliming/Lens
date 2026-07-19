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

async function realPathState(p, kind) {
  try {
    const st = await fsp.lstat(p);
    const exists = !st.isSymbolicLink() && (kind === 'dir' ? st.isDirectory() : st.isFile());
    return { exists, complete: true };
  } catch (error) {
    return { exists: false, complete: error?.code === 'ENOENT' };
  }
}
async function readdirState(p) {
  try { return { entries: await fsp.readdir(p), complete: true }; }
  catch (error) { return { entries: [], complete: error?.code === 'ENOENT' }; }
}

// Returns [{ filePath, kind: 'task' | 'workflow', runId? }], deduped by
// filePath. `journal.jsonl` is excluded naturally (doesn't match agent-*.jsonl).
async function listClaudeSubagentTranscriptFilesWithStatus(sessionDir) {
  const out = [];
  const seen = new Set();
  let complete = true;
  const subagentsDir = path.join(sessionDir, 'subagents');
  const subagentsState = await realPathState(subagentsDir, 'dir');
  complete &&= subagentsState.complete;
  if (!subagentsState.exists) return { files: out, complete };

  // Task agents — directly under subagents/.
  const taskEntries = await readdirState(subagentsDir);
  complete &&= taskEntries.complete;
  for (const name of taskEntries.entries) {
    if (!AGENT_JSONL_RE.test(name)) continue;
    const fp = path.join(subagentsDir, name);
    if (seen.has(fp)) continue;
    const fileState = await realPathState(fp, 'file');
    complete &&= fileState.complete;
    if (!fileState.exists) continue;
    seen.add(fp);
    out.push({ filePath: fp, kind: 'task' });
  }

  // Workflow agents — one level deeper, under subagents/workflows/<runId>/.
  const workflowsDir = path.join(subagentsDir, 'workflows');
  const workflowsState = await realPathState(workflowsDir, 'dir');
  complete &&= workflowsState.complete;
  if (workflowsState.exists) {
    const workflowEntries = await readdirState(workflowsDir);
    complete &&= workflowEntries.complete;
    for (const runId of workflowEntries.entries) {
      const runDir = path.join(workflowsDir, runId);
      const runState = await realPathState(runDir, 'dir');
      complete &&= runState.complete;
      if (!runState.exists) continue;
      const runEntries = await readdirState(runDir);
      complete &&= runEntries.complete;
      for (const name of runEntries.entries) {
        if (!AGENT_JSONL_RE.test(name)) continue;
        const fp = path.join(runDir, name);
        if (seen.has(fp)) continue;
        const fileState = await realPathState(fp, 'file');
        complete &&= fileState.complete;
        if (!fileState.exists) continue;
        seen.add(fp);
        out.push({ filePath: fp, kind: 'workflow', runId });
      }
    }
  }

  return { files: out, complete };
}

async function listClaudeSubagentTranscriptFiles(sessionDir) {
  return (await listClaudeSubagentTranscriptFilesWithStatus(sessionDir)).files;
}

module.exports = {
  listClaudeSubagentTranscriptFiles,
  listClaudeSubagentTranscriptFilesWithStatus,
};
