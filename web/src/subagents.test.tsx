// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDashboard } from '../../src/dashboard/server';
import { createFakeClient, fakeResponse, textStep, toolStep } from '../../src/models/fake';
import { silentLogger } from '../../src/observability/logger';
import { REVIEW_TOOL } from '../../src/policy/reviewer';
import { createTestApp } from '../../test/app-harness';
import { App } from './App';

// the test keeps the stream, so that it can send the messages that the server sends.
let stream: { onmessage: ((event: { data: string }) => void) | null } | undefined;
vi.stubGlobal(
  'EventSource',
  class {
    onmessage = null;
    constructor() {
      // eslint-disable-next-line @typescript-eslint/no-this-alias
      stream = this as never;
    }
    close() {}
  },
);
afterEach(() => cleanup());

describe('the run page with a sub-agent and a reviewer', () => {
  // a parent run starts a research child, then writes a note that the reviewer checks. without rules, memory_write
  // goes to review.
  it('nests the child run in the delegate call, the reviewer call in its tool call, and links the child back', async () => {
    const main = createFakeClient([
      toolStep({ id: 'd1', name: 'delegate', input: { profile: 'research', task: 'Find my notes about the trip.' } }),
      toolStep({ id: 'k1', name: 'memory_search', input: { query: 'trip' } }),
      textStep('No notes about the trip.'),
      toolStep({ id: 'w1', name: 'memory_write', input: { text: 'No trip notes yet.' } }),
      textStep('Done.'),
    ]);
    const reviewer = createFakeClient([toolStep({ id: 'v', name: REVIEW_TOOL, input: { verdict: 'allow', reason: 'the owner asked for a note' } })], 'rev');
    const t = createTestApp([], {
      start: '2026-10-13T09:00:00-07:00',
      config: {
        slots: { main: { chain: ['fake/m'] }, utility: { chain: ['rev/r'] } },
        pricing: { 'fake/m': { input: 1, cachedInput: 0.1, cacheWrite: 1.25, output: 5 } },
      },
      deps: { rules: [], clients: { fake: main, rev: reviewer } },
    });
    await t.app.start();
    await t.say('look for my trip notes and note the result');
    const dashboard = createDashboard({ db: t.db, config: t.config, clock: t.clock, logger: silentLogger, app: t.app, webDir: t.dataDir });
    vi.stubGlobal('fetch', (input: string, init?: RequestInit) => dashboard.request(String(input), init));

    location.hash = '#/runs/run-1';
    render(<App />);
    expect(await screen.findByText('Timeline')).toBeTruthy();
    // the reviewer call is not a turn of the agent.
    const turns = document.querySelectorAll('.timeline > li.step-model');
    expect([...turns].map((step) => step.querySelector('.step-head')?.textContent)).toEqual([
      expect.stringContaining('fake/m'),
      expect.stringContaining('fake/m'),
      expect.stringContaining('fake/m'),
    ]);
    expect(screen.getByText(/in 1 sub-agent run/)).toBeTruthy();

    const delegate = [...document.querySelectorAll('.timeline.nested > li')].find((step) => step.textContent?.includes('delegate')) as HTMLElement;
    expect(within(delegate).getByText('research')).toBeTruthy();
    fireEvent.click(within(delegate).getByText(/timeline of the sub-agent/));
    expect(await within(delegate).findByText(/memory_search/)).toBeTruthy();

    const write = [...document.querySelectorAll('.timeline.nested > li')].find((step) => step.querySelector('.step-head')?.textContent?.includes('memory_write')) as HTMLElement;
    fireEvent.click(within(write).getByText(/policy decision/));
    expect(await within(write).findByText('Reviewer call')).toBeTruthy();
    expect(within(write).getByText(/rev\/r, slot utility/)).toBeTruthy();

    cleanup();
    location.hash = '#/runs/run-2';
    render(<App />);
    expect(await screen.findByText('Started by')).toBeTruthy();
    expect(screen.getByText(/as the research sub-agent/)).toBeTruthy();
    expect(screen.getByText('run run-1').getAttribute('href')).toBe('#/runs/run-1');
    await t.app.stop();
  });

  // the parent writes no events while its delegate call waits, so the page must follow the events of the child
  // (verification round 7).
  it('updates the nested child timeline and the parent run while the child runs', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let reached!: () => void;
    const atGate = new Promise<void>((resolve) => (reached = resolve));
    let release2!: () => void;
    const gate2 = new Promise<void>((resolve) => (release2 = resolve));
    let reached2!: () => void;
    const atGate2 = new Promise<void>((resolve) => (reached2 = resolve));
    const main = createFakeClient([
      toolStep({ id: 'd1', name: 'delegate', input: { profile: 'research', task: 'Find trip notes.' } }),
      toolStep({ id: 'k1', name: 'memory_search', input: { query: 'trip' } }),
      async () => {
        reached();
        await gate;
        return fakeResponse({ toolCalls: [{ id: 'k2', name: 'memory_search', input: { query: 'flight' } }], stopReason: 'tool_use' });
      },
      async () => {
        reached2();
        await gate2;
        return fakeResponse({ text: 'No notes.' });
      },
      textStep('Done.'),
    ]);
    const t = createTestApp([], { start: '2026-10-13T09:00:00-07:00', deps: { clients: { fake: main } } });
    await t.app.start();
    const said = t.say('look for my trip notes');
    await atGate;
    const dashboard = createDashboard({ db: t.db, config: t.config, clock: t.clock, logger: silentLogger, app: t.app, webDir: t.dataDir });
    const fetched: string[] = [];
    vi.stubGlobal('fetch', (input: string, init?: RequestInit) => {
      fetched.push(String(input));
      return dashboard.request(String(input), init);
    });
    location.hash = '#/runs/run-1';
    render(<App />);
    expect(await screen.findByText('Timeline')).toBeTruthy();
    const delegate = [...document.querySelectorAll('.timeline.nested > li')].find((step) => step.textContent?.includes('delegate')) as HTMLElement;
    fireEvent.click(within(delegate).getByText(/timeline of the sub-agent/));
    await within(delegate).findByText(/memory_search/);
    const calls = () => (delegate.querySelector('.timeline.child')?.textContent?.match(/memory_search/g) ?? []).length;
    expect(calls()).toBe(1);

    release();
    await atGate2;
    const parentLoads = fetched.filter((path) => path === '/api/runs/run-1').length;
    // the server sends each new event of the child, as the stream does.
    for (const event of t.db.prepare("SELECT * FROM events WHERE runId = 'run-2'").all()) {
      act(() => stream?.onmessage?.({ data: JSON.stringify({ kind: 'event', event: { ...event, payload: JSON.parse(String(event.payload)) } }) }));
    }
    await waitFor(() => expect(calls()).toBe(2));
    // the parent loads again too, for the status and the cost of its child.
    expect(fetched.filter((path) => path === '/api/runs/run-1').length).toBeGreaterThan(parentLoads);
    release2();
    await said;
    await t.app.stop();
  });
});
