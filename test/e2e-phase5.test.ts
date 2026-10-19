import { InMemoryTransport, type Transport } from '@modelcontextprotocol/client';
import type { Hono } from 'hono';
import { afterEach, describe, expect, it } from 'vitest';
import { createTelegramChannel } from '../src/channels/telegram.js';
import { createWebChannel } from '../src/channels/web.js';
import { createDashboard } from '../src/dashboard/server.js';
import type { ChatMessagesPage, ChatSendResponse, ChatsPage, ChatStreamEvent, RunSpans, SearchResults } from '../src/dashboard/types.js';
import { listEvents } from '../src/events/log.js';
import { parseIntegrations } from '../src/integrations/config.js';
import { textStep, toolStep } from '../src/models/fake.js';
import { silentLogger } from '../src/observability/logger.js';
import { createTestApp } from './app-harness.js';
import { createFakeTelegram } from './fake-telegram.js';
import { createTestServer } from './mcp-server.js';

// this test runs the whole system once, with a fake model, a fake telegram and an mcp server in memory. it follows one
// web chat message through the run, its tools, the stream, the reply, the chat list, the search, the spans and the
// approval card, and each step reads only the public routes of the dashboard.

const OWNER = 777;
const pdt = (time: string) => new Date(`2026-10-12T${time}:00-07:00`).toISOString();

type Seen = ChatStreamEvent | { kind: 'ready' };
type Of<K extends Seen['kind']> = Extract<Seen, { kind: K }>;
const of = <K extends Seen['kind']>(events: Seen[], kind: K): Array<Of<K>> => events.filter((event): event is Of<K> => event.kind === kind);

interface Reader {
  events: Seen[];
  cancel(): Promise<void>;
}

const readers: Reader[] = [];
const apps: Array<{ app: { stop(): Promise<void> } }> = [];

afterEach(async () => {
  for (const reader of readers.splice(0)) await reader.cancel();
  for (const each of apps.splice(0)) await each.app.stop();
});

// the reader keeps each event of the chat stream in order. event: ready shows as the kind ready, and pings are left
// out, because the page ignores them.
async function openStream(dashboard: Hono): Promise<Reader> {
  const response = await dashboard.request('/api/chat/stream');
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toContain('text/event-stream');
  const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
  const events: Seen[] = [];
  let buffer = '';
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
    }
  })();
  const opened: Reader = {
    events,
    async cancel() {
      await reader.cancel().catch(() => {});
      await pump;
    },
  };
  readers.push(opened);
  return opened;
}

// the stream and the run take a few turns of the event loop. the helper waits for a condition.
async function waitFor(condition: () => boolean, what: string, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`${what} did not become true`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

const call = (id: string, name: string, args: Record<string, unknown>) => toolStep({ id, name: 'tool_call', input: { name, arguments: args } });

describe('phase 5 end to end', () => {
  it('follows a web chat message through the run, the stream, the chats, the search, the spans and the approval', async () => {
    const telegram = createFakeTelegram();
    let uuids = 0;
    const web = createWebChannel({
      clock: () => t.clock(),
      newId: () => `u${++uuids}`,
      textTickMs: 0,
      logger: silentLogger,
    });
    const entries = parseIntegrations({
      integrations: [
        {
          id: 'notes',
          kind: 'mcp-stdio',
          command: 'node',
          args: ['server.js'],
          tools: { allow: ['add_note'] },
          sessions: ['main'],
        },
      ],
    });
    if (!entries.ok) throw new Error(entries.error);
    const transport = async (): Promise<Transport> => {
      const [client, server] = InMemoryTransport.createLinkedPair();
      await createTestServer().connect(server);
      return client;
    };
    // the model reads the time, asks to add a note, which needs an approval, and then gives its final reply.
    const t = createTestApp(
      [
        toolStep({ id: 'n1', name: 'now', input: {} }),
        call('c1', 'notes__add_note', { note: 'descale the kettle' }),
        textStep('I asked to save the kettle note. It waits for your approval.'),
      ],
      {
        start: pdt('09:00'),
        deps: {
          channels: [
            createTelegramChannel({
              bot: telegram.bot,
              ownerId: String(OWNER),
              logger: silentLogger,
              clock: () => t.clock(),
            }),
            web,
          ],
          ownerIds: { telegram: String(OWNER) },
          integrations: entries.value,
          mcpTransport: transport,
        },
      },
    );
    apps.push(t);
    await t.app.start();
    await expect.poll(() => t.app.integrations.status()[0]!.state.status).toBe('connected');
    const dashboard = createDashboard({
      db: t.db,
      config: t.config,
      clock: t.clock,
      logger: silentLogger,
      app: t.app,
    });
    const get = async <T>(path: string): Promise<T> => {
      const response = await dashboard.request(path);
      expect(response.status, path).toBe(200);
      return (await response.json()) as T;
    };
    const post = (path: string, body: unknown) =>
      dashboard.request(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });

    // 1. a web chat message starts a run.
    const reader = await openStream(dashboard);
    await waitFor(() => reader.events.length >= 2, 'the ready and snapshot events');
    expect(reader.events.slice(0, 2)).toEqual([{ kind: 'ready' }, { kind: 'snapshot', turns: [] }]);
    const sent = await post('/api/chat', {
      text: 'remind me to descale the kettle',
    });
    expect(sent.status).toBe(200);
    const { turnId, state } = (await sent.json()) as ChatSendResponse;
    expect(turnId).toBe('web:u1');
    expect(state).toBe('running');
    await waitFor(() => of(reader.events, 'done').some((event) => event.turnId === turnId), 'the done event');
    await t.app.idle();

    // 2. the run called its tools and ended.
    const runs = t.rows('SELECT id, trigger, sessionKey, status FROM runs') as Array<{ id: string; status: string }>;
    expect(runs).toEqual([
      {
        id: expect.any(String),
        trigger: 'message',
        sessionKey: 'main',
        status: 'completed',
      },
    ]);
    const runId = runs[0]!.id;
    const calls = t.rows('SELECT name FROM tool_calls WHERE runId = ? ORDER BY id', runId) as Array<{ name: string }>;
    expect(calls.map((row) => row.name)).toEqual(['now', 'notes__add_note']);
    expect(t.model.calls).toHaveLength(3);

    // 3. the stream gave the owner message, the run, the activity of the tools, the card, the reply and the end, in
    // that order.
    const events = reader.events;
    const index = (match: (event: Seen) => boolean, what: string) => {
      const at = events.findIndex(match);
      expect(at, what).toBeGreaterThanOrEqual(0);
      return at;
    };
    const ownerAt = index((e) => e.kind === 'owner' && e.turnId === turnId, 'the owner event');
    const runAt = index((e) => e.kind === 'run' && e.turnId === turnId && e.runId === runId, 'the run event');
    const activityAt = index((e) => e.kind === 'activity' && e.turnId === turnId, 'an activity event');
    const cardAt = index((e) => e.kind === 'reply' && e.turnId === null && e.text.startsWith('Approval needed (#1): notes__add_note'), 'the card');
    const replyAt = index((e) => e.kind === 'reply' && e.turnId === turnId, 'the reply');
    const doneAt = index((e) => e.kind === 'done' && e.turnId === turnId, 'the done event');
    expect(ownerAt).toBeLessThan(runAt);
    expect(runAt).toBeLessThan(activityAt);
    expect(activityAt).toBeLessThan(cardAt);
    expect(cardAt).toBeLessThan(replyAt);
    expect(replyAt).toBeLessThan(doneAt);
    expect(events[ownerAt]).toEqual({
      kind: 'owner',
      turnId,
      channel: 'web',
      text: 'remind me to descale the kettle',
      at: expect.any(String),
    });
    expect(of(events, 'done')).toEqual([{ kind: 'done', turnId, ok: true }]);
    expect(events.at(-1)).toEqual({ kind: 'state', turnId, state: 'done' });

    // 4. the reply is the final text of the run.
    const reply = events[replyAt] as Of<'reply'>;
    expect(reply).toMatchObject({
      runId,
      text: 'I asked to save the kettle note. It waits for your approval.',
      markdown: true,
      buttons: [],
    });

    // 5. the chat is in the list, and its messages are the owner message, the approval turn and the reply.
    const chats = await get<ChatsPage>('/api/chats');
    expect(chats.nextCursor).toBeNull();
    const main = chats.chats.find((chat) => chat.key === 'main@0');
    expect(main).toMatchObject({
      kind: 'main',
      sessionKey: 'main',
      channel: 'web',
      runs: 1,
      lastRunStatus: 'completed',
      pendingApprovals: 1,
    });
    expect(main!.title).toContain('remind me to descale the kettle');
    expect(main!.preview).toContain('It waits for your approval.');
    const page = await get<ChatMessagesPage>(`/api/chats/${encodeURIComponent('main@0')}/messages`);
    expect(page.chat.key).toBe('main@0');
    expect(page.before).toBeNull();
    const owners = page.messages.filter((message) => message.role === 'owner');
    expect(owners).toEqual([
      expect.objectContaining({
        channel: 'web',
        text: 'remind me to descale the kettle',
        runId,
      }),
    ]);
    const agents = page.messages.filter((message) => message.role === 'agent');
    expect(agents.at(-1)).toMatchObject({
      runId,
      text: 'I asked to save the kettle note. It waits for your approval.',
      guarded: false,
    });
    expect(agents.some((message) => message.approvalId === 1)).toBe(true);
    // the messages are oldest first.
    const ids = page.messages.map((message) => message.id);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));

    // 6. the search finds the reply and the tool call, and the hits open the chat and the run.
    const found = await get<SearchResults>('/api/search?q=kettle');
    expect(found.mode).toBe('fts');
    const group = (scope: string) => found.groups.find((each) => each.scope === scope)!;
    expect(found.groups.map((each) => each.scope)).toEqual(['messages', 'runs', 'tools', 'automations', 'memory', 'approvals']);
    const messageHits = group('messages').hits;
    expect(messageHits.length).toBeGreaterThan(0);
    for (const hit of messageHits) {
      expect(hit).toMatchObject({
        scope: 'messages',
        chatKey: 'main@0',
        sessionKey: 'main',
      });
      expect(hit.snippet.toLowerCase()).toContain('kettle');
      for (const [start, end] of hit.marks) expect(hit.snippet.slice(start, end).toLowerCase()).toBe('kettle');
    }
    expect(messageHits.some((hit) => hit.runId === runId)).toBe(true);
    expect(messageHits.map((hit) => hit.href)).toEqual(messageHits.map(() => 'chats/main%400'));
    // the tools scope matches the name of a tool and the text of its result, not its input.
    const tools = await get<SearchResults>('/api/search?q=add_note&scope=tools');
    expect(tools.groups.map((each) => each.scope)).toEqual(['tools']);
    expect(tools.groups[0]!.hits).toEqual([
      expect.objectContaining({
        title: 'notes__add_note',
        runId,
        href: `runs/${runId}`,
      }),
    ]);
    expect(group('approvals').hits.map((hit) => hit.id)).toContain('1');

    // 7. the spans of the run hold the model calls, both tool calls and the approval.
    const spans = await get<RunSpans>(`/api/runs/${encodeURIComponent(runId)}/spans`);
    expect(spans.runId).toBe(runId);
    expect(spans.endedAt).not.toBeNull();
    expect(spans.spans[0]).toMatchObject({
      kind: 'run',
      parentId: null,
      status: 'completed',
      ref: { kind: 'run', runId },
    });
    const byKind = (kind: string) => spans.spans.filter((each) => each.kind === kind);
    expect(byKind('model')).toHaveLength(3);
    expect(byKind('tool').map((each) => each.label)).toEqual(
      expect.arrayContaining([expect.stringContaining('now'), expect.stringContaining('notes__add_note')]),
    );
    expect(byKind('approval')).toEqual([
      expect.objectContaining({
        status: 'pending',
        ref: { kind: 'approval', approvalId: 1 },
      }),
    ]);
    // a tool span has the outcome word of the run detail as its status.
    expect(spans.spans.find((each) => each.label === 'now')).toMatchObject({
      status: 'ran',
      ref: { kind: 'tool', toolCallId: 'n1' },
    });
    const addNote = spans.spans.find((each) => each.label === 'notes__add_note' && each.kind === 'tool')!;
    expect(addNote.ref).toMatchObject({ kind: 'tool', toolCallId: 'c1' });
    expect(byKind('approval')[0]!.parentId).toBe(addNote.id);
    // the test clock stands still while the durations are real, so the starts are not checked. each parent comes
    // before its children.
    const seen = new Set<string>();
    for (const each of spans.spans) {
      if (each.parentId !== null) expect(seen.has(each.parentId), `the parent of ${each.id}`).toBe(true);
      seen.add(each.id);
    }
    expect((await dashboard.request('/api/runs/not-a-run/spans')).status).toBe(404);

    // 8. the button of the card on the web resolves the approval, and the tool runs.
    const approve = (events[cardAt] as Of<'reply'>).buttons.flat().find((button) => button.data.startsWith('approval:1:approve.'));
    expect(approve).toBeDefined();
    const pressed = await post('/api/chat/button', { data: approve!.data });
    expect(pressed.status).toBe(200);
    expect(await pressed.json()).toEqual({ ok: true });
    await waitFor(() => of(reader.events, 'reply').some((event) => event.turnId === null && /^Approved #1\./.test(event.text)), 'the reply to the button');
    await t.app.idle();
    expect(t.rows('SELECT status FROM approvals')).toEqual([{ status: 'approved' }]);
    expect(t.rows("SELECT output FROM tool_calls WHERE toolCallId = 'approval-1'")).toEqual([{ output: expect.stringContaining('saved: descale the kettle') }]);
    // a press is not a turn, so it starts no run and does not reach the model.
    expect(t.rows('SELECT COUNT(*) AS n FROM runs')).toEqual([{ n: 1 }]);
    expect(t.model.calls).toHaveLength(3);
    expect(JSON.stringify(t.model.calls)).not.toContain(approve!.data);
    expect(JSON.stringify(listEvents(t.db, 'main'))).not.toContain(approve!.data);

    // 9. the views agree with the approval after the press.
    const after = await get<ChatsPage>('/api/chats');
    expect(after.chats.find((chat) => chat.key === 'main@0')).toMatchObject({
      pendingApprovals: 0,
    });
    const searched = await get<SearchResults>('/api/search?q=kettle&scope=approvals');
    expect(searched.groups[0]!.hits).toEqual([
      expect.objectContaining({
        id: '1',
        title: 'notes__add_note (approved)',
        runId,
      }),
    ]);
    // the chat shows the result of the approval as a system message.
    const pageAfter = await get<ChatMessagesPage>(`/api/chats/${encodeURIComponent('main@0')}/messages`);
    expect(pageAfter.messages.at(-1)).toMatchObject({
      role: 'system',
      text: expect.stringMatching(/^The owner approved #1 /),
    });
    expect(pageAfter.messages.at(-1)!.text).toContain('saved: descale the kettle');
    const spansAfter = await get<RunSpans>(`/api/runs/${encodeURIComponent(runId)}/spans`);
    expect(spansAfter.spans.filter((each) => each.kind === 'approval')).toEqual([expect.objectContaining({ status: 'approved' })]);
    // the tool call that ran after the approval sits under the approval, with its call to the mcp server.
    const ran = spansAfter.spans.find((each) => each.kind === 'tool' && each.ref.kind === 'tool' && each.ref.toolCallId === 'approval-1');
    expect(ran).toMatchObject({ label: 'notes__add_note', status: 'ran', parentId: 'approval:1' });
    expect(spansAfter.spans.filter((each) => each.kind === 'mcp' && each.parentId === ran!.id)).toHaveLength(1);

    // the event log only grew, so each id is larger than the one before it.
    const log = listEvents(t.db, 'main').map((event) => event.id);
    expect(log).toEqual([...log].sort((a, b) => a - b));
    expect(new Set(log).size).toBe(log.length);
  });
});
