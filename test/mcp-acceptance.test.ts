import { join } from 'node:path';
import { InMemoryTransport, type Transport } from '@modelcontextprotocol/client';
import type { McpServer } from '@modelcontextprotocol/server';
import { afterEach, describe, expect, it } from 'vitest';
import { createDashboard } from '../src/dashboard/server.js';
import { openDb } from '../src/db/index.js';
import type { IntegrationStatus } from '../src/integrations/integrations.js';
import { silentLogger } from '../src/observability/logger.js';
import { listEvents } from '../src/events/log.js';
import { parseIntegrations, type IntegrationEntry } from '../src/integrations/config.js';
import { textStep, toolStep } from '../src/models/fake.js';
import { sessionTaint } from '../src/policy/store.js';
import { createTestApp } from './app-harness.js';
import { createTestServer } from './mcp-server.js';

const FIXTURE = join(import.meta.dirname, 'fixtures/stdio-server.ts');
const start = '2026-10-13T09:00:00-07:00';

function notesEntry(extra: Record<string, unknown> = {}): IntegrationEntry {
  const parsed = parseIntegrations({
    integrations: [
      {
        id: 'notes',
        kind: 'mcp-stdio',
        command: process.execPath,
        args: ['--import', 'tsx', FIXTURE],
        tools: { allow: ['echo', 'add_note', 'grow', 'calendar_lookup', 'slow', 'long_report'] },
        risk: { echo: 'read', grow: 'read', calendar_lookup: 'read', slow: 'read', long_report: 'read' },
        sessions: ['main', 'auto'],
        ...extra,
      },
    ],
  });
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value[0]!;
}

// each connection gets a new server, as a restart of a stdio process would.
function memoryServers(gate?: Promise<void>) {
  const servers: McpServer[] = [];
  const transport = async (): Promise<Transport> => {
    await gate;
    const [client, server] = InMemoryTransport.createLinkedPair();
    const instance = createTestServer();
    servers.push(instance);
    await instance.connect(server);
    return client;
  };
  return { servers, transport };
}

const apps: Array<{ app: { stop(): Promise<void> } }> = [];
afterEach(async () => {
  for (const each of apps.splice(0)) await each.app.stop();
});

const call = (id: string, name: string, args: Record<string, unknown> = {}) => toolStep({ id, name: 'tool_call', input: { name, arguments: args } });
const search = (id: string, query: string) => toolStep({ id, name: 'tool_search', input: { query } });

describe('mcp acceptance', () => {
  it('connects, searches and calls a server, traces every message, and keeps the tools parameter byte-stable when the catalog changes', async () => {
    const { transport } = memoryServers();
    const t = createTestApp(
      [
        search('s1', 'echo'),
        call('c1', 'notes__echo', { text: 'hi' }),
        textStep('It said hi.'),
        call('c2', 'notes__grow'),
        textStep('Grown.'),
        search('s2', 'calendar events'),
        call('c3', 'notes__calendar_lookup', { query: 'dentist' }),
        textStep('No events.'),
        call('c4', 'notes__add_note', { note: 'buy milk' }),
        textStep('It waits for your approval.'),
      ],
      { start, deps: { integrations: [notesEntry()], mcpTransport: transport } },
    );
    apps.push(t);
    await t.app.start();
    await expect.poll(() => t.app.integrations.status()[0]!.state.status).toBe('connected');

    await t.say('what does echo say?');
    await t.say('grow the server');
    // the server sends list_changed. the client waits for its debounce, then reads the new list.
    await expect.poll(() => t.app.integrations.status()[0]!.tools.map((tool) => tool.mcpName), { timeout: 5_000 }).toContain('calendar_lookup');
    await t.say('any calendar events about the dentist?');
    await t.say('add a note: buy milk');

    // the tools parameter is the same bytes in every request, before and after the catalog changed.
    const toolParams = new Set(t.model.calls.map((each) => JSON.stringify(each.tools)));
    expect(toolParams.size).toBe(1);
    const names = t.model.calls[0]!.tools.map((tool) => tool.name);
    expect(names).toContain('tool_search');
    expect(names).toContain('tool_call');
    expect(names.some((name) => name.startsWith('notes__'))).toBe(false);
    // the heartbeat and the consolidation see no integration, so they keep their small fixed tool lists.
    expect(t.app.integrations.allowedNames('heartbeat:run-9')).toEqual([]);
    expect(t.app.integrations.allowedNames('consolidate:2026-10-13')).toEqual([]);

    // the search found the new tool, and its text was wrapped as untrusted catalog text.
    const results = listEvents(t.db, 'main').filter((event) => event.type === 'tool_result');
    const found = results.find((event) => (event.payload as { toolCallId: string }).toolCallId === 's2')!.payload as { content: string };
    expect(found.content).toContain('notes__calendar_lookup');
    expect(found.content).toContain('<untrusted source="mcp catalog: notes"');

    // the trace and the policy see the real tool, never tool_call.
    const rows = t.rows("SELECT toolCallId, name, input, source, serverId FROM tool_calls WHERE source = 'mcp' ORDER BY id");
    expect(rows).toEqual([
      { toolCallId: 'c1', name: 'notes__echo', input: '{"text":"hi"}', source: 'mcp', serverId: 'notes' },
      { toolCallId: 'c2', name: 'notes__grow', input: '{}', source: 'mcp', serverId: 'notes' },
      { toolCallId: 'c3', name: 'notes__calendar_lookup', input: '{"query":"dentist"}', source: 'mcp', serverId: 'notes' },
      { toolCallId: 'c4', name: 'notes__add_note', input: '{"note":"buy milk"}', source: 'mcp', serverId: 'notes' },
    ]);
    expect(t.rows("SELECT toolName, decision FROM policy_decisions WHERE toolCallId = 'c4'")).toEqual([
      { toolName: 'notes__add_note', decision: 'approve' },
    ]);

    // every call that ran has its request and its answer in mcp_messages, with the run and the call.
    for (const id of ['c1', 'c2', 'c3']) {
      expect(t.rows('SELECT direction, method FROM mcp_messages WHERE toolCallId = ? ORDER BY id', id)).toEqual([
        { direction: 'out', method: 'tools/call' },
        { direction: 'in', method: 'tools/call' },
      ]);
    }
    expect(t.rows("SELECT count(*) AS n FROM mcp_messages WHERE method = 'notifications/tools/list_changed'")).toEqual([{ n: 1 }]);
    expect(t.rows("SELECT count(*) AS n FROM integration_catalogs WHERE integrationId = 'notes'")).toEqual([{ n: 2 }]);

    // the owner approves. the approval finds the tool by its name and runs it on the original run.
    const approval = t.rows("SELECT id FROM approvals WHERE toolName = 'notes__add_note'")[0] as { id: number };
    await t.app.resolveApproval(approval.id, 'approve', 'dashboard');
    await t.settle();
    expect(t.rows("SELECT name, output, source FROM tool_calls WHERE toolCallId = ?", `approval-${approval.id}`)).toEqual([
      { name: 'notes__add_note', output: expect.stringContaining('saved: buy milk'), source: 'mcp' },
    ]);
    expect(t.rows("SELECT count(*) AS n FROM mcp_messages WHERE toolCallId = ? AND method = 'tools/call'", `approval-${approval.id}`)).toEqual([{ n: 2 }]);
    // the output of the server is untrusted, so the session is tainted.
    expect(sessionTaint(t.db, 'main').map((each) => each.source)).toContain('mcp:notes');
  });

  it('finds the stored catalog after a restart, and a call before the slow server connects does not run', async () => {
    const db = openDb(':memory:');
    const first = memoryServers();
    const t1 = createTestApp([], { start, deps: { db, integrations: [notesEntry()], mcpTransport: first.transport } });
    await t1.app.start();
    await expect.poll(() => t1.app.integrations.status()[0]!.state.status).toBe('connected');
    await t1.app.stop();

    let release = () => {};
    const second = memoryServers(new Promise<void>((resolve) => (release = resolve)));
    const t2 = createTestApp(
      [
        search('s1', 'echo'),
        call('c1', 'notes__echo', { text: 'too early' }),
        textStep('It is not connected yet.'),
        call('c2', 'notes__echo', { text: 'after restart' }),
        textStep('Done.'),
      ],
      { start, deps: { db, integrations: [notesEntry()], mcpTransport: second.transport } },
    );
    apps.push(t2);
    await t2.app.start();
    expect(t2.app.integrations.status()[0]).toMatchObject({ state: { status: 'connecting' }, catalogStored: true });
    await t2.say('echo after restart');
    release();
    await expect.poll(() => t2.app.integrations.status()[0]!.state.status).toBe('connected');
    await t2.say('try again');
    const results = listEvents(db, 'main').filter((event) => event.type === 'tool_result').map((event) => (event.payload as { content: string }).content);
    expect(results[0]).toContain('server connecting');
    expect(results[1]).toContain('notes__echo did not run: notes is not connected yet. The app connects it now; try again in a moment.');
    expect(results[2]).toContain('after restart');
    // the early call never reached the server, so only the second call has a tools/call request.
    expect(db.prepare("SELECT toolCallId FROM mcp_messages WHERE method = 'tools/call' AND direction = 'out'").all()).toEqual([{ toolCallId: 'c2' }]);
  });

  it('records a late result when the run stopped while the server worked', async () => {
    const { transport } = memoryServers();
    const t = createTestApp([call('c1', 'notes__slow', { ms: 400 }), textStep('never reached')], {
      start,
      config: { agent: { chatTimeoutMs: 100 } },
      deps: { integrations: [notesEntry()], mcpTransport: transport },
    });
    apps.push(t);
    await t.app.start();
    await expect.poll(() => t.app.integrations.status()[0]!.state.status).toBe('connected');
    await t.say('be slow');
    expect(t.rows("SELECT outcome FROM tool_calls WHERE toolCallId = 'c1'")).toEqual([{ outcome: 'abandoned' }]);
    // the sdk did not cancel the request, so the answer arrives and goes into the same row and the session.
    await expect.poll(() => t.rows("SELECT outcome FROM tool_calls WHERE toolCallId = 'c1'"), { timeout: 3_000 }).toEqual([{ outcome: 'late' }]);
    expect(t.rows("SELECT count(*) AS n FROM mcp_messages WHERE method = 'notifications/cancelled'")).toEqual([{ n: 0 }]);
    await t.settle();
    const late = listEvents(t.db, 'main').filter((event) => event.type === 'system_event').map((event) => (event.payload as { text: string }).text);
    expect(late.some((text) => text.includes('done after 400 ms'))).toBe(true);
  });

  it('refuses an argument that does not match the schema before the policy and the server see it', async () => {
    const { transport } = memoryServers();
    const t = createTestApp([call('c1', 'notes__echo', { text: 42 }), call('c2', 'notes__hidden_admin'), call('c3', 'now'), textStep('ok')], {
      start,
      deps: { integrations: [notesEntry()], mcpTransport: transport },
    });
    apps.push(t);
    await t.app.start();
    await expect.poll(() => t.app.integrations.status()[0]!.state.status).toBe('connected');
    await t.say('try bad calls');
    const results = listEvents(t.db, 'main')
      .filter((event) => event.type === 'tool_result')
      .map((event) => (event.payload as { content: string }).content);
    expect(results[0]).toContain('invalid input for notes__echo');
    // a tool outside the allow list and a built-in tool are not reachable through tool_call.
    expect(results[1]).toContain('unknown integration tool: notes__hidden_admin');
    expect(results[2]).toContain('unknown integration tool: now');
    expect(t.rows("SELECT count(*) AS n FROM mcp_messages WHERE method = 'tools/call'")).toEqual([{ n: 0 }]);
    expect(t.rows('SELECT count(*) AS n FROM policy_decisions')).toEqual([{ n: 0 }]);
  });

  it('changes nothing for an app without integrations, so an upgrade keeps the cached prefix', async () => {
    const t = createTestApp([textStep('hi')], { start });
    apps.push(t);
    await t.app.start();
    await t.say('hello');
    const names = t.model.calls[0]!.tools.map((tool) => tool.name);
    expect(names).not.toContain('tool_search');
    expect(names).not.toContain('tool_call');
  });

  it('gives a second process the same tools, but it never connects', async () => {
    const db = openDb(':memory:');
    const first = memoryServers();
    const service = createTestApp([textStep('hi')], { start, deps: { db, integrations: [notesEntry()], mcpTransport: first.transport } });
    apps.push(service);
    await service.app.start();
    await expect.poll(() => service.app.integrations.status()[0]!.state.status).toBe('connected');
    await service.say('hello');

    const second = memoryServers();
    let chatRuns = 0;
    const chat = createTestApp([call('c1', 'notes__echo', { text: 'x' }), textStep('ok')], {
      start,
      deps: { db, integrations: [notesEntry()], mcpTransport: second.transport, connectIntegrations: false, newId: () => `chat-${++chatRuns}` },
    });
    apps.push(chat);
    await chat.app.start();
    await chat.say('echo from the chat process');
    expect(JSON.stringify(chat.model.calls[0]!.tools)).toBe(JSON.stringify(service.model.calls[0]!.tools));
    expect(second.servers).toHaveLength(0);
    expect(db.prepare("SELECT output FROM tool_calls WHERE toolCallId = 'c1'").all()).toEqual([{ output: expect.stringContaining('did not run: notes is stopped') }]);
  });

  it('shows each integration on the dashboard api, and a pause stays over a restart', async () => {
    const db = openDb(':memory:');
    const { transport } = memoryServers();
    const t = createTestApp([], { start, deps: { db, integrations: [notesEntry()], mcpTransport: transport } });
    apps.push(t);
    await t.app.start();
    await expect.poll(() => t.app.integrations.status()[0]!.state.status).toBe('connected');
    const dashboard = createDashboard({ db, config: t.config, clock: t.clock, logger: silentLogger, app: t.app });
    const status = (await (await dashboard.request('/api/integrations')).json()) as IntegrationStatus[];
    expect(status[0]).toMatchObject({ id: 'notes', state: { status: 'connected' }, paused: false, rejected: [{ mcpName: 'calendar_lookup' }] });
    expect(status[0]!.tools.map((tool) => tool.name)).toContain('notes__echo');

    const json = (body: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    expect((await dashboard.request('/api/integrations/notes/pause', json({ paused: true }))).status).toBe(200);
    expect(t.app.integrations.status()[0]).toMatchObject({ paused: true, state: { status: 'stopped' } });
    expect((await dashboard.request('/api/integrations/nope/pause', json({ paused: true }))).status).toBe(404);
    expect(await (await dashboard.request('/api/integrations/notes/connect', json({}))).json()).toEqual({ error: 'notes does not use oauth' });

    const again = memoryServers();
    const restarted = createTestApp([], { start, deps: { db, integrations: [notesEntry()], mcpTransport: again.transport } });
    apps.push(restarted);
    await restarted.app.start();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(again.servers).toHaveLength(0);
    const history = (await (await createDashboard({ db, config: t.config, clock: t.clock, logger: silentLogger, app: restarted.app }).request('/api/integrations/notes/catalogs')).json()) as unknown[];
    expect(history).toHaveLength(1);
  });

  it('does not run an approved call when its tool is gone or its input no longer matches the schema', async () => {
    const db = openDb(':memory:');
    const first = memoryServers();
    const t1 = createTestApp([call('c1', 'notes__add_note', { note: 'one' }), call('c2', 'notes__add_note', { note: 'two' }), textStep('waiting')], {
      start,
      deps: { db, integrations: [notesEntry()], mcpTransport: first.transport },
    });
    await t1.app.start();
    await expect.poll(() => t1.app.integrations.status()[0]!.state.status).toBe('connected');
    await t1.say('add two notes');
    await t1.app.stop();
    const [one, two] = db.prepare("SELECT id FROM approvals ORDER BY id").all() as Array<{ id: number }>;

    // after a restart, the server's add_note needs a field that the stored input does not have.
    const changed = async (): Promise<Transport> => {
      const [client, server] = InMemoryTransport.createLinkedPair();
      await createTestServer({ needsBook: true }).connect(server);
      return client;
    };
    let ids = 0;
    const t2 = createTestApp([], { start, deps: { db, integrations: [notesEntry()], mcpTransport: changed, newId: () => `t2-${++ids}` } });
    apps.push(t2);
    await t2.app.start();
    await expect.poll(() => t2.app.integrations.status()[0]!.state.status).toBe('connected');
    expect(await t2.app.resolveApproval(one!.id, 'approve', 'dashboard')).toBeTypeOf('string');
    await t2.settle();
    expect(db.prepare('SELECT output FROM tool_calls WHERE toolCallId = ?').get(`approval-${one!.id}`)).toEqual({
      output: expect.stringContaining('invalid input for notes__add_note'),
    });

    // the owner removed the integration from the config. the approved call finds no tool and does not run.
    const t3 = createTestApp([], { start, deps: { db, newId: () => `t3-${++ids}` } });
    apps.push(t3);
    await t3.app.start();
    await t3.app.resolveApproval(two!.id, 'approve', 'dashboard');
    await t3.settle();
    expect(db.prepare('SELECT output FROM tool_calls WHERE toolCallId = ?').get(`approval-${two!.id}`)).toEqual({
      output: expect.stringContaining('unknown tool: notes__add_note'),
    });
    expect(db.prepare("SELECT count(*) AS n FROM mcp_messages WHERE method = 'tools/call' AND toolCallId LIKE 'approval-%'").get()).toEqual({ n: 0 });
  });

  it('works with a real stdio server', async () => {
    const t = createTestApp([search('s1', 'echo'), call('c1', 'notes__echo', { text: 'from a child process' }), textStep('ok')], {
      start,
      deps: { integrations: [notesEntry()] },
    });
    apps.push(t);
    await t.app.start();
    await expect.poll(() => t.app.integrations.status()[0]!.state.status, { timeout: 15_000 }).toBe('connected');
    await t.say('echo through stdio');
    expect(t.rows("SELECT output FROM tool_calls WHERE toolCallId = 'c1'")).toEqual([{ output: expect.stringContaining('from a child process') }]);
    expect(t.rows("SELECT count(*) AS n FROM mcp_messages WHERE toolCallId = 'c1'")).toEqual([{ n: 2 }]);
  }, 30_000);
});
