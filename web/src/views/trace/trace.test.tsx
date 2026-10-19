// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { seedDashboard } from '../../../../test/seed';
import type { RunSpans } from '../../../../src/dashboard/types';
import { setPrefs } from '../../shell/prefs';
import { inMain, installEventSource, json, openApp, stubFetch, type StubRoutes } from '../../testing';
import { runOneSpans } from './fixture';

installEventSource();

let seeded: Awaited<ReturnType<typeof seedDashboard>>;
let spans: RunSpans;

const routes = (extra: StubRoutes = {}): StubRoutes => ({
  'GET /api/runs/:id/spans': ({ params }) => (params.id === 'run-1' ? spans : json({ error: 'run not found' }, 404)),
  ...extra,
});

beforeEach(async () => {
  setPrefs({ theme: 'system', devMode: true, detailsHidden: false });
  spans = runOneSpans();
  seeded = await seedDashboard();
  stubFetch(seeded.dashboard, routes());
});
afterEach(() => cleanup());

const table = () => within(inMain().getByRole('table', { name: 'spans' }));
const order = () =>
  [...inMain().getByRole('table', { name: 'spans' }).querySelectorAll<HTMLElement>('.trace-name')].map(
    (name) => `${name.dataset.depth}:${name.dataset.testid!.slice('span-'.length)}`,
  );
const bar = (id: string) => screen.getByTestId(`span-${id}`).closest('tr')!.querySelector<HTMLElement>('.trace-bar')!;
const inspector = () => within(screen.getByTestId('span-inspector'));
const panel = async () => within(await screen.findByTestId('span-inspector'));

describe('the trace waterfall', () => {
  it('nests the spans in tree order, with child runs under their sub-agent span', async () => {
    openApp('#/trace/run-1');
    expect(await inMain().findByTestId('span-run:run-1')).toBeTruthy();
    expect(order()).toEqual([
      '0:run:run-1',
      '1:model:1',
      '2:tool:1',
      '2:tool:2',
      '1:approval:1',
      '1:subagent:call-sub',
      '2:run:run-child',
      '3:model:99',
      '1:model:2',
    ]);
    expect(screen.getByTestId('span-model:99').style.getPropertyValue('--trace-depth')).toBe('3');
    expect(screen.getByRole('heading', { level: 1, name: 'Trace' })).toBeTruthy();
    expect(within(inMain().getByLabelText('trace summary')).getByText('9')).toBeTruthy();
    expect(within(screen.getByTestId('span-tool:2').closest('tr')!).getByText('failed')).toBeTruthy();
  });

  it('places each bar by its start and length, and draws an open span to the end', async () => {
    openApp('#/trace/run-1');
    await inMain().findByTestId('span-model:1');
    expect(bar('model:1').style.left).toBe('0%');
    expect(bar('model:1').style.width).toBe('40%');
    expect(bar('tool:2').style.left).toBe('45%');
    expect(bar('tool:2').style.width).toBe('2%');
    expect(bar('approval:1').style.left).toBe('48%');
    expect(bar('approval:1').style.width).toBe('52%');
    expect(bar('approval:1').className).toContain('is-open');
    expect(bar('tool:2').className).toContain('is-error');
    expect(within(screen.getByTestId('span-approval:1').closest('tr')!).getByText('running')).toBeTruthy();
    expect(table().getByText('333 ms')).toBeTruthy();
  });

  it('draws a run of zero length with every bar at the start', async () => {
    spans = { ...runOneSpans(), runId: 'run-1', durationMs: 0, spans: runOneSpans().spans.map((span) => ({ ...span, startMs: 0, endMs: 0 })) };
    openApp('#/trace/run-1');
    await inMain().findByTestId('span-model:1');
    await waitFor(() => expect(bar('model:2').style.left).toBe('0%'));
    expect(bar('model:2').style.width).toBe('0%');
    expect(inMain().getByRole('table', { name: 'spans' }).innerHTML).not.toContain('NaN');
  });

  it('collapses and expands a sub-agent subtree', async () => {
    openApp('#/trace/run-1');
    await inMain().findByTestId('span-model:99');
    const toggle = table().getByRole('button', { name: /Collapse research/ });
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(toggle);
    expect(order()).not.toContain('3:model:99');
    expect(order()).not.toContain('2:run:run-child');
    expect(order()).toContain('1:subagent:call-sub');
    const expand = table().getByRole('button', { name: /Expand research/ });
    expect(expand.getAttribute('aria-expanded')).toBe('false');
    expect(location.hash).toBe('#/trace/run-1');
    fireEvent.click(expand);
    expect(order()).toContain('3:model:99');
  });

  it('selects a span into the hash and shows the stored model request, raw or formatted', async () => {
    openApp('#/trace/run-1');
    await inMain().findByTestId('span-model:1');
    fireEvent.click(screen.getByTestId('span-model:1').closest('tr')!);
    expect(location.hash).toBe('#/trace/run-1/model%3A1');
    const request = await (await panel()).findByText(/my goals: essay by 21:00, and gym/);
    expect(request.textContent).toContain('"role": "user"');
    expect(inspector().getByText(/stop reason/i)).toBeTruthy();
    expect(inspector().getByText('tool_use', { selector: 'dd' })).toBeTruthy();
    fireEvent.click(inspector().getByRole('button', { name: 'raw' }));
    const raw = inspector().getByText(/my goals: essay by 21:00, and gym/);
    expect(raw.textContent).toContain('"role":"user"');
    const body = (await (await fetch('/api/model-calls/1')).json()) as { request: unknown };
    expect(raw.textContent).toBe(JSON.stringify(body.request));
    expect(inspector().getByText(/28 tools offered/)).toBeTruthy();
    expect(screen.getByTestId('span-model:1').closest('tr')!.getAttribute('aria-selected')).toBe('true');
  });

  it('shows the tool call with its policy decision, taint and raw result', async () => {
    const taint = [{ source: 'mail:work', toolName: 'mail_read', runId: 'run-5', toolCallId: 'm1', at: '2026-10-12T21:00:00.000Z' }];
    seeded.t.db
      .prepare("UPDATE policy_decisions SET taint = ? WHERE id = (SELECT policyDecisionId FROM tool_calls WHERE toolCallId = 'call-goals')")
      .run(JSON.stringify(taint));
    openApp('#/trace/run-1/tool%3A1');
    expect(await (await panel()).findByText(/builtin:goals_set/)).toBeTruthy();
    expect(inspector().getByText('the tool changes only local data')).toBeTruthy();
    expect(inspector().getByText(/mail:work, read by mail_read/)).toBeTruthy();
    expect(inspector().getByRole('link', { name: 'run run-5' }).getAttribute('href')).toBe('#/runs/run-5');
    expect(inspector().getByText('The model saw the raw result unchanged.')).toBeTruthy();
    expect(inspector().getAllByText(/#1 finish essay/).length).toBe(2);
    expect(inspector().getByText(/"finish essay"/)).toBeTruthy();
  });

  it('says that a raw result was not stored when the blob is missing', async () => {
    seeded.t.db.prepare("UPDATE tool_calls SET truncated = 1, rawResultBlob = NULL WHERE toolCallId = 'call-bad'").run();
    openApp('#/trace/run-1/tool%3A2');
    expect(await (await panel()).findByText('The raw result was not stored.')).toBeTruthy();
  });

  it('shows an approval span as an approval card', async () => {
    openApp('#/trace/run-1/approval%3A1');
    const card = await screen.findByRole('article', { name: 'approval #1' });
    expect(within(card).getByRole('button', { name: 'Approve' })).toBeTruthy();
    expect(within(card).getByText('now {}')).toBeTruthy();
  });

  it('links a sub-agent span to the trace of its child run', async () => {
    openApp('#/trace/run-1/subagent%3Acall-sub');
    const link = await (await panel()).findByRole('link', { name: 'Trace of the sub-agent' });
    expect(link.getAttribute('href')).toBe('#/trace/run-child');
    expect(await (await panel()).findByText(/Not found/)).toBeTruthy();
  });

  it('keeps the waterfall when an inspector fails, and shows the error in the panel', async () => {
    stubFetch(seeded.dashboard, routes({ 'GET /api/model-calls/:id': () => json({ error: 'the stored body is damaged' }, 500) }));
    openApp('#/trace/run-1/model%3A2');
    expect(await (await panel()).findByText(/Could not load: the stored body is damaged/)).toBeTruthy();
    expect(order()).toHaveLength(9);
  });

  it('says when the span of the hash is not in the trace, and when the run has no trace', async () => {
    openApp('#/trace/run-1/model%3A404');
    expect(await screen.findByText('This span is not in the trace.')).toBeTruthy();
    cleanup();
    openApp('#/trace/nope');
    expect(await inMain().findByText('No trace: run not found')).toBeTruthy();
  });

  it('offers developer mode when it is off, and still shows the trace', async () => {
    setPrefs({ devMode: false });
    openApp('#/trace/run-1');
    expect(await inMain().findByTestId('span-model:1')).toBeTruthy();
    fireEvent.click(inMain().getByRole('button', { name: 'Turn on developer mode' }));
    await waitFor(() => expect(inMain().queryByRole('button', { name: 'Turn on developer mode' })).toBeNull());
    expect(JSON.parse(localStorage.getItem('okc.prefs')!).devMode).toBe(true);
  });
});
