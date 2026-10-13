import { AsyncLocalStorage } from 'node:async_hooks';
import { Client, UnauthorizedError, type CallToolResult, type JSONRPCMessage, type Tool as McpTool, type Transport } from '@modelcontextprotocol/client';
import type { Db } from '../db/index.js';
import type { BlobStore } from '../observability/blobs.js';
import type { Logger } from '../observability/logger.js';
import { redact } from '../observability/redact.js';
import type { SetTimer } from '../scheduler/scheduler.js';
import type { Clock } from '../time.js';

export type { McpTool };

// a message over this size goes to the blob store. a smaller message stays in its row.
export const INLINE_LIMIT = 8 * 1024;

export interface CallTrace {
  runId: string;
  toolCallId: string;
}

interface Pending {
  method: string;
  sentAt: number;
  trace: CallTrace | undefined;
}

// the trace of the tool call that sent a request. the response row gets the same trace through the rpc id.
const activeCall = new AsyncLocalStorage<CallTrace>();

export interface MessageRecorder {
  (direction: 'out' | 'in', message: JSONRPCMessage): void;
}

export function createMessageRecorder(deps: { db: Db; blobs: BlobStore; clock: Clock; serverId: string }): MessageRecorder {
  const pending = new Map<string, Pending>();
  const insert = deps.db.prepare(
    `INSERT INTO mcp_messages (serverId, runId, toolCallId, direction, method, rpcId, payload, payloadBlob, latencyMs, createdAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  return (direction, message) => {
    const text = redact(JSON.stringify(message));
    const rpcId = 'id' in message && message.id !== undefined ? String(message.id) : null;
    let method = 'method' in message ? message.method : null;
    let trace: CallTrace | undefined;
    let latencyMs: number | null = null;
    // a request from the server to the client has its own ids, so the key includes the direction of the request.
    const key = (from: 'out' | 'in') => `${from}:${rpcId}`;
    if (method && rpcId !== null) {
      trace = direction === 'out' ? activeCall.getStore() : undefined;
      pending.set(key(direction), { method, sentAt: performance.now(), trace });
    } else if (!method && rpcId !== null) {
      const request = pending.get(key(direction === 'in' ? 'out' : 'in'));
      if (request) {
        pending.delete(key(direction === 'in' ? 'out' : 'in'));
        method = request.method;
        trace = request.trace;
        latencyMs = Math.round(performance.now() - request.sentAt);
      }
    } else if (direction === 'out') {
      trace = activeCall.getStore();
    }
    const small = Buffer.byteLength(text) <= INLINE_LIMIT;
    insert.run(
      deps.serverId,
      trace?.runId ?? null,
      trace?.toolCallId ?? null,
      direction,
      method,
      rpcId,
      small ? text : null,
      small ? null : deps.blobs.put(text, 'application/json'),
      latencyMs,
      deps.clock().toISOString(),
    );
  };
}

// the wrapper sees every message in both directions. the client and the inner transport do not know about it.
export function recordingTransport(inner: Transport, record: MessageRecorder): Transport {
  const outer: Transport = {
    start: () => inner.start(),
    close: () => inner.close(),
    async send(message, options) {
      record('out', message);
      return inner.send(message, options);
    },
    get sessionId() {
      return inner.sessionId;
    },
    get hasPerRequestStream() {
      return inner.hasPerRequestStream;
    },
    setProtocolVersion: (version) => inner.setProtocolVersion?.(version),
    setSupportedProtocolVersions: (versions) => inner.setSupportedProtocolVersions?.(versions),
  };
  inner.onmessage = (message, extra) => {
    record('in', message);
    outer.onmessage?.(message, extra);
  };
  inner.onclose = () => outer.onclose?.();
  inner.onerror = (error) => outer.onerror?.(error);
  return outer;
}

export type ConnectionStatus = 'stopped' | 'connecting' | 'connected' | 'needs_auth' | 'error';

export interface ConnectionState {
  status: ConnectionStatus;
  error?: string;
  server?: { name: string; version: string };
  // the time of the next attempt after a failure.
  retryAt?: string;
}

export interface McpConnectionDeps {
  id: string;
  db: Db;
  blobs: BlobStore;
  logger: Logger;
  clock: Clock;
  // each attempt gets a new transport. the oauth flow needs the same transport for finishAuth, so it gets it here.
  transport: () => Promise<Transport>;
  onTools: (tools: McpTool[]) => void;
  onState?: (state: ConnectionState) => void;
  setTimer?: SetTimer;
}

export interface McpConnection {
  state(): ConnectionState;
  start(): Promise<void>;
  stop(): Promise<void>;
  // the transport of the last attempt. the oauth flow calls finishAuth on it.
  transport(): Transport | undefined;
  callTool(name: string, args: Record<string, unknown>, trace: CallTrace, signal: AbortSignal): Promise<CallToolResult>;
}

// a failed server gets a new attempt after each delay. the last delay repeats.
export const RETRY_DELAYS_MS = [1_000, 5_000, 30_000, 120_000, 600_000];
export const PING_EVERY_MS = 5 * 60_000;
const CLIENT_INFO = { name: 'ok-computer', version: '0.1.0' };

const realTimer: SetTimer = (fn, ms) => {
  const timer = setTimeout(fn, ms);
  timer.unref();
  return () => clearTimeout(timer);
};

export function createMcpConnection(deps: McpConnectionDeps): McpConnection {
  const { id, logger, clock } = deps;
  const setTimer = deps.setTimer ?? realTimer;
  const record = createMessageRecorder({ ...deps, serverId: id });
  let state: ConnectionState = { status: 'stopped' };
  let client: Client | undefined;
  let inner: Transport | undefined;
  let failures = 0;
  let stopped = true;
  let cancelTimer: (() => void) | undefined;

  const setState = (next: ConnectionState) => {
    state = next;
    deps.onState?.(next);
  };
  const clearTimer = () => {
    cancelTimer?.();
    cancelTimer = undefined;
  };

  const retry = (error: string) => {
    const delay = RETRY_DELAYS_MS[Math.min(failures, RETRY_DELAYS_MS.length - 1)]!;
    failures++;
    setState({ status: 'error', error, retryAt: new Date(clock().getTime() + delay).toISOString() });
    logger.warn('mcp server failed', { integration: id, error, retryInMs: delay });
    clearTimer();
    cancelTimer = setTimer(() => void connect(), delay);
  };

  const ping = async () => {
    cancelTimer = setTimer(() => void ping(), PING_EVERY_MS);
    try {
      await client?.ping();
    } catch (err) {
      // a closed transport starts the next attempt through onclose.
      logger.warn('mcp server did not answer a ping', { integration: id, err });
      await client?.close().catch(() => {});
    }
  };

  async function connect(): Promise<void> {
    clearTimer();
    if (stopped) return;
    setState({ status: 'connecting' });
    const attempt = new Client(CLIENT_INFO, {
      listChanged: {
        tools: {
          onChanged: (error, tools) => {
            if (error) logger.warn('mcp tool list refresh failed', { integration: id, err: error });
            else if (tools) deps.onTools(tools);
          },
        },
      },
    });
    try {
      inner = await deps.transport();
      const transport = recordingTransport(inner, record);
      await attempt.connect(transport);
      const { tools } = await attempt.listTools();
      client = attempt;
      failures = 0;
      const server = attempt.getServerVersion();
      setState({ status: 'connected', ...(server ? { server: { name: server.name, version: server.version } } : {}) });
      logger.info('mcp server connected', { integration: id, tools: tools.length });
      deps.onTools(tools);
      // the close handler goes on after the first tool list, so a failed attempt never starts a second retry.
      attempt.onclose = () => {
        if (client !== attempt) return;
        client = undefined;
        if (!stopped) retry('the connection closed');
      };
      cancelTimer = setTimer(() => void ping(), PING_EVERY_MS);
    } catch (err) {
      await attempt.close().catch(() => {});
      // a server that needs the owner's authorization waits for the owner. a retry loop would open the browser again
      // and again.
      if (err instanceof UnauthorizedError) {
        setState({ status: 'needs_auth', error: 'the server needs authorization. connect it from the dashboard.' });
        logger.warn('mcp server needs authorization', { integration: id });
        return;
      }
      retry((err as Error).message);
    }
  }

  return {
    state: () => state,
    transport: () => inner,
    async start() {
      stopped = false;
      failures = 0;
      await connect();
    },
    async stop() {
      stopped = true;
      clearTimer();
      const current = client;
      client = undefined;
      await current?.close().catch(() => {});
      setState({ status: 'stopped' });
    },
    async callTool(name, args, trace, signal) {
      if (!client) throw new Error(`${id} is not connected (${state.status}${state.error ? `: ${state.error}` : ''})`);
      const connected = client;
      return activeCall.run(trace, () => connected.callTool({ name, arguments: args }, { signal })) as Promise<CallToolResult>;
    },
  };
}
