import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import {
  Client,
  OAuthError,
  ProtocolError,
  SdkError,
  SdkErrorCode,
  SdkHttpError,
  UnauthorizedError,
  type CallToolResult,
  type JSONRPCMessage,
  type Tool as McpTool,
  type Transport,
} from '@modelcontextprotocol/client';
import { z } from 'zod';
import type { Db } from '../db/index.js';
import type { BlobStore } from '../observability/blobs.js';
import type { Logger } from '../observability/logger.js';
import { redact, redactedJson } from '../observability/redact.js';
import type { SetTimer } from '../scheduler/scheduler.js';
import type { Clock } from '../time.js';
import { errorText } from '../tools/registry.js';
import { CredentialStoreError } from './secrets.js';

export type { McpTool };

// a message over this size goes to the blob store. a smaller message stays in its row.
export const INLINE_LIMIT = 8 * 1024;

export interface CallTrace {
  // null for a call of the app's own code, for example a poll, which has no run.
  runId: string | null;
  toolCallId: string;
}

// the tool call that sent a request. answer says what came back for it: a result or a json-rpc error. the sdk throws
// the same error type for a refusal of the server and for a result that it cannot read, so only the message tells
// whether the tool ran.
interface ActiveCall {
  trace: CallTrace;
  answer?: 'result' | 'error';
}

interface Pending {
  method: string;
  sentAt: number;
  call: ActiveCall | undefined;
}

// the call that sent a request. the response row gets the same trace through the rpc id.
const activeCall = new AsyncLocalStorage<ActiveCall>();

// unsent marks a message whose out row exists, but the transport refused to send it. its row holds the error.
// refused marks a request that reached an http server, which answered with an http error and no json-rpc message. it
// is recorded as an in row with the status, because the server got the request and read it.
export interface MessageRecorder {
  (direction: 'out' | 'in' | 'unsent' | 'refused', message: JSONRPCMessage, error?: string, httpStatus?: number): void;
}

// a server can send notifications and requests without a limit, and each row is a synchronous write on the event
// loop. so each window records this many of each. the client still gets every message and answers every request.
export const NOTIFICATIONS_PER_MINUTE = 100;
// 20,000 pings from a server held the event loop for 50 s: each one is an in row and an out row for the answer.
export const REQUESTS_PER_MINUTE = 100;
// these notifications change what the app does. each one has its own small limit, so a flood of other notifications
// cannot hide them, and a flood of them cannot hold the event loop: 20,000 list_changed held it for 25 s.
export const OWN_LIMIT_PER_MINUTE: Readonly<Record<string, number>> = { 'notifications/tools/list_changed': 10, 'notifications/cancelled': 10 };
// a server can send list_changed often, and the refresh then gets the same list again. 200 tools are about 100 kb, so
// a list that the attempt already recorded gets a short row with its hash. the set has a limit, because a server can
// send a new list each time.
const LISTS_REMEMBERED = 100;

// each connection attempt gets its own recorder. a new client numbers its requests from 0 again, so a shared map of
// pending requests would pair a new response with a request of the old attempt.
export function createMessageRecorder(deps: { db: Db; blobs: BlobStore; clock: Clock; serverId: string }): MessageRecorder {
  const pending = new Map<string, Pending>();
  const insert = deps.db.prepare(
    `INSERT INTO mcp_messages (serverId, runId, toolCallId, direction, method, rpcId, payload, payloadBlob, latencyMs, createdAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  let windowStart = 0;
  const counts = new Map<string, number>();
  const lists = new Set<string>();
  // the ids of the server's requests that were not recorded. the app's answer to such a request is not recorded
  // either, so the page never shows an answer without its request.
  const unrecorded = new Set<string>();
  // over reports whether a notification or a request from the server is over the limit of its window. the first one
  // over the limit leaves one row that says so.
  const over = (method: string, kind: 'notification' | 'request') => {
    const now = deps.clock().getTime();
    // a clock that moves back would keep the old window open for the length of the jump.
    if (now - windowStart >= 60_000 || now < windowStart) {
      windowStart = now;
      counts.clear();
    }
    const own = kind === 'notification' ? OWN_LIMIT_PER_MINUTE[method] : undefined;
    const limit = own ?? (kind === 'request' ? REQUESTS_PER_MINUTE : NOTIFICATIONS_PER_MINUTE);
    const key = own === undefined ? kind : method;
    const count = (counts.get(key) ?? 0) + 1;
    counts.set(key, count);
    if (count <= limit) return false;
    if (count === limit + 1) {
      const what = own !== undefined ? `${method} notifications` : kind === 'request' ? 'requests' : 'notifications';
      const others = kind === 'request' ? 'the others of this minute and the answers of the app to them' : 'the others of this minute';
      const note = JSON.stringify({ dropped: `the server sent more than ${limit} ${what} in one minute. ${others} are not recorded.` });
      insert.run(deps.serverId, null, null, 'in', method, null, note, null, null, deps.clock().toISOString());
    }
    return true;
  };
  return (direction, message, error, httpStatus) => {
    const rpcId = 'id' in message && message.id !== undefined ? String(message.id) : null;
    let method = 'method' in message ? message.method : null;
    if (direction === 'in' && method && rpcId === null && over(method, 'notification')) return;
    if (direction === 'in' && method && rpcId !== null && over(method, 'request')) {
      unrecorded.add(rpcId);
      return;
    }
    if (direction === 'out' && !method && rpcId !== null && unrecorded.delete(rpcId)) return;
    let call: ActiveCall | undefined;
    let latencyMs: number | null = null;
    // a request from the server to the client has its own ids, so the key includes the direction of the request.
    const key = (from: 'out' | 'in') => `${from}:${rpcId}`;
    // only a tools/call and its cancel belong to a tool call. other requests can run in the async context of a call,
    // for example the tools/list that a list_changed during the call starts, but the call did not send them.
    const ownCall = () => (direction === 'out' && (method === 'tools/call' || method === 'notifications/cancelled') ? activeCall.getStore() : undefined);
    if (direction === 'unsent' || direction === 'refused') {
      // no json-rpc answer comes for a request that did not leave or that the http server refused, so its pending
      // entry ends here.
      const request = pending.get(key('out'));
      pending.delete(key('out'));
      call = request?.call;
      if (direction === 'refused' && request) latencyMs = Math.round(performance.now() - request.sentAt);
    } else if (method && rpcId !== null) {
      call = ownCall();
      pending.set(key(direction), { method, sentAt: performance.now(), call });
    } else if (!method && rpcId !== null) {
      const request = pending.get(key(direction === 'in' ? 'out' : 'in'));
      if (request) {
        pending.delete(key(direction === 'in' ? 'out' : 'in'));
        method = request.method;
        call = request.call;
        latencyMs = Math.round(performance.now() - request.sentAt);
        // the answer is noted before the write, so a failed write cannot hide that the tool ran.
        if (call && direction === 'in') call.answer = 'error' in message ? 'error' : 'result';
      }
    } else {
      call = ownCall();
    }
    const trace = call?.trace;
    let text = redactedJson(direction === 'unsent' ? { error } : direction === 'refused' ? { httpStatus: httpStatus ?? null, error } : message);
    if (direction === 'in' && method === 'tools/list' && 'result' in message) {
      const hash = createHash('sha256').update(redactedJson(message.result)).digest('hex');
      if (lists.has(hash)) text = JSON.stringify({ jsonrpc: '2.0', id: message.id, unchanged: `the result has the sha-256 ${hash}, the same as an earlier tools/list answer of this connection` });
      else {
        if (lists.size >= LISTS_REMEMBERED) lists.clear();
        lists.add(hash);
      }
    }
    const bytes = Buffer.byteLength(text);
    let payload: string | null = bytes <= INLINE_LIMIT ? text : null;
    let payloadBlob: string | null = null;
    let blobError: unknown;
    if (payload === null) {
      try {
        payloadBlob = deps.blobs.put(text, 'application/json');
      } catch (err) {
        // a message out does not go without its whole trace. a message in already came, and its row keeps the rpc
        // id, the latency and the call, so the page does not show a request without an answer.
        if (direction !== 'in') throw err;
        blobError = err;
        payload = JSON.stringify({ unrecorded: `the payload of ${bytes} bytes was not stored: ${errorText(err)}` });
      }
    }
    const stored = direction === 'refused' ? 'in' : direction;
    insert.run(deps.serverId, trace?.runId ?? null, trace?.toolCallId ?? null, stored, method, rpcId, payload, payloadBlob, latencyMs, deps.clock().toISOString());
    // the transport logs the error.
    if (blobError !== undefined) throw blobError;
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
      try {
        return await inner.send(message, options);
      } catch (err) {
        // the out row exists. when the error shows that the message did not leave, a second row says so. an http send
        // also reads the answer, so other errors can come after the server acted, and they keep only the out row.
        // a 401 or a 403 shows that the server got the request and refused it, so its row is an answer with the status.
        if (classify(err).kind === 'not_sent') {
          try {
            const status = refusedStatus(err);
            if (status !== undefined) record('refused', message, errorText(err), status ?? undefined);
            // a credential manager failure can come before the post or after a 401, so it keeps only the out row.
            else if (!(err instanceof CredentialStoreError)) record('unsent', message, errorText(err));
          } catch (recordErr) {
            onRecordError(recordErr);
          }
        }
        throw err;
      }
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
//   answered marks an answer that came but that the client could not read. the tool then ran.
export type CallOutcome =
  | { kind: 'result'; result: CallToolResult }
  | { kind: 'not_sent'; reason: string }
  | { kind: 'refused'; code: number; message: string }
  | { kind: 'unknown'; reason: string; answered?: true };

export interface McpConnectionDeps {
  id: string;
  db: Db;
  blobs: BlobStore;
  logger: Logger;
  clock: Clock;
  // each attempt gets a new transport. the oauth flow needs the same transport for finishAuth, so it gets it here.
  transport: () => Promise<Transport>;
  // the tools as the server listed them. the catalog checks the shape of each one.
  onTools: (tools: unknown[]) => void;
  onState?: (state: ConnectionState) => void;
  setTimer?: SetTimer;
  // the longest time to wait for the answer of one tools/call. the run does not wait this long, but the late result
  // still reaches the trace and the session.
  answerWaitMs?: number;
  // the reason when the last sign-in step failed because the sign-in server was down, for example a refresh that got
  // a 503. the sdk then asks for a new sign-in, but the stored tokens can still be good, so the app tries again later.
  signInOutage?: () => string | undefined;
  // the text for the owner when the server refuses the key with a 401 or a 403, for example the name of the secret.
  refusedKeyHint?: string;
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

  // the error is often the server's own text, for example a json-rpc error or an http body that quotes the key. the
  // state goes to the database, the page and the answer of connect, so it is redacted here, once.
  const setState = (next: ConnectionState) => {
    state = next.error === undefined ? next : { ...next, error: redact(next.error) };
    deps.onState?.(state);
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

  // the tools/call requests that wait for an answer. a server with one thread does not answer a ping during a long
  // call, and a close then would end a call that would answer later.
  let calls = 0;
  const ping = async (attempt: Client) => {
    cancelTimer = setTimer(() => void ping(attempt), PING_EVERY_MS);
    if (calls > 0) return;
    try {
      await attempt.ping({ timeout: 30_000 });
    } catch (err) {
      if (calls > 0) {
        logger.info('mcp server did not answer a ping during a call', { integration: id, err });
        return;
      }
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
    // the default is legacy today. auto mode starts a second stdio process that the recorder never sees, so the mode
    // is fixed here and an sdk update cannot change it.
    const attempt = new Client(CLIENT_INFO, { versionNegotiation: { mode: 'legacy' } });
    // only one walk of the tool list runs at a time, and the first walk counts as one. a list_changed during a walk
    // starts one more walk after it. without this, walks ran side by side: a slow, older answer replaced a newer
    // list, and a server with large pages and frequent list_changed filled the heap until the app crashed.
    let walking = true;
    let again = false;
    const walk = () => {
      if (mine !== generation) return;
      if (walking) {
        again = true;
        return;
      }
      walking = true;
      again = false;
      listTools(attempt)
        .then(
          (tools) => mine === generation && deps.onTools(tools),
          (err: unknown) => mine === generation && logger.warn('mcp tool list refresh failed', { integration: id, err }),
        )
        .finally(() => {
          walking = false;
          if (again) walk();
        });
    };
    // the refresh after list_changed waits for a quiet second, because a server often sends several at once.
    let refreshTimer: NodeJS.Timeout | undefined;
    attempt.setNotificationHandler('notifications/tools/list_changed', () => {
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(walk, LIST_CHANGED_DEBOUNCE_MS);
      refreshTimer.unref();
    });
    const stale = async () => {
      if (mine === generation && !stopped) return false;
      await attempt.close().catch(() => {});
      return true;
    };
    let transportError: string | undefined;
    const reason = (text: string) => (transportError && !text.includes(transportError) ? `${text}: ${transportError}` : text);
    // the sdk gives no status in the text of an http error, for example "Error POSTing to endpoint: " for a 401.
    // the hint of a refused key says all that the owner needs, so the transport error does not follow it.
    const describe = (err: unknown) => {
      const status = err instanceof SdkHttpError ? err.status : undefined;
      if ((status === 401 || status === 403) && deps.refusedKeyHint) return `the server refused the key (http ${status}). ${deps.refusedKeyHint}`;
      return reason(status ? `http ${status}: ${errorText(err)}` : errorText(err));
    };
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
      const tools = await listTools(attempt);
      if (await stale()) return;
      client = attempt;
      connectedAt = clock().getTime();
      const server = attempt.getServerVersion();
      setState({ status: 'connected', ...(server ? { server: { name: server.name, version: server.version } } : {}) });
      logger.info('mcp server connected', { integration: id, tools: tools.length });
      deps.onTools(tools);
      walking = false;
      if (again) walk();
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
      const outage = isAuthError(err) ? deps.signInOutage?.() : undefined;
      if (outage) {
        retry(`the sign-in server did not answer: ${outage}`);
        return;
      }
      if (isAuthError(err)) {
        setState({ status: 'needs_auth', error: 'the server needs authorization. connect it from the dashboard.' });
        logger.warn('mcp server needs authorization', { integration: id });
        return;
      }
      retry(describe(err));
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
      const call: ActiveCall = { trace };
      calls++;
      try {
        // the run's signal does not go to the request. after an abort the sdk sends a cancel and drops the answer, so
        // the app would never learn whether the tool acted. the wait has its own long limit. at that limit the sdk
        // sends notifications/cancelled, and the trace links it to the call.
        // a plain request and not callTool: callTool checks the result against the outputSchema of the server. that
        // check runs the server's patterns on the event loop, and it throws for a tool that ran.
        const result = await activeCall.run(call, () =>
          connected.request({ method: 'tools/call', params: { name, arguments: args } }, { timeout: deps.answerWaitMs ?? ANSWER_WAIT_MS }),
        );
        return { kind: 'result', result: result as CallToolResult };
      } catch (err) {
        if (call.answer === 'result') return { kind: 'unknown', reason: errorText(err), answered: true };
        const outage = isAuthError(err) ? deps.signInOutage?.() : undefined;
        if (outage) {
          // the stored tokens can still be good, so the connection stays, and the next call tries the refresh again.
          return { kind: 'not_sent', reason: `the sign-in server did not answer (${outage}). Try again later.` };
        }
        if (isAuthError(err) && client === connected) {
          // the server refused the token before it acted, and the refresh failed too. the owner must sign in again.
          client = undefined;
          generation++;
          clearTimer();
          await connected.close().catch(() => {});
          setState({ status: 'needs_auth', error: 'the sign-in expired or was revoked. connect it again from the dashboard.' });
          logger.warn('mcp server needs authorization again', { integration: id });
        }
        // a server that cannot be reached stays down until it starts again. a close starts the backoff now, so the
        // next call says that it is not connected, and the next ping does not have to find it.
        if (unreachedCode(err) && client === connected) await connected.close().catch(() => {});
        return classify(err);
      } finally {
        calls--;
      }
    },
  };
}

export const LIST_CHANGED_DEBOUNCE_MS = 1_000;
// a server whose pages never end must not hold the connection. the sdk has the same limit.
export const LIST_PAGES_LIMIT = 64;
// the sdk checks a whole tools/list answer against its strict tool schema, so one tool with a sloppy shape, also a
// tool that the config hides, threw the whole list away, and the integration never connected. this schema takes the
// list as it is, and the catalog checks each allowed tool on its own.
// some servers send nextCursor: null on the last page.
const ToolsPage = z.looseObject({ tools: z.array(z.unknown()), nextCursor: z.string().nullish() });

export async function listTools(client: Client): Promise<unknown[]> {
  // a server without the tools capability has no tools, and a request would get an error.
  if (!client.getServerCapabilities()?.tools) return [];
  const tools: unknown[] = [];
  let cursor: string | undefined;
  for (let page = 1; ; page++) {
    const result = await client.request({ method: 'tools/list', ...(cursor === undefined ? {} : { params: { cursor } }) }, ToolsPage);
    tools.push(...result.tools);
    // a server that gives the same cursor again has no more pages.
    if (result.nextCursor === undefined || result.nextCursor === null || result.nextCursor === cursor) return tools;
    if (page >= LIST_PAGES_LIMIT) throw new Error(`the tools/list of the server has more than ${LIST_PAGES_LIMIT} pages`);
    cursor = result.nextCursor;
  }
}

// the sdk gives a typed error for each way that a request can fail. the kind decides what the model may assume.
// a 401 that the sdk could not repair with a refresh. the http transport throws it before the server acts.
const isAuthError = (err: unknown) => err instanceof UnauthorizedError || err instanceof OAuthError;

// the http status of a request that the server refused: null when the sdk does not give it, undefined when the server
// did not refuse it. the sdk throws its auth errors only after the server answered a post with a 401, or with a 403
// for a missing scope. it reads the token for a header without a request.
function refusedStatus(err: unknown): number | null | undefined {
  if (err instanceof SdkHttpError && (err.status === 401 || err.status === 403)) return err.status;
  return isAuthError(err) ? null : undefined;
}

export function classify(err: unknown): CallOutcome {
  if (err instanceof ProtocolError) return { kind: 'refused', code: err.code, message: err.message };
  // the oauth provider reads and writes the tokens before the post, or after a 401. the tool did not run either way.
  if (err instanceof CredentialStoreError) return { kind: 'not_sent', reason: err.message };
  if (isAuthError(err)) return { kind: 'not_sent', reason: `the server refused the sign-in: ${errorText(err)}` };
  // an http server checks the key before it acts.
  if (err instanceof SdkHttpError && (err.status === 401 || err.status === 403)) return { kind: 'not_sent', reason: `the server refused the key (http ${err.status})` };
  if (err instanceof SdkError && (err.code === SdkErrorCode.NotConnected || err.code === SdkErrorCode.SendFailed)) {
    return { kind: 'not_sent', reason: err.message };
  }
  // the protocol rejects a request without a transport with a plain error, before any message goes out.
  if (err instanceof Error && !(err instanceof SdkError) && err.message === 'Not connected') return { kind: 'not_sent', reason: err.message };
  const code = unreachedCode(err);
  if (code) return { kind: 'not_sent', reason: `the server cannot be reached (${code})` };
  return { kind: 'unknown', reason: errorText(err) };
}

// fetch fails with these codes before a byte leaves: nothing listens on the port, or the name has no address. fetch
// gives "fetch failed", and the code is on its cause.
const UNREACHED = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN']);
function unreachedCode(err: unknown): string | undefined {
  // the name and not instanceof: the TypeError of fetch can come from another realm, for example in a test runner.
  const code = err instanceof Error && err.name === 'TypeError' ? (err.cause as { code?: unknown } | undefined)?.code : undefined;
  return typeof code === 'string' && UNREACHED.has(code) ? code : undefined;
}
