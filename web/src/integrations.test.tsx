// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StreamMessage } from '../../src/dashboard/types';
import { createDashboard } from '../../src/dashboard/server';
import { silentLogger } from '../../src/observability/logger';
import { createTestApp } from '../../test/app-harness';
import { notesIntegration, seedIntegrations } from '../../test/seed-integrations';
import { App } from './App';
import './testing';

// the browser stream is a fake, so a test can send a log line of an integration to the pages.
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

let seeded: Awaited<ReturnType<typeof seedIntegrations>>;
const requests: string[] = [];

beforeEach(async () => {
  seeded = await seedIntegrations();
  const dashboard = seeded.dashboard;
  requests.length = 0;
  vi.stubGlobal('fetch', (input: string, init?: RequestInit) => {
    requests.push(String(input));
    return dashboard.request(String(input), init);
  });
});
afterEach(async () => {
  cleanup();
  await seeded.t.app.stop();
});

function open(hash: string) {
  location.hash = hash;
  return render(<App />);
}

const log = (integration: string): StreamMessage => ({ kind: 'log', line: { ts: '2026-10-13T03:15:00Z', level: 'info', msg: 'mcp server connected', integration } });

describe('the integrations pages', () => {
  it('lists each integration with its state, the next step for the owner, and the tool counts', async () => {
    open('#/integrations');
    expect(await screen.findByText('notes')).toBeTruthy();
    expect(screen.getByText('connected')).toBeTruthy();
    expect(screen.getByText(/okc.integrations.json allows ghost, but the server does not have it/)).toBeTruthy();
    expect(screen.getByText(/5 allowed/)).toBeTruthy();
    expect(screen.getByText(/6 hidden/)).toBeTruthy();
    expect(screen.getByText(/1 missing/)).toBeTruthy();
    expect(screen.getByText('Reconnect')).toBeTruthy();
  });

  it('reloads only for a log line of an integration', async () => {
    open('#/integrations');
    await screen.findByText('notes');
    const before = requests.filter((url) => url === '/api/integrations').length;
    FakeEventSource.last!.emit({ kind: 'log', line: { ts: '2026-10-13T03:15:00Z', level: 'info', msg: 'run started' } });
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(requests.filter((url) => url === '/api/integrations').length).toBe(before);
    FakeEventSource.last!.emit(log('notes'));
    await vi.waitFor(() => expect(requests.filter((url) => url === '/api/integrations').length).toBe(before + 1));
  });

  it('shows the tools with the source of their risk, a changed description in red, the calls and the messages', async () => {
    open('#/integrations/notes');
    expect(await screen.findByText('Tools the agent can use')).toBeTruthy();
    expect(screen.getAllByText('default: the server does not say read only').length).toBe(1);
    expect(screen.getAllByText('okc.integrations.json').length).toBe(4);
    expect(screen.getByText(/added notes__calendar_lookup/)).toBeTruthy();
    // a new description of an allowed tool is new text in front of the model.
    expect(screen.getByText(/changed the description of notes__echo/).className).toBe('error-text');
    expect(screen.getAllByText(/okc.integrations.json allows ghost, but the server does not have it./).length).toBe(2);
    expect(screen.getByText(/Hidden, because okc.integrations.json does not allow them: broken/)).toBeTruthy();
    expect(screen.getByText('waiting')).toBeTruthy();
    expect(screen.getByText('notes-server --pinned 1.2.3')).toBeTruthy();
    expect(screen.getAllByText('tools/call').length).toBeGreaterThan(0);
  });

  it('says that the tools are not known yet before the first tool list', async () => {
    // a new app with no stored catalog, whose server never answers.
    const fresh = createTestApp([], { start: '2026-10-13T03:15:00Z', deps: { integrations: notesIntegration(), mcpTransport: () => new Promise(() => {}) } });
    await fresh.app.start();
    const dashboard = createDashboard({ db: fresh.db, config: fresh.config, clock: fresh.clock, logger: silentLogger, app: fresh.app });
    vi.stubGlobal('fetch', (input: string, init?: RequestInit) => dashboard.request(String(input), init));
    open('#/integrations');
    expect(await screen.findByText('not known yet')).toBeTruthy();
    expect(screen.getByText(/The app connects it now/)).toBeTruthy();
    cleanup();
    open('#/integrations/notes');
    expect(await screen.findByText(/The server never gave a tool list, so its tools are not known yet/)).toBeTruthy();
    await fresh.app.stop();
  });

  it('links a tool call in the run timeline to its integration and its json-rpc messages', async () => {
    open('#/runs/run-1');
    fireEvent.click((await screen.findAllByText(/2 json-rpc messages with notes/))[0]!);
    expect((await screen.findAllByText('tools/call')).length).toBe(2);
    expect(screen.getAllByText('notes').length).toBeGreaterThan(0);
    expect(screen.getAllByText(/tool call tool_call → notes__echo/).length).toBeGreaterThan(0);
  });
});
