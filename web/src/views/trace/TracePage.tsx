import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import type { RunSpans, Span, StreamMessage } from '../../../../src/dashboard/types';
import { useApi } from '../../api';
import { ms, tokens, usd } from '../../format';
import { Icon } from '../../icons';
import type { RouteProps } from '../../routes';
import { groupLabel } from '../../shell/model';
import { setPrefs, useDevMode } from '../../shell/prefs';
import { Button, ButtonLink, DetailsPanel, EmptyState, isNotFound, NotFound, Page, Skeleton, Stat, Stats, Status, Table, type Column } from '../../ui';
import { SpanInspector } from './inspectors';
import { axisTicks, barGeometry, fittingTicks, isErrorSpan, kindIcon, runIdsOf, tickLabel, totalMs, traceHref, visibleRows, type SpanRow } from './tree';
import './trace.css';

// a new span in the hash keeps the page, but a visit to another page and back mounts it again, so the last spans of
// each run and the collapsed subtrees live here. the page then draws the waterfall at once while it loads the spans
// again.
const lastSpans = new Map<string, RunSpans>();
const collapsedOf = new Map<string, Set<string>>();

// the tests start each case with an empty memory, so a trace of one test never draws in the next one.
export function forgetTraces(): void {
  lastSpans.clear();
  collapsedOf.clear();
}

// a message about the run or one of its child runs. a run row does not name its parent, so a new sub-agent run that
// is not in the trace reloads an open trace one time. when the reload does not show it, it belongs to another run, and
// its later messages are left out.
function aboutTrace(message: StreamMessage, ids: ReadonlySet<string>, foreign: Set<string>): boolean {
  switch (message.kind) {
    case 'model_call':
      return ids.has(message.call.runId ?? '');
    case 'tool_call':
      return ids.has(message.call.runId);
    case 'browser_step':
      return ids.has(message.step.runId ?? '');
    case 'approval':
      return ids.has(message.approval.runId);
    case 'policy':
      return ids.has(message.decision.runId);
    case 'run': {
      if (ids.has(message.run.id)) return true;
      if (message.run.trigger !== 'subagent' || foreign.has(message.run.id)) return false;
      foreign.add(message.run.id);
      return true;
    }
    default:
      return false;
  }
}

// the clock of an open trace ticks each second, so an open span grows. an ended trace never ticks.
function useNow(ticking: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!ticking) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [ticking]);
  return now;
}

function DevModeNote() {
  return (
    <div className="trace-note" role="note">
      <span>Developer mode is off. The trace still shows here, and the nav shows the developer pages when it is on.</span>
      <Button size="sm" onClick={() => setPrefs({ devMode: true })}>
        Turn on developer mode
      </Button>
    </div>
  );
}

// the time axis over the bars. it measures its own width, so a tick label that would overlap the label before it is
// left out, for example when the details panel makes the table narrow.
function Axis({ total }: { total: number }) {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const element = box.current;
    if (!element) return;
    setWidth(element.clientWidth);
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => setWidth(element.clientWidth));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const ticks = axisTicks(total);
  const shown = fittingTicks(ticks, width);
  return (
    <div className="trace-axis" ref={box}>
      <span className="sr-only">Timeline</span>
      {ticks.map((tick, index) =>
        shown[index] ? (
          <span
            key={index}
            className={['trace-tick', index === 0 ? 'is-first' : '', index === ticks.length - 1 ? 'is-last' : ''].filter(Boolean).join(' ')}
            style={{ left: `${tick.at}%` }}
            aria-hidden="true"
          >
            {tickLabel(tick.ms)}
          </span>
        ) : null,
      )}
    </div>
  );
}

function spanDuration(span: Span): string {
  return span.endMs === null ? 'running' : ms(span.endMs - span.startMs);
}

function Waterfall({ trace, spanId }: { trace: RunSpans; spanId: string | null }) {
  const open = trace.endedAt === null;
  const now = useNow(open);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => collapsedOf.get(trace.runId) ?? new Set());
  const rows = useMemo(() => visibleRows(trace.spans, collapsed), [trace.spans, collapsed]);
  const byId = useMemo(() => new Map(trace.spans.map((span) => [span.id, span])), [trace.spans]);
  const total = totalMs(trace, now);
  const nowMs = Math.max(0, now - Date.parse(trace.startedAt));
  const errors = useMemo(() => trace.spans.filter(isErrorSpan).length, [trace.spans]);
  const table = useRef<HTMLDivElement>(null);

  const toggle = (id: string) => {
    const next = new Set(collapsed);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    collapsedOf.set(trace.runId, next);
    setCollapsed(next);
  };

  // a page that opens with a span in its hash puts the focus on the selected row, so the arrow keys go on from there.
  useEffect(() => {
    const active = document.activeElement;
    if (active && active !== document.body) return;
    table.current?.querySelector<HTMLElement>('tr[aria-current="true"]')?.focus({ preventScroll: true });
  }, []);

  const columns: Array<Column<SpanRow>> = [
    {
      key: 'span',
      header: 'Span',
      cell: ({ span, depth, childCount }) => {
        const shut = collapsed.has(span.id);
        return (
          <div className="trace-name" data-testid={`span-${span.id}`} data-depth={depth} style={{ '--trace-depth': depth } as CSSProperties}>
            {childCount ? (
              <button
                type="button"
                className="trace-toggle"
                aria-expanded={!shut}
                aria-label={`${shut ? 'Expand' : 'Collapse'} ${span.label}, ${childCount} ${childCount === 1 ? 'child' : 'children'}`}
                onClick={() => toggle(span.id)}
              >
                <Icon name={shut ? 'chevron-right' : 'chevron-down'} size={14} />
              </button>
            ) : (
              <span className="trace-toggle-space" />
            )}
            <Icon name={kindIcon(span.kind)} size={14} />
            <span className="trace-kind">{span.kind}</span>
            <span className="trace-label" title={span.label}>
              {span.label}
            </span>
          </div>
        );
      },
    },
    {
      key: 'status',
      header: 'Status',
      cell: ({ span }) => (span.status ? <Status value={span.status} /> : span.error ? <Status value="error" /> : span.endMs === null ? <Status value="running" /> : <span className="muted">-</span>),
    },
    { key: 'duration', header: 'Duration', align: 'end', cell: ({ span }) => spanDuration(span) },
    // the usage columns hide when the waterfall is narrow, for example next to an open details panel. trace.css does
    // that with a container query on the trace-usage class.
    {
      key: 'cost',
      header: <span className="trace-usage">Cost</span>,
      align: 'end',
      hideBelow: 'md',
      cell: ({ span }) => <span className="trace-usage">{span.costUsd === null ? '-' : usd(span.costUsd)}</span>,
    },
    {
      key: 'tokens',
      header: <span className="trace-usage">Tokens in / out</span>,
      align: 'end',
      hideBelow: 'md',
      cell: ({ span }) => (
        <span className="trace-usage">
          {span.inputTokens === null && span.outputTokens === null ? '-' : `${tokens(span.inputTokens ?? 0)} / ${tokens(span.outputTokens ?? 0)}`}
        </span>
      ),
    },
    {
      key: 'bar',
      header: <Axis total={total} />,
      hideBelow: 'sm',
      width: '36%',
      cell: ({ span }) => {
        const bar = barGeometry(span, total, nowMs);
        const error = isErrorSpan(span);
        // a short cut bar keeps its point inside the track, even when the span starts at the end of the axis.
        const left = bar.cut && bar.width < 5 ? `min(${bar.left}%, calc(100% - 8px))` : `${bar.left}%`;
        return (
          <div className="trace-track">
            <span
              className={['trace-bar', error ? 'is-error' : '', span.endMs === null ? 'is-open' : '', bar.cut ? 'is-cut' : ''].filter(Boolean).join(' ')}
              style={{ left, width: `${bar.width}%` }}
              title={`${span.label}: ${ms(span.startMs)} to ${span.endMs === null ? 'now' : ms(span.endMs)}${bar.cut ? ', past the end of the axis' : ''}`}
            />
          </div>
        );
      },
    },
  ];

  const selected = spanId ? byId.get(spanId) : undefined;
  return (
    <>
      <Stats label="trace summary">
        <Stat label="Duration" value={trace.durationMs === null ? `${ms(nowMs)} so far` : ms(trace.durationMs)} note={open ? <Status value="running" /> : undefined} />
        <Stat label="Cost" value={usd(trace.costUsd)} />
        <Stat label="Spans" value={trace.spans.length} />
        <Stat label="Errors" value={errors} />
      </Stats>
      <div className="trace-waterfall" ref={table}>
        {spanId ? null : <p className="muted trace-hint">Select a span to inspect it.</p>}
        <Table
          label="spans"
          dense
          columns={columns}
          rows={rows}
          rowKey={(row) => row.span.id}
          selected={spanId}
          onSelect={(row) => {
            location.hash = traceHref(trace.runId, row.span.id);
          }}
          rowClassName={(row) => (isErrorSpan(row.span) ? 'trace-row-error' : undefined)}
          empty={<EmptyState icon="trace" title="This run has no spans." />}
        />
      </div>
      {/* the panel shows only for a span, so the waterfall has the whole width until the owner picks one. */}
      {spanId ? (
        <DetailsPanel title={selected ? `${selected.kind} ${selected.label}` : 'Span'} openKey={spanId} onClose={() => (location.hash = traceHref(trace.runId))}>
          {selected ? (
            <SpanInspector key={selected.id} span={selected} runId={trace.runId} spans={trace.spans} byId={byId} />
          ) : (
            <EmptyState icon="trace" title="This span is not in the trace.">
              The span <code>{spanId}</code> is not one of the {trace.spans.length} spans of this run.
            </EmptyState>
          )}
        </DetailsPanel>
      ) : null}
    </>
  );
}

export function TracePage({ params }: RouteProps) {
  const runId = params.runId ?? '';
  const spanId = params.spanId || null;
  const devMode = useDevMode();
  const watch = useRef<{ ids: ReadonlySet<string>; open: boolean }>({ ids: new Set([runId]), open: true });
  const foreign = useRef(new Set<string>());
  const loaded = useApi<RunSpans>(
    `/api/runs/${encodeURIComponent(runId)}/spans`,
    (message) => watch.current.open && aboutTrace(message, watch.current.ids, foreign.current),
  );
  if (loaded.data) lastSpans.set(runId, loaded.data);
  const trace = loaded.error ? undefined : (loaded.data ?? lastSpans.get(runId));
  if (trace) watch.current = { ids: runIdsOf(trace), open: trace.endedAt === null };
  // the crumbs follow the same trail as the run page, with the run page as the last step.
  const runHref = `#/runs/${encodeURIComponent(runId)}`;
  return (
    <Page
      title="Trace"
      width="full"
      subtitle={<>run {runId}</>}
      crumbs={[
        { label: groupLabel('dev'), href: '#/runs' },
        { label: 'Runs', href: '#/runs' },
        { label: `Run ${runId.slice(0, 8)}`, href: runHref },
      ]}
      actions={
        <>
          <ButtonLink size="sm" icon="run" href={runHref}>
            Run page
          </ButtonLink>
          <ButtonLink size="sm" icon="log" href={`#/logs?runId=${encodeURIComponent(runId)}`}>
            Logs
          </ButtonLink>
        </>
      }
    >
      {devMode ? null : <DevModeNote />}
      {loaded.error ? (
        isNotFound(loaded.error) ? (
          <NotFound icon="trace" what="trace">
            <a href="#/runs">Go to all runs</a>
          </NotFound>
        ) : (
          <p className="error-box">Could not load: {loaded.error}</p>
        )
      ) : trace ? (
        <Waterfall trace={trace} spanId={spanId} />
      ) : (
        <Skeleton lines={6} />
      )}
    </Page>
  );
}
