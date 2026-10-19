// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RunSpans, Span } from '../../../../src/dashboard/types';
import { seedDashboard } from '../../../../test/seed';
import { setPrefs } from '../../shell/prefs';
import { FakeEventSource, inMain, installEventSource, json, openApp, stubFetch, type StubRoutes } from '../../testing';
import { runOneSpans } from './fixture';
import { barGeometry, isErrorSpan, kindIcon, runIdsOf, traceHref, visibleRows } from './tree';

// the edge cases of the trace: a span kind from a newer server, a server error that is not a 404, the keys of the
// waterfall, and the reload rule of an open trace.

installEventSource();

let seeded: Awaited<ReturnType<typeof seedDashboard>>;
let spans: RunSpans;

const spansCalls = (calls: Array<{ url: string }>) => calls.filter((call) => call.url === '/api/runs/run-1/spans');

function open(extra: StubRoutes = {}) {
  return stubFetch(seeded.dashboard, {
    'GET /api/runs/:id/spans': ({ params }) => (params.id === 'run-1' ? spans : json({ error: 'run not found' }, 404)),
    ...extra,
  });
}

beforeEach(async () => {
  setPrefs({ theme: 'system', devMode: true, detailsHidden: false });
  spans = runOneSpans();
  seeded = await seedDashboard();
});
afterEach(() => cleanup());

describe('the pure parts of the trace', () => {
  it('gives an icon and no crash for a kind it does not know', () => {
    expect(kindIcon('calendar')).toBe('trace');
    expect(kindIcon('model')).toBe('agent');
  });

  it('counts the http and exit words of a span as errors, and the good words not', () => {
    const [run] = runOneSpans().spans;
    const of = (status: string | null, error: string | null = null): Span => ({ ...run!, status, error });
    for (const bad of ['failed', 'error', 'timeout', 'killed', '404', '500', '429']) expect(isErrorSpan(of(bad)), bad).toBe(true);
    for (const good of ['ok', 'completed', '200', '204', '302', 'approved', null]) expect(isErrorSpan(of(good)), String(good)).toBe(false);
    expect(isErrorSpan(of('ok', 'it broke'))).toBe(true);
  });

  it('clamps a span that starts before the run or after its end', () => {
    const [run] = runOneSpans().spans;
    expect(barGeometry({ ...run!, startMs: -50, endMs: 100 }, 1000, 0)).toEqual({ left: 0, width: 10 });
    expect(barGeometry({ ...run!, startMs: 2000, endMs: 3000 }, 1000, 0)).toEqual({ left: 100, width: 0 });
    // an open span with a clock behind its start never gets a negative width.
    expect(barGeometry({ ...run!, startMs: 500, endMs: null }, 1000, 100)).toEqual({ left: 50, width: 0 });
  });

  it('keeps the order of the server for spans with the same start', () => {
    const [run] = runOneSpans().spans;
    const kids = ['c', 'a', 'b'].map((id) => ({ ...run!, id, parentId: 'run:run-1', startMs: 10, ref: { kind: 'tool', toolCallRowId: 1, toolCallId: id } as const }));
    expect(visibleRows([run!, ...kids], new Set()).map((row) => row.span.id)).toEqual(['run:run-1', 'c', 'a', 'b']);
  });

  it('collects the child run ids and encodes the parts of a trace link', () => {
    expect([...runIdsOf(runOneSpans())].sort()).toEqual(['run-1', 'run-child']);
    expect(traceHref('run/1', 'tool:a b')).toBe('#/trace/run%2F1/tool%3Aa%20b');
  });
});

describe('the trace page', () => {
  it('shows a span of a kind it does not know with its facts only', async () => {
    const [run] = runOneSpans().spans;
    const strange = { ...run!, id: 'calendar:1', parentId: 'run:run-1', kind: 'calendar', label: 'a new kind', startMs: 10, endMs: 20, ref: { kind: 'calendar', calendarId: 1 } } as unknown as Span;
    spans = { ...runOneSpans(), spans: [...runOneSpans().spans, strange] };
    open();
    openApp('#/trace/run-1/calendar%3A1');
    const inspector = within(await screen.findByTestId('span-inspector'));
    expect(inspector.getByText('This kind of span has no inspector yet.')).toBeTruthy();
    expect(inMain().getByTestId('span-calendar:1')).toBeTruthy();
  });

  it('shows a server error that is not a 404 as an error, not as a missing trace', async () => {
    open({ 'GET /api/runs/:id/spans': () => json({ error: 'the trace tables are damaged' }, 500) });
    openApp('#/trace/run-1');
    expect(await inMain().findByText(/Could not load: the trace tables are damaged/)).toBeTruthy();
    expect(inMain().queryByText(/No trace/)).toBeNull();
  });

  it('moves between the spans with the arrow keys and opens one with Enter', async () => {
    open();
    openApp('#/trace/run-1');
    const first = (await inMain().findByTestId('span-run:run-1')).closest('tr')!;
    first.focus();
    fireEvent.keyDown(first, { key: 'ArrowDown' });
    const second = screen.getByTestId('span-model:1').closest('tr')!;
    expect(document.activeElement).toBe(second);
    fireEvent.keyDown(second, { key: 'Enter' });
    await waitFor(() => expect(location.hash).toBe('#/trace/run-1/model%3A1'));
    expect(await screen.findByTestId('span-inspector')).toBeTruthy();
  });

  it('loads an open trace again for a message about its run, and not for another run', async () => {
    spans = { ...runOneSpans(), endedAt: null, durationMs: null };
    const calls = open();
    openApp('#/trace/run-1');
    await inMain().findByTestId('span-model:1');
    const stream = () => FakeEventSource.find('/api/stream')!;
    const before = spansCalls(calls).length;
    const toolCall = (runId: string) => ({
      kind: 'tool_call',
      call: { id: 9, runId, toolCallId: 'c9', name: 'goals_set', outcome: 'ran', durationMs: 3, createdAt: '2026-10-13T01:00:01.000Z' },
    });
    act(() => stream().emit(toolCall('run-other')));
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(spansCalls(calls).length).toBe(before);
    act(() => stream().emit(toolCall('run-child')));
    await waitFor(() => expect(spansCalls(calls).length).toBe(before + 1));
  });

  it('never loads an ended trace again', async () => {
    const calls = open();
    openApp('#/trace/run-1');
    await inMain().findByTestId('span-model:1');
    const before = spansCalls(calls).length;
    act(() =>
      FakeEventSource.find('/api/stream')!.emit({
        kind: 'tool_call',
        call: { id: 9, runId: 'run-1', toolCallId: 'c9', name: 'goals_set', outcome: 'ran', durationMs: 3, createdAt: '2026-10-13T01:00:01.000Z' },
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(spansCalls(calls).length).toBe(before);
  });

  it('keeps the waterfall, its data and its scroll when a span is clicked', async () => {
    const calls = open();
    openApp('#/trace/run-1');
    const row = (await inMain().findByTestId('span-model:1')).closest('tr')!;
    const before = spansCalls(calls).length;
    const main = document.querySelector('main')!;
    main.scrollTop = 120;
    fireEvent.click(row);
    await waitFor(() => expect(location.hash).toBe('#/trace/run-1/model%3A1'));
    expect(await screen.findByTestId('span-inspector')).toBeTruthy();
    expect(screen.getByTestId('span-model:1').closest('tr')).toBe(row);
    expect(spansCalls(calls).length).toBe(before);
    expect(main.scrollTop).toBe(120);
  });

  it('loads an open trace again one time for a sub-agent run of another parent', async () => {
    spans = { ...runOneSpans(), endedAt: null, durationMs: null };
    const calls = open();
    openApp('#/trace/run-1');
    await inMain().findByTestId('span-model:1');
    const before = spansCalls(calls).length;
    const run = (status: string) => ({
      kind: 'run',
      run: { id: 'run-stranger', sessionKey: 'subagent:research:run-stranger', trigger: 'subagent', slot: 'main', status, startedAt: '2026-10-13T01:00:01.000Z', endedAt: null, error: null, costUsd: null, modelCalls: 0, toolCalls: 0 },
    });
    act(() => FakeEventSource.find('/api/stream')!.emit(run('running')));
    await waitFor(() => expect(spansCalls(calls).length).toBe(before + 1));
    act(() => FakeEventSource.find('/api/stream')!.emit(run('completed')));
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(spansCalls(calls).length).toBe(before + 1);
  });
});
