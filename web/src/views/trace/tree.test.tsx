import { describe, expect, it } from 'vitest';
import { runOneSpans } from './fixture';
import { axisTicks, barGeometry, fittingTicks, runOfSpan, tickLabel, totalMs, visibleRows } from './tree';

describe('the span tree', () => {
  it('keeps every span: an orphan and a loop of parents become roots', () => {
    const [run, model] = runOneSpans().spans;
    const orphan = { ...model!, id: 'tool:7', parentId: 'model:gone', startMs: 5 };
    const a = { ...model!, id: 'a', parentId: 'b', startMs: 6 };
    const b = { ...model!, id: 'b', parentId: 'a', startMs: 7 };
    const rows = visibleRows([run!, model!, orphan, a, b], new Set());
    expect(rows.map((row) => `${row.depth}:${row.span.id}`)).toEqual(['0:run:run-1', '1:model:1', '0:tool:7', '0:a', '1:b']);
  });

  it('handles thousands of spans in a deep chain without recursion', () => {
    const [run] = runOneSpans().spans;
    const chain = Array.from({ length: 5000 }, (_, i) => ({ ...run!, id: `s${i}`, parentId: i ? `s${i - 1}` : null, startMs: i }));
    const rows = visibleRows(chain, new Set());
    expect(rows).toHaveLength(5000);
    expect(rows.at(-1)!.depth).toBe(4999);
    expect(visibleRows(chain, new Set(['s0']))).toHaveLength(1);
  });

  it('never divides by zero, and clamps a bar to the axis', () => {
    const [run] = runOneSpans().spans;
    expect(barGeometry(run!, 0, 0)).toEqual({ left: 0, width: 0 });
    expect(barGeometry({ ...run!, startMs: 900, endMs: 5000 }, 1000, 0)).toEqual({ left: 90, width: 10, cut: true });
    expect(barGeometry({ ...run!, startMs: 500, endMs: null }, 1000, 750)).toEqual({ left: 50, width: 25 });
    expect(axisTicks(0).map((tick) => tick.ms)).toEqual([0, 0, 0, 0]);
    expect(axisTicks(900).map((tick) => tick.ms)).toEqual([0, 300, 600, 900]);
  });

  it('scales the axis to the run and not to an approval that ends long after it', () => {
    const trace = runOneSpans();
    const [run] = trace.spans;
    const approval = { ...run!, id: 'approval:1', kind: 'approval' as const, parentId: run!.id, startMs: 10, endMs: 1_800_000 };
    const total = totalMs({ ...trace, spans: [...trace.spans, approval] }, 0);
    expect(total).toBe(totalMs(trace, 0));
    expect(barGeometry(approval, total, 0).cut).toBe(true);
  });

  it('labels the ticks short and leaves out a label that would overlap', () => {
    expect(tickLabel(600_000)).toBe('10 min');
    expect(tickLabel(630_000)).toBe('10.5 min');
    expect(tickLabel(1500)).toBe('1.5 s');
    expect(tickLabel(0)).toBe('0 ms');
    const ticks = axisTicks(1_800_000);
    expect(fittingTicks(ticks, 600)).toEqual([true, true, true, true]);
    expect(fittingTicks(ticks, 160)).toEqual([true, false, false, true]);
    expect(fittingTicks(ticks, 0)).toEqual([true, true, true, true]);
  });

  it('grows an open run to now', () => {
    const trace = { ...runOneSpans(), endedAt: null, durationMs: null };
    expect(totalMs(trace, Date.parse(trace.startedAt) + 4000)).toBe(4000);
  });

  it('finds the run of a span under a sub-agent', () => {
    const { spans } = runOneSpans();
    const byId = new Map(spans.map((span) => [span.id, span]));
    expect(runOfSpan(byId.get('model:99')!, byId, 'run-1')).toBe('run-child');
    expect(runOfSpan(byId.get('tool:1')!, byId, 'x')).toBe('run-1');
    expect(runOfSpan(byId.get('subagent:call-sub')!, byId, 'x')).toBe('run-1');
  });
});
