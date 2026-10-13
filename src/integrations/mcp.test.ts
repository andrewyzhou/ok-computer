import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryTransport, type Transport } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestServer } from '../../test/mcp-server.js';
import { openDb } from '../db/index.js';
import { createBlobStore } from '../observability/blobs.js';
import { silentLogger, type Logger } from '../observability/logger.js';
import { parseIntegrations, type StdioEntry } from './config.js';
import { createMcpConnection, type McpConnection, type McpTool } from './mcp.js';
import { createMemorySecretStore } from './secrets.js';
import { stdioTransport } from './transports.js';

const FIXTURE = join(import.meta.dirname, '../../test/fixtures/stdio-server.ts');
const clock = () => new Date('2026-10-13T03:15:00Z');

export function memoryTransport(): () => Promise<Transport> {
  return async () => {
    const [client, server] = InMemoryTransport.createLinkedPair();
    await createTestServer().connect(server);
    return client;
  };
}

const open: McpConnection[] = [];
afterEach(async () => {
  for (const connection of open.splice(0)) await connection.stop();
});

function setup(transport: () => Promise<Transport>, logger: Logger = silentLogger) {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO runs (id, sessionKey, trigger, slot, status, startedAt) VALUES ('r1', 'main', 'message', 'main', 'running', 'x')").run();
  const blobs = createBlobStore(db, mkdtempSync(join(tmpdir(), 'okc-mcp-')), clock);
  const lists: string[][] = [];
  const timers: Array<{ fn: () => void; ms: number }> = [];
  const connection = createMcpConnection({
    id: 'notes',
    db,
    blobs,
    logger,
    clock,
    transport,
    onTools: (tools: McpTool[]) => lists.push(tools.map((tool) => tool.name)),
    setTimer: (fn, ms) => {
      const timer = { fn, ms };
      timers.push(timer);
      return () => timers.splice(timers.indexOf(timer), 1);
    },
  });
  open.push(connection);
  const messages = () =>
    db.prepare('SELECT direction, method, rpcId, runId, toolCallId, payload, payloadBlob, latencyMs FROM mcp_messages ORDER BY id').all();
  return { db, blobs, connection, lists, timers, messages };
}

const trace = { runId: 'r1', toolCallId: 'call-1' };
const signal = new AbortController().signal;

describe('mcp connection', () => {
  it('records every json-rpc message, and links a tool call to its run', async () => {
    const { connection, lists, messages } = setup(memoryTransport());
    await connection.start();
    expect(connection.state()).toMatchObject({ status: 'connected', server: { name: 'okc-test-server', version: '1.2.3' } });
    expect(lists[0]).toContain('echo');

    const result = await connection.callTool('echo', { text: 'hello' }, trace, signal);
    expect(result.content).toEqual([{ type: 'text', text: 'hello' }]);

    const rows = messages();
    expect(rows.map((row) => `${row.direction} ${row.method}`)).toEqual([
      'out initialize',
      'in initialize',
      'out notifications/initialized',
      'out tools/list',
      'in tools/list',
      'out tools/call',
      'in tools/call',
    ]);
    const [request, response] = rows.slice(-2);
    expect(request).toMatchObject({ runId: 'r1', toolCallId: 'call-1', rpcId: response!.rpcId, latencyMs: null });
    expect(response).toMatchObject({ runId: 'r1', toolCallId: 'call-1' });
    expect(response!.latencyMs).toBeTypeOf('number');
    expect(JSON.parse(String(request!.payload))).toMatchObject({ method: 'tools/call', params: { name: 'echo', arguments: { text: 'hello' } } });
    expect(rows[3]).toMatchObject({ runId: null, toolCallId: null });
  });

  it('puts a message over 8 kb in the blob store', async () => {
    const { connection, blobs, messages } = setup(memoryTransport());
    await connection.start();
    await connection.callTool('long_report', {}, trace, signal);
    const response = messages().at(-1)!;
    expect(response.payload).toBeNull();
    expect(blobs.read(String(response.payloadBlob))).toContain('report line 1999');
  });

  it('gives the new tool list when the server changes its catalog', async () => {
    const { connection, lists, messages } = setup(memoryTransport());
    await connection.start();
    await connection.callTool('grow', {}, trace, signal);
    await expect.poll(() => lists.length).toBe(2);
    expect(lists[1]).toContain('calendar_lookup');
    expect(messages().map((row) => row.method)).toContain('notifications/tools/list_changed');
  });

  it('retries a failed server with backoff', async () => {
    let attempts = 0;
    const flaky = memoryTransport();
    const { connection, timers } = setup(async () => {
      if (++attempts < 3) throw new Error('spawn failed');
      return flaky();
    });
    await connection.start();
    expect(connection.state()).toMatchObject({ status: 'error', error: 'spawn failed' });
    expect(timers.map((timer) => timer.ms)).toEqual([1_000]);
    timers.pop()!.fn();
    await expect.poll(() => timers[0]?.ms).toBe(5_000);
    timers.pop()!.fn();
    await expect.poll(() => connection.state().status).toBe('connected');
  });
});

describe('stdio server', () => {
  it('runs a child process, logs its stderr, and connects again after it stops', async () => {
    const lines: string[] = [];
    const logger: Logger = { ...silentLogger, info: (msg, fields) => void (msg === 'mcp server stderr' && lines.push(String(fields?.line))) };
    const parsed = parseIntegrations({
      integrations: [
        {
          id: 'notes',
          kind: 'mcp-stdio',
          command: process.execPath,
          args: ['--import', 'tsx', FIXTURE],
          env: { NOTES_TOKEN: { secretRef: 'notes-token' } },
          tools: { allow: ['echo'] },
        },
      ],
    });
    if (!parsed.ok) throw new Error(parsed.error);
    const entry = parsed.value[0] as StdioEntry;
    const secrets = createMemorySecretStore({ 'notes-token': 'secret-notes-token' });
    const { connection, timers } = setup(() => stdioTransport(entry, secrets, logger), logger);

    await connection.start();
    expect(connection.state().status).toBe('connected');
    await expect.poll(() => lines).toContain('test server ready');
    expect((await connection.callTool('echo', { text: 'from a child' }, trace, signal)).content).toEqual([
      { type: 'text', text: 'from a child' },
    ]);

    await connection.callTool('crash', {}, trace, signal);
    await expect.poll(() => connection.state().status).toBe('error');
    const retry = timers.find((timer) => timer.ms === 1_000)!;
    retry.fn();
    await expect.poll(() => connection.state().status, { timeout: 10_000 }).toBe('connected');
  }, 20_000);
});
