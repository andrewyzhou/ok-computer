// @vitest-environment jsdom
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StreamMessage } from '../../src/dashboard/types';
import { createDashboard } from '../../src/dashboard/server';
import { silentLogger } from '../../src/observability/logger';
import { createTestApp } from '../../test/app-harness';
import { notesIntegration, seedIntegrations } from '../../test/seed-integrations';
import { FakeEventSource, inMain, installEventSource, openApp, stubFetch } from './testing';

// the browser stream is a fake, so a test can send a log line of an integration to the pages.
installEventSource();

let seeded: Awaited<ReturnType<typeof seedIntegrations>>;
let calls: ReturnType<typeof stubFetch>;

beforeEach(async () => {
  seeded = await seedIntegrations();
  calls = stubFetch(seeded.dashboard);
});
afterEach(async () => {
  cleanup();
  await seeded.t.app.stop();
});

const log = (integration: string): StreamMessage => ({ kind: 'log', line: { ts: '2026-10-13T03:15:00Z', level: 'info', msg: 'mcp server connected', integration } });
const listLoads = () => calls.filter((call) => call.method === 'GET' && call.url === '/api/integrations').length;
const details = () => within(screen.getByRole('complementary', { name: 'details' }));
const stream = () => FakeEventSource.find('/api/stream')!;

describe('the integrations pages', () => {
  it('lists each integration with its state, the next step for the owner, and the tool counts', async () => {
    openApp('#/integrations');
    const row = (await inMain().findByText('notes')).closest('tr')!;
    expect(within(row).getByText('connected')).toBeTruthy();
    expect(within(row).getByText(/okc.integrations.json allows ghost, but the server does not have it/)).toBeTruthy();
    expect(within(row).getByText(/5 allowed/)).toBeTruthy();
    expect(within(row).getByText(/6 hidden/)).toBeTruthy();
    expect(within(row).getByText(/1 missing/)).toBeTruthy();
    expect(within(row).getByRole('button', { name: 'Reconnect notes' })).toBeTruthy();
    expect(within(row).getByRole('button', { name: 'Pause notes' })).toBeTruthy();
  });

  it('shows the summary of the selected integration in the details panel, with a link to its page', async () => {
    openApp('#/integrations');
    const row = (await inMain().findByText('notes')).closest('tr')!;
    expect(details().getByText('Integrations')).toBeTruthy();
    fireEvent.click(row);
    expect(row.getAttribute('aria-selected')).toBe('true');
    expect(await details().findByRole('heading', { name: 'notes' })).toBeTruthy();
    expect(details().getByText('connected')).toBeTruthy();
    expect(details().getByText('Token expires')).toBeTruthy();
    expect(details().getByText('Last error')).toBeTruthy();
    expect(details().getByRole('link', { name: /Open/ }).getAttribute('href')).toBe('#/integrations/notes');
  });

  it('pauses an integration and says so in the header', async () => {
    openApp('#/integrations');
    const row = (await inMain().findByText('notes')).closest('tr')!;
    fireEvent.click(within(row).getByRole('button', { name: 'Pause notes' }));
    expect(await screen.findByText('notes is paused.')).toBeTruthy();
    expect(screen.getByText('notes is paused.').closest('main')).toBeNull();
    expect(calls.some((call) => call.method === 'POST' && call.url === '/api/integrations/notes/pause')).toBe(true);
    expect(await inMain().findByRole('button', { name: 'Resume notes' })).toBeTruthy();
    expect(within(inMain().getByText('notes').closest('tr')!).getByText('paused')).toBeTruthy();
  });

  it('reloads only for a log line of an integration', async () => {
    openApp('#/integrations');
    await inMain().findByText('notes');
    const before = listLoads();
    stream().emit({ kind: 'log', line: { ts: '2026-10-13T03:15:00Z', level: 'info', msg: 'run started' } });
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(listLoads()).toBe(before);
    stream().emit(log('notes'));
    await vi.waitFor(() => expect(listLoads()).toBe(before + 1));
  });

  it('shows the tools with the source of their risk, a changed description in red, the calls and the messages', async () => {
    openApp('#/integrations/notes');
    const main = inMain();
    expect(await main.findByText('Tools the agent can use')).toBeTruthy();
    expect(main.getAllByText('default: the server does not say read only').length).toBe(1);
    expect(main.getAllByText('okc.integrations.json').length).toBe(4);
    expect(main.getByText(/added notes__calendar_lookup/)).toBeTruthy();
    // a new description of an allowed tool is new text in front of the model.
    expect(main.getByText(/changed the description of notes__echo/).className).toBe('error-text');
    expect(main.getByText(/okc.integrations.json allows ghost, but the server does not have it. Check the spelling/)).toBeTruthy();
    expect(main.getByText(/Hidden, because okc.integrations.json does not allow them: broken/)).toBeTruthy();
    expect(main.getByText('waiting')).toBeTruthy();
    expect(main.getAllByText('tools/call').length).toBeGreaterThan(0);
    // the facts of the integration are in the details panel, and the crumbs lead back to the list.
    expect(details().getByText('notes-server --pinned 1.2.3')).toBeTruthy();
    expect(details().getByText(/okc.integrations.json allows ghost, but the server does not have it\.$/)).toBeTruthy();
    expect(within(screen.getByRole('navigation', { name: 'breadcrumb' })).getByRole('link', { name: 'Integrations' }).getAttribute('href')).toBe('#/integrations');
    expect(screen.getByRole('button', { name: 'Reconnect notes' })).toBeTruthy();
  });

  it('says that the tools are not known yet before the first tool list', async () => {
    // a new app with no stored catalog, whose server never answers.
    const fresh = createTestApp([], { start: '2026-10-13T03:15:00Z', deps: { integrations: notesIntegration(), mcpTransport: () => new Promise(() => {}) } });
    await fresh.app.start();
    const dashboard = createDashboard({ db: fresh.db, config: fresh.config, clock: fresh.clock, logger: silentLogger, app: fresh.app });
    stubFetch(dashboard);
    openApp('#/integrations');
    expect(await inMain().findByText('not known yet')).toBeTruthy();
    expect(inMain().getByText(/The app connects it now/)).toBeTruthy();
    cleanup();
    openApp('#/integrations/notes');
    expect(await inMain().findByText(/The server never gave a tool list, so its tools are not known yet/)).toBeTruthy();
    await fresh.app.stop();
  });

  it('links a tool call in the run timeline to its integration and its json-rpc messages', async () => {
    openApp('#/runs/run-1');
    fireEvent.click((await screen.findAllByText(/2 json-rpc messages with notes/))[0]!);
    expect((await screen.findAllByText('tools/call')).length).toBe(2);
    expect(screen.getAllByText('notes').length).toBeGreaterThan(0);
    expect(screen.getAllByText(/tool call tool_call → notes__echo/).length).toBeGreaterThan(0);
  });
});
