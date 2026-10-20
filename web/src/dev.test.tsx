// @vitest-environment jsdom
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RunRow } from '../../src/dashboard/types';
import { seedDashboard } from '../../test/seed';
import { setPrefs } from './shell/prefs';
import { FakeEventSource, inMain, installEventSource, json, openApp as open, stubFetch } from './testing';

installEventSource();

let seeded: Awaited<ReturnType<typeof seedDashboard>>;
let calls: ReturnType<typeof stubFetch>;

beforeEach(async () => {
  seeded = await seedDashboard();
  calls = stubFetch(seeded.dashboard);
});
afterEach(() => {
  cleanup();
  setPrefs({ devMode: false });
});

const details = () => within(screen.getByRole('complementary', { name: 'details' }));

function fakeRun(index: number): RunRow {
  const at = new Date(Date.UTC(2026, 9, 12, 12, 0, 0) - index * 60_000).toISOString();
  return {
    id: `r-${index}`,
    sessionKey: 'main',
    trigger: 'message',
    slot: 'main',
    status: 'completed',
    startedAt: at,
    endedAt: at,
    error: null,
    costUsd: 0,
    modelCalls: 1,
    toolCalls: 0,
  };
}

describe('the developer pages load against the seeded database', () => {
  it('lists runs and filters them by status', async () => {
    open('#/runs');
    expect(await screen.findByText('run-5')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('status'), { target: { value: 'failed' } });
    expect(await screen.findByText('run-3')).toBeTruthy();
    expect(screen.queryByText('run-5')).toBeNull();
  });

  it('shows the full timeline of a run with the request and response on expand', async () => {
    open('#/runs/run-1');
    expect(await screen.findByText('Timeline')).toBeTruthy();
    const steps = document.querySelectorAll('.timeline > li');
    expect([...steps].map((step) => step.querySelector('.step-head')?.textContent)).toEqual([
      expect.stringContaining('fake/m'),
      expect.stringContaining('goals_set'),
      expect.stringContaining('goal_update'),
      expect.stringContaining('fake/m'),
    ]);
    expect(steps[2]!.className).toContain('is-error');
    fireEvent.click(within(steps[0] as HTMLElement).getByText(/full request and response/));
    expect(await screen.findByText('Request')).toBeTruthy();
    expect(screen.getByText(/"call-goals"/)).toBeTruthy();
  });

  it('nests tool calls in their model call and shows what the model saw next to the raw result', async () => {
    open('#/runs/run-5');
    expect(await screen.findByText('Timeline')).toBeTruthy();
    const nested = document.querySelectorAll('.timeline.nested > li');
    expect([...nested].map((step) => step.querySelector('.step-head')?.textContent)).toEqual([
      expect.stringMatching(/memory_get.*allow.*by risk:read.*risk read.*res_[0-9a-f]{12}/),
      expect.stringMatching(/result_read.*allow/),
    ]);
    const week = nested[0] as HTMLElement;
    fireEvent.click(within(week).getByText(/result and what the model saw/));
    expect(await within(week).findByText('Raw result')).toBeTruthy();
    expect(within(week).getByText('What the model saw')).toBeTruthy();
    expect(within(week).getByText(/The model got a preview and the handle/)).toBeTruthy();
    expect(await within(week).findByText(/late nights hurt sleep/)).toBeTruthy();
    fireEvent.click(within(week).getByText(/policy decision/));
    expect(within(week).getByText('memory_get only reads')).toBeTruthy();
    fireEvent.click(screen.getAllByText(/tools offered/)[0]!);
    expect(await screen.findByText(/Catalog [0-9a-f]{12}, first offered/)).toBeTruthy();
  });

  it('says that the raw result was not stored when the blob write failed, and never calls a note the raw result', async () => {
    const { db } = seeded.t;
    db.prepare("UPDATE tool_calls SET rawResultBlob = NULL WHERE toolCallId = 'call-week'").run();
    db.prepare("UPDATE tool_calls SET outcome = 'abandoned' WHERE toolCallId = 'call-read'").run();
    open('#/runs/run-5');
    expect(await screen.findByText('Timeline')).toBeTruthy();
    const [week, read] = [...document.querySelectorAll('.timeline.nested > li')] as HTMLElement[];
    fireEvent.click(within(week!).getByText(/result and what the model saw/));
    expect(await within(week!).findByText(/The raw result was not stored, because its blob write failed/)).toBeTruthy();
    expect(within(week!).queryByText('The model saw the raw result unchanged.')).toBeNull();
    fireEvent.click(within(read!).getByText(/result and what the model saw/));
    expect(await within(read!).findByText('The tool gave no result.')).toBeTruthy();
    expect(within(read!).queryByText('The model saw the raw result unchanged.')).toBeNull();
    db.prepare("UPDATE tool_calls SET outcome = 'late', rawResultBlob = NULL, untrustedSource = NULL, truncated = 0 WHERE toolCallId = 'call-read'").run();
    cleanup();
    open('#/runs/run-5');
    expect(await screen.findByText('Timeline')).toBeTruthy();
    const late = document.querySelectorAll('.timeline.nested > li')[1] as HTMLElement;
    fireEvent.click(within(late).getByText(/result and what the model saw/));
    expect(await within(late).findByText(/The raw result was not stored/)).toBeTruthy();
  });

  it('shows the outcome of each tool call, so a call that waits for the owner never looks like it ran', async () => {
    const { db } = seeded.t;
    // the call to result_read waits for the owner, and the session was tainted by an email.
    const taint = [{ source: 'gmail:work', toolName: 'mail_read', runId: 'run-1', toolCallId: 'm1', at: '2026-10-12T21:00:00.000Z' }];
    db.prepare(
      "UPDATE policy_decisions SET decision = 'approve', approvalId = ?, taint = ? WHERE id = (SELECT policyDecisionId FROM tool_calls WHERE toolCallId = 'call-read')",
    ).run(seeded.pendingApprovalId, JSON.stringify(taint));
    db.prepare("UPDATE tool_calls SET outcome = 'interrupted' WHERE toolCallId = 'call-week'").run();
    open('#/runs/run-5');
    expect(await screen.findByText('Timeline')).toBeTruthy();
    const [week, read] = [...document.querySelectorAll('.timeline.nested > li')] as HTMLElement[];
    expect(week!.querySelector('.step-head')?.textContent).toMatch(/memory_get\s*interrupted/);
    expect(read!.querySelector('.step-head')?.textContent).toMatch(/result_read\s*waiting/);
    expect(read!.querySelector('.step-head')?.textContent).not.toMatch(/\bran\b/);
    fireEvent.click(within(week!).getByText(/result and what the model saw/));
    expect(await within(week!).findByText(/The app stopped while the tool ran/)).toBeTruthy();
    fireEvent.click(within(read!).getByText(/policy decision/));
    expect(within(read!).getByText(/gmail:work, read by mail_read/)).toBeTruthy();
    expect(within(read!).getByText('run run-1')).toBeTruthy();
  });

  it('lists sessions', async () => {
    open('#/sessions');
    expect(await screen.findByText('heartbeat:run-4')).toBeTruthy();
  });

  it('shows a session with its compaction marker and what the model saw', async () => {
    open('#/sessions/main');
    expect(await screen.findByText(/Compaction: 5000 → 900/)).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Show what the model saw'));
    expect(await screen.findByText(/The context strategy gives this input/)).toBeTruthy();
    const view = await (await fetch('/api/sessions/main/context')).json();
    const panel = screen.getByText('What the model saw').closest('section')!;
    expect(panel.querySelectorAll('.event')).toHaveLength(view.messages.length);
    expect(within(panel as HTMLElement).getByText(/<summary>/)).toBeTruthy();
  });

  it('lists the policy decisions newest first, filters the held calls, and shows the rules', async () => {
    seeded.t.db
      .prepare(
        `INSERT INTO policy_decisions (runId, toolCallId, toolName, decision, rule, reason, reviewerVerdict, reviewerReason, createdAt)
         VALUES ('run-1', 'call-held', 'browser_type', 'review', 'risk:write', 'browser_type changes data', 'hold', 'the owner did not ask for this', '2026-10-13T01:40:00.000Z')`,
      )
      .run();
    open('#/policy');
    expect(await screen.findByText('the owner did not ask for this', { exact: false })).toBeTruthy();
    const tools = () => [...document.querySelectorAll('tbody')[0]!.querySelectorAll('tr')].map((row) => row.cells[1]!.textContent);
    expect(tools()[0]).toBe('browser_type');
    expect(tools()).toContain('goals_set');
    expect(screen.getByText('builtin:delegate')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('verdict'), { target: { value: 'hold' } });
    await expect.poll(() => tools()).toEqual(['browser_type']);
  });

  it('shows the level of the trust ladder that applied to a decision', async () => {
    seeded.t.db
      .prepare(
        `INSERT INTO policy_decisions (runId, toolCallId, toolName, decision, rule, reason, autonomyDomain, autonomyLevel, createdAt)
         VALUES ('run-1', 'call-draft', 'google__gmail_draft', 'allow', 'autonomy:mail_drafts', 'the owner set mail drafts to auto', 'mail_drafts', 'auto', '2026-10-13T01:41:00.000Z')`,
      )
      .run();
    open('#/policy');
    expect(await screen.findByText('level: auto (mail drafts)')).toBeTruthy();
    // a decision outside the ladder shows no level.
    expect(screen.getAllByText(/^level: /)).toHaveLength(1);
  });

  it('shows the cost by day, slot and model', async () => {
    open('#/cost');
    expect(await screen.findByText('Cost by day')).toBeTruthy();
    expect(screen.getByText('fake/m')).toBeTruthy();
    expect(screen.getAllByText('heartbeat').length).toBeGreaterThan(0);
  });

  it('shows the logs and adds live lines from the stream', async () => {
    open('#/logs');
    expect(await screen.findByText('model request failed')).toBeTruthy();
    FakeEventSource.find('/api/stream')!.emit({ kind: 'log', line: { ts: '2026-10-13T01:31:00.000Z', level: 'warn', msg: 'a live line' } });
    expect(await screen.findByText('a live line')).toBeTruthy();
  });

  it('reads the run filters from the hash and writes a new filter to it', async () => {
    open('#/runs?status=failed');
    expect(await inMain().findByText('run-3')).toBeTruthy();
    expect(inMain().queryByText('run-5')).toBeNull();
    expect((screen.getByLabelText('status') as HTMLSelectElement).value).toBe('failed');
    fireEvent.change(screen.getByLabelText('trigger'), { target: { value: 'heartbeat' } });
    expect(location.hash).toBe('#/runs?status=failed&trigger=heartbeat');
    fireEvent.change(screen.getByLabelText('status'), { target: { value: '' } });
    expect(location.hash).toBe('#/runs?trigger=heartbeat');
    await expect.poll(() => calls.at(-1)?.url).toBe('/api/runs?trigger=heartbeat&limit=50');
  });

  it('keeps the runs of one session and clears that filter with its pill', async () => {
    open('#/runs?sessionKey=heartbeat%3Arun-4');
    expect(await inMain().findByText('run-4')).toBeTruthy();
    expect(inMain().queryByText('run-5')).toBeNull();
    expect(calls.some((call) => call.url === '/api/runs?sessionKey=heartbeat%3Arun-4&limit=50')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Clear the session filter' }));
    expect(location.hash).toBe('#/runs');
    expect(await inMain().findByText('run-5')).toBeTruthy();
  });

  it('loads older runs with the id of the last run, and stops after a short page', async () => {
    calls = stubFetch(seeded.dashboard, {
      'GET /api/runs': ({ query }) => {
        const before = query.get('before');
        if (!before) return Array.from({ length: 50 }, (_, i) => fakeRun(i));
        if (before === 'r-49') return [50, 51, 52].map(fakeRun);
        return json({ error: 'unknown run' }, 400);
      },
    });
    open('#/runs');
    expect(await inMain().findByText('r-49')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Load older runs' }));
    expect(await inMain().findByText('r-52')).toBeTruthy();
    expect(calls.map((call) => call.url)).toContain('/api/runs?limit=50&before=r-49');
    expect(inMain().getAllByRole('row')).toHaveLength(54);
    expect(screen.queryByRole('button', { name: 'Load older runs' })).toBeNull();
    expect(inMain().getByText('No older runs.')).toBeTruthy();
  });

  it('shows the error of a page of older runs', async () => {
    stubFetch(seeded.dashboard, {
      'GET /api/runs': ({ query }) => (query.get('before') ? json({ error: 'unknown run' }, 400) : Array.from({ length: 50 }, (_, i) => fakeRun(i))),
    });
    open('#/runs');
    fireEvent.click(await screen.findByRole('button', { name: 'Load older runs' }));
    expect((await screen.findByRole('alert')).textContent).toContain('unknown run');
    expect(inMain().getByText('r-49')).toBeTruthy();
  });

  it('shows the facts of a selected run in the details panel', async () => {
    open('#/runs');
    const cell = await inMain().findByText('run-3');
    fireEvent.click(cell.closest('tr')!);
    expect(await details().findByRole('heading', { name: 'Run run-3' })).toBeTruthy();
    expect(details().getByText('failed')).toBeTruthy();
    expect(
      details()
        .getByRole('link', { name: /Open the run/ })
        .getAttribute('href'),
    ).toBe('#/runs/run-3');
  });

  it('shows the facts of a run in the details panel, and the trace link only in developer mode', async () => {
    open('#/runs/run-1');
    expect(await inMain().findByText('Timeline')).toBeTruthy();
    expect(await details().findByRole('heading', { name: 'Run' })).toBeTruthy();
    expect(details().getByText('Session')).toBeTruthy();
    expect(details().getByRole('link', { name: 'main' }).getAttribute('href')).toBe('#/sessions/main');
    const header = () => within(document.querySelector<HTMLElement>('header.topbar')!);
    expect(header().getByRole('link', { name: 'All runs' })).toBeTruthy();
    expect(screen.queryByRole('link', { name: /Trace/ })).toBeNull();
    expect(screen.queryByRole('link', { name: /Logs of this run/ })).toBeNull();
    expect(screen.getByRole('navigation', { name: 'breadcrumb' }).textContent).toContain('Runs');
    cleanup();
    setPrefs({ devMode: true });
    open('#/runs/run-1');
    expect(await inMain().findByText('Timeline')).toBeTruthy();
    expect(header().getByRole('link', { name: /Trace/ }).getAttribute('href')).toBe('#/trace/run-1');
    expect(header().getByRole('link', { name: 'Logs of this run' }).getAttribute('href')).toBe('#/logs?runId=run-1');
    // a phone shows the same link in the details panel.
    expect(details().getByRole('link', { name: /Logs of this run/ }).getAttribute('href')).toBe('#/logs?runId=run-1');
  });

  it('filters the sessions by key and shows the selected one in the details panel', async () => {
    open('#/sessions');
    expect(await inMain().findByText('heartbeat:run-4')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Filter sessions'), { target: { value: 'heart' } });
    expect(inMain().queryByRole('link', { name: 'main' })).toBeNull();
    fireEvent.click(inMain().getByText('heartbeat:run-4').closest('tr')!);
    expect(await details().findByRole('link', { name: /Open the session/ })).toBeTruthy();
  });

  it('shows the token estimate of the next request in the panel of a session, and the system prompt in developer mode', async () => {
    const view = await (await fetch('/api/sessions/main/context')).json();
    setPrefs({ devMode: true });
    open('#/sessions/main');
    expect(await details().findByText('Next request, estimated tokens')).toBeTruthy();
    expect(await details().findByText(String(view.estimatedTokens))).toBeTruthy();
    expect(details().getByText('system prompt')).toBeTruthy();
  });

  it('shows the reviewer and the taint of a selected policy decision', async () => {
    const taint = [{ source: 'gmail:work', toolName: 'mail_read', runId: 'run-1', toolCallId: 'm1', at: '2026-10-12T21:00:00.000Z' }];
    seeded.t.db
      .prepare(
        `INSERT INTO policy_decisions (runId, toolCallId, toolName, decision, rule, reason, reviewerVerdict, reviewerReason, taint, createdAt)
         VALUES ('run-1', 'call-held', 'browser_type', 'review', 'risk:write', 'browser_type changes data', 'hold', 'the owner did not ask for this', ?, '2026-10-13T01:40:00.000Z')`,
      )
      .run(JSON.stringify(taint));
    open('#/policy');
    fireEvent.click((await inMain().findByText('browser_type')).closest('tr')!);
    expect(await details().findByRole('heading', { name: 'browser_type' })).toBeTruthy();
    expect(details().getByText(/gmail:work, read by mail_read/)).toBeTruthy();
    expect(details().getByRole('link', { name: 'run run-1' }).getAttribute('href')).toBe('#/runs/run-1');
    expect(details().getByText('hold')).toBeTruthy();
  });

  it('keeps the log lines of one run, also from the stream, and clears the run filter', async () => {
    open('#/logs?runId=run-3');
    expect(await inMain().findByText('model request failed')).toBeTruthy();
    expect(inMain().queryByText('run started')).toBeNull();
    expect(calls.map((call) => call.url)).toContain('/api/logs?level=info&limit=500&runId=run-3');
    FakeEventSource.find('/api/stream')!.emit({ kind: 'log', line: { ts: '2026-10-13T01:31:00.000Z', level: 'warn', msg: 'a line of another run', runId: 'run-1' } });
    FakeEventSource.find('/api/stream')!.emit({ kind: 'log', line: { ts: '2026-10-13T01:31:01.000Z', level: 'warn', msg: 'a line of this run', runId: 'run-3' } });
    expect(await inMain().findByText('a line of this run')).toBeTruthy();
    expect(inMain().queryByText('a line of another run')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Clear the run filter' }));
    expect(location.hash).toBe('#/logs');
    expect(await inMain().findByText('run started')).toBeTruthy();
  });

  it('shows no live lines for another day', async () => {
    open('#/logs?day=2026-10-01');
    expect(await inMain().findByText(/The lines of 2026-10-01/)).toBeTruthy();
    expect(calls.map((call) => call.url)).toContain('/api/logs?level=info&limit=500&day=2026-10-01');
    // the lines of that day come from the server. the server of this test may not know the day yet, so the test waits
    // for the list or the empty state, whichever it gets.
    await expect.poll(() => document.querySelector('main .skeleton')).toBeNull();
    FakeEventSource.find('/api/stream')!.emit({ kind: 'log', line: { ts: '2026-10-13T01:31:00.000Z', level: 'warn', msg: 'a line of today' } });
    await new Promise((done) => setTimeout(done, 50));
    expect(inMain().queryByText('a line of today')).toBeNull();
  });
});
