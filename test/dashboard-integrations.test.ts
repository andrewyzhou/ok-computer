import { afterEach, describe, expect, it } from 'vitest';
import type { IntegrationDetail, IntegrationSummary, McpMessageRow, RunDetail } from '../src/dashboard/types.js';
import { seedIntegrations } from './seed-integrations.js';

let stop: (() => Promise<void>) | undefined;
afterEach(async () => {
  await stop?.();
  stop = undefined;
});

async function seeded() {
  const seed = await seedIntegrations();
  stop = () => seed.t.app.stop();
  const get = async <T>(path: string): Promise<T> => {
    const response = await seed.dashboard.request(path);
    expect(response.status, path).toBe(200);
    return (await response.json()) as T;
  };
  const post = (path: string, body: unknown = {}) =>
    seed.dashboard.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { ...seed, get, post };
}

describe('the integrations api', () => {
  it('lists each integration with its state, its tools with the source of their risk, and the names that do not match', async () => {
    const { get } = await seeded();
    const [notes] = await get<IntegrationSummary[]>('/api/integrations');
    expect(notes).toMatchObject({
      id: 'notes',
      kind: 'mcp-stdio',
      target: 'notes-server --pinned 1.2.3',
      paused: false,
      auth: 'none',
      state: { status: 'connected', server: { name: 'okc-test-server', version: '1.2.3' } },
      missing: ['ghost'],
      unknown: [],
      hidden: ['broken', 'crash', 'hang', 'hidden_admin', 'long_report', 'slow'],
      calls24h: 4,
      errors24h: 0,
    });
    expect(notes!.tools.map((tool) => [tool.name, tool.risk, tool.riskFrom])).toEqual([
      ['notes__add_note', 'external', 'default: the server does not say read only'],
      ['notes__calendar_lookup', 'read', 'okc.integrations.json'],
      ['notes__echo', 'read', 'okc.integrations.json'],
      ['notes__grow', 'read', 'okc.integrations.json'],
      ['notes__reword', 'read', 'okc.integrations.json'],
    ]);
  });

  it('gives the tool list versions with each change, the calls with their outcome word, and the messages', async () => {
    const { get } = await seeded();
    const detail = await get<IntegrationDetail>('/api/integrations/notes');
    // the newest version is first. a new description of an allowed tool is a change the owner must see.
    expect(detail.catalogs.map((version) => version.diff)).toEqual([
      { added: [], removed: [], changed: [{ name: 'notes__echo', fields: ['description'] }] },
      { added: ['notes__calendar_lookup'], removed: [], changed: [] },
      null,
    ]);
    // the two calls of one model turn run at the same time, so their rows can come in either order.
    expect(detail.calls.map((call) => [call.name, call.outcome]).sort()).toEqual([
      ['notes__add_note', 'waiting'],
      ['notes__echo', 'ran'],
      ['notes__grow', 'ran'],
      ['notes__reword', 'ran'],
    ]);
    expect(detail.messages.map((message) => `${message.direction} ${message.method}`)).toEqual(
      expect.arrayContaining(['in tools/call', 'out tools/list', 'in notifications/tools/list_changed']),
    );
  });

  it('shows the json-rpc messages of a call in the run timeline, and the full payload of one message', async () => {
    const { get } = await seeded();
    const run = await get<RunDetail>('/api/runs/run-1');
    const tools = run.timeline.flatMap((item) => (item.kind === 'model' ? item.tools : [item.call]));
    const echo = tools.find((tool) => tool.name === 'notes__echo')!;
    expect(echo.serverId).toBe('notes');
    expect(echo.mcpMessages.map((message) => `${message.direction} ${message.method}`)).toEqual(['out tools/call', 'in tools/call']);
    const full = await get<McpMessageRow>(`/api/mcp-messages/${echo.mcpMessages[1]!.id}`);
    expect(full.payload).toMatchObject({ result: { content: [{ type: 'text', text: 'hello' }] } });
    // a built-in tool has no server and no messages.
    expect(tools.every((tool) => tool.serverId === 'notes' || tool.mcpMessages.length === 0)).toBe(true);
  });

  it('pauses an integration, resumes it with connect, and refuses an unknown id', async () => {
    const { t, dashboard, get, post } = await seeded();
    expect(await (await post('/api/integrations/notes/pause', { paused: true })).json()).toEqual({ paused: true });
    expect((await get<IntegrationSummary[]>('/api/integrations'))[0]).toMatchObject({ paused: true, state: { status: 'stopped' } });
    expect(await (await post('/api/integrations/notes/connect')).json()).toEqual({ connected: true });
    expect(t.app.integrations.status()[0]).toMatchObject({ paused: false, state: { status: 'connected' } });
    expect((await post('/api/integrations/nope/connect')).status).toBe(404);
    expect((await dashboard.request('/api/integrations/nope')).status).toBe(404);
  });

  it('refuses a pasted sign-in address when no sign-in waits', async () => {
    const { post } = await seeded();
    const response = await post('/api/integrations/callback', { url: 'https://127.0.0.1:4318/oauth/callback?code=x&state=y' });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'No integration signs in with OAuth.' });
    expect((await post('/api/integrations/callback', { url: 'x', extra: 1 })).status).toBe(400);
  });
});

