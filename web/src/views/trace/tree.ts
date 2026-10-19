import type { RunSpans, Span, SpanKind } from '../../../../src/dashboard/types';
import type { IconName } from '../../routes';

// the pure parts of the waterfall: the tree of the spans, the rows that show, and the place of each bar. they have
// no react, so a test checks them with plain data.

export interface SpanRow {
  span: Span;
  depth: number;
  childCount: number;
}

// the server sorts the spans by startMs. a child keeps that order under its parent. a span whose parent is missing,
// or that sits in a loop of parents, becomes a root, so the waterfall shows every span the server gave.
export function spanTree(spans: Span[]): { roots: Span[]; children: Map<string, Span[]> } {
  const sorted = spans.map((span, index) => ({ span, index })).sort((a, b) => a.span.startMs - b.span.startMs || a.index - b.index);
  const ids = new Set(spans.map((span) => span.id));
  const children = new Map<string, Span[]>();
  const roots: Span[] = [];
  for (const { span } of sorted) {
    if (span.parentId !== null && span.parentId !== span.id && ids.has(span.parentId)) {
      const list = children.get(span.parentId) ?? [];
      list.push(span);
      children.set(span.parentId, list);
    } else roots.push(span);
  }
  // a loop of parents has no root, so its spans are not reached from the roots. the first of them becomes a root.
  const reached = new Set<string>();
  const walk = (span: Span) => {
    const stack = [span];
    while (stack.length) {
      const next = stack.pop()!;
      if (reached.has(next.id)) continue;
      reached.add(next.id);
      stack.push(...(children.get(next.id) ?? []));
    }
  };
  roots.forEach(walk);
  for (const { span } of sorted) {
    if (reached.has(span.id)) continue;
    roots.push(span);
    walk(span);
  }
  return { roots, children };
}

// the rows in the order of the tree, with the subtrees of the collapsed spans left out. the walk uses a stack and
// not recursion, because a run can have thousands of spans.
export function visibleRows(spans: Span[], collapsed: ReadonlySet<string>): SpanRow[] {
  const { roots, children } = spanTree(spans);
  const rows: SpanRow[] = [];
  const seen = new Set<string>();
  const stack: Array<{ span: Span; depth: number }> = [...roots].reverse().map((span) => ({ span, depth: 0 }));
  while (stack.length) {
    const { span, depth } = stack.pop()!;
    if (seen.has(span.id)) continue;
    seen.add(span.id);
    const kids = children.get(span.id) ?? [];
    rows.push({ span, depth, childCount: kids.length });
    if (collapsed.has(span.id)) continue;
    for (let i = kids.length - 1; i >= 0; i--) stack.push({ span: kids[i]!, depth: depth + 1 });
  }
  return rows;
}

// the length of the axis in ms. an open run grows to now. a span that the server ends after the run end still fits.
export function totalMs(trace: RunSpans, now: number): number {
  const sinceStart = Math.max(0, now - Date.parse(trace.startedAt));
  const base = trace.durationMs ?? sinceStart;
  const latest = trace.spans.reduce((max, span) => Math.max(max, span.endMs ?? 0), 0);
  return Math.max(base, latest, 0);
}

// the bar of a span in percent of the axis. an open span is drawn to now. a run of zero length puts each bar at the
// start, and the css gives each bar a width of at least 2px, so it never divides by zero and no bar vanishes.
export function barGeometry(span: Span, total: number, nowMs: number): { left: number; width: number } {
  if (total <= 0) return { left: 0, width: 0 };
  const start = Math.min(Math.max(span.startMs, 0), total);
  const end = Math.min(Math.max(span.endMs ?? nowMs, start), total);
  const left = (start / total) * 100;
  const width = ((end - start) / total) * 100;
  return { left: round(left), width: round(Math.min(width, 100 - left)) };
}

const round = (value: number) => Math.round(value * 1000) / 1000;

// the ticks of the time axis: the start, two marks between, and the end.
export function axisTicks(total: number): Array<{ at: number; ms: number }> {
  return [0, 1 / 3, 2 / 3, 1].map((share) => ({ at: round(share * 100), ms: Math.round(share * total) }));
}

export const KIND_ICON: Record<SpanKind, IconName> = {
  run: 'run',
  model: 'agent',
  tool: 'integration',
  review: 'policy',
  approval: 'approval',
  subagent: 'session',
  mcp: 'connection',
  google: 'google',
  browser: 'browser',
  sandbox: 'sandbox',
};

export function kindIcon(kind: string): IconName {
  return KIND_ICON[kind as SpanKind] ?? 'trace';
}

// a span is an error when it has an error text, or its status word is an error word.
const ERROR_WORDS = new Set(['failed', 'error', 'invalid', 'timeout', 'killed', 'crashed']);

export function isErrorSpan(span: Span): boolean {
  return span.error !== null || (span.status !== null && (ERROR_WORDS.has(span.status) || /^[45]\d\d$/.test(span.status)));
}

// the run of a span: the nearest run or sub-agent span above it. the spans of a child run sit under their sub-agent
// span, so an inspector loads the row from the child run and not from the run of the page.
export function runOfSpan(span: Span, byId: ReadonlyMap<string, Span>, fallback: string): string {
  let at: Span | undefined = span;
  const seen = new Set<string>();
  while (at && !seen.has(at.id)) {
    seen.add(at.id);
    if (at.ref.kind === 'run') return at.ref.runId;
    if (at.ref.kind === 'subagent' && at !== span) return at.ref.childRunId;
    at = at.parentId ? byId.get(at.parentId) : undefined;
  }
  return fallback;
}

// the run ids in a trace: the run of the page and each child run. a stream message about any of them reloads it.
export function runIdsOf(trace: RunSpans): Set<string> {
  const ids = new Set([trace.runId]);
  for (const span of trace.spans) {
    if (span.ref.kind === 'run') ids.add(span.ref.runId);
    if (span.ref.kind === 'subagent') ids.add(span.ref.childRunId);
  }
  return ids;
}

export function traceHref(runId: string, spanId?: string): string {
  return `#/trace/${encodeURIComponent(runId)}${spanId ? `/${encodeURIComponent(spanId)}` : ''}`;
}
