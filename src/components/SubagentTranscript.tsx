import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ChevronRight, ChevronDown, ChevronsUpDown, ChevronsDownUp, Bot, Workflow } from 'lucide-react';
import { cn } from '../lib/utils';
import { cleanDisplayText, fmtBytes, fmtModel, fmtTokens } from '../lib/format';
import { highlightDom } from '../lib/highlight';
import { useTranslation } from '../lib/I18nProvider';
import { Message } from './Message';
import { useDemoMode } from '../lib/demoMode';
import { DEMO_SUBAGENT_TRANSCRIPTS } from '../lib/demoData';
import type { MessageItem, SubagentTaskRef, WorkflowRunRef, WorkflowAgentRef } from '../types';
import type { LinkedSubagents } from '../lib/subagents';
import type { DisplayPrefs } from '../lib/displayPrefs';

type Source = 'claude' | 'codex';

// Inline-highlight a text field for the in-session query, so SessionDetail's
// mark counter picks the hits up for prev/next nav. The span is rendered with
// NO React children — we set its text imperatively and run highlightDom on it.
// Two reasons this matters (both were real bugs with a `{text}` child):
//   1. highlightDom replaces text nodes with <mark> fragments. React must not
//      own those nodes, or it reconciles against detached nodes (stale text /
//      removeChild errors) when the SWR refresh changes the field.
//   2. We reset textContent every run, so changing the query wipes the prior
//      query's marks instead of stacking them (highlightDom skips existing
//      <mark>, so without the reset old highlights would accumulate).
function Hl({ text, query, className }: { text: string; query: string; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.textContent = text;
    if (query.trim()) highlightDom(el, query);
  }, [text, query]);
  return <span ref={ref} className={className} />;
}

// Whether a not-normally-shown field (promptPreview / resultPreview / summary)
// matches the active query — gates the small "matched preview" line we render
// so the hit is visible and counted.
function hit(s: string | null | undefined, query: string): boolean {
  const q = query.trim().toLowerCase();
  return !!q && !!s && s.toLowerCase().includes(q);
}

function fmtDuration(ms: number): string {
  if (ms <= 0) return '';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)}s`;
  const m = Math.floor(ms / 60000);
  const s = Math.round((ms % 60000) / 1000);
  return `${m}m ${s}s`;
}

function StatusPill({ state }: { state: string }) {
  const s = state.toLowerCase();
  const cls =
    s === 'done' || s === 'completed' || s === 'success'
      ? 'text-emerald-700 bg-emerald-100 dark:text-emerald-300 dark:bg-emerald-900/40'
      : s === 'failed' || s === 'error'
      ? 'text-rose-700 bg-rose-100 dark:text-rose-300 dark:bg-rose-900/40'
      : 'text-amber-700 bg-amber-100 dark:text-amber-300 dark:bg-amber-900/40';
  return (
    <span className={cn('rounded px-1.5 py-0.5 text-[9.5px] uppercase tracking-wide font-medium shrink-0', cls)}>
      {cleanDisplayText(state)}
    </span>
  );
}

// Lazily-loaded nested transcript. The agent JSONL is the same shape as a
// top-level session, so we reuse the existing getSession IPC + Message
// renderer. Fetch fires only when the disclosure opens — a session with
// hundreds of subagents must not read them all up front. The main-process
// 200 MB hard cap surfaces here as an error row rather than a silent failure.
function AgentBody({ filePath, source, prefs }: { filePath: string; source: Source; prefs: DisplayPrefs }) {
  const { t } = useTranslation();
  const [demoMode] = useDemoMode();
  const [state, setState] = useState<{ status: 'loading' | 'error' | 'ready'; messages?: MessageItem[]; error?: string }>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    // Demo mode has no real files — resolve the synthetic `demo://` transcript
    // synchronously instead of hitting the getSession IPC.
    if (demoMode) {
      setState({ status: 'ready', messages: DEMO_SUBAGENT_TRANSCRIPTS[filePath] || [] });
      return;
    }
    setState({ status: 'loading' });
    window.api.getSession(filePath)
      .then(msgs => { if (!cancelled) setState({ status: 'ready', messages: msgs }); })
      .catch(e => { if (!cancelled) setState({ status: 'error', error: e?.message || String(e) }); });
    return () => { cancelled = true; };
  }, [filePath, demoMode]);

  if (state.status === 'loading') {
    return <div className="px-3 py-2 text-[11.5px] text-text-muted">{t('subagent.loading')}</div>;
  }
  if (state.status === 'error') {
    return <div className="px-3 py-2 text-[11.5px] text-rose-500">{t('subagent.loadError')}: {cleanDisplayText(state.error || '')}</div>;
  }
  const msgs = state.messages || [];
  if (!msgs.length) {
    return <div className="px-3 py-2 text-[11.5px] text-text-muted">{t('subagent.empty')}</div>;
  }
  return (
    <div className={cn('flex flex-col', prefs.compact ? 'gap-2' : 'gap-4')}>
      {msgs.map((m, i) => (
        // promptStyle: inside a subagent transcript a "user" turn is the prompt
        // handed to the agent, not the human operator.
        <Message key={i} message={m} defaultMode="markdown" query="" prefs={prefs} source={source} promptStyle />
      ))}
    </div>
  );
}

// A clickable header row that expands into the nested transcript. When the
// agent has no transcript file on disk (a run that crashed before writing),
// the row is inert and shows a "no transcript" note instead. Open state is
// controlled when `open`/`onToggle` are supplied (so a parent can drive
// expand-all / collapse-all), otherwise self-managed.
function AgentDisclosure({ header, filePath, source, prefs, open, onToggle }: { header: React.ReactNode; filePath: string | null; source: Source; prefs: DisplayPrefs; open?: boolean; onToggle?: () => void }) {
  const { t } = useTranslation();
  const [localOpen, setLocalOpen] = useState(false);
  const controlled = open !== undefined;
  const isOpen = controlled ? !!open : localOpen;
  const toggle = () => { if (!filePath) return; if (controlled) onToggle?.(); else setLocalOpen(o => !o); };
  return (
    <div className="rounded-md border border-emerald-200/60 dark:border-emerald-900/40 bg-emerald-50/40 dark:bg-emerald-950/20">
      <button
        type="button"
        onClick={toggle}
        disabled={!filePath}
        aria-expanded={isOpen}
        className={cn(
          'w-full flex items-center gap-2 px-2.5 py-1.5 text-left',
          filePath ? 'cursor-pointer hover:bg-emerald-100/50 dark:hover:bg-emerald-900/20' : 'cursor-default opacity-70',
        )}
      >
        {filePath
          ? (isOpen ? <ChevronDown className="w-3.5 h-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" /> : <ChevronRight className="w-3.5 h-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />)
          : <span className="w-3.5 shrink-0" />}
        <div className="min-w-0 flex-1">{header}</div>
      </button>
      {!filePath && <div className="px-3 pb-2 -mt-0.5 text-[11px] text-text-muted">{t('subagent.missing')}</div>}
      {isOpen && filePath && (
        <div className="ml-3 border-l-2 border-emerald-300/60 dark:border-emerald-800/50 pl-3 pr-2 py-2">
          <AgentBody filePath={filePath} source={source} prefs={prefs} />
        </div>
      )}
    </div>
  );
}

function TaskAgentRow({ agent, source, prefs, query }: { agent: SubagentTaskRef; source: Source; prefs: DisplayPrefs; query: string }) {
  const { t } = useTranslation();
  const header = (
    <div className="flex items-center gap-2 min-w-0">
      <Bot className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400 shrink-0" />
      <span className="text-[10px] uppercase tracking-wider font-semibold text-emerald-700 dark:text-emerald-400 shrink-0">{t('subagent.badge')}</span>
      {agent.agentType && <Hl text={cleanDisplayText(agent.agentType)} query={query} className="text-[11px] text-text-muted shrink-0" />}
      {agent.description && <Hl text={cleanDisplayText(agent.description)} query={query} className="text-[12px] text-text truncate" />}
      {agent.fileSize > 0 && <span className="ml-auto text-[10px] text-text-muted tabular-nums shrink-0">{fmtBytes(agent.fileSize)}</span>}
    </div>
  );
  return <AgentDisclosure header={header} filePath={agent.filePath} source={source} prefs={prefs} />;
}

function WorkflowAgentRow({ agent, source, prefs, open, onToggle, query }: { agent: WorkflowAgentRef; source: Source; prefs: DisplayPrefs; open?: boolean; onToggle?: () => void; query: string }) {
  const header = (
    <div className="min-w-0">
      <div className="flex items-center gap-2 min-w-0">
        {agent.label && <Hl text={cleanDisplayText(agent.label)} query={query} className="text-[12px] text-text truncate" />}
        {agent.state && <StatusPill state={agent.state} />}
        <span className="ml-auto flex items-center gap-2 text-[10px] text-text-muted tabular-nums shrink-0">
          {agent.model && <span>{fmtModel(agent.model)}</span>}
          {agent.tokens > 0 && <span>{fmtTokens(agent.tokens)}</span>}
          {agent.durationMs > 0 && <span>{fmtDuration(agent.durationMs)}</span>}
        </span>
      </div>
      {/* Preview fields aren't shown by default — surface them (highlighted)
         only when the in-session query hits them, so the match is reachable. */}
      {hit(agent.promptPreview, query) && <div className="mt-0.5 text-[11px] text-text-muted truncate"><Hl text={cleanDisplayText(agent.promptPreview!)} query={query} /></div>}
      {hit(agent.resultPreview, query) && <div className="mt-0.5 text-[11px] text-text-muted truncate"><Hl text={cleanDisplayText(agent.resultPreview!)} query={query} /></div>}
    </div>
  );
  return <AgentDisclosure header={header} filePath={agent.filePath} source={source} prefs={prefs} open={open} onToggle={onToggle} />;
}

// Group a run's agents into consecutive phase blocks, preserving the run's
// progress order (agents already arrive ordered by the workflow engine).
function groupByPhase(run: WorkflowRunRef): Array<{ title: string; agents: WorkflowAgentRef[] }> {
  const groups: Array<{ title: string; agents: WorkflowAgentRef[] }> = [];
  for (const a of run.agents) {
    const title = a.phaseTitle || '';
    const last = groups[groups.length - 1];
    if (last && last.title === title) last.agents.push(a);
    else groups.push({ title, agents: [a] });
  }
  return groups;
}

function WorkflowRunCard({ run, source, prefs, query }: { run: WorkflowRunRef; source: Source; prefs: DisplayPrefs; query: string }) {
  const { t } = useTranslation();
  const groups = groupByPhase(run);
  const [openSet, setOpenSet] = useState<Set<string>>(() => new Set());

  // Stable per-agent key (agentId can repeat / be null, so pin it to the global
  // index). The same object refs flow into groupByPhase, so the map lookups
  // line up across both render passes.
  const keyByAgent = new Map<WorkflowAgentRef, string>();
  run.agents.forEach((a, i) => keyByAgent.set(a, (a.agentId || 'i') + ':' + i));
  const openableKeys = run.agents.filter(a => a.filePath).map(a => keyByAgent.get(a)!);
  const allOpen = openableKeys.length > 0 && openableKeys.every(k => openSet.has(k));

  const toggleOne = (k: string) => setOpenSet(prev => {
    const n = new Set(prev);
    if (n.has(k)) n.delete(k); else n.add(k);
    return n;
  });
  const toggleAll = () => setOpenSet(allOpen ? new Set() : new Set(openableKeys));

  return (
    <div className="rounded-lg border border-emerald-200/70 dark:border-emerald-900/50 bg-emerald-50/40 dark:bg-emerald-950/20 overflow-hidden">
      <div className="px-3 py-2 border-b border-emerald-200/60 dark:border-emerald-900/40">
        <div className="flex items-center gap-2">
          <Workflow className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
          <span className="text-[10px] uppercase tracking-wider font-semibold text-emerald-700 dark:text-emerald-400 shrink-0">{t('workflow.badge')}</span>
          {run.name && <Hl text={cleanDisplayText(run.name)} query={query} className="text-[12.5px] font-medium text-text truncate" />}
          {run.status && <StatusPill state={run.status} />}
          <span className="ml-auto flex items-center gap-2 text-[10.5px] text-text-muted tabular-nums shrink-0">
            <span>{t('workflow.agentsCount', { n: run.agents.length })}</span>
            {run.totalTokens > 0 && <span>{fmtTokens(run.totalTokens)}</span>}
            {run.durationMs > 0 && <span>{fmtDuration(run.durationMs)}</span>}
            {openableKeys.length > 1 && (
              <button
                type="button"
                onClick={toggleAll}
                className="flex items-center gap-1 rounded px-1.5 py-0.5 text-emerald-700 dark:text-emerald-400 hover:bg-emerald-100/60 dark:hover:bg-emerald-900/30"
              >
                {allOpen ? <ChevronsDownUp className="w-3 h-3" /> : <ChevronsUpDown className="w-3 h-3" />}
                {allOpen ? t('workflow.collapseAll') : t('workflow.expandAll')}
              </button>
            )}
          </span>
        </div>
        {hit(run.summary, query) && <div className="mt-1 text-[11px] text-text-muted"><Hl text={cleanDisplayText(run.summary!)} query={query} /></div>}
      </div>
      <div className="p-2 flex flex-col gap-2">
        {groups.map((g, gi) => (
          <div key={gi} className="flex flex-col gap-1.5">
            {g.title && <div className="px-1 text-[10.5px] uppercase tracking-wide text-text-muted">{t('workflow.phaseLabel', { title: cleanDisplayText(g.title) })}</div>}
            {g.agents.map(a => {
              const k = keyByAgent.get(a)!;
              return <WorkflowAgentRow key={k} agent={a} source={source} prefs={prefs} open={openSet.has(k)} onToggle={() => toggleOne(k)} query={query} />;
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

// Rendered at the bottom of a tool_use card (Agent / Workflow call): the
// subagents / workflow runs that call spawned.
export function SubagentSection({ linked, source, prefs, query = '' }: { linked: LinkedSubagents; source: Source; prefs: DisplayPrefs; query?: string }) {
  if (!linked.taskAgents.length && !linked.workflowRuns.length) return null;
  return (
    <div className="mt-2.5 flex flex-col gap-2">
      {linked.taskAgents.map((a, i) => <TaskAgentRow key={'t:' + (a.toolUseId || a.agentId || i)} agent={a} source={source} prefs={prefs} query={query} />)}
      {linked.workflowRuns.map((r, i) => <WorkflowRunCard key={'w:' + r.runId + ':' + i} run={r} source={source} prefs={prefs} query={query} />)}
    </div>
  );
}

// Fallback region (bottom of the detail pane) for subagents / workflow runs we
// couldn't tie to a specific tool call — orphan task agents (meta without a
// toolUseId) and workflow runs whose Workflow call couldn't be resolved. They
// surface here rather than being dropped.
export function UnlinkedSubagents({ taskAgents, runs, source, prefs, query = '' }: { taskAgents: SubagentTaskRef[]; runs: WorkflowRunRef[]; source: Source; prefs: DisplayPrefs; query?: string }) {
  const { t } = useTranslation();
  if (!taskAgents.length && !runs.length) return null;
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border-soft bg-surface/50 p-3">
      <div className="flex items-center gap-2">
        <Workflow className="w-4 h-4 text-text-muted shrink-0" />
        <span className="text-[12px] font-medium text-text">{t('workflow.unlinkedTitle')}</span>
        <span className="text-[11px] text-text-muted truncate">· {t('workflow.unlinkedNote')}</span>
      </div>
      {taskAgents.map((a, i) => <TaskAgentRow key={'t:' + (a.agentId || i)} agent={a} source={source} prefs={prefs} query={query} />)}
      {runs.map((r, i) => <WorkflowRunCard key={'w:' + r.runId + ':' + i} run={r} source={source} prefs={prefs} query={query} />)}
    </div>
  );
}
