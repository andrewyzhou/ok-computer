import { InMemoryTransport, type Transport } from '@modelcontextprotocol/client';
import type { Hono } from 'hono';
import { afterEach, describe, expect, it } from 'vitest';
import { createTelegramChannel } from '../src/channels/telegram.js';
import { createWebChannel } from '../src/channels/web.js';
import { createDashboard } from '../src/dashboard/server.js';
import type { ChatSendResponse, ChatStreamEvent, ChatStopResponse } from '../src/dashboard/types.js';
import { listEvents } from '../src/events/log.js';
import { parseIntegrations } from '../src/integrations/config.js';
import { fakeResponse, textStep, toolStep, type FakeStep } from '../src/models/fake.js';
import { ModelError } from '../src/models/types.js';
import { silentLogger } from '../src/observability/logger.js';
import { createTestApp } from './app-harness.js';
import { createFakeTelegram, textUpdate, until } from './fake-telegram.js';
import { createTestServer } from './mcp-server.js';

const OWNER = 777;
const pdt = (time: string) => new Date(`2026-10-12T${time}:00-07:00`).toISOString();

// the reader keeps each event of the chat stream in order. event: ready shows as the kind ready, and the pings are
// left out, because the page ignores them.
type Seen = ChatStreamEvent | { kind: 'ready' };

interface Reader {
  status: number;
  events: Seen[];
  cancel(): Promise<void>;
  closed(): boolean;
}

const readers: Reader[] = [];

async function openStream(dashboard: Hono): Promise<Reader> {
  const response = await dashboard.request('/api/chat/stream');
  const events: Seen[] = [];
  if (response.status !== 200) {
    await response.body?.cancel();
    return { status: response.status, events, cancel: async () => {}, closed: () => true };
  }
  expect(response.headers.get('content-type')).toContain('text/event-stream');
  const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  let closed = false;
  const pump = (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buffer += value;
        for (let end = buffer.indexOf('\n\n'); end >= 0; end = buffer.indexOf('\n\n')) {
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const name = /^event: ?(.*)$/m.exec(block)?.[1];
          const data = block
            .split('\n')
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).replace(/^ /, ''))
            .join('\n');
          if (name === 'ready') events.push({ kind: 'ready' });
          else if (name === 'ping') continue;
          else if (data) events.push(JSON.parse(data) as ChatStreamEvent);
        }
      }
    } catch {
      // a cancelled reader ends the loop.
    } finally {
      closed = true;
    }
  })();
  const opened: Reader = {
    status: response.status,
    events,
    async cancel() {
      await reader.cancel().catch(() => {});
      await pump;
    },
    closed: () => closed,
  };
  readers.push(opened);
  return opened;
}

// the stream and the run take a few turns of the event loop and a few timers. the helper waits for a condition.
async function waitFor(condition: () => boolean, what = 'the condition', ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`${what} did not become true`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

const json = (body: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

type Of<K extends Seen['kind']> = Extract<Seen, { kind: K }>;
const of = <K extends Seen['kind']>(events: Seen[], kind: K): Array<Of<K>> => events.filter((event): event is Of<K> => event.kind === kind);
const forTurn = (events: Seen[], turnId: string) => events.filter((event) => 'turnId' in event && event.turnId === turnId);
const stateOf = (events: Seen[], turnId: string, state: string) =>
  events.findIndex((event) => event.kind === 'state' && event.turnId === turnId && event.state === state);
const hasState = (reader: Reader, turnId: string, state: string) => stateOf(reader.events, turnId, state) >= 0;
// consecutive text events show as one kind, so a list of kinds does not depend on how the text was cut.
const kinds = (events: Seen[]) => events.map((event) => event.kind).filter((kind, i, all) => kind !== 'text' || all[i - 1] !== 'text');
const streamed = (events: Seen[], turnId: string) =>
  of(events, 'text')
    .filter((event) => event.turnId === turnId)
    .reduce((text, event) => (event.reset ? event.delta : text + event.delta), '');

// a gate holds a model step until the test opens it.
function gate() {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => (open = resolve));
  return { open, wait };
}

// the step streams its parts, then waits for the gate or the abort of the run. at the gate it gives the final text.
function held(parts: string[], final: string, until: Promise<void>): FakeStep {
  return (_call, signal, onText) =>
    new Promise((resolve, reject) => {
      let shown = '';
      for (const part of parts) {
        shown += part;
        onText?.(shown);
      }
      signal?.addEventListener('abort', () => reject(new ModelError('aborted', 'the request was aborted')));
      void until.then(() => {
        onText?.(final);
        resolve(fakeResponse({ text: final }));
      });
    });
}

// the step streams the final text in parts and gives it at once.
function chunked(parts: string[]): FakeStep {
  return async (_call, _signal, onText) => {
    let shown = '';
    for (const part of parts) {
      shown += part;
      onText?.(shown);
      await new Promise((resolve) => setImmediate(resolve));
    }
    return fakeResponse({ text: shown });
  };
}

const call = (id: string, name: string, args: Record<string, unknown>) => toolStep({ id, name: 'tool_call', input: { name, arguments: args } });

// the whole app with telegram and the web chat, a fake model and the dashboard. the uuid part of each web turn id is
// u<n>, so the first web turn is web:u1.
async function setup(steps: FakeStep[], options: { web?: boolean; integrations?: boolean; textTickMs?: number } = {}) {
  const telegram = createFakeTelegram();
  let uuids = 0;
  const web = createWebChannel({
    clock: () => t.clock(),
    newId: () => `u${++uuids}`,
    textTickMs: options.textTickMs ?? 0,
    logger: silentLogger,
  });
  const entries = options.integrations
    ? parseIntegrations({
        integrations: [{ id: 'notes', kind: 'mcp-stdio', command: 'node', args: ['server.js'], tools: { allow: ['add_note'] }, sessions: ['main'] }],
      })
    : undefined;
  if (entries && !entries.ok) throw new Error(entries.error);
  const transport = async (): Promise<Transport> => {
    const [client, server] = InMemoryTransport.createLinkedPair();
    await createTestServer().connect(server);
    return client;
  };
  const t = createTestApp(steps, {
    start: pdt('09:00'),
    deps: {
      channels: [
        createTelegramChannel({ bot: telegram.bot, ownerId: String(OWNER), logger: silentLogger, clock: () => t.clock() }),
        ...(options.web === false ? [] : [web]),
      ],
      ownerIds: { telegram: String(OWNER) },
      ...(entries ? { integrations: entries.value, mcpTransport: transport } : {}),
    },
  });
  apps.push(t);
  await t.app.start();
  const dashboard = createDashboard({ db: t.db, config: t.config, clock: t.clock, logger: silentLogger, app: t.app });
  const post = (path: string, body: unknown) => dashboard.request(path, json(body));
  const send = async (text: string) => {
    const response = await post('/api/chat', { text });
    expect(response.status).toBe(200);
    return (await response.json()) as ChatSendResponse;
  };
  const stop = async (turnId: string) => {
    const response = await post('/api/chat/stop', { turnId });
    expect(response.status).toBe(200);
    return (await response.json()) as ChatStopResponse;
  };
  const of = (method: string) => telegram.calls.filter((c) => c.method === method).map((c) => c.payload);
  const rich = () => of('sendRichMessage').map((payload) => (payload.rich_message as { markdown: string }).markdown);
  return { ...t, telegram, web, dashboard, post, send, stop, of, rich, stream: () => openStream(dashboard) };
}

const apps: Array<{ app: { stop(): Promise<void> } }> = [];
afterEach(async () => {
  for (const reader of readers.splice(0)) await reader.cancel();
  for (const each of apps.splice(0)) await each.app.stop();
});

describe('the web chat', () => {
  it('streams a web turn in order, and the run, the log and the answer agree', async () => {
    const t = await setup([chunked(['Hello', ', ', 'owner.'])]);
    const reader = await t.stream();
    await waitFor(() => reader.events.length >= 2, 'the ready and snapshot events');

    const answer = await t.send('hello there');
    expect(answer).toEqual({ turnId: 'web:u1', state: 'running' });
    await waitFor(() => hasState(reader, 'web:u1', 'done'), 'the done state');
    await t.app.idle();

    const runs = t.rows('SELECT id, trigger, sessionKey, status FROM runs') as Array<{ id: string }>;
    expect(runs).toEqual([{ id: expect.any(String), trigger: 'message', sessionKey: 'main', status: 'completed' }]);
    const runId = runs[0]!.id;
    const events = reader.events;
    expect(kinds(events)).toEqual(['ready', 'snapshot', 'owner', 'state', 'run', 'text', 'reply', 'done', 'state']);
    expect(events[1]).toEqual({ kind: 'snapshot', turns: [] });
    expect(events[2]).toEqual({ kind: 'owner', turnId: 'web:u1', channel: 'web', text: 'hello there', at: expect.any(String) });
    expect(events[3]).toEqual({ kind: 'state', turnId: 'web:u1', state: 'running' });
    expect(events[4]).toEqual({ kind: 'run', turnId: 'web:u1', runId });
    expect(of(events, 'text').every((event) => event.turnId === 'web:u1')).toBe(true);
    expect(streamed(events, 'web:u1')).toBe('Hello, owner.');
    expect(of(events, 'reply')).toEqual([
      expect.objectContaining({ kind: 'reply', turnId: 'web:u1', runId, text: 'Hello, owner.', markdown: true, buttons: [] }),
    ]);
    expect(of(events, 'done')).toEqual([{ kind: 'done', turnId: 'web:u1', ok: true }]);
    expect(events.at(-1)).toEqual({ kind: 'state', turnId: 'web:u1', state: 'done' });

    const owner = listEvents(t.db, 'main').filter((event) => event.type === 'user_message');
    expect(owner).toEqual([expect.objectContaining({ runId, payload: expect.objectContaining({ text: 'hello there', channel: 'web' }) })]);
    // the reply went to the web, not to telegram.
    expect(t.rich()).toEqual([]);
  });

  it('trusts the web channel as the owner', async () => {
    const t = await setup([textStep('Hi.')]);
    const reader = await t.stream();
    await t.send('who am i talking to');
    await waitFor(() => hasState(reader, 'web:u1', 'done'), 'the done state');
    await t.app.idle();
    expect(t.model.calls).toHaveLength(1);
    expect(JSON.stringify(t.model.calls[0]!.messages)).toContain('who am i talking to');
    const texts = of(reader.events, 'reply').map((reply) => reply.text);
    expect(texts).toEqual(['Hi.']);
    expect(t.telegram.messages().map((m) => m.text)).not.toContain('Sorry, I only talk with my owner.');
  });

  it('gives each open client the same events, and a late client a snapshot of the running turn', async () => {
    const release = gate();
    const t = await setup([held(['Draft ', 'so far'], 'Draft so far, and the end.', release.wait)]);
    const clients = [await t.stream(), await t.stream(), await t.stream()];
    await waitFor(() => clients.every((client) => client.events.length >= 2), 'the snapshots');

    const { turnId } = await t.send('write it');
    await waitFor(() => streamed(clients[0]!.events, turnId) === 'Draft so far', 'the streamed draft');
    const runId = (t.rows('SELECT id FROM runs') as Array<{ id: string }>)[0]!.id;

    const late = await t.stream();
    await waitFor(() => late.events.length >= 2, 'the late snapshot');
    expect(late.events.slice(0, 2)).toEqual([
      { kind: 'ready' },
      { kind: 'snapshot', turns: [{ turnId, channel: 'web', state: 'running', runId, text: 'Draft so far', activity: null }] },
    ]);

    release.open();
    await waitFor(() => [...clients, late].every((client) => hasState(client, turnId, 'done')), 'the done state on each client');
    await t.app.idle();
    expect(clients[1]!.events).toEqual(clients[0]!.events);
    expect(clients[2]!.events).toEqual(clients[0]!.events);
    expect(of(late.events, 'reply')).toEqual([expect.objectContaining({ turnId, text: 'Draft so far, and the end.' })]);
    expect(of(late.events, 'done')).toEqual([{ kind: 'done', turnId, ok: true }]);
    expect(streamed(clients[0]!.events, turnId)).toBe('Draft so far, and the end.');
  });

  it('finishes the run when a client goes away in the middle', async () => {
    const release = gate();
    const t = await setup([held(['Half'], 'Half and whole.', release.wait), textStep('Again.')]);
    const leaving = await t.stream();
    const staying = await t.stream();
    const { turnId } = await t.send('first');
    await waitFor(() => streamed(leaving.events, turnId) === 'Half', 'the streamed draft');
    await leaving.cancel();
    expect(leaving.closed()).toBe(true);

    release.open();
    await waitFor(() => hasState(staying, turnId, 'done'), 'the done state');
    await t.app.idle();
    expect(t.rows('SELECT status FROM runs')).toEqual([{ status: 'completed' }]);
    expect(of(staying.events, 'reply')).toEqual([expect.objectContaining({ turnId, text: 'Half and whole.' })]);
    expect(of(staying.events, 'done')).toEqual([{ kind: 'done', turnId, ok: true }]);
    expect(of(leaving.events, 'reply')).toEqual([]);

    // the chat still works for the client that stayed and for a new one.
    const next = await t.send('second');
    expect(next).toEqual({ turnId: 'web:u2', state: 'running' });
    await waitFor(() => hasState(staying, 'web:u2', 'done'), 'the second done state');
    await t.app.idle();
    expect(of(staying.events, 'reply').map((reply) => reply.text)).toEqual(['Half and whole.', 'Again.']);
    const fresh = await t.stream();
    await waitFor(() => fresh.events.length >= 2, 'the fresh snapshot');
    expect(fresh.events[1]).toEqual({ kind: 'snapshot', turns: [] });
  });

  it('stops a web turn through the stop route', async () => {
    const t = await setup([held(['Working on'], 'never', new Promise(() => {})), textStep('Fresh answer.')]);
    const reader = await t.stream();
    const { turnId } = await t.send('think for a long time');
    await waitFor(() => streamed(reader.events, turnId) === 'Working on', 'the streamed draft');

    expect(await t.stop(turnId)).toEqual({ stopped: true });
    await waitFor(() => hasState(reader, turnId, 'stopped'), 'the stopped state');
    await t.app.idle();
    const turn = forTurn(reader.events, turnId);
    expect(of(turn, 'done')).toEqual([{ kind: 'done', turnId, ok: false }]);
    expect(of(turn, 'reply')).toEqual([expect.objectContaining({ turnId, text: 'Stopped.' })]);
    expect(turn.at(-1)).toEqual({ kind: 'state', turnId, state: 'stopped' });
    expect(t.rows('SELECT status FROM runs')).toEqual([{ status: 'aborted' }]);
    expect(listEvents(t.db, 'main').at(-1)).toMatchObject({
      type: 'system_event',
      payload: { text: 'The owner stopped the previous reply before it was done.' },
    });

    expect(await t.stop(turnId)).toEqual({ stopped: false });
    expect(await t.stop('web:not-a-turn')).toEqual({ stopped: false });

    // the next message runs normally.
    const next = await t.send('hi');
    await waitFor(() => hasState(reader, next.turnId, 'done'), 'the next done state');
    expect(of(forTurn(reader.events, next.turnId), 'reply')).toEqual([expect.objectContaining({ text: 'Fresh answer.' })]);
  });

  it('queues a web message behind a telegram run, and runs it after', async () => {
    const release = gate();
    const t = await setup([held(['Long'], 'Long answer.', release.wait), textStep('Web answer.')]);
    const reader = await t.stream();
    t.telegram.push(textUpdate(OWNER, 'a long task'));
    await waitFor(() => streamed(reader.events, 'telegram:1') === 'Long', 'the telegram draft on the web');

    const answer = await t.send('and this too');
    expect(answer).toEqual({ turnId: 'web:u1', state: 'queued' });
    await waitFor(() => hasState(reader, 'web:u1', 'queued'), 'the queued state');
    expect(hasState(reader, 'web:u1', 'running')).toBe(false);
    expect(t.model.calls).toHaveLength(1);

    release.open();
    await waitFor(() => hasState(reader, 'web:u1', 'done'), 'the web done state');
    await t.app.idle();
    const events = reader.events;
    expect(stateOf(events, 'web:u1', 'queued')).toBeLessThan(stateOf(events, 'telegram:1', 'done'));
    expect(stateOf(events, 'telegram:1', 'done')).toBeLessThan(stateOf(events, 'web:u1', 'running'));
    expect(stateOf(events, 'web:u1', 'running')).toBeLessThan(stateOf(events, 'web:u1', 'done'));
    expect(of(events, 'reply').map((reply) => [reply.turnId, reply.text])).toEqual([
      ['telegram:1', 'Long answer.'],
      ['web:u1', 'Web answer.'],
    ]);
    expect(t.rows('SELECT status FROM runs ORDER BY startedAt, rowid')).toEqual([{ status: 'completed' }, { status: 'completed' }]);
    expect(JSON.stringify(t.model.calls[1]!.messages)).toContain('and this too');
    // each reply went out on the channel of its message.
    expect(t.rich()).toEqual(['Long answer.']);
  });

  it('streams a turn that telegram started to the web clients', async () => {
    const t = await setup([chunked(['From ', 'telegram.'])]);
    const reader = await t.stream();
    t.telegram.push(textUpdate(OWNER, 'hello from the phone'));
    await waitFor(() => hasState(reader, 'telegram:1', 'done'), 'the telegram done state');
    await t.app.idle();

    const runId = (t.rows('SELECT id FROM runs') as Array<{ id: string }>)[0]!.id;
    const events = reader.events;
    expect(kinds(events)).toEqual(['ready', 'snapshot', 'owner', 'state', 'run', 'text', 'reply', 'done', 'state']);
    expect(events[2]).toEqual({ kind: 'owner', turnId: 'telegram:1', channel: 'telegram', text: 'hello from the phone', at: expect.any(String) });
    expect(events[3]).toEqual({ kind: 'state', turnId: 'telegram:1', state: 'running' });
    expect(events[4]).toEqual({ kind: 'run', turnId: 'telegram:1', runId });
    expect(streamed(events, 'telegram:1')).toBe('From telegram.');
    expect(of(events, 'reply')).toEqual([expect.objectContaining({ turnId: 'telegram:1', runId, text: 'From telegram.', markdown: true })]);
    expect(of(events, 'done')).toEqual([{ kind: 'done', turnId: 'telegram:1', ok: true }]);
    expect(events.at(-1)).toEqual({ kind: 'state', turnId: 'telegram:1', state: 'done' });

    // telegram shows its own draft and gets its own reply.
    await until(() => t.rich().length === 1);
    expect(t.of('sendMessageDraft').length).toBeGreaterThan(0);
    expect(t.rich()).toEqual(['From telegram.']);
  });

  it('sends the approval card to telegram, and a button from the web resolves it', async () => {
    const t = await setup([call('c1', 'notes__add_note', { note: 'one' }), textStep('It waits for you.')], { integrations: true });
    await expect.poll(() => t.app.integrations.status()[0]!.state.status).toBe('connected');
    const reader = await t.stream();
    const { turnId } = await t.send('add note one');
    expect(turnId).toBe('web:u1');
    await waitFor(() => hasState(reader, turnId, 'done'), 'the done state');
    await t.app.idle();

    // the card went to the owner messenger, which is telegram, and not to the web stream.
    const cards = t.of('sendMessage').filter((m) => m.parse_mode === 'HTML');
    expect(cards).toHaveLength(1);
    expect(String(cards[0]!.text)).toMatch(/^Approval needed \(#1\): notes__add_note/);
    expect(of(reader.events, 'reply').map((reply) => reply.text)).toEqual(['It waits for you.']);
    expect(t.rows('SELECT status FROM approvals')).toEqual([{ status: 'pending' }]);

    const pressed = await t.post('/api/chat/button', { data: 'approval:1:approve', turnId });
    expect(pressed.status).toBe(200);
    expect(await pressed.json()).toEqual({ ok: true });
    await waitFor(() => of(reader.events, 'reply').length === 2, 'the reply to the button');
    await t.app.idle();
    expect(t.rows('SELECT status FROM approvals')).toEqual([{ status: 'approved' }]);
    expect(t.rows("SELECT output FROM tool_calls WHERE toolCallId = 'approval-1'")).toEqual([{ output: expect.stringContaining('saved: one') }]);
    const resolved = of(reader.events, 'reply')[1]!;
    // the press is its own message, so the reply names it as its turn.
    expect(resolved).toMatchObject({ turnId: 'web:u2', text: expect.stringMatching(/^Approved #1\./) });
    // a press is not an owner message, so it gets no owner event and no run.
    expect(of(reader.events, 'owner').map((event) => event.turnId)).toEqual([turnId]);

    // the data of the button never reached the model.
    expect(t.model.calls).toHaveLength(2);
    expect(JSON.stringify(t.model.calls)).not.toContain('approval:1:approve');
    expect(JSON.stringify(listEvents(t.db, 'main'))).not.toContain('approval:1:approve');
  });

  it('sends a proactive message to telegram after the owner used the web chat', async () => {
    const t = await setup([
      toolStep({
        id: 'a1',
        name: 'automations_create',
        input: { name: 'build', schedule: { kind: 'cron', expr: '0 10 * * *' }, payload: { type: 'agent', prompt: 'Tell the owner about the build.' } },
      }),
      textStep('Done.'),
      toolStep({ id: 'm1', name: 'message_owner', input: { text: '**Heads up:** the build is green.' } }),
      textStep('NO_REPLY'),
    ]);
    const reader = await t.stream();
    const { turnId } = await t.send('tell me about the build at 10am');
    await waitFor(() => hasState(reader, turnId, 'done'), 'the done state');
    await t.app.idle();
    await t.at(pdt('10:00'));

    expect(t.rich()).toEqual(['**Heads up:** the build is green.']);
    expect(of(reader.events, 'reply').map((reply) => reply.text)).toEqual(['Done.']);
    const saved = t.rows("SELECT value FROM settings WHERE key = 'owner_chat'") as Array<{ value: string }>;
    for (const row of saved) expect((JSON.parse(row.value) as { channel: string }).channel).not.toBe('web');
  });
});

describe('the web chat when it does not run', () => {
  it('answers 503 when the app has no web channel', async () => {
    const t = await setup([], { web: false });
    const sent = await t.post('/api/chat', { text: 'hello' });
    expect(sent.status).toBe(503);
    expect(await sent.json()).toEqual({ error: expect.any(String) });
    expect((await t.stream()).status).toBe(503);
  });

  it('answers 503 after the web channel stopped', async () => {
    const t = await setup([]);
    await t.web.stop();
    const sent = await t.post('/api/chat', { text: 'hello' });
    expect(sent.status).toBe(503);
    expect(await sent.json()).toEqual({ error: expect.any(String) });
    expect((await t.stream()).status).toBe(503);
    expect(t.model.calls).toEqual([]);
  });

  it('refuses an empty text, a body that is not json, and empty button data', async () => {
    const t = await setup([]);
    const empty = await t.post('/api/chat', { text: '' });
    expect(empty.status).toBe(400);
    expect(await empty.json()).toEqual({ error: expect.any(String) });
    const form = await t.dashboard.request('/api/chat', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'hello' });
    expect(form.status).toBe(415);
    expect((await t.post('/api/chat/button', { data: '' })).status).toBe(400);
    expect(t.model.calls).toEqual([]);
    expect(listEvents(t.db, 'main')).toEqual([]);
  });
});
