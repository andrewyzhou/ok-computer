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
