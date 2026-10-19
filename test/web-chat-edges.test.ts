import { InMemoryTransport, type Transport } from '@modelcontextprotocol/client';
import type { Hono } from 'hono';
import { afterEach, describe, expect, it } from 'vitest';
import { createTelegramChannel } from '../src/channels/telegram.js';
import { createWebChannel } from '../src/channels/web.js';
import { createDashboard } from '../src/dashboard/server.js';
import type { ChatSendResponse, ChatStreamEvent, ChatStopResponse } from '../src/dashboard/types.js';
import { appendEvent, listEvents } from '../src/events/log.js';
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

const failing: FakeStep = async () => {
  throw new ModelError('request', 'the model refused the request', 400);
};

describe('the web chat at its edges', () => {
  it('stops a turn that telegram started through the web stop route', async () => {
    const t = await setup([held(['Phone draft'], 'never', new Promise(() => {}))]);
    const reader = await t.stream();
    t.telegram.push(textUpdate(OWNER, 'a long phone task'));
    await waitFor(() => streamed(reader.events, 'telegram:1') === 'Phone draft', 'the telegram draft on the web');

    expect(await t.stop('telegram:1')).toEqual({ stopped: true });
    await waitFor(() => hasState(reader, 'telegram:1', 'stopped'), 'the stopped state');
    await t.app.idle();
    expect(t.rows('SELECT status FROM runs')).toEqual([{ status: 'aborted' }]);
    // the stopped reply went out on telegram, the channel of the message, and the web saw it too.
    await until(() => t.telegram.messages().some((m) => m.text === 'Stopped.'));
    expect(of(forTurn(reader.events, 'telegram:1'), 'reply')).toEqual([expect.objectContaining({ text: 'Stopped.' })]);
    expect(of(forTurn(reader.events, 'telegram:1'), 'done')).toEqual([{ kind: 'done', turnId: 'telegram:1', ok: false }]);
    expect(await t.stop('telegram:1')).toEqual({ stopped: false });
  });

  it('stops a telegram run when the owner types /stop in the web chat', async () => {
    const t = await setup([held(['Busy'], 'never', new Promise(() => {}))]);
    const reader = await t.stream();
    t.telegram.push(textUpdate(OWNER, 'work hard'));
    await waitFor(() => streamed(reader.events, 'telegram:1') === 'Busy', 'the telegram draft');
    const answer = await t.send('/stop');
    expect(answer.turnId).toBe('web:u1');
    await waitFor(() => hasState(reader, 'telegram:1', 'stopped'), 'the stopped state');
    await t.app.idle();
    expect(t.model.calls).toHaveLength(1);
    expect(t.rows('SELECT status FROM runs')).toEqual([{ status: 'aborted' }]);
    // /stop is a command, so it never becomes a turn of its own.
    expect(t.web.chat.snapshot()).toEqual([]);
  });

  it('gives an end state on the stream to each turn that the send route said runs', async () => {
    const t = await setup([]);
    const reader = await t.stream();
    const { turnId, state } = await t.send('/status');
    expect(state).toBe('running');
    await waitFor(() => of(reader.events, 'reply').length > 0, 'the status reply');
    expect(of(reader.events, 'reply')[0]!.turnId).toBe(turnId);
    // the page waits for an end of each turn that runs. a command answers at once, so its turn must end too.
    await waitFor(() => ['done', 'failed', 'stopped'].some((end) => hasState(reader, turnId, end)), 'an end of the command turn', 500);
  });

  it('ends the turn of a /stop that stopped a telegram run, next to the stopped telegram turn', async () => {
    const t = await setup([held(['Busy'], 'never', new Promise(() => {}))]);
    const reader = await t.stream();
    t.telegram.push(textUpdate(OWNER, 'work hard'));
    await waitFor(() => streamed(reader.events, 'telegram:1') === 'Busy', 'the telegram draft');
    const { turnId, state } = await t.send('/stop');
    expect([turnId, state]).toEqual(['web:u1', 'running']);
    await waitFor(() => hasState(reader, 'web:u1', 'done'), 'the end of the /stop turn');
    await waitFor(() => hasState(reader, 'telegram:1', 'stopped'), 'the stopped state');
    expect(of(reader.events, 'owner').map((event) => event.turnId)).toEqual(['telegram:1', 'web:u1']);
  });

  it('sends the error of a failed turn before its failed state', async () => {
    const t = await setup([failing]);
    const reader = await t.stream();
    const { turnId } = await t.send('try it');
    await waitFor(() => hasState(reader, turnId, 'failed'), 'the failed state');
    const turn = forTurn(reader.events, turnId);
    expect(turn.slice(-2)).toEqual([
      { kind: 'error', turnId, error: expect.stringMatching(/^Sorry, I could not finish that/) },
      { kind: 'state', turnId, state: 'failed' },
    ]);
  });

  it('gives the queued state to each message sent at once, and runs them one at a time in order', async () => {
    const release = gate();
    const t = await setup([held(['One'], 'First.', release.wait), textStep('Second.'), textStep('Third.')]);
    const reader = await t.stream();
    const answers = await Promise.all([t.send('one'), t.send('two'), t.send('three')]);
    expect(answers).toEqual([
      { turnId: 'web:u1', state: 'running' },
      { turnId: 'web:u2', state: 'queued' },
      { turnId: 'web:u3', state: 'queued' },
    ]);

    // a client that comes now sees all three turns, oldest first.
    const late = await t.stream();
    await waitFor(() => late.events.length >= 2, 'the late snapshot');
    const snapshot = late.events[1] as Of<'snapshot'>;
    expect(snapshot.turns.map((turn) => [turn.turnId, turn.state])).toEqual([
      ['web:u1', 'running'],
      ['web:u2', 'queued'],
      ['web:u3', 'queued'],
    ]);
    expect(snapshot.turns.slice(1).every((turn) => turn.runId === null && turn.text === '')).toBe(true);

    release.open();
    await waitFor(() => hasState(reader, 'web:u3', 'done'), 'the last done state');
    await t.app.idle();
    expect(of(reader.events, 'reply').map((reply) => [reply.turnId, reply.text])).toEqual([
      ['web:u1', 'First.'],
      ['web:u2', 'Second.'],
      ['web:u3', 'Third.'],
    ]);
    expect(stateOf(reader.events, 'web:u1', 'done')).toBeLessThan(stateOf(reader.events, 'web:u2', 'running'));
    expect(stateOf(reader.events, 'web:u2', 'done')).toBeLessThan(stateOf(reader.events, 'web:u3', 'running'));
    expect(t.web.chat.snapshot()).toEqual([]);
  });

  it('gives false for the stop of a queued turn, and the turn still runs after the one before it', async () => {
    const release = gate();
    const t = await setup([held(['A'], 'A done.', release.wait), textStep('B done.')]);
    const reader = await t.stream();
    await t.send('a');
    const queued = await t.send('b');
    expect(queued.state).toBe('queued');
    expect(await t.stop(queued.turnId)).toEqual({ stopped: false });
    release.open();
    await waitFor(() => hasState(reader, queued.turnId, 'done'), 'the done state of the queued turn');
    expect(of(forTurn(reader.events, queued.turnId), 'reply')).toEqual([expect.objectContaining({ text: 'B done.' })]);
  });

  it('ends a turn whose model call fails as failed, and the next message works', async () => {
    const t = await setup([failing, textStep('Better now.')]);
    const reader = await t.stream();
    const { turnId } = await t.send('try it');
    await waitFor(() => hasState(reader, turnId, 'failed'), 'the failed state');
    await t.app.idle();
    const turn = forTurn(reader.events, turnId);
    expect(of(turn, 'done')).toEqual([{ kind: 'done', turnId, ok: false }]);
    expect(of(turn, 'reply')).toEqual([expect.objectContaining({ text: expect.stringMatching(/^Sorry, I could not finish that/) })]);
    expect(turn.at(-1)).toEqual({ kind: 'state', turnId, state: 'failed' });
    expect(t.web.chat.snapshot()).toEqual([]);

    const next = await t.send('again');
    await waitFor(() => hasState(reader, next.turnId, 'done'), 'the next done state');
    expect(of(forTurn(reader.events, next.turnId), 'reply')).toEqual([expect.objectContaining({ text: 'Better now.' })]);
  });

  it('never shows NO_REPLY on the web, and ends the turn as done without a reply', async () => {
    const t = await setup([chunked(['NO', '_RE', 'PLY'])]);
    const reader = await t.stream();
    const { turnId } = await t.send('just note this');
    await waitFor(() => hasState(reader, turnId, 'done'), 'the done state');
    await t.app.idle();
    expect(JSON.stringify(of(reader.events, 'text'))).not.toContain('NO');
    expect(of(reader.events, 'reply')).toEqual([]);
    expect(of(reader.events, 'done')).toEqual([{ kind: 'done', turnId, ok: true }]);
  });

  it('shows nothing of a message from a stranger on telegram', async () => {
    const t = await setup([textStep('should not run')]);
    const reader = await t.stream();
    await waitFor(() => reader.events.length >= 2, 'the snapshot');
    t.telegram.push(textUpdate(4242, 'let me in'));
    await until(() => t.telegram.messages().some((m) => m.text === 'Sorry, I only talk with my owner.'));
    await t.app.idle();
    // the stream has a few turns of the event loop to show anything that it would show.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(reader.events.slice(2)).toEqual([]);
    expect(t.model.calls).toEqual([]);
  });

  it('never gives the data of a button to the model or the log, also when it looks like a command', async () => {
    const t = await setup([textStep('unused')]);
    const reader = await t.stream();
    await waitFor(() => reader.events.length >= 2, 'the snapshot');
    // only the data of a button that the web channel sent counts, so a card puts these on buttons first.
    await t.web.send({ chatId: 'web', text: 'a card', buttons: [['/new', '/stop', 'hello model'].map((data) => ({ text: data, data }))] });
    await waitFor(() => of(reader.events, 'reply').length === 1, 'the card');
    for (const { data } of of(reader.events, 'reply')[0]!.buttons.flat()) {
      const pressed = await t.post('/api/chat/button', { data });
      expect(pressed.status).toBe(200);
      expect(await pressed.json()).toEqual({ ok: true });
    }
    await t.app.idle();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(t.model.calls).toEqual([]);
    expect(listEvents(t.db, 'main')).toEqual([]);
    expect(of(reader.events, 'owner')).toEqual([]);
    expect(t.web.chat.snapshot()).toEqual([]);
  });

  it('refuses a text over 16,000 characters and one of only spaces, and takes exactly 16,000', async () => {
    const t = await setup([textStep('Long read.')]);
    expect((await t.post('/api/chat', { text: 'a'.repeat(16_001) })).status).toBe(400);
    expect((await t.post('/api/chat', { text: ' \n\t ' })).status).toBe(400);
    expect((await t.post('/api/chat', {})).status).toBe(400);
    expect((await t.post('/api/chat', { text: 42 })).status).toBe(400);
    expect((await t.post('/api/chat', null)).status).toBe(400);
    expect((await t.post('/api/chat', ['hi'])).status).toBe(400);
    expect(t.model.calls).toEqual([]);
    const reader = await t.stream();
    const { turnId } = await t.send('a'.repeat(16_000));
    await waitFor(() => hasState(reader, turnId, 'done'), 'the done state');
    expect(t.model.calls).toHaveLength(1);
  });

  it('refuses a stop or a button without a valid body', async () => {
    const t = await setup([]);
    expect((await t.post('/api/chat/stop', {})).status).toBe(400);
    expect((await t.post('/api/chat/stop', { turnId: '' })).status).toBe(400);
    expect((await t.post('/api/chat/stop', { turnId: 7 })).status).toBe(400);
    expect((await t.post('/api/chat/button', {})).status).toBe(400);
    expect((await t.post('/api/chat/button', { data: 5 })).status).toBe(400);
    expect((await t.post('/api/chat/button', { data: 'x', turnId: '' })).status).toBe(400);
  });

  it('carries text with new lines and quotes over the stream unchanged', async () => {
    const tricky = 'line one\n\ndata: fake\r\nevent: ping\n"quoted"   end';
    const t = await setup([textStep(tricky)]);
    const reader = await t.stream();
    const { turnId } = await t.send(tricky);
    await waitFor(() => hasState(reader, turnId, 'done'), 'the done state');
    expect(of(reader.events, 'owner')[0]!.text).toBe(tricky);
    expect(of(reader.events, 'reply')[0]!.text).toBe(tricky);
  });

  it('removes the listener of a client that disconnects', async () => {
    const t = await setup([]);
    const chat = t.app.chat!;
    let open = 0;
    const counted = {
      ...chat,
      subscribe(listener: (event: ChatStreamEvent) => void) {
        open++;
        const off = chat.subscribe(listener);
        return () => {
          open--;
          off();
        };
      },
    };
    const dashboard = createDashboard({ db: t.db, config: t.config, clock: t.clock, logger: silentLogger, app: { ...t.app, chat: counted } });
    const clients = [await openStream(dashboard), await openStream(dashboard), await openStream(dashboard)];
    await waitFor(() => open === 3, 'three listeners');
    await clients[0]!.cancel();
    await clients[1]!.cancel();
    await waitFor(() => open === 1, 'one listener');
    await clients[2]!.cancel();
    await waitFor(() => open === 0, 'no listener');
  });

  // a session that read untrusted text is tainted. a draft then shows each link that can carry data as a mark.
  const taint = (t: { db: Parameters<typeof appendEvent>[0] }) =>
    appendEvent(t.db, {
      sessionKey: 'main',
      runId: null,
      type: 'system_event',
      payload: { text: 'an automation read a web page.', taint: [{ source: 'web:evil.example', toolName: 'web_fetch', runId: null, toolCallId: 'x1', at: pdt('08:00') }] },
    });
  const leak = 'See https://evil.example/collect?secret=hunter2abc and more';

  for (const from of ['web', 'telegram'] as const) {
    it(`hides a data link of a tainted session in the streamed draft of a ${from} turn and in the snapshot`, async () => {
      const release = gate();
      const t = await setup([held([leak], 'Plain end.', release.wait)]);
      taint(t);
      const reader = await t.stream();
      const turnId = from === 'web' ? (await t.send('summarize it')).turnId : 'telegram:1';
      if (from === 'telegram') t.telegram.push(textUpdate(OWNER, 'summarize it'));
      await waitFor(() => streamed(reader.events, turnId).includes('[link]'), 'the guarded draft');
      const late = await t.stream();
      await waitFor(() => late.events.length >= 2, 'the late snapshot');
      release.open();
      await waitFor(() => hasState(reader, turnId, 'done'), 'the done state');
      await t.app.idle();
      const texts = JSON.stringify([...of(reader.events, 'text'), late.events[1]]);
      expect(texts).not.toContain('hunter2abc');
      expect(texts).not.toContain('evil.example/collect');
      expect((late.events[1] as Of<'snapshot'>).turns[0]!.text).toContain('[link]');
    });
  }

  it('keeps the other clients going while one client reads nothing', async () => {
    const t = await setup([]);
    const stalled = await t.dashboard.request('/api/chat/stream');
    expect(stalled.status).toBe(200);
    const reader = await t.stream();
    await waitFor(() => reader.events.length >= 2, 'the snapshot');
    const total = 1_200;
    for (let i = 0; i < total; i++) {
      await t.web.send({ chatId: 'web', text: `note ${i}` });
      if (i % 100 === 99) await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await waitFor(() => of(reader.events, 'reply').length === total, `every reply (seen ${of(reader.events, 'reply').length})`, 10_000).catch((err) => {
      throw new Error(`${String(err)}: ${of(reader.events, 'reply').length}`);
    });
    expect(of(reader.events, 'reply').map((reply) => reply.text)).toEqual(Array.from({ length: total }, (_, i) => `note ${i}`));
    // a proactive text names no turn.
    expect(of(reader.events, 'reply').every((reply) => reply.turnId === null)).toBe(true);
    await stalled.body?.cancel();
  }, 20_000);
});

