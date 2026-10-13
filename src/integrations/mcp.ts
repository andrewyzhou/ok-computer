import { AsyncLocalStorage } from 'node:async_hooks';
import {
  Client,
  OAuthError,
  ProtocolError,
  SdkError,
  SdkErrorCode,
  UnauthorizedError,
  type CallToolResult,
  type JSONRPCMessage,
  type Tool as McpTool,
  type Transport,
} from '@modelcontextprotocol/client';
import type { Db } from '../db/index.js';
import type { BlobStore } from '../observability/blobs.js';
import type { Logger } from '../observability/logger.js';
import { redactedJson } from '../observability/redact.js';
import type { SetTimer } from '../scheduler/scheduler.js';
import type { Clock } from '../time.js';
import { errorText } from '../tools/registry.js';

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

// each connection attempt gets its own recorder. a new client numbers its requests from 0 again, so a shared map of
// pending requests would pair a new response with a request of the old attempt.
export function createMessageRecorder(deps: { db: Db; blobs: BlobStore; clock: Clock; serverId: string }): MessageRecorder {
  const pending = new Map<string, Pending>();
  const insert = deps.db.prepare(
    `INSERT INTO mcp_messages (serverId, runId, toolCallId, direction, method, rpcId, payload, payloadBlob, latencyMs, createdAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  return (direction, message) => {
    const text = redactedJson(message);
    const rpcId = 'id' in message && message.id !== undefined ? String(message.id) : null;
    let method = 'method' in message ? message.method : null;
    let trace: CallTrace | undefined;
    let latencyMs: number | null = null;
    // a request from the server to the client has its own ids, so the key includes the direction of the request.
    const key = (from: 'out' | 'in') => `${from}:${rpcId}`;
    // only a tools/call and its cancel belong to a tool call. other requests can run in the async context of a call,
    // for example the tools/list that a list_changed during the call starts, but the call did not send them.
    const ownTrace = () => (direction === 'out' && (method === 'tools/call' || method === 'notifications/cancelled') ? activeCall.getStore() : undefined);
    if (method && rpcId !== null) {
      trace = ownTrace();
      pending.set(key(direction), { method, sentAt: performance.now(), trace });
    } else if (!method && rpcId !== null) {
      const request = pending.get(key(direction === 'in' ? 'out' : 'in'));
      if (request) {
        pending.delete(key(direction === 'in' ? 'out' : 'in'));
        method = request.method;
        trace = request.trace;
        latencyMs = Math.round(performance.now() - request.sentAt);
      }
    } else {
      trace = ownTrace();
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
// - a message out is recorded before it goes. when the record fails, the message does not go, so nothing leaves the
//   machine without a trace. the request then fails before the server acts.
// - a message in is delivered also when its record fails. the server already acted, and a lost answer would make the
//   client wait and then report a failure for work that was done.
// onError sees each error of the inner transport, for example a command that does not exist. the client then gives
// only "connection closed", so the connection keeps the real error for the owner.
export function recordingTransport(
  inner: Transport,
  record: MessageRecorder,
  onRecordError: (err: unknown) => void,
  onError?: (error: Error) => void,
): Transport {
  const outer: Transport = {
    start: () => inner.start(),
    close: () => inner.close(),
    async send(message, options) {
      try {
        record('out', message);
      } catch (err) {
        onRecordError(err);
        throw new SdkError(SdkErrorCode.SendFailed, `the message was not sent, because its trace write failed: ${errorText(err)}`);
      }
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
    try {
      record('in', message);
    } catch (err) {
      onRecordError(err);
    }
    outer.onmessage?.(message, extra);
  };
  inner.onclose = () => outer.onclose?.();
  inner.onerror = (error) => {
    onError?.(error);
    outer.onerror?.(error);
  };
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

// the outcome of one tools/call tells the model whether the tool can have acted.
// - not_sent: the request never left, so the tool did not run. a retry is safe.
// - refused: the server answered with a json-rpc error, for example invalid params. the tool did not give a result.
// - unknown: the request left, but no answer came, for example because the connection closed. the tool can have acted.
export type CallOutcome =
  | { kind: 'result'; result: CallToolResult }
  | { kind: 'not_sent'; reason: string }
  | { kind: 'refused'; code: number; message: string }
  | { kind: 'unknown'; reason: string };

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
  // the longest time to wait for the answer of one tools/call. the run does not wait this long, but the late result
  // still reaches the trace and the session.
  answerWaitMs?: number;
}

export interface McpConnection {
  state(): ConnectionState;
  start(): Promise<void>;
  stop(): Promise<void>;
  // the transport of the last attempt. the oauth flow calls finishAuth on it.
  transport(): Transport | undefined;
  callTool(name: string, args: Record<string, unknown>, trace: CallTrace): Promise<CallOutcome>;
}

// a failed server gets a new attempt after each delay. the last delay repeats.
export const RETRY_DELAYS_MS = [1_000, 5_000, 30_000, 120_000, 600_000];
// a connection must stay up this long before the backoff starts again from the first delay. without this, a server
// that crashes just after the start restarts every second for ever.
export const HEALTHY_AFTER_MS = 60_000;
export const PING_EVERY_MS = 5 * 60_000;
export const ANSWER_WAIT_MS = 60 * 60_000;
// a server that writes much to stderr must not fill the log. each window allows this many lines.
export const STDERR_LINES_PER_MINUTE = 100;
const CLIENT_INFO = { name: 'ok-computer', version: '0.1.0' };

const realTimer: SetTimer = (fn, ms) => {
  const timer = setTimeout(fn, ms);
  timer.unref();
  return () => clearTimeout(timer);
};

export function createMcpConnection(deps: McpConnectionDeps): McpConnection {
  const { id, logger, clock } = deps;
  const setTimer = deps.setTimer ?? realTimer;
  let state: ConnectionState = { status: 'stopped' };
  let client: Client | undefined;
  let inner: Transport | undefined;
  let failures = 0;
  let stopped = true;
  // each start, stop and attempt gets a new number. an attempt that sees a newer number after an await gives up, so a
  // stop during a slow start never leaves a live client or child process.
  let generation = 0;
  let connectedAt: number | undefined;
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
    const mine = generation;
    cancelTimer = setTimer(() => void (mine === generation && connect()), delay);
  };

  const ping = async (attempt: Client) => {
    cancelTimer = setTimer(() => void ping(attempt), PING_EVERY_MS);
    try {
      await attempt.ping({ timeout: 30_000 });
    } catch (err) {
      // a closed transport starts the next attempt through onclose.
      logger.warn('mcp server did not answer a ping', { integration: id, err });
      await attempt.close().catch(() => {});
    }
  };

  async function connect(): Promise<void> {
    clearTimer();
    if (stopped) return;
    const mine = ++generation;
    setState({ status: 'connecting' });
    const record = createMessageRecorder({ ...deps, serverId: id });
    const attempt = new Client(CLIENT_INFO, {
      // the default is legacy today. auto mode starts a second stdio process that the recorder never sees, so the
      // mode is fixed here and an sdk update cannot change it.
      versionNegotiation: { mode: 'legacy' },
      listChanged: {
        tools: {
          debounceMs: 1_000,
          onChanged: (error, tools) => {
            if (mine !== generation) return;
            if (error) logger.warn('mcp tool list refresh failed', { integration: id, err: error });
            else if (tools) deps.onTools(tools);
          },
        },
      },
    });
    const stale = async () => {
      if (mine === generation && !stopped) return false;
      await attempt.close().catch(() => {});
      return true;
    };
    let transportError: string | undefined;
    const reason = (text: string) => (transportError && !text.includes(transportError) ? `${text}: ${transportError}` : text);
    try {
      const transport = await deps.transport();
      if (mine !== generation || stopped) {
        await transport.close().catch(() => {});
        return;
      }
      inner = transport;
      await attempt.connect(
        recordingTransport(
          transport,
          record,
          (err) => logger.error('mcp message trace write failed', { integration: id, err }),
          (error) => {
            transportError = errorText(error);
            logger.warn('mcp transport error', { integration: id, err: error });
          },
        ),
      );
      if (await stale()) return;
      const { tools } = await attempt.listTools();
      if (await stale()) return;
      client = attempt;
      connectedAt = clock().getTime();
      const server = attempt.getServerVersion();
      setState({ status: 'connected', ...(server ? { server: { name: server.name, version: server.version } } : {}) });
      logger.info('mcp server connected', { integration: id, tools: tools.length });
      deps.onTools(tools);
      // the close handler goes on after the first tool list, so a failed attempt never starts a second retry.
      attempt.onclose = () => {
        if (client !== attempt) return;
        client = undefined;
        if (connectedAt !== undefined && clock().getTime() - connectedAt >= HEALTHY_AFTER_MS) failures = 0;
        connectedAt = undefined;
        if (!stopped && mine === generation) retry(reason('the connection closed'));
      };
      cancelTimer = setTimer(() => void ping(attempt), PING_EVERY_MS);
    } catch (err) {
      await attempt.close().catch(() => {});
      if (mine !== generation || stopped) return;
      // a server that needs the owner's authorization waits for the owner. a retry loop would ask again and again, and a
      // revoked refresh token would hit the token endpoint at each attempt.
      if (isAuthError(err)) {
        setState({ status: 'needs_auth', error: 'the server needs authorization. connect it from the dashboard.' });
        logger.warn('mcp server needs authorization', { integration: id });
        return;
      }
      retry(reason(errorText(err)));
    }
  }

  return {
    state: () => state,
    transport: () => inner,
    async start() {
      if (!stopped) return;
      stopped = false;
      failures = 0;
      await connect();
    },
    async stop() {
      stopped = true;
      generation++;
      clearTimer();
      const current = client;
      client = undefined;
      connectedAt = undefined;
      await current?.close().catch(() => {});
      // an attempt that has not finished closes its own transport when it sees the new generation.
      await inner?.close().catch(() => {});
      setState({ status: 'stopped' });
    },
    async callTool(name, args, trace) {
      const connected = client;
      if (!connected) return { kind: 'not_sent', reason: `${id} is not connected (${state.status}${state.error ? `: ${state.error}` : ''})` };
      try {
        // the run's signal does not go to the request. after an abort the sdk sends a cancel and drops the answer, so
        // the app would never learn whether the tool acted. the wait has its own long limit instead.
        const result = await activeCall.run(trace, () =>
          connected.callTool({ name, arguments: args }, { timeout: deps.answerWaitMs ?? ANSWER_WAIT_MS }),
        );
        return { kind: 'result', result: result as CallToolResult };
      } catch (err) {
        if (isAuthError(err) && client === connected) {
          // the server refused the token before it acted, and the refresh failed too. the owner must sign in again.
          client = undefined;
          generation++;
          clearTimer();
          await connected.close().catch(() => {});
          setState({ status: 'needs_auth', error: 'the sign-in expired or was revoked. connect it again from the dashboard.' });
          logger.warn('mcp server needs authorization again', { integration: id });
        }
        return classify(err);
      }
    },
  };
}

// the sdk gives a typed error for each way that a request can fail. the kind decides what the model may assume.
// a 401 that the sdk could not repair with a refresh. the http transport throws it before the server acts.
const isAuthError = (err: unknown) => err instanceof UnauthorizedError || err instanceof OAuthError;

export function classify(err: unknown): CallOutcome {
  if (err instanceof ProtocolError) return { kind: 'refused', code: err.code, message: err.message };
  if (isAuthError(err)) return { kind: 'not_sent', reason: `the server refused the sign-in: ${errorText(err)}` };
  if (err instanceof SdkError && (err.code === SdkErrorCode.NotConnected || err.code === SdkErrorCode.SendFailed)) {
    return { kind: 'not_sent', reason: err.message };
  }
  // the protocol rejects a request without a transport with a plain error, before any message goes out.
  if (err instanceof Error && !(err instanceof SdkError) && err.message === 'Not connected') return { kind: 'not_sent', reason: err.message };
  return { kind: 'unknown', reason: errorText(err) };
}
