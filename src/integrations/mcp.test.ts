import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryTransport, type Transport } from '@modelcontextprotocol/client';
import type { McpServer } from '@modelcontextprotocol/server';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestServer } from '../../test/mcp-server.js';
import { openDb } from '../db/index.js';
import { createBlobStore, type BlobStore } from '../observability/blobs.js';
import { silentLogger, type Logger } from '../observability/logger.js';
import { parseIntegrations, type StdioEntry } from './config.js';
import { createMcpConnection, HEALTHY_AFTER_MS, type CallOutcome, type McpConnection, type McpTool } from './mcp.js';
import { createMemorySecretStore } from './secrets.js';
import { stdioTransport } from './transports.js';

const FIXTURE = join(import.meta.dirname, '../../test/fixtures/stdio-server.ts');

// servers holds each server that a memory transport started, so a test can close it from the server side.
export function memoryTransport(servers: McpServer[] = []): () => Promise<Transport> {
  return async () => {
    const [client, server] = InMemoryTransport.createLinkedPair();
    const instance = createTestServer();
    servers.push(instance);
    await instance.connect(server);
    return client;
  };
}

const open: McpConnection[] = [];
afterEach(async () => {
  for (const connection of open.splice(0)) await connection.stop();
});

function setup(transport: () => Promise<Transport>, options: { logger?: Logger; blobs?: (real: BlobStore) => BlobStore } = {}) {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO runs (id, sessionKey, trigger, slot, status, startedAt) VALUES ('r1', 'main', 'message', 'main', 'running', 'x')").run();
  let now = new Date('2026-10-13T03:15:00Z').getTime();
  const clock = () => new Date(now);
  const real = createBlobStore(db, mkdtempSync(join(tmpdir(), 'okc-mcp-')), clock);
  const blobs = options.blobs ? options.blobs(real) : real;
  const lists: string[][] = [];
  const timers: Array<{ fn: () => void; ms: number }> = [];
  const connection = createMcpConnection({
    id: 'notes',
    db,
    blobs,
    logger: options.logger ?? silentLogger,
    clock,
    transport,
    onTools: (tools: McpTool[]) => lists.push(tools.map((tool) => tool.name)),
    setTimer: (fn, ms) => {
      const timer = { fn, ms };
      timers.push(timer);
      return () => {
        const at = timers.indexOf(timer);
        if (at >= 0) timers.splice(at, 1);
      };
    },
  });
  open.push(connection);
  const messages = () =>
    db.prepare('SELECT direction, method, rpcId, runId, toolCallId, payload, payloadBlob, latencyMs FROM mcp_messages ORDER BY id').all();
  // fire runs the timer with the given delay, so a test can move through the backoff.
  const fire = (ms: number) => {
    const timer = timers.find((each) => each.ms === ms);
    if (!timer) throw new Error(`no timer of ${ms} ms, only ${timers.map((each) => each.ms).join(', ')}`);
    timers.splice(timers.indexOf(timer), 1);
    timer.fn();
  };
  return { db, blobs, connection, lists, timers, messages, fire, advance: (ms: number) => (now += ms) };
}

const trace = { runId: 'r1', toolCallId: 'call-1' };
const resultOf = (outcome: CallOutcome) => {
  if (outcome.kind !== 'result') throw new Error(`expected a result, got ${JSON.stringify(outcome)}`);
  return outcome.result;
};

describe('mcp connection', () => {
  it('records every json-rpc message, and links a tool call to its run', async () => {
    const { connection, lists, messages } = setup(memoryTransport());
    await connection.start();
    expect(connection.state()).toMatchObject({ status: 'connected', server: { name: 'okc-test-server', version: '1.2.3' } });
    expect(lists[0]).toContain('echo');

    expect(resultOf(await connection.callTool('echo', { text: 'hello' }, trace)).content).toEqual([{ type: 'text', text: 'hello' }]);

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
    await connection.callTool('long_report', {}, trace);
    const response = messages().at(-1)!;
    expect(response.payload).toBeNull();
    expect(blobs.read(String(response.payloadBlob))).toContain('report line 1999');
  });

  it('gives the new tool list when the server changes its catalog', async () => {
    const { connection, lists, messages } = setup(memoryTransport());
    await connection.start();
    await connection.callTool('grow', {}, trace);
    await expect.poll(() => lists.length, { timeout: 3_000 }).toBe(2);
    expect(lists[1]).toContain('calendar_lookup');
    expect(messages().map((row) => row.method)).toContain('notifications/tools/list_changed');
  });

  it('retries a failed server with backoff', async () => {
    let attempts = 0;
    const flaky = memoryTransport();
    const { connection, timers, fire } = setup(async () => {
      if (++attempts < 3) throw new Error('spawn failed');
      return flaky();
    });
    await connection.start();
    expect(connection.state()).toMatchObject({ status: 'error', error: 'spawn failed' });
    expect(timers.map((timer) => timer.ms)).toEqual([1_000]);
    fire(1_000);
    await expect.poll(() => timers[0]?.ms).toBe(5_000);
    fire(5_000);
    await expect.poll(() => connection.state().status).toBe('connected');
  });
});

describe('mcp connection failure modes', () => {
  it('keeps the backoff for a server that crashes just after each start, and resets it after a healthy period', async () => {
    const servers: McpServer[] = [];
    const { connection, fire, timers, advance } = setup(memoryTransport(servers));
    await connection.start();
    // the server dies at once, three times. each retry waits longer, so a crash loop cannot spawn a process each second.
    for (const delay of [1_000, 5_000, 30_000]) {
      await servers.at(-1)!.close();
      await expect.poll(() => timers.some((timer) => timer.ms === delay)).toBe(true);
      fire(delay);
      await expect.poll(() => connection.state().status).toBe('connected');
    }
    // a connection that stayed up past the healthy period starts the backoff from the first delay again.
    advance(HEALTHY_AFTER_MS);
    await servers.at(-1)!.close();
    await expect.poll(() => connection.state().status).toBe('error');
    expect(timers.map((timer) => timer.ms)).toContain(1_000);
  });

  it('closes an attempt that a stop overtook, so no client stays alive', async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    let closed = false;
    const make = memoryTransport();
    const { connection } = setup(async () => {
      await gate;
      const transport = await make();
      const close = transport.close.bind(transport);
      transport.close = async () => {
        closed = true;
        await close();
      };
      return transport;
    });
    const starting = connection.start();
    await connection.stop();
    release();
    await starting;
    expect(connection.state().status).toBe('stopped');
    expect(closed).toBe(true);
    expect((await connection.callTool('echo', { text: 'x' }, trace)).kind).toBe('not_sent');
  });

  it('starts one client when start is called twice', async () => {
    let made = 0;
    const make = memoryTransport();
    const { connection, messages } = setup(async () => {
      made++;
      return make();
    });
    await Promise.all([connection.start(), connection.start()]);
    expect(made).toBe(1);
    expect(messages().filter((row) => row.method === 'initialize' && row.direction === 'out')).toHaveLength(1);
  });

  it('still delivers an answer whose trace write failed, because the server already acted', async () => {
    const errors: string[] = [];
    const logger: Logger = { ...silentLogger, error: (msg) => void errors.push(msg) };
    const { connection } = setup(memoryTransport(), {
      logger,
      blobs: (real) => ({
        ...real,
        put: () => {
          throw new Error('EPERM: the scanner holds the file');
        },
      }),
    });
    await connection.start();
    // the answer of long_report is over 8 kb, so its record needs the blob store, which fails.
    const outcome = await connection.callTool('long_report', {}, trace);
    expect(resultOf(outcome).content).toHaveLength(1);
    expect(errors).toContain('mcp message trace write failed');
  });

  it('does not send a request whose trace write failed, and says that the tool did not run', async () => {
    const { connection, messages } = setup(memoryTransport(), {
      blobs: (real) => ({
        ...real,
        put: () => {
          throw new Error('ENOSPC: the disk is full');
        },
      }),
    });
    await connection.start();
    const outcome = await connection.callTool('add_note', { note: 'x'.repeat(9_000) }, trace);
    expect(outcome).toMatchObject({ kind: 'not_sent', reason: expect.stringContaining('ENOSPC') });
    // the server never saw the call: there is no answer for it.
    expect(messages().filter((row) => row.method === 'tools/call')).toHaveLength(0);
  });

  it('says that the effect is unknown when the connection closes during a call', async () => {
    const servers: McpServer[] = [];
    const { connection } = setup(memoryTransport(servers));
    await connection.start();
    const pending = connection.callTool('hang', {}, trace);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await servers[0]!.close();
    expect(await pending).toMatchObject({ kind: 'unknown', reason: expect.stringContaining('Connection closed') });
  });

  it('waits past the sdk default timeout and has no cancel on the run signal', async () => {
    const { connection, messages } = setup(memoryTransport());
    await connection.start();
    expect(resultOf(await connection.callTool('slow', { ms: 50 }, trace)).content).toEqual([{ type: 'text', text: 'done after 50 ms' }]);
    expect(messages().map((row) => row.method)).not.toContain('notifications/cancelled');
  });

  it('reports a json-rpc error from the server as refused', async () => {
    const { connection } = setup(memoryTransport());
    await connection.start();
    const outcome = await connection.callTool('echo', { text: 42 }, trace);
    // the sdk server answers invalid arguments with an error result or a json-rpc error, depending on the version.
    if (outcome.kind === 'result') expect(outcome.result.isError).toBe(true);
    else expect(outcome).toMatchObject({ kind: 'refused', code: -32602 });
  });

  it('lets a caller wait for the first connection, and gives up on a server that needs the owner', async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const make = memoryTransport();
    const { connection } = setup(async () => {
      await gate;
      return make();
    });
    const starting = connection.start();
    const ready = connection.ready(5_000, new AbortController().signal);
    release();
    await starting;
    expect(await ready).toBe(true);
    const stopped = new AbortController();
    stopped.abort();
    expect(await connection.ready(5_000, stopped.signal)).toBe(true);
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
    const { connection, fire } = setup(() => stdioTransport(entry, secrets, logger), { logger });

    await connection.start();
    expect(connection.state().status).toBe('connected');
    await expect.poll(() => lines).toContain('test server ready');
    expect(resultOf(await connection.callTool('echo', { text: 'from a child' }, trace)).content).toEqual([
      { type: 'text', text: 'from a child' },
    ]);

    await connection.callTool('crash', {}, trace);
    await expect.poll(() => connection.state().status).toBe('error');
    fire(1_000);
    await expect.poll(() => connection.state().status, { timeout: 10_000 }).toBe('connected');
  }, 20_000);
});
