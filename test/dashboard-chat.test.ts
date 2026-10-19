import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WebChat } from '../src/channels/web.js';
import { parseConfig } from '../src/config/load.js';
import { CHAT_MAX_PENDING, CHAT_PING_MS } from '../src/dashboard/chat.js';
import { createDashboard, type DashboardDeps } from '../src/dashboard/server.js';
import type { ChatSendResponse, ChatStreamEvent, ChatTurnSnapshot } from '../src/dashboard/types.js';
import { openDb } from '../src/db/index.js';
import { silentLogger } from '../src/observability/logger.js';

// the fake chat records each call and lets the test emit stream events by hand.
function fakeChat(options: { snapshot?: ChatTurnSnapshot[] } = {}) {
  const listeners = new Set<(event: ChatStreamEvent) => void>();
  const calls = { submit: [] as string[], press: [] as Array<[string, string | undefined]>, stop: [] as string[] };
  const state = {
    running: true,
    submitResult: { turnId: 'web:1', state: 'running' } as ChatSendResponse | undefined,
    pressResult: true,
    stopResult: true,
    snapshot: options.snapshot ?? [],
    // it runs right after a listener is added, so a test can emit before the snapshot is written.
    onSubscribe: undefined as (() => void) | undefined,
  };
  const chat: WebChat = {
    running: () => state.running,
    submit(text) {
      calls.submit.push(text);
      return state.submitResult;
    },
    press(data, turnId) {
      calls.press.push([data, turnId]);
      return state.pressResult;
    },
    stop(turnId) {
      calls.stop.push(turnId);
      return state.stopResult;
    },
    snapshot: () => state.snapshot,
    subscribe(listener) {
      listeners.add(listener);
      state.onSubscribe?.();
      return () => listeners.delete(listener);
    },
  };
  const emit = (event: ChatStreamEvent) => {
    for (const listener of listeners) listener(event);
  };
  return { chat, calls, state, listeners, emit };
}

function dashboard(chat: WebChat | undefined, token?: string) {
  const dir = mkdtempSync(join(tmpdir(), 'okc-chat-'));
  const parsed = parseConfig({ paths: { data: dir, workspace: dir } });
  if (!parsed.ok) throw new Error(parsed.error);
  return createDashboard({
    db: openDb(':memory:'),
    config: parsed.value,
    clock: () => new Date('2026-10-18T16:00:00Z'),
    logger: silentLogger,
    app: (chat ? { chat } : {}) as unknown as DashboardDeps['app'],
    webDir: dir,
    ...(token ? { token } : {}),
  });
}

type Server = ReturnType<typeof dashboard>;
const post = (server: Server, path: string, body: unknown, headers: Record<string, string> = {}) =>
  server.request(path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });

interface SseMessage {
  event?: string;
  data: string;
}

// the reader splits the stream on blank lines. next() gives the next message, or undefined at the end.
function sseReader(res: Response) {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const ready: SseMessage[] = [];
  return {
    async next(): Promise<SseMessage | undefined> {
      while (ready.length === 0) {
        const { done, value } = await reader.read();
        if (done) return undefined;
        buffer += decoder.decode(value, { stream: true });
        let end: number;
        while ((end = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const message: SseMessage = { data: '' };
          const data: string[] = [];
          for (const line of block.split('\n')) {
            if (line.startsWith('event: ')) message.event = line.slice(7);
            else if (line.startsWith('data: ')) data.push(line.slice(6));
          }
          message.data = data.join('\n');
          ready.push(message);
        }
      }
      return ready.shift();
    },
    async json(): Promise<unknown> {
      const message = await this.next();
      expect(message?.event).toBeUndefined();
      return JSON.parse(message!.data);
    },
    cancel: () => reader.cancel(),
  };
}

async function waitFor(check: () => boolean) {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
  expect(check()).toBe(true);
}

const turn: ChatTurnSnapshot = { turnId: 'telegram:7', channel: 'telegram', state: 'running', runId: 'run-1', text: 'hel', activity: 'web_search' };
const events: ChatStreamEvent[] = [
  { kind: 'owner', turnId: 'web:1', channel: 'web', text: 'hi', at: '2026-10-18T16:00:00.000Z' },
  { kind: 'state', turnId: 'web:1', state: 'running' },
  { kind: 'run', turnId: 'web:1', runId: 'run-2' },
  { kind: 'text', turnId: 'web:1', delta: 'hello\nthere', reset: false },
  { kind: 'activity', turnId: 'web:1', tools: 'read_file' },
  {
    kind: 'reply',
    turnId: 'web:1',
    messageId: 'm1',
    runId: 'run-2',
    text: 'hello there',
    markdown: true,
    details: null,
    buttons: [[{ text: 'Approve', data: 'approve:1' }]],
    at: '2026-10-18T16:00:01.000Z',
  },
  { kind: 'done', turnId: 'web:1', ok: true },
  { kind: 'error', turnId: null, error: 'the model failed' },
];

afterEach(() => {
  vi.useRealTimers();
});

describe('POST /api/chat', () => {
  it('passes the text unchanged and gives the submit answer', async () => {
    const fake = fakeChat();
    const server = dashboard(fake.chat);
    const text = '  hello\n  world  ';
    const res = await post(server, '/api/chat', { text });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ turnId: 'web:1', state: 'running' });
    expect(fake.calls.submit).toEqual([text]);

    fake.state.submitResult = { turnId: 'web:2', state: 'queued' };
    const queued = await post(server, '/api/chat', { text: 'x'.repeat(16_000) });
    expect(queued.status).toBe(200);
    expect(await queued.json()).toEqual({ turnId: 'web:2', state: 'queued' });
  });

  it('refuses a text that is not valid with 400 before it checks the chat', async () => {
    const fake = fakeChat();
    const server = dashboard(fake.chat);
    for (const body of [{}, { text: '' }, { text: ' \n\t ' }, { text: 'x'.repeat(16_001) }, { text: 'hi', extra: 1 }, { text: 3 }, 'not json']) {
      const res = await post(server, '/api/chat', body);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'give a text of 1 to 16,000 characters' });
    }
    expect((await post(dashboard(undefined), '/api/chat', { text: '' })).status).toBe(400);
    expect(fake.calls.submit).toEqual([]);
  });

  it('gives 415 for a body that is not json', async () => {
    const server = dashboard(fakeChat().chat);
    const res = await server.request('/api/chat', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{"text":"hi"}' });
    expect(res.status).toBe(415);
  });

  it('gives 503 when the chat is missing, not running, or does not take the text', async () => {
    const missing = await post(dashboard(undefined), '/api/chat', { text: 'hi' });
    expect(missing.status).toBe(503);
    expect(await missing.json()).toEqual({ error: 'the web chat is not running' });

    const fake = fakeChat();
    const server = dashboard(fake.chat);
    fake.state.running = false;
    expect((await post(server, '/api/chat', { text: 'hi' })).status).toBe(503);
    expect(fake.calls.submit).toEqual([]);

    fake.state.running = true;
    fake.state.submitResult = undefined;
    const refused = await post(server, '/api/chat', { text: 'hi' });
    expect(refused.status).toBe(503);
    expect(await refused.json()).toEqual({ error: 'the web chat is not running' });
  });

  it('needs the token when one is set, and the stream takes it in the query', async () => {
    const fake = fakeChat({ snapshot: [turn] });
    const server = dashboard(fake.chat, 'secret-token');
    expect((await post(server, '/api/chat', { text: 'hi' })).status).toBe(401);
    expect((await server.request('/api/chat/stream')).status).toBe(401);
    expect((await post(server, '/api/chat', { text: 'hi' }, { authorization: 'Bearer secret-token' })).status).toBe(200);

    const res = await server.request('/api/chat/stream?token=secret-token');
    expect(res.status).toBe(200);
    const sse = sseReader(res);
    expect(await sse.next()).toEqual({ event: 'ready', data: '{}' });
    expect(await sse.json()).toEqual({ kind: 'snapshot', turns: [turn] });
    await sse.cancel();
  });
});

describe('POST /api/chat/button', () => {
  it('passes the data and the turn id to the chat', async () => {
    const fake = fakeChat();
    const server = dashboard(fake.chat);
    const res = await post(server, '/api/chat/button', { data: 'approve:1', turnId: 'web:1' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect((await post(server, '/api/chat/button', { data: 'deny:2' })).status).toBe(200);
    expect(fake.calls.press).toEqual([
      ['approve:1', 'web:1'],
      ['deny:2', undefined],
    ]);
  });

  it('gives 400 for empty data and 503 when the chat does not take the press', async () => {
    const fake = fakeChat();
    const server = dashboard(fake.chat);
    for (const body of [{}, { data: '' }, { data: 'x'.repeat(257) }, { data: 'a', other: 1 }]) {
      const res = await post(server, '/api/chat/button', body);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'give the data of a button' });
    }
    fake.state.pressResult = false;
    const refused = await post(server, '/api/chat/button', { data: 'approve:1' });
    expect(refused.status).toBe(503);
    expect(await refused.json()).toEqual({ error: 'the web chat is not running' });
    expect((await post(dashboard(undefined), '/api/chat/button', { data: 'approve:1' })).status).toBe(503);
  });
});

describe('POST /api/chat/stop', () => {
  it('passes the answer of stop through', async () => {
    const fake = fakeChat();
    const server = dashboard(fake.chat);
    const stopped = await post(server, '/api/chat/stop', { turnId: 'web:1' });
    expect(stopped.status).toBe(200);
    expect(await stopped.json()).toEqual({ stopped: true });
    fake.state.stopResult = false;
    expect(await (await post(server, '/api/chat/stop', { turnId: 'web:9' })).json()).toEqual({ stopped: false });
    expect(fake.calls.stop).toEqual(['web:1', 'web:9']);
  });

  it('gives 400 without a turn id and 503 without a chat', async () => {
    const server = dashboard(fakeChat().chat);
    for (const body of [{}, { turnId: '' }, { turnId: 'web:1', extra: true }]) {
      const res = await post(server, '/api/chat/stop', body);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'give the turnId of the turn to stop' });
    }
    expect((await post(dashboard(undefined), '/api/chat/stop', { turnId: 'web:1' })).status).toBe(503);
  });
});

describe('GET /api/chat/stream', () => {
  it('sends ready, then the snapshot, then each event in order', async () => {
    const fake = fakeChat({ snapshot: [turn] });
    const res = await dashboard(fake.chat).request('/api/chat/stream');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    const sse = sseReader(res);
    expect(await sse.next()).toEqual({ event: 'ready', data: '{}' });
    expect(await sse.json()).toEqual({ kind: 'snapshot', turns: [turn] });
    await waitFor(() => fake.listeners.size === 1);
    for (const event of events) fake.emit(event);
    for (const event of events) expect(await sse.json()).toEqual(event);
    await sse.cancel();
    await waitFor(() => fake.listeners.size === 0);
  });

  it('sends every event to each open client, and a client that leaves does not stop the others', async () => {
    const fake = fakeChat();
    const server = dashboard(fake.chat);
    const a = sseReader(await server.request('/api/chat/stream'));
    const b = sseReader(await server.request('/api/chat/stream'));
    for (const sse of [a, b]) {
      expect((await sse.next())?.event).toBe('ready');
      expect(await sse.json()).toEqual({ kind: 'snapshot', turns: [] });
    }
    await waitFor(() => fake.listeners.size === 2);
    fake.emit(events[0]!);
    fake.emit(events[1]!);
    for (const sse of [a, b]) {
      expect(await sse.json()).toEqual(events[0]);
      expect(await sse.json()).toEqual(events[1]);
    }

    // the first client leaves in the middle of the run.
    fake.emit(events[2]!);
    await a.cancel();
    await waitFor(() => fake.listeners.size === 1);
    fake.emit(events[3]!);
    fake.emit(events[6]!);
    expect(await b.json()).toEqual(events[2]);
    expect(await b.json()).toEqual(events[3]);
    expect(await b.json()).toEqual(events[6]);
    await b.cancel();
    await waitFor(() => fake.listeners.size === 0);
  });

  it('sends an event once when it comes between the subscribe and the snapshot write', async () => {
    const fake = fakeChat({ snapshot: [turn] });
    fake.state.onSubscribe = () => fake.emit(events[3]!);
    const sse = sseReader(await dashboard(fake.chat).request('/api/chat/stream'));
    expect((await sse.next())?.event).toBe('ready');
    expect(await sse.json()).toEqual({ kind: 'snapshot', turns: [turn] });
    fake.state.onSubscribe = undefined;
    fake.emit(events[6]!);
    expect(await sse.json()).toEqual(events[3]);
    expect(await sse.json()).toEqual(events[6]);
    await sse.cancel();
  });

  it('sends a ping on the timer', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const fake = fakeChat();
    const sse = sseReader(await dashboard(fake.chat).request('/api/chat/stream'));
    expect((await sse.next())?.event).toBe('ready');
    await sse.json();
    vi.advanceTimersByTime(CHAT_PING_MS);
    expect(await sse.next()).toEqual({ event: 'ping', data: '{}' });
    fake.emit(events[1]!);
    expect(await sse.json()).toEqual(events[1]);
    await sse.cancel();
  });

  it('closes the stream of a client that falls too far behind', async () => {
    const fake = fakeChat();
    const sse = sseReader(await dashboard(fake.chat).request('/api/chat/stream'));
    await waitFor(() => fake.listeners.size === 1);
    // the client reads nothing, so the events wait in the queue.
    for (let i = 0; i <= CHAT_MAX_PENDING; i++) fake.emit({ kind: 'text', turnId: 'web:1', delta: String(i), reset: false });
    let last: SseMessage | undefined;
    let count = 0;
    for (let message = await sse.next(); message; message = await sse.next()) {
      last = message;
      count++;
    }
    expect(count).toBeLessThan(CHAT_MAX_PENDING + 3);
    expect(last).toBeDefined();
    expect(fake.listeners.size).toBe(0);
  });

  it('gives 503 when the chat is not running', async () => {
    const fake = fakeChat();
    fake.state.running = false;
    const res = await dashboard(fake.chat).request('/api/chat/stream');
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'the web chat is not running' });
    expect(fake.listeners.size).toBe(0);
    expect((await dashboard(undefined).request('/api/chat/stream')).status).toBe(503);
  });
});
