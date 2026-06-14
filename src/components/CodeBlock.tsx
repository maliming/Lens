// Code / JSON display block used in tool messages. Auto-detects valid JSON
// (whole-body OR after a `[Tool: Name]` header) and renders with syntax
// highlighting. Falls back to plain monospace for everything else — log
// output, file contents, anything that isn't JSON.

import React from 'react';

type Props = {
  text: string;
  maxHeight?: number;
};

export function CodeBlock({ text, maxHeight }: Props) {
  const { header, body } = splitToolHeader(text);
  const parsed = tryParseJson(body);

  return (
    <div style={maxHeight ? { maxHeight, overflowY: 'auto' } : undefined}>
      {header && (
        <div className="text-[10.5px] uppercase tracking-wider font-semibold text-emerald-700 dark:text-emerald-300 mb-1.5">
          {header}
        </div>
      )}
      {parsed != null ? (
        <pre className="whitespace-pre overflow-x-auto text-[11px] leading-[1.55] font-mono">
          {renderJson(parsed, 0)}
        </pre>
      ) : (
        <pre className="whitespace-pre overflow-x-auto text-[11px] leading-[1.55] font-mono">
          {body}
        </pre>
      )}
    </div>
  );
}

function splitToolHeader(text: string): { header: string | null; body: string } {
  const m = text.match(/^(\[Tool:\s*[^\]]+\])\s*\n([\s\S]*)$/);
  if (m) return { header: m[1], body: m[2] };
  return { header: null, body: text };
}

function tryParseJson(s: string): unknown | null {
  const t = s.trim();
  if (t.length < 2) return null;
  const a = t[0];
  const b = t[t.length - 1];
  if (!((a === '{' && b === '}') || (a === '[' && b === ']'))) return null;
  try { return JSON.parse(t); } catch { return null; }
}

// Token color classes — tuned for both light + dark themes via Tailwind palette.
const C = {
  key: 'text-sky-700 dark:text-sky-300',
  str: 'text-emerald-700 dark:text-emerald-300',
  num: 'text-violet-700 dark:text-violet-300',
  bool: 'text-rose-700 dark:text-rose-300',
  nul: 'text-rose-700 dark:text-rose-300',
  punct: 'text-text-muted',
};

function renderJson(value: unknown, depth: number): React.ReactNode {
  const indent = '  '.repeat(depth);
  const next = '  '.repeat(depth + 1);

  if (value === null) return <span className={C.nul}>null</span>;
  if (typeof value === 'string') return <span className={C.str}>{JSON.stringify(value)}</span>;
  if (typeof value === 'number') return <span className={C.num}>{String(value)}</span>;
  if (typeof value === 'boolean') return <span className={C.bool}>{String(value)}</span>;

  if (Array.isArray(value)) {
    if (value.length === 0) return <><span className={C.punct}>[]</span></>;
    return (
      <>
        <span className={C.punct}>[</span>
        {'\n'}
        {value.map((v, i) => (
          <React.Fragment key={i}>
            {next}{renderJson(v, depth + 1)}
            <span className={C.punct}>{i < value.length - 1 ? ',' : ''}</span>
            {'\n'}
          </React.Fragment>
        ))}
        {indent}<span className={C.punct}>]</span>
      </>
    );
  }

  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return <span className={C.punct}>{'{}'}</span>;
    return (
      <>
        <span className={C.punct}>{'{'}</span>
        {'\n'}
        {entries.map(([k, v], i) => (
          <React.Fragment key={k}>
            {next}
            <span className={C.key}>{JSON.stringify(k)}</span>
            <span className={C.punct}>{': '}</span>
            {renderJson(v, depth + 1)}
            <span className={C.punct}>{i < entries.length - 1 ? ',' : ''}</span>
            {'\n'}
          </React.Fragment>
        ))}
        {indent}<span className={C.punct}>{'}'}</span>
      </>
    );
  }
  return String(value);
}
