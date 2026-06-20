import type { MessageItem, SessionSubagents, SubagentTaskRef, WorkflowAgentRef, WorkflowRunRef } from '../types';

// Subagent / workflow transcripts indexed by the tool_use call that spawned
// them, so the detail view can hang inline "open transcript" expanders on the
// originating Agent / Workflow card.
export type LinkedSubagents = {
  taskAgents: SubagentTaskRef[];
  workflowRuns: WorkflowRunRef[];
};

export type SubagentLinks = {
  // toolUseId → the subagents / workflow runs spawned by that call.
  byToolUseId: Map<string, LinkedSubagents>;
  // Task agents whose meta carried no originating tool_use id (orphans), and
  // workflow runs we couldn't tie to a specific Workflow call. Both render in a
  // flat region so they're never silently dropped.
  unlinkedTaskAgents: SubagentTaskRef[];
  unlinkedWorkflowRuns: WorkflowRunRef[];
  isEmpty: boolean;
};

const EMPTY: SubagentLinks = { byToolUseId: new Map(), unlinkedTaskAgents: [], unlinkedWorkflowRuns: [], isEmpty: true };

function bucket(map: Map<string, LinkedSubagents>, id: string): LinkedSubagents {
  let b = map.get(id);
  if (!b) { b = { taskAgents: [], workflowRuns: [] }; map.set(id, b); }
  return b;
}

export function linkSubagents(
  messages: MessageItem[] | null,
  index: SessionSubagents | null,
): SubagentLinks {
  if (!index || (!index.taskAgents.length && !index.workflowRuns.length)) return EMPTY;
  const msgs = messages || [];
  const byToolUseId = new Map<string, LinkedSubagents>();
  const unlinkedTaskAgents: SubagentTaskRef[] = [];

  // Task/Agent subagents: meta.json carries the originating tool_use id, so the
  // link is direct. No id → orphan (surfaced in the flat region).
  for (const ta of index.taskAgents) {
    if (ta.toolUseId) bucket(byToolUseId, ta.toolUseId).taskAgents.push(ta);
    else unlinkedTaskAgents.push(ta);
  }

  // Workflow tool_use ids in message order, for the order-based fallback.
  const workflowCallIds: string[] = [];
  const workflowCallIdSet = new Set<string>();
  for (const m of msgs) {
    if (!m.toolCalls) continue;
    for (const tc of m.toolCalls) {
      // Case-insensitive so a renamed/namespaced launch tool still links.
      if (tc.toolName.toLowerCase() === 'workflow') { workflowCallIds.push(tc.toolUseId); workflowCallIdSet.add(tc.toolUseId); }
    }
  }

  // runId → the Workflow call it answers, read per-block from the launch
  // result so parallel Workflow calls in one user turn don't cross-link.
  const callByRunId = new Map<string, string>();
  for (const m of msgs) {
    if (!m.isToolResult || !m.toolResults) continue;
    for (const r of m.toolResults) {
      if (r.workflowRunId && workflowCallIdSet.has(r.toolUseId) && !callByRunId.has(r.workflowRunId)) {
        callByRunId.set(r.workflowRunId, r.toolUseId);
      }
    }
  }

  const linkedRunIds = new Set<string>();
  const usedCallIds = new Set<string>();
  for (const run of index.workflowRuns) {
    const callId = callByRunId.get(run.runId);
    if (callId) {
      bucket(byToolUseId, callId).workflowRuns.push(run);
      linkedRunIds.add(run.runId);
      usedCallIds.add(callId);
    }
  }

  // Order-based fallback: only when the remaining Workflow calls and runs line
  // up exactly. Zipping a mismatched count would attach a run to the wrong card
  // — better to leave them all in the flat region than mis-attribute. Synthetic
  // (orphan-dir) runs are excluded: they have no real ordering signal (only a
  // dir mtime), so they link via exact runId or not at all.
  const remainingCalls = workflowCallIds.filter(id => !usedCallIds.has(id));
  const remainingRuns = index.workflowRuns.filter(r => !linkedRunIds.has(r.runId) && !r.synthetic);
  // The zip pairs Nth call with Nth run by startTime, so the order is only
  // trustworthy when there's a single pair (unambiguous) or every run has a
  // real startTime. A run with a missing startTime (defaulted to 0 in main)
  // sorts to the front and would mis-pair — leave those in the unlinked region.
  const orderReliable = remainingRuns.length <= 1 || remainingRuns.every(r => r.startTime > 0);
  if (remainingCalls.length > 0 && remainingCalls.length === remainingRuns.length && orderReliable) {
    for (let i = 0; i < remainingRuns.length; i++) {
      bucket(byToolUseId, remainingCalls[i]).workflowRuns.push(remainingRuns[i]);
      linkedRunIds.add(remainingRuns[i].runId);
    }
  }

  const unlinkedWorkflowRuns = index.workflowRuns.filter(r => !linkedRunIds.has(r.runId));
  return {
    byToolUseId,
    unlinkedTaskAgents,
    unlinkedWorkflowRuns,
    isEmpty: byToolUseId.size === 0 && unlinkedTaskAgents.length === 0 && unlinkedWorkflowRuns.length === 0,
  };
}

// Does this message carry a tool_use that has a linked subagent / workflow run?
// SessionDetail uses it to keep such cards visible even when "Show tools" is off
// (the expander would otherwise be filtered out with the rest of the tool cards).
export function messageHasLinkedSubagent(m: MessageItem, links: SubagentLinks): boolean {
  if (links.isEmpty || !m.toolCalls) return false;
  for (const tc of m.toolCalls) {
    if (links.byToolUseId.has(tc.toolUseId)) return true;
  }
  return false;
}

// In-session search (lightweight): match against the subagent / workflow index
// fields already held in renderer memory — no transcript read. `q` is expected
// lowercased. Lets the detail-pane search keep an Agent / Workflow card in view
// (and surface a matched preview) when the hit is inside a subagent it spawned.
function has(s: string | null | undefined, q: string): boolean {
  return !!s && s.toLowerCase().includes(q);
}
export function taskAgentMatches(a: SubagentTaskRef, q: string): boolean {
  return has(a.agentType, q) || has(a.description, q);
}
export function workflowAgentMatches(a: WorkflowAgentRef, q: string): boolean {
  return has(a.label, q) || has(a.phaseTitle, q) || has(a.state, q)
    || has(a.model, q) || has(a.promptPreview, q) || has(a.resultPreview, q);
}
export function workflowRunMatches(r: WorkflowRunRef, q: string): boolean {
  return has(r.name, q) || has(r.summary, q) || has(r.status, q)
    || r.agents.some(a => workflowAgentMatches(a, q));
}
export function linkedMatchesQuery(linked: LinkedSubagents | null, q: string): boolean {
  if (!linked || !q) return false;
  return linked.taskAgents.some(a => taskAgentMatches(a, q))
    || linked.workflowRuns.some(r => workflowRunMatches(r, q));
}

// The linked subagents / workflow runs for a single message (merged across all
// of its tool_use blocks), or null when none.
export function linkedFor(m: MessageItem, links: SubagentLinks): LinkedSubagents | null {
  if (links.isEmpty || !m.toolCalls) return null;
  let taskAgents: SubagentTaskRef[] = [];
  let workflowRuns: WorkflowRunRef[] = [];
  for (const tc of m.toolCalls) {
    const b = links.byToolUseId.get(tc.toolUseId);
    if (!b) continue;
    if (b.taskAgents.length) taskAgents = taskAgents.concat(b.taskAgents);
    if (b.workflowRuns.length) workflowRuns = workflowRuns.concat(b.workflowRuns);
  }
  if (!taskAgents.length && !workflowRuns.length) return null;
  return { taskAgents, workflowRuns };
}
