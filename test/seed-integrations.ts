import { InMemoryTransport, type Transport } from '@modelcontextprotocol/client';
import { expect } from 'vitest';
import { createDashboard } from '../src/dashboard/server.js';
import { parseIntegrations } from '../src/integrations/config.js';
import { fakeResponse, textStep, toolStep } from '../src/models/fake.js';
import { silentLogger } from '../src/observability/logger.js';
import { createTestApp } from './app-harness.js';
import { createTestServer } from './mcp-server.js';

// tools.allow names ghost, which the server does not have.
export function notesIntegration() {
  const parsed = parseIntegrations({
    integrations: [
      {
        id: 'notes',
        kind: 'mcp-stdio',
        command: 'notes-server',
        args: ['--pinned', '1.2.3'],
        tools: { allow: ['echo', 'add_note', 'grow', 'reword', 'calendar_lookup', 'ghost'] },
        risk: { echo: 'read', grow: 'read', reword: 'read', calendar_lookup: 'read' },
      },
    ],
  });
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
}

// one integration with calls that ran, two changes of its tool list (a new tool, and a new description of an allowed
// tool), and a call that waits for the owner. the dashboard api tests and the page tests use it.
export async function seedIntegrations() {
  const transport = async (): Promise<Transport> => {
    const [client, server] = InMemoryTransport.createLinkedPair();
    await createTestServer().connect(server);
    return client;
  };
  let t: ReturnType<typeof createTestApp>;
  // the server sends list_changed after grow and reword. the client reads the new list after its debounce.
  const versions = (n: number) => async () => {
    await expect.poll(() => t.rows("SELECT id FROM integration_catalogs WHERE integrationId = 'notes'").length, { timeout: 5_000 }).toBe(n);
  };
  const afterGrow = versions(2);
  const afterReword = versions(3);
  t = createTestApp(
    [
      toolStep(
        { id: 'call-echo', name: 'tool_call', input: { name: 'notes__echo', arguments: { text: 'hello' } } },
        { id: 'call-grow', name: 'tool_call', input: { name: 'notes__grow', arguments: {} } },
      ),
      async () => {
        await afterGrow();
        return fakeResponse(toolStep({ id: 'call-reword', name: 'tool_call', input: { name: 'notes__reword', arguments: {} } }));
      },
      async () => {
        await afterReword();
        return fakeResponse(toolStep({ id: 'call-note', name: 'tool_call', input: { name: 'notes__add_note', arguments: { note: 'buy milk' } } }));
      },
      textStep('asked the owner'),
    ],
    { start: '2026-10-13T03:15:00Z', deps: { integrations: notesIntegration(), mcpTransport: transport } },
  );
  await t.app.start();
  await expect.poll(() => t.app.integrations.status()[0]!.state.status).toBe('connected');
  await t.say('note that I need milk');
  const dashboard = createDashboard({ db: t.db, config: t.config, clock: t.clock, logger: silentLogger, app: t.app });
  return { t, dashboard };
}
