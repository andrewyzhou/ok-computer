// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StreamMessage } from '../../src/dashboard/types';
import { seedDashboard } from '../../test/seed';
import { App } from './App';

// the browser stream is a fake, so a test can send a message to the pages.
class FakeEventSource {
  static last: FakeEventSource | undefined;
  onmessage: ((event: { data: string }) => void) | null = null;
  constructor(readonly url: string) {
    FakeEventSource.last = this;
  }
  emit(message: StreamMessage) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}
vi.stubGlobal('EventSource', FakeEventSource);

let seeded: Awaited<ReturnType<typeof seedDashboard>>;

beforeEach(async () => {
  seeded = await seedDashboard();
  const dashboard = seeded.dashboard;
  vi.stubGlobal('fetch', (input: string, init?: RequestInit) => dashboard.request(String(input), init));
});
afterEach(() => cleanup());

function open(hash: string) {
  location.hash = hash;
  return render(<App />);
}

describe('every dashboard page loads against the seeded database', () => {
  it('shows the overview', async () => {
    open('#/');
    expect(await screen.findByText('Cost today')).toBeTruthy();
    expect(screen.getByText('check-in: finish essay')).toBeTruthy();
    expect(screen.getByText('Blob store')).toBeTruthy();
    expect(screen.getByText('remind me when a goal eta is less than one hour away')).toBeTruthy();
  });

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

  // a failed blob write keeps the row without its raw text. the page once said that the model saw the raw result
  // unchanged, and showed the preview, or the note of an abandoned call, as the raw result.
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

  it('lists automations and turns one off', async () => {
    open('#/automations');
    const name = await screen.findByText('goals: ask');
    const row = name.closest('tr')!;
    fireEvent.click(within(row).getByText('Turn off'));
    expect(await screen.findByText('goals: ask is off.')).toBeTruthy();
    expect(seeded.t.rows("SELECT enabled FROM automations WHERE name = 'goals: ask'")).toEqual([{ enabled: 0 }]);
    expect(screen.getByLabelText('heartbeat checklist')).toBeTruthy();
  });

  it('shows goals with stats and charts', async () => {
    open('#/goals');
    expect(await screen.findByText('Hit rate, 7 days')).toBeTruthy();
    expect(screen.getAllByText('63%')).toHaveLength(2);
    expect(document.querySelectorAll('svg.chart')).toHaveLength(2);
    expect(screen.getByText('2026-10-11')).toBeTruthy();
  });

  it('browses memory files', async () => {
    open('#/memory');
    expect(await screen.findByText(/the owner writes essays in the evening/)).toBeTruthy();
    fireEvent.click(screen.getByText('consolidation-log.md'));
    expect(await screen.findByText(/weekly trends saved/)).toBeTruthy();
  });

  it('approves a pending approval', async () => {
    open('#/approvals');
    fireEvent.click(await screen.findByText('Approve'));
    expect(await screen.findByText(/^Approved #1\./)).toBeTruthy();
    expect(await screen.findByText('Nothing waits for your approval.')).toBeTruthy();
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

  it('shows the cost by day, slot and model', async () => {
    open('#/cost');
    expect(await screen.findByText('Cost by day')).toBeTruthy();
    expect(screen.getByText('fake/m')).toBeTruthy();
    expect(screen.getAllByText('heartbeat').length).toBeGreaterThan(0);
  });

  it('shows the logs and adds live lines from the stream', async () => {
    open('#/logs');
    expect(await screen.findByText('model request failed')).toBeTruthy();
    FakeEventSource.last!.emit({ kind: 'log', line: { ts: '2026-10-13T01:31:00.000Z', level: 'warn', msg: 'a live line' } });
    expect(await screen.findByText('a live line')).toBeTruthy();
  });
});
