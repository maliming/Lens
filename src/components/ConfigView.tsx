import { useEffect, useMemo, useState } from 'react';
import {
  Search, FolderOpen, ExternalLink, ChevronRight, ChevronLeft,
  BookOpen, Sparkles, Terminal, Webhook, Package, SlidersHorizontal,
  Code2, ArrowRight,
} from 'lucide-react';
import { useTranslation as useTranslationLocal } from '../lib/I18nProvider';
import { cn } from '../lib/utils';
import { fmtTime, cleanDisplayText } from '../lib/format';
import { renderMarkdown } from '../lib/markdown';
import { Resizer } from './Resizer';
import { DEMO_CONFIGS } from '../lib/demoData';
import { useCurrentSource, getSource, type SessionSource, type KindMeta, type ResourceKindKey } from '../lib/sources';
import type { ConfigItem, ConfigPayload } from '../types';

// Collapsed group state is per-source: Claude and Codex have different sets
// of kinds (Skills vs Rules, Commands vs ...), so a user's collapse choices
// shouldn't carry across when they flip the source.
const collapseStorageKey = (source: SessionSource) => `config-collapsed-v1:${source}`;

// Icons are visual constants for each KIND — shared across sources. Text
// (label / short / hint) lives on the source registry so adding a tool is one
// row in lib/sources.ts, no editing here.
const KIND_ICON: Record<ResourceKindKey, any> = {
  'rootInstructions': BookOpen,
  'Skill':            Sparkles,
  'Command':          Terminal,
  'Hook':             Webhook,
  'Plugin':           Package,
  'Settings':         SlidersHorizontal,
};

const KIND_ORDER: ResourceKindKey[] = ['rootInstructions', 'Skill', 'Command', 'Hook', 'Plugin', 'Settings'];

// Merge per-source kind text from the registry with the static KIND_ICON map
// so render code only ever touches one shape.
type FullKindMeta = KindMeta & { icon: any };
function resolveKindMeta(source: SessionSource): Record<ResourceKindKey, FullKindMeta> {
  const text = getSource(source).kindMeta;
  const out: Record<string, FullKindMeta> = {};
  for (const k of KIND_ORDER) out[k] = { ...text[k], icon: KIND_ICON[k] };
  return out as Record<ResourceKindKey, FullKindMeta>;
}

function loadCollapsed(source: SessionSource): Set<string> {
  try {
    const raw = localStorage.getItem(collapseStorageKey(source));
    if (raw) return new Set(JSON.parse(raw));
  } catch {}
  return new Set();
}

export function ConfigView({ demoMode = false, onStatus, refreshTick = 0 }: { demoMode?: boolean; onStatus?: (msg: string) => void; refreshTick?: number }) {
  const { t: tConfigRoot } = useTranslationLocal();
  const [config, setConfig] = useState<ConfigPayload | null>(null);
  const [active, setActive] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [currentSource] = useCurrentSource();
  const [collapsed, setCollapsed] = useState<Set<string>>(() => loadCollapsed(currentSource));
  const [showSource, setShowSource] = useState(true);

  // Reset to "source expanded" whenever the user picks a different resource —
  // most people want to read content immediately, so default open.
  useEffect(() => { setShowSource(true); }, [active]);

  const toggleGroup = (kind: string) => {
    setCollapsed(prev => {
      const next = new Set(prev);
      if (next.has(kind)) next.delete(kind); else next.add(kind);
      localStorage.setItem(collapseStorageKey(currentSource), JSON.stringify([...next]));
      return next;
    });
  };

  useEffect(() => {
    // Source-flip side effects (reset selection / filter / collapsed) only
    // run when the source actually changed — refreshTick re-fires this effect
    // too (to re-read disk), and clearing the user's filter+collapsed state
    // on every ⌘R would feel like the workspace nav was "snapping back".
    if (demoMode) {
      setConfig(DEMO_CONFIGS[currentSource]);
      return;
    }
    // Re-fetch when source changes so codex AGENTS.md / skills / rules
    // replace the claude resources. Also re-fetch on refreshTick so ⌘R /
    // sidebar Rescan picks up edits to CLAUDE.md, new skills, etc. We keep
    // the previous config visible while the new fetch is in flight — the
    // refresh case shouldn't blank the pane just because a refetch is
    // happening.
    let cancelled = false;
    const reqSource = currentSource;
    window.api.readConfig(reqSource)
      .then(cfg => { if (!cancelled && reqSource === currentSource) setConfig(cfg); })
      .catch(e => {
        if (cancelled) return;
        console.error('readConfig failed', e);
        // Leave config null so the empty state still renders rather than
        // hanging on a stale "loading" overlay.
      });
    return () => { cancelled = true; };
  }, [demoMode, currentSource, refreshTick]);

  // Source flip: reset the prior source's selection / filter / collapsed
  // state — they are conceptually about different resource sets and
  // shouldn't survive a tool switch. Kept separate from the data-fetch
  // effect so a refreshTick bump doesn't clear them.
  useEffect(() => {
    setActive(null);
    setFilter('');
    setCollapsed(loadCollapsed(currentSource));
    if (!demoMode) setConfig(null);
  }, [currentSource, demoMode]);

  // Memoised so a re-render doesn't allocate a new meta object every time and
  // bust the downstream items useMemo.
  const meta = useMemo(() => resolveKindMeta(currentSource), [currentSource]);
  const sourceDef = getSource(currentSource);
  const items: ConfigItem[] = useMemo(() => {
    if (!config) return [];
    const home = config.paths?.home || '';
    const shortPath = (p: string) => (p && home && p.startsWith(home)) ? '~' + p.slice(home.length) : (p || '');
    const arr: ConfigItem[] = [];
    if (config.claudeMd) arr.push({
      key: 'claudeMd', kind: 'rootInstructions',
      name: cleanDisplayText(shortPath(config.claudeMd.path)),
      description: meta['rootInstructions'].short,
      path: cleanDisplayText(config.claudeMd.path),
      content: config.claudeMd.content,
      contentKind: 'md',
      mtime: config.claudeMd.mtime,
    });
    // Defensive Array.isArray — IPC payload shape is "trusted" but the parser
    // could regress, demo data could drift, or a new source might forget a
    // field. Guarding keeps the workspace from throwing on an unexpected
    // shape and falling through to the empty state instead.
    const asArr = <T,>(v: unknown): T[] => Array.isArray(v) ? v as T[] : [];
    // Every user-displayed string from the IPC payload — names, descriptions,
    // path labels, plugin entries — goes through cleanDisplayText so a file
    // whose name carries bidi overrides or control chars can't reorder the
    // visible workspace row. Content (md/json/code body) is sanitised at
    // render time by the cleanDisplayText wrap around `pre`/markdown.
    const cd = cleanDisplayText;
    for (const sk of asArr<any>(config.skills)) arr.push({ key: 'skill:' + sk.name, kind: 'Skill', name: cd(sk.title), description: cd(sk.description), path: cd(sk.path), content: sk.content, contentKind: 'md', mtime: sk.mtime });
    for (const c of asArr<any>(config.commands)) arr.push({ key: 'cmd:' + c.name, kind: 'Command', name: cd(c.name), description: cd(c.description), path: cd(c.path), content: c.content, contentKind: 'md', mtime: c.mtime });
    for (const h of asArr<any>(config.hooks)) arr.push({ key: 'hook:' + h.name, kind: 'Hook', name: cd(h.name), description: '', path: cd(h.path), content: h.content, contentKind: 'code', mtime: h.mtime });
    for (const p of asArr<any>(config.plugins)) arr.push({ key: 'plugin:' + p.name, kind: 'Plugin', name: cd(p.name), description: (p.entries || []).map((e: string) => cd(e)).join(', '), path: cd(p.path), content: '', contentKind: 'dir', entries: (p.entries || []).map((e: string) => cd(e)), mtime: p.mtime });
    if (config.settings) arr.push({
      key: 'settings', kind: 'Settings',
      name: cleanDisplayText(shortPath(config.settings.path)),
      description: meta['Settings'].short,
      path: cleanDisplayText(config.settings.path),
      content: config.settings.content,
      contentKind: 'json',
      mtime: config.settings.mtime,
    });
    return arr;
  }, [config, meta]);

  const filtered = useMemo(() => {
    const q = filter.toLowerCase().trim();
    if (!q) return items;
    return items.filter(it => (it.name + ' ' + it.description + ' ' + it.kind).toLowerCase().includes(q));
  }, [items, filter]);

  const grouped = useMemo(() => {
    const m = new Map<string, ConfigItem[]>();
    for (const k of KIND_ORDER) m.set(k, []);
    for (const it of filtered) {
      if (!m.has(it.kind)) m.set(it.kind, []);
      m.get(it.kind)!.push(it);
    }
    return m;
  }, [filtered]);

  const countsByKind = useMemo(() => {
    const m: Record<string, number> = {};
    for (const it of items) m[it.kind] = (m[it.kind] || 0) + 1;
    return m;
  }, [items]);

  const activeItem = items.find(it => it.key === active);
  const totalCount = items.length;

  return (
    <>
      <div data-pane="list" style={{ width: 'var(--workspace-list-width, 360px)' }} className="flex-shrink-0 border border-border rounded-2xl bg-surface flex flex-col overflow-hidden">
        <div className="px-4 pt-4 pb-3">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-text-muted" />
            <input value={filter} onChange={e => setFilter(e.target.value)} placeholder={tConfigRoot('config.filterPlaceholder')} className="w-full pl-9 pr-3 py-2 bg-surface border border-border rounded-lg text-[13px] outline-none focus:border-accent" />
          </div>
        </div>
        <div className="flex-1 overflow-y-auto px-3 pb-3 space-y-1.5">
          {[...grouped.entries()].map(([kind, arr]) => {
            if (arr.length === 0 && !filter.trim()) return null;
            const isCollapsed = collapsed.has(kind) && !filter.trim();
            const itemMeta = meta[kind as ResourceKindKey];
            const Icon = itemMeta?.icon;
            return (
              <div key={kind}>
                <button
                  onClick={() => toggleGroup(kind)}
                  className="w-full flex items-center gap-1.5 px-2 py-1.5 text-text-muted hover:text-text rounded-md transition text-left"
                >
                  <ChevronRight className={cn('w-3 h-3 transition-transform duration-150 flex-shrink-0', !isCollapsed && 'rotate-90')} />
                  {Icon && <Icon className="w-3 h-3 flex-shrink-0" />}
                  <span className="text-[10px] uppercase tracking-wider font-semibold">{itemMeta?.pluralLabel || kind}</span>
                  <span className="text-[10px] text-text-muted tabular-nums">{arr.length}</span>
                </button>
                {!isCollapsed && (
                  <div className="flex flex-col gap-1 mt-1 mb-2">
                    {arr.map(it => (
                      <button key={it.key} onClick={() => setActive(it.key)} className={cn(
                        'text-left px-3 py-2 rounded-lg transition border',
                        active === it.key ? 'bg-accent-soft border-accent/30 text-accent' : 'bg-surface border-border-soft hover:border-border'
                      )}>
                        <div className="text-[12px] font-medium truncate">{it.name}</div>
                        {it.description && <div className="text-[11px] text-text-muted mt-0.5 line-clamp-2">{it.description}</div>}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      <Resizer cssVar="--workspace-list-width" storageKey="workspace-list-width" min={260} max={520} side="left" />

      <main data-pane="detail" className="flex-1 min-w-0 overflow-y-auto bg-surface border border-border rounded-2xl">
        {!activeItem ? (
          <WorkspaceOverview
            totalCount={totalCount}
            countsByKind={countsByKind}
            meta={meta}
            sourceDef={sourceDef}
            onPick={(kind) => {
              if (collapsed.has(kind)) toggleGroup(kind);
              const first = items.find(it => it.kind === kind);
              if (first) setActive(first.key);
            }}
          />
        ) : (
          <ResourceDetail
            item={activeItem}
            meta={meta}
            showSource={showSource}
            onToggleSource={() => setShowSource(v => !v)}
            onBack={() => setActive(null)}
            onStatus={onStatus}
          />
        )}
      </main>
    </>
  );
}

function WorkspaceOverview({
  totalCount,
  countsByKind,
  meta,
  sourceDef,
  onPick,
}: {
  totalCount: number;
  countsByKind: Record<string, number>;
  meta: Record<ResourceKindKey, FullKindMeta>;
  sourceDef: ReturnType<typeof getSource>;
  onPick: (kind: string) => void;
}) {
  const { t } = useTranslationLocal();
  return (
    <div className="px-8 py-7 max-w-[820px] mx-auto">
      <div className="mb-7">
        <div className="text-[11px] uppercase tracking-wider font-semibold text-text-muted mb-1.5">{t('config.workspaceLabel')}</div>
        <h1 className="text-[22px] font-bold text-text leading-tight mb-1">{sourceDef.workspaceRoot}</h1>
        <p className="text-[13px] text-text-muted">{sourceDef.workspaceBlurb}</p>
      </div>

      {/* Summary strip — at-a-glance scale of the environment */}
      <div className="flex flex-wrap gap-x-5 gap-y-2 mb-7 pb-5 border-b border-border-soft">
        {KIND_ORDER.map(kind => {
          const n = countsByKind[kind] || 0;
          return (
            <div key={kind} className="flex items-baseline gap-1.5">
              <span className="text-[15px] font-semibold tabular-nums text-text">{n}</span>
              <span className="text-[12px] text-text-muted">{meta[kind].pluralLabel}</span>
            </div>
          );
        })}
        <div className="ml-auto text-[11.5px] text-text-muted tabular-nums self-end">{totalCount} resources total</div>
      </div>

      {/* Resource cards — these are the primary scanning grid */}
      <div className="grid grid-cols-2 gap-3">
        {KIND_ORDER.map(kind => {
          const cardMeta = meta[kind];
          const Icon = cardMeta.icon;
          const n = countsByKind[kind] || 0;
          const empty = n === 0;
          return (
            <button
              key={kind}
              onClick={() => !empty && onPick(kind)}
              disabled={empty}
              className={cn(
                'group text-left px-4 py-3.5 rounded-xl border transition-[background-color,border-color] duration-200 ease-out',
                empty
                  ? 'border-border-soft/50 bg-muted/10 opacity-60 cursor-not-allowed'
                  : 'border-border-soft bg-surface hover:border-accent/30 hover:bg-accent-soft/30 cursor-pointer'
              )}
            >
              <div className="flex items-center justify-between gap-2 mb-1.5">
                <div className="flex items-center gap-2">
                  <Icon className={cn('w-4 h-4', empty ? 'text-text-muted' : 'text-accent')} />
                  <span className="text-[13.5px] font-semibold text-text">{cardMeta.pluralLabel}</span>
                </div>
                <span className="text-[16px] font-semibold tabular-nums text-text">{n}</span>
              </div>
              <div className="text-[12px] text-text-muted leading-snug">{cardMeta.short}</div>
              {!empty && (
                <div className="flex items-center gap-1 text-[10.5px] uppercase tracking-wider font-semibold text-accent/70 group-hover:text-accent mt-2 transition">
                  Browse <ArrowRight className="w-3 h-3" />
                </div>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function ResourceDetail({
  item,
  meta,
  showSource,
  onToggleSource,
  onBack,
  onStatus,
}: {
  item: ConfigItem;
  meta: Record<ResourceKindKey, FullKindMeta>;
  showSource: boolean;
  onToggleSource: () => void;
  onBack: () => void;
  onStatus?: (msg: string) => void;
}) {
  const { t } = useTranslationLocal();
  const itemMeta = meta[item.kind as ResourceKindKey];
  const Icon = itemMeta?.icon;
  const mtimeIso = item.mtime ? new Date(item.mtime).toISOString() : null;
  const hasContent = item.contentKind !== 'dir' && !!item.content;
  const hasEntries = item.contentKind === 'dir' && (item.entries?.length || 0) > 0;

  return (
    <div className="px-8 py-7 max-w-[820px] mx-auto">
      {/* Breadcrumb back to overview */}
      <button onClick={onBack} className="flex items-center gap-1 text-[11.5px] text-text-muted hover:text-text transition mb-4">
        <ChevronLeft className="w-3.5 h-3.5" /> {t('config.workspaceLabel')}
      </button>

      {/* Resource hero — icon + kind chip + name */}
      <div className="flex items-start gap-3 mb-5">
        {Icon && (
          <div className="w-10 h-10 rounded-xl bg-accent-soft border border-accent/15 flex items-center justify-center flex-shrink-0">
            <Icon className="w-5 h-5 text-accent" />
          </div>
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 mb-0.5">
            <span className="text-[10.5px] uppercase tracking-wider font-semibold text-text-muted">{itemMeta?.pluralLabel || item.kind}</span>
          </div>
          <h1 className="selectable text-[19px] font-semibold text-text break-words leading-tight">{item.name}</h1>
        </div>
      </div>

      {/* Metadata grid — Description / Path / Last Modified / Type */}
      <div className="rounded-xl border border-border-soft bg-muted/15 px-5 py-4 mb-4 space-y-3">
        {(item.description || itemMeta?.short) && (
          <MetaRow label={t('config.description')}>
            <div className="text-[12.5px] text-text leading-snug">{item.description || itemMeta?.short}</div>
          </MetaRow>
        )}
        {itemMeta?.hint && (
          <MetaRow label={t('config.purpose')}>
            <div className="text-[12.5px] text-text-muted leading-snug">{itemMeta.hint}</div>
          </MetaRow>
        )}
        <MetaRow label={t('config.path')}>
          <div className="selectable text-[12px] font-mono text-text break-all">{item.path}</div>
        </MetaRow>
        <MetaRow label={t('config.type')}>
          <div className="text-[12px] text-text">
            {item.contentKind === 'md' && t('config.kind.md')}
            {item.contentKind === 'json' && t('config.kind.json')}
            {item.contentKind === 'code' && t('config.kind.code')}
            {item.contentKind === 'dir' && t('config.kind.dir', { n: item.entries?.length || 0 })}
          </div>
        </MetaRow>
        {mtimeIso && (
          <MetaRow label={t('config.lastModified')}>
            <div className="text-[12px] text-text tabular-nums">{fmtTime(mtimeIso)}</div>
          </MetaRow>
        )}
      </div>

      {/* Actions */}
      <div className="flex flex-wrap gap-2 mb-5">
        <button
          onClick={async () => {
            try { await window.api.openConfigFile(item.path); }
            catch (e: any) { if (onStatus) { onStatus('Open failed: ' + (e?.message || e)); setTimeout(() => onStatus(''), 3000); } }
          }}
          className="px-3 py-1.5 bg-surface border border-border rounded-lg text-[11.5px] hover:bg-muted flex items-center gap-1.5">
          <ExternalLink className="w-3 h-3" /> {t('config.openInApp')}
        </button>
        <button
          onClick={async () => {
            try { await window.api.revealInFinder(item.path); }
            catch (e: any) { if (onStatus) { onStatus('Reveal failed: ' + (e?.message || e)); setTimeout(() => onStatus(''), 3000); } }
          }}
          className="px-3 py-1.5 bg-surface border border-border rounded-lg text-[11.5px] hover:bg-muted flex items-center gap-1.5">
          <FolderOpen className="w-3 h-3" /> {t('config.reveal')}
        </button>
        {(hasContent || hasEntries) && (
          <button onClick={onToggleSource} className={cn(
            'ml-auto px-3 py-1.5 rounded-lg text-[11.5px] flex items-center gap-1.5 border transition',
            showSource ? 'bg-accent-soft border-accent/30 text-accent' : 'bg-surface border-border hover:bg-muted'
          )}>
            <Code2 className="w-3 h-3" /> {showSource ? t('config.hideSource') : t('config.viewSource')}
          </button>
        )}
      </div>

      {/* Source — hidden by default per v10 P4 */}
      {showSource && (hasContent || hasEntries) && (
        <div>
          {item.contentKind === 'md' && (
            <div className="markdown-body bg-surface border border-border-soft rounded-xl p-5 shadow-soft" dangerouslySetInnerHTML={{ __html: renderMarkdown(cleanDisplayText(item.content)) }} />
          )}
          {item.contentKind === 'json' && (
            <pre className="bg-muted border border-border-soft rounded-xl p-5 text-[12px] font-mono overflow-x-auto whitespace-pre">{cleanDisplayText(prettyJson(item.content))}</pre>
          )}
          {item.contentKind === 'code' && (
            <pre className="bg-muted border border-border-soft rounded-xl p-5 text-[12px] font-mono overflow-x-auto whitespace-pre">{cleanDisplayText(item.content)}</pre>
          )}
          {item.contentKind === 'dir' && (
            <div className="grid grid-cols-3 gap-2">
              {(item.entries || []).map(name => (
                <div key={name} className="bg-muted border border-border-soft rounded-lg px-3 py-2 text-[12px] font-mono">{name}</div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function MetaRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[110px_1fr] gap-3">
      <div className="text-[10.5px] uppercase tracking-wider font-semibold text-text-muted pt-0.5">{label}</div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

function prettyJson(s: string) {
  try { return JSON.stringify(JSON.parse(s), null, 2); }
  catch { return s; }
}
