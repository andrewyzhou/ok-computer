import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryTransport, SdkError, SdkErrorCode, SdkHttpError, StreamableHTTPClientTransport, type Transport } from '@modelcontextprotocol/client';
import { WebStandardStreamableHTTPServerTransport, type McpServer } from '@modelcontextprotocol/server';
import { afterEach, describe, expect, it } from 'vitest';
import { createShapeServer, createTestServer } from '../../test/mcp-server.js';
import { openDb } from '../db/index.js';
import { createBlobStore, type BlobStore } from '../observability/blobs.js';
import { silentLogger, type Logger } from '../observability/logger.js';
import { registerSecret } from '../observability/redact.js';
import { parseIntegrations, type HttpEntry, type StdioEntry } from './config.js';
import { outcomeOutput } from './discovery.js';
import {
  classify,
  createMcpConnection,
  createMessageRecorder,
  HEALTHY_AFTER_MS,
  LIST_CHANGED_DEBOUNCE_MS,
  LIST_PAGES_LIMIT,
  NOTIFICATIONS_PER_MINUTE,
  OWN_LIMIT_PER_MINUTE,
  PING_EVERY_MS,
  REQUESTS_PER_MINUTE,
  type CallOutcome,
  type McpConnection,
  type McpTool,
} from './mcp.js';
import { createMemorySecretStore, CredentialStoreError } from './secrets.js';
import { httpTransport, MESSAGE_LIMIT, stdioTransport } from './transports.js';

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
// on windows the stop of a stdio server lists the processes of the system before and after the close, so it can end
// what the server started. one such list took more than 10 s on a busy ci machine, though it takes about 0.3 s.
afterEach(async () => {
  for (const connection of open.splice(0)) await connection.stop();
}, 30_000);

function setup(
  transport: () => Promise<Transport>,
  options: { logger?: Logger; blobs?: (real: BlobStore) => BlobStore; answerWaitMs?: number; refusedKeyHint?: string } = {},
) {
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
    onTools: (tools) => lists.push((tools as McpTool[]).map((tool) => tool.name)),
    ...(options.answerWaitMs ? { answerWaitMs: options.answerWaitMs } : {}),
    ...(options.refusedKeyHint ? { refusedKeyHint: options.refusedKeyHint } : {}),
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
    const { connection, messages } = setup(async () => {
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
    // the attempt gave up before the handshake, so a stdio server would not even start.
    expect(messages()).toEqual([]);
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
    const { connection, messages } = setup(memoryTransport(), {
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
    // the row of the answer stays without its payload, so the page does not show a request without an answer.
    const answer = messages().find((row) => row.direction === 'in' && row.method === 'tools/call')!;
    expect(answer).toMatchObject({ toolCallId: 'call-1', payloadBlob: null, latencyMs: expect.any(Number) });
    expect(String(answer.payload)).toContain('was not stored: EPERM');
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

  it('adds an unsent row when the transport refuses a request after its out row, so the trace agrees with not_sent', async () => {
    const make = memoryTransport();
    let refuse = false;
    const { connection, messages } = setup(async () => {
      const transport = await make();
      const send = transport.send.bind(transport);
      transport.send = async (message, options) => {
        if (refuse && 'method' in message && message.method === 'tools/call') throw new SdkError(SdkErrorCode.NotConnected, 'Not connected');
        return send(message, options);
      };
      return transport;
    });
    await connection.start();
    refuse = true;
    expect(await connection.callTool('echo', { text: 'x' }, trace)).toMatchObject({ kind: 'not_sent' });
    const rows = messages().filter((row) => row.method === 'tools/call');
    expect(rows).toEqual([
      expect.objectContaining({ direction: 'out', runId: 'r1', toolCallId: 'call-1' }),
      expect.objectContaining({ direction: 'unsent', rpcId: rows[0]!.rpcId, runId: 'r1', toolCallId: 'call-1', payload: '{"error":"Not connected"}' }),
    ]);
  });

  it('keeps only the out row when a send fails in a way that can follow the action', async () => {
    const make = memoryTransport();
    const { connection, messages } = setup(async () => {
      const transport = await make();
      const send = transport.send.bind(transport);
      transport.send = async (message, options) => {
        // an http send reads the answer too, so a broken answer throws from send after the server acted.
        if ('method' in message && message.method === 'tools/call') throw new Error('Unexpected end of JSON input');
        return send(message, options);
      };
      return transport;
    });
    await connection.start();
    expect(await connection.callTool('echo', { text: 'x' }, trace)).toMatchObject({ kind: 'unknown' });
    expect(messages().filter((row) => row.method === 'tools/call').map((row) => row.direction)).toEqual(['out']);
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

  it('ends the wait at the answer limit with a cancel that the trace links to the call', async () => {
    const { connection, messages } = setup(memoryTransport(), { answerWaitMs: 100 });
    await connection.start();
    expect(await connection.callTool('hang', {}, trace)).toMatchObject({ kind: 'unknown', reason: 'Request timed out' });
    const cancels = messages().filter((row) => row.method === 'notifications/cancelled');
    expect(cancels).toEqual([expect.objectContaining({ direction: 'out', runId: 'r1', toolCallId: 'call-1' })]);
  });

  it('says that a tool ran when its answer came but the client cannot read it', async () => {
    const shape = createShapeServer();
    const { connection } = setup(async () => {
      const [client, server] = InMemoryTransport.createLinkedPair();
      const send = server.send.bind(server);
      server.send = (message, options) => send(JSON.parse(JSON.stringify(message).replace('"text":"garble me"', '"textx":"garble me"')), options);
      await shape.server.connect(server);
      return client;
    });
    await connection.start();
    // the client does not check the output schema, so a result that does not match it, or that has only text, is
    // still a result.
    expect(resultOf(await connection.callTool('stamp', {}, trace)).structuredContent).toEqual({ id: 42, ts: 'now' });
    expect(resultOf(await connection.callTool('text_only', {}, trace)).content).toEqual([{ type: 'text', text: 'done' }]);
    // a hostile pattern in the output schema never runs.
    const start = performance.now();
    expect(await connection.callTool('slow_check', {}, trace)).toMatchObject({ kind: 'result' });
    expect(performance.now() - start).toBeLessThan(500);
    // a block without its text is not a result. the server ran the tool, so the model must not hear "did not run".
    const garbled = await connection.callTool('garbled', {}, trace);
    expect(garbled).toMatchObject({ kind: 'unknown', answered: true });
    expect(outcomeOutput('chat__garbled', 'chat', garbled).content).toMatch(/^chat__garbled ran on chat, but its answer could not be read/);
    expect(shape.calls).toEqual(['stamp', 'text_only', 'slow_check', 'garbled']);
  });

  it('marks the effect of each outcome, so an approval and a late note can say what happened', () => {
    expect(outcomeOutput('notes__x', 'notes', { kind: 'not_sent', reason: 'paused' }).effect).toBe('none');
    expect(outcomeOutput('notes__x', 'notes', { kind: 'unknown', reason: 'Connection closed' }).effect).toBe('unknown');
    // the server answered, so the tool ran or refused. neither is unknown, and a refusal can come after a part acted.
    expect(outcomeOutput('notes__x', 'notes', { kind: 'unknown', reason: 'bad block', answered: true }).effect).toBeUndefined();
    expect(outcomeOutput('notes__x', 'notes', { kind: 'refused', code: -32602, message: 'bad' }).effect).toBeUndefined();
  });

  it('sends no ping during a call, so a server with one thread is not closed in the middle of its work', async () => {
    const { connection, messages, fire } = setup(memoryTransport());
    await connection.start();
    const pending = connection.callTool('slow', { ms: 100 }, trace);
    await new Promise((resolve) => setTimeout(resolve, 20));
    fire(PING_EVERY_MS);
    expect(messages().map((row) => row.method)).not.toContain('ping');
    expect(resultOf(await pending).content).toEqual([{ type: 'text', text: 'done after 100 ms' }]);
    fire(PING_EVERY_MS);
    await expect.poll(() => messages().filter((row) => row.method === 'ping').length).toBe(2);
    expect(connection.state().status).toBe('connected');
  });

  it('records at most the limit of notifications in a minute, and says where it stops', () => {
    const db = openDb(':memory:');
    let now = 0;
    const clock = () => new Date(now);
    const record = createMessageRecorder({ db, blobs: createBlobStore(db, mkdtempSync(join(tmpdir(), 'okc-mcp-')), clock), clock, serverId: 'noisy' });
    const log = { jsonrpc: '2.0' as const, method: 'notifications/message', params: { level: 'info', data: 'x' } };
    for (let i = 0; i < NOTIFICATIONS_PER_MINUTE + 50; i++) record('in', log);
    record('in', { jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
    const count = () => db.prepare("SELECT count(*) AS n FROM mcp_messages WHERE method = 'notifications/message'").get();
    expect(count()).toEqual({ n: NOTIFICATIONS_PER_MINUTE + 1 });
    expect(db.prepare('SELECT payload FROM mcp_messages ORDER BY id DESC LIMIT 2').all().map((row) => String(row.payload))).toEqual([
      expect.stringContaining('list_changed'),
      expect.stringContaining('not recorded'),
    ]);
    now += 60_000;
    record('in', log);
    expect(count()).toEqual({ n: NOTIFICATIONS_PER_MINUTE + 2 });
  });

  it('gives list_changed and cancelled their own small limit, so neither a flood of them nor of others holds the app', () => {
    const db = openDb(':memory:');
    let now = 0;
    const clock = () => new Date(now);
    const record = createMessageRecorder({ db, blobs: createBlobStore(db, mkdtempSync(join(tmpdir(), 'okc-mcp-')), clock), clock, serverId: 'noisy' });
    const count = (method: string) => db.prepare('SELECT count(*) AS n FROM mcp_messages WHERE method = ?').get(method)!.n;
    for (let i = 0; i < 1_000; i++) {
      record('in', { jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
      record('in', { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: i } });
    }
    const listLimit = OWN_LIMIT_PER_MINUTE['notifications/tools/list_changed']!;
    // the limit, and one row that says where the record stops.
    expect(count('notifications/tools/list_changed')).toBe(listLimit + 1);
    expect(count('notifications/cancelled')).toBe(OWN_LIMIT_PER_MINUTE['notifications/cancelled']! + 1);
    // a flood of list_changed does not use up the limit of the other notifications.
    record('in', { jsonrpc: '2.0', method: 'notifications/message', params: { level: 'info', data: 'x' } });
    expect(count('notifications/message')).toBe(1);
    // a clock that moves back an hour starts a new window, and does not drop every notification for that hour.
    now -= 3_600_000;
    record('in', { jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
    expect(count('notifications/tools/list_changed')).toBe(listLimit + 2);
  });

  it('records a tools/list answer that the connection already recorded as a short row with its hash', () => {
    const db = openDb(':memory:');
    const clock = () => new Date(0);
    const record = createMessageRecorder({ db, blobs: createBlobStore(db, mkdtempSync(join(tmpdir(), 'okc-mcp-')), clock), clock, serverId: 'notes' });
    const tools = Array.from({ length: 200 }, (_, i) => ({ name: `tool_${i}`, description: 'x'.repeat(400), inputSchema: { type: 'object' } }));
    const list = (id: number, result: unknown) => {
      record('out', { jsonrpc: '2.0', id, method: 'tools/list' });
      record('in', { jsonrpc: '2.0', id, result } as never);
    };
    list(1, { tools });
    list(2, { tools });
    list(3, { tools: tools.slice(1) });
    const rows = db.prepare("SELECT rpcId, payload, payloadBlob FROM mcp_messages WHERE direction = 'in' ORDER BY id").all();
    expect(rows.map((row) => [row.rpcId, row.payloadBlob !== null])).toEqual([
      ['1', true],
      ['2', false],
      ['3', true],
    ]);
    expect(String(rows[1]!.payload)).toMatch(/"id":2,"unchanged":"the result has the sha-256 [0-9a-f]{64}/);
  });

  it('says that an http server that cannot be reached did not get the call, and starts the backoff', async () => {
    const server = createServer((req, res) => {
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        const mcp = createTestServer();
        const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
        await mcp.connect(transport);
        const headers = new Headers();
        for (const [key, value] of Object.entries(req.headers)) if (typeof value === 'string') headers.set(key, value);
        const body = req.method === 'POST' ? { body: Buffer.concat(chunks).toString() } : {};
        const response = await transport.handleRequest(new Request(`http://127.0.0.1${req.url}`, { method: req.method!, headers, ...body }));
        // no socket stays open. a call on an old socket that the server closed fails with ECONNRESET, and that error
        // can also come after the server read the request, so it stays unknown.
        res.writeHead(response.status, { ...Object.fromEntries(response.headers.entries()), connection: 'close' });
        res.end(Buffer.from(await response.arrayBuffer()));
      })();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`);
    const { connection, messages } = setup(async () => new StreamableHTTPClientTransport(url));
    await connection.start();
    expect(connection.state().status).toBe('connected');
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));

    const outcome = await connection.callTool('echo', { text: 'hi' }, trace);
    expect(outcome).toEqual({ kind: 'not_sent', reason: 'the server cannot be reached (ECONNREFUSED)' });
    expect(messages().filter((row) => row.toolCallId === 'call-1').map((row) => row.direction)).toEqual(['out', 'unsent']);
    await expect.poll(() => connection.state().status).toBe('error');
    // a reset can come after the server read the request, so the tool can have acted.
    const reset = new TypeError('fetch failed', { cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }) });
    expect(classify(reset)).toEqual({ kind: 'unknown', reason: 'fetch failed' });
  });

  // the http transport had no size limit: a 400 mb result held the event loop for 13 s and wrote 857 mb of blobs.
  it('closes an http connection whose answer is over the limit, as a long stdio line does', async () => {
    const server = createServer((req, res) => {
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        if (req.method !== 'POST') return void res.writeHead(405).end();
        const message = JSON.parse(Buffer.concat(chunks).toString()) as { id?: number; method: string };
        if (message.id === undefined) return void res.writeHead(202).end();
        const results: Record<string, unknown> = {
          initialize: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'big', version: '1.0.0' } },
          'tools/list': { tools: [echo] },
          'tools/call': { content: [{ type: 'text', text: 'x'.repeat(MESSAGE_LIMIT) }] },
        };
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: results[message.method] ?? {} }));
      })();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const parsed = parseIntegrations({
        integrations: [{ id: 'notes', kind: 'mcp-http', url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`, tools: { allow: ['echo'] } }],
      });
      if (!parsed.ok) throw new Error(parsed.error);
      const { connection, messages } = setup(() => httpTransport(parsed.value[0] as HttpEntry, createMemorySecretStore()));
      await connection.start();
      expect(connection.state().status).toBe('connected');
      const outcome = await connection.callTool('echo', { text: 'hi' }, trace);
      expect(outcome).toMatchObject({ kind: 'unknown' });
      await expect.poll(() => connection.state().status).toBe('error');
      // nothing of the answer reached the trace.
      expect(messages().filter((row) => row.toolCallId === 'call-1').map((row) => row.direction)).toEqual(['out']);
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('names the status and the secret when an http server refuses the key', async () => {
    const server = createServer((_req, res) => res.writeHead(401).end());
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`);
    try {
      const { connection } = setup(async () => new StreamableHTTPClientTransport(url), { refusedKeyHint: 'Update the secret notes-key.' });
      await connection.start();
      expect(connection.state()).toMatchObject({ status: 'error', error: 'the server refused the key (http 401). Update the secret notes-key.' });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('reports a json-rpc error from the server as refused', async () => {
    const { connection } = setup(memoryTransport());
    await connection.start();
    const outcome = await connection.callTool('echo', { text: 42 }, trace);
    // the sdk server answers invalid arguments with an error result or a json-rpc error, depending on the version.
    if (outcome.kind === 'result') expect(outcome.result.isError).toBe(true);
    else expect(outcome).toMatchObject({ kind: 'refused', code: -32602 });
  });

  it('does not send a call before the first connection', async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const make = memoryTransport();
    const { connection, db } = setup(async () => {
      await gate;
      return make();
    });
    const starting = connection.start();
    expect(await connection.callTool('echo', { text: 'early' }, trace)).toMatchObject({ kind: 'not_sent' });
    release();
    await starting;
    expect(await connection.callTool('echo', { text: 'late' }, trace)).toMatchObject({ kind: 'result' });
    expect(db.prepare("SELECT count(*) AS n FROM mcp_messages WHERE method = 'tools/call' AND direction = 'out'").get()).toEqual({ n: 1 });
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
    await expect.poll(() => lines.some((line) => line.startsWith('test server ready'))).toBe(true);
    expect(resultOf(await connection.callTool('echo', { text: 'from a child' }, trace)).content).toEqual([
      { type: 'text', text: 'from a child' },
    ]);

    await connection.callTool('crash', {}, trace);
    await expect.poll(() => connection.state().status).toBe('error');
    fire(1_000);
    await expect.poll(() => connection.state().status, { timeout: 10_000 }).toBe('connected');
  }, 20_000);

  it('names the transport error of a command that does not exist', async () => {
    const parsed = parseIntegrations({ integrations: [{ id: 'notes', kind: 'mcp-stdio', command: 'okc-no-such-server', tools: { allow: ['echo'] } }] });
    if (!parsed.ok) throw new Error(parsed.error);
    const entry = parsed.value[0] as StdioEntry;
    const { connection } = setup(() => stdioTransport(entry, createMemorySecretStore(), silentLogger));
    await connection.start();
    // the client alone says only "connection closed". the error of the transport says why.
    expect(connection.state()).toMatchObject({ status: 'error', error: expect.stringContaining('spawn okc-no-such-server ENOENT') });
  }, 20_000);
});

// rawServer answers json-rpc by hand, so nothing on the server side cleans its answers. tools gives the tool list of
// each tools/list request: the cursor of the request, or undefined for the first page. a promise holds the answer back.
type Page = { tools: unknown[]; nextCursor?: string | null };
function rawServer(tools: (cursor: string | undefined) => Page | Promise<Page>, onReady?: (server: Transport) => void) {
  return async (): Promise<Transport> => {
    const [client, server] = InMemoryTransport.createLinkedPair();
    server.onmessage = (message) => {
      const m = message as { id?: number; method?: string; params?: { cursor?: string; arguments?: { text?: string } } };
      if (m.id === undefined) return;
      const reply = (result: unknown) => void server.send({ jsonrpc: '2.0', id: m.id!, result } as never);
      if (m.method === 'initialize') reply({ protocolVersion: '2025-06-18', capabilities: { tools: { listChanged: true } }, serverInfo: { name: 'raw', version: '1.0.0' } });
      else if (m.method === 'tools/list') void Promise.resolve(tools(m.params?.cursor)).then(reply);
      else if (m.method === 'tools/call') reply({ content: [{ type: 'text', text: `echo: ${m.params?.arguments?.text}` }] });
      else reply({});
    };
    await server.start();
    onReady?.(server);
    return client;
  };
}

const echo = { name: 'echo', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } };

describe('a server that breaks the rules', () => {
  // the sdk checked the whole list with its strict schema, so one sloppy tool, also a hidden one, stopped the
  // integration: it retried for ever, and the allowed tool was never callable.
  it('connects when one tool of the list has a shape that the strict schema of the sdk refuses', async () => {
    let list: unknown[] = [echo, { name: 'ping_server', inputSchema: { type: 'object', required: null } }, { name: 'bare' }, { description: 'no name' }, 42];
    let server: Transport | undefined;
    const { connection, lists } = setup(rawServer(() => ({ tools: list }), (each) => (server = each)));
    await connection.start();
    expect(connection.state().status).toBe('connected');
    expect(lists[0]).toEqual(['echo', 'ping_server', 'bare', undefined, undefined]);
    expect(resultOf(await connection.callTool('echo', { text: 'hi' }, trace)).content).toEqual([{ type: 'text', text: 'echo: hi' }]);
    // the refresh after list_changed reads the list the same way.
    list = [echo, { name: 'later', annotations: { readOnlyHint: 'true' } }];
    await server!.send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
    await expect.poll(() => lists.length, { timeout: 3_000 }).toBe(2);
    expect(lists[1]).toEqual(['echo', 'later']);
  });

  it('reads every page of the list, and stops a server whose pages never end', async () => {
    const paged = setup(rawServer((cursor) => (cursor === undefined ? { tools: [echo], nextCursor: 'p2' } : { tools: [{ name: 'two' }], nextCursor: 'p2' })));
    await paged.connection.start();
    // a server that gives the same cursor again has no more pages.
    expect(paged.lists[0]).toEqual(['echo', 'two']);
    const endless = setup(rawServer((cursor) => ({ tools: [], nextCursor: `${Number(cursor ?? 0) + 1}` })));
    await endless.connection.start();
    expect(endless.connection.state()).toMatchObject({ status: 'error', error: expect.stringContaining(`more than ${LIST_PAGES_LIMIT} pages`) });
    expect(endless.messages().filter((row) => row.method === 'tools/list' && row.direction === 'out')).toHaveLength(LIST_PAGES_LIMIT);
  });

  // the strict cursor schema refused the whole list, so the integration retried for ever.
  it('takes a nextCursor of null as the last page', async () => {
    const { connection, lists } = setup(rawServer(() => ({ tools: [echo], nextCursor: null })));
    await connection.start();
    expect(connection.state().status).toBe('connected');
    expect(lists).toEqual([['echo']]);
    expect(resultOf(await connection.callTool('echo', { text: 'hi' }, trace)).content).toEqual([{ type: 'text', text: 'echo: hi' }]);
  });

  // versioned gives the server's list at the moment of each request. while hold is set, an answer waits in held.
  function versioned() {
    const control = { version: 1, hold: false, open: 0, most: 0, held: [] as Array<() => void>, server: undefined as Transport | undefined };
    const transport = rawServer(
      () => {
        const page = { tools: [{ ...echo, name: `v${control.version}` }] };
        control.most = Math.max(control.most, ++control.open);
        const answer = () => (control.open--, page);
        return control.hold ? new Promise<Page>((resolve) => control.held.push(() => resolve(answer()))) : answer();
      },
      (each) => (control.server = each),
    );
    const changed = () => control.server!.send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
    return { control, transport, changed };
  }
  const quiet = () => new Promise((resolve) => setTimeout(resolve, LIST_CHANGED_DEBOUNCE_MS + 300));

  // two refreshes ran side by side, and a slow answer with an older list replaced the newer list. with large pages,
  // the walks piled up until the heap was full.
  it('runs one walk of the tool list at a time, so the newest list stays', async () => {
    const { control, transport, changed } = versioned();
    const { connection, lists } = setup(transport);
    await connection.start();
    control.hold = true;
    control.version = 2;
    await changed();
    await expect.poll(() => control.held.length, { timeout: 3_000 }).toBe(1);
    control.hold = false;
    control.version = 3;
    await changed();
    await quiet();
    expect(control.most).toBe(1);
    control.held.shift()!();
    await expect.poll(() => lists.length, { timeout: 3_000 }).toBe(3);
    expect(lists).toEqual([['v1'], ['v2'], ['v3']]);
    expect(control.most).toBe(1);
  }, 10_000);

  it('walks the list again after the first walk when list_changed comes during it', async () => {
    const { control, transport, changed } = versioned();
    control.hold = true;
    const { connection, lists } = setup(transport);
    const started = connection.start();
    await expect.poll(() => control.held.length, { timeout: 3_000 }).toBe(1);
    control.hold = false;
    control.version = 2;
    await changed();
    await quiet();
    expect(control.most).toBe(1);
    control.held.shift()!();
    await started;
    await expect.poll(() => lists.length, { timeout: 3_000 }).toBe(2);
    expect(lists).toEqual([['v1'], ['v2']]);
  }, 10_000);

  // a server that quotes its key in an error put the key in plain text into integration_state, the page and the
  // answer of connect.
  it('redacts a secret in the error of a connection attempt', async () => {
    registerSecret('raw-server-api-key-2026', 'raw-key');
    const { connection } = setup(async () => {
      throw new Error('upstream said: invalid api key raw-server-api-key-2026');
    });
    await connection.start();
    expect(connection.state()).toMatchObject({ status: 'error', error: 'upstream said: invalid api key [redacted]' });
  });

  // 20,000 pings from a server held the event loop for 50 s, because each one and its answer were rows.
  it('records at most the limit of server requests in a minute, and leaves out the answers to the others', () => {
    const db = openDb(':memory:');
    const clock = () => new Date(0);
    const record = createMessageRecorder({ db, blobs: createBlobStore(db, mkdtempSync(join(tmpdir(), 'okc-mcp-')), clock), clock, serverId: 'noisy' });
    for (let i = 0; i < REQUESTS_PER_MINUTE + 50; i++) {
      record('in', { jsonrpc: '2.0', id: i, method: 'ping' });
      record('out', { jsonrpc: '2.0', id: i, result: {} });
    }
    const rows = db.prepare('SELECT direction, method, rpcId, payload FROM mcp_messages ORDER BY id').all();
    expect(rows.filter((row) => row.direction === 'in' && row.rpcId !== null)).toHaveLength(REQUESTS_PER_MINUTE);
    expect(rows.filter((row) => row.direction === 'out')).toHaveLength(REQUESTS_PER_MINUTE);
    // each recorded answer has the method of its request.
    expect(rows.filter((row) => row.direction === 'out').every((row) => row.method === 'ping')).toBe(true);
    expect(rows.filter((row) => row.rpcId === null).map((row) => String(row.payload))).toEqual([expect.stringContaining('more than 100 requests')]);
    // the notifications of the server have their own limit.
    record('in', { jsonrpc: '2.0', method: 'notifications/message', params: { level: 'info', data: 'x' } });
    expect(db.prepare("SELECT count(*) AS n FROM mcp_messages WHERE method = 'notifications/message'").get()).toEqual({ n: 1 });
  });

  // the http transport posted the whole call before the 401 or the 403, so the server got the arguments. the trace
  // said that the message did not leave.
  it('records a 401 or a 403 of an http server as an answer with the status, not as unsent', async () => {
    for (const status of [401, 403]) {
      const make = memoryTransport();
      const { connection, messages } = setup(async () => {
        const transport = await make();
        const send = transport.send.bind(transport);
        transport.send = async (message, options) => {
          if ('method' in message && message.method === 'tools/call') {
            throw new SdkHttpError(SdkErrorCode.ClientHttpNotImplemented, 'Error POSTing to endpoint: no', { status, statusText: 'no' });
          }
          return send(message, options);
        };
        return transport;
      });
      await connection.start();
      expect(await connection.callTool('echo', { text: 'x' }, trace)).toMatchObject({ kind: 'not_sent' });
      const rows = messages().filter((row) => row.method === 'tools/call');
      expect(rows.map((row) => [row.direction, row.toolCallId])).toEqual([
        ['out', 'call-1'],
        ['in', 'call-1'],
      ]);
      expect(JSON.parse(String(rows[1]!.payload))).toEqual({ httpStatus: status, error: 'Error POSTing to endpoint: no' });
      await connection.stop();
    }
  });

  it('says that a call did not run when the credential manager fails', () => {
    expect(classify(new CredentialStoreError('the system credential store failed: locked'))).toEqual({
      kind: 'not_sent',
      reason: 'the system credential store failed: locked',
    });
  });
});
