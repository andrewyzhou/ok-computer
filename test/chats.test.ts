import { describe, expect, it } from 'vitest';
import type { ChatMessagesPage, ChatRow, ChatsPage } from '../src/dashboard/types.js';
import type { Db } from '../src/db/index.js';
import { appendEvent } from '../src/events/log.js';
import { REMOVED_LINK, REMOVED_REPLY, REPLY_CALL_ID, REPLY_NOTE, REPLY_TOOL } from '../src/policy/reply.js';
import { seedDashboard } from './seed.js';
import { at, CHILD_SESSION, GUARDED_REPLY, seedM1, TRACE_RUN } from './seed-m1.js';

type Dashboard = { request: (path: string) => Response | Promise<Response> };

async function get<T>(dashboard: Dashboard, path: string): Promise<T> {
  const response = await dashboard.request(path);
  expect(response.status, path).toBe(200);
  return (await response.json()) as T;
}

const keysOf = (page: ChatsPage) => page.chats.map((chat) => chat.key);
const messagesPath = (key: string, query = '') => `/api/chats/${encodeURIComponent(key)}/messages${query}`;

const addRun = (db: Db, id: string, sessionKey = 'main', status = 'completed') =>
  db.prepare("INSERT INTO runs (id, sessionKey, trigger, slot, status, startedAt) VALUES (?, ?, 'message', 'main', ?, ?)").run(id, sessionKey, status, at(30_000));

const agentTurn = (text: string, toolCalls: Array<{ id: string; name: string; input: Record<string, unknown> }> = []) => ({
  provider: 'fake',
  model: 'm',
  content: [...(text ? [{ type: 'text' as const, text }] : []), ...toolCalls.map((call) => ({ type: 'tool_use' as const, ...call }))],
  text,
  toolCalls,
  stopReason: toolCalls.length ? ('tool_use' as const) : ('end_turn' as const),
});

const addDecision = (db: Db, runId: string, toolCallId: string, toolName: string, extra: { approvalId?: number; verdict?: string } = {}) =>
  db
    .prepare(
      `INSERT INTO policy_decisions (runId, toolCallId, toolName, decision, rule, reason, reviewerVerdict, approvalId, createdAt)
       VALUES (?, ?, ?, 'review', 'exfiltration', 'seeded', ?, ?, ?)`,
    )
    .run(runId, toolCallId, toolName, extra.verdict ?? null, extra.approvalId ?? null, at(30_000));

describe('the chat list', () => {
  it('splits main at the reset and gives each segment its numbers', async () => {
    const { dashboard, resetEventId } = await seedM1();
    const page = await get<ChatsPage>(dashboard, '/api/chats');
    const byKey = new Map(page.chats.map((chat) => [chat.key, chat]));
    expect(page.nextCursor).toBeNull();

    const first = byKey.get('main@0')!;
    expect(first).toMatchObject({ kind: 'main', sessionKey: 'main', fromEventId: 0, toEventId: resetEventId - 1 });
    expect(first.title).toBe('my goals: essay by 21:00, and gym');
    expect(first.channel).toBe('cli');
    expect(first.preview).toBe('Next is the essay check-in at 21:00.');

    const trip = byKey.get(`main@${resetEventId}`)!;
    expect(trip).toMatchObject({
      kind: 'main',
      fromEventId: resetEventId,
      toEventId: null,
      title: 'plan the trip to the coast',
      channel: 'web',
      runs: 1,
      lastRunStatus: 'completed',
      pendingApprovals: 1,
    });
    // the three calls of trace-1. the call of the child run counts in the sub chat only.
    expect(trip.costUsd).toBeCloseTo(0.031, 10);
    // the preview is the delivered text, so the guarded link is not in it.
    expect(trip.preview).not.toContain('owner-notes');
    expect(trip.preview).toContain(REMOVED_LINK.slice(0, 40));

    const sub = byKey.get(CHILD_SESSION)!;
    expect(sub).toMatchObject({ kind: 'sub', title: 'Sub-agent: research', channel: null, toEventId: null, runs: 1, preview: 'The ferry leaves at 11:00.' });
    expect(sub.costUsd).toBeCloseTo(0.002, 10);
    const heartbeat = page.chats.find((chat) => chat.kind === 'heartbeat')!;
    expect(heartbeat.title).toBe('Heartbeat');
    // the heartbeat answered NO_REPLY, so it has no text to show.
    expect(heartbeat.preview).toBeNull();
  });

  it('sorts by lastAt and then by key, newest first', async () => {
    const { dashboard } = await seedM1();
    const { chats } = await get<ChatsPage>(dashboard, '/api/chats');
    const sorted = [...chats].sort((a, b) => (a.lastAt === b.lastAt ? (a.key < b.key ? 1 : -1) : a.lastAt < b.lastAt ? 1 : -1));
    expect(keysOf({ chats, nextCursor: null })).toEqual(sorted.map((chat) => chat.key));
  });

  it('leaves out a segment that holds only its reset', async () => {
    const { t, dashboard } = await seedM1();
    await t.say('/new');
    const lastReset = Number(t.db.prepare("SELECT MAX(id) AS id FROM events WHERE type = 'session_reset'").get()!.id);
    expect(keysOf(await get<ChatsPage>(dashboard, '/api/chats?kind=main'))).not.toContain(`main@${lastReset}`);
    // the messages page still knows the segment, because its reset exists.
    const page = await get<ChatMessagesPage>(dashboard, messagesPath(`main@${lastReset}`));
    expect(page.chat.title).toBe('New chat');
    expect(page.messages.map((message) => message.text)).toEqual(['Started a new session.']);
  });

  it('filters by kind', async () => {
    const { dashboard, resetEventId } = await seedM1();
    const activity = keysOf(await get<ChatsPage>(dashboard, '/api/chats?kind=activity'));
    const main = keysOf(await get<ChatsPage>(dashboard, '/api/chats?kind=main'));
    expect(activity).toContain(CHILD_SESSION);
    expect(activity.some((key) => key.startsWith('heartbeat:'))).toBe(true);
    expect(activity.some((key) => key.startsWith('main@'))).toBe(false);
    expect(main.sort()).toEqual(['main@0', `main@${resetEventId}`].sort());
    expect(keysOf(await get<ChatsPage>(dashboard, '/api/chats?kind=sub'))).toEqual([CHILD_SESSION]);
    expect((await dashboard.request('/api/chats?kind=nope')).status).toBe(400);
  });

  it('matches q on the title and the preview, case-blind', async () => {
    const { dashboard, resetEventId } = await seedM1();
    expect(keysOf(await get<ChatsPage>(dashboard, '/api/chats?q=COAST'))).toEqual([`main@${resetEventId}`]);
    expect(keysOf(await get<ChatsPage>(dashboard, '/api/chats?q=ferry%20leaves'))).toEqual([CHILD_SESSION]);
    expect(keysOf(await get<ChatsPage>(dashboard, '/api/chats?q=essay&kind=activity'))).toEqual([]);
    expect(keysOf(await get<ChatsPage>(dashboard, '/api/chats?q=nothing-like-this'))).toEqual([]);
  });

  it('pages with a cursor, with no duplicates and no gaps', async () => {
    const { dashboard } = await seedM1();
    const all = keysOf(await get<ChatsPage>(dashboard, '/api/chats'));
    expect(all.length).toBeGreaterThan(2);
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const query: string = cursor ? `&cursor=${encodeURIComponent(cursor)}` : '';
      const page: ChatsPage = await get<ChatsPage>(dashboard, `/api/chats?limit=1${query}`);
      expect(page.chats.length).toBe(1);
      seen.push(...keysOf(page));
      cursor = page.nextCursor;
    } while (cursor && seen.length < 20);
    expect(seen).toEqual(all);
    // the cursor pages with the q filter too.
    const filtered = await get<ChatsPage>(dashboard, '/api/chats?limit=1&kind=main');
    const rest = await get<ChatsPage>(dashboard, `/api/chats?limit=1&kind=main&cursor=${filtered.nextCursor}`);
    expect([...keysOf(filtered), ...keysOf(rest)]).toHaveLength(2);
    expect(rest.nextCursor).toBeNull();
  });

  it('answers 400 for a cursor that it cannot read', async () => {
    const { dashboard } = await seedM1();
    const wrongShape = Buffer.from(JSON.stringify({ lastAt: 5, key: 'main@0' })).toString('base64url');
    for (const cursor of ['nope', '%7B%7D', wrongShape, Buffer.from('[1,2]').toString('base64url'), Buffer.from('null').toString('base64url')]) {
      expect((await dashboard.request(`/api/chats?cursor=${cursor}`)).status, cursor).toBe(400);
    }
  });

  it('titles a background chat by its session key', async () => {
    const { t, dashboard } = await seedDashboard();
    t.db
      .prepare(
        `INSERT INTO automations (id, name, schedule, payload, sessionMode, slot, enabled, createdBy, createdAt, updatedAt)
         VALUES ('a1', 'Morning   brief', '{}', '{}', 'isolated', 'main', 1, 'owner', ?, ?)`,
      )
      .run(at(0), at(0));
    const keys = ['auto:a1:r1', 'auto:gone:r2', 'consolidate:2026-10-12', 'workshop:w1', 'poll:google', 'cli-odd'];
    for (const sessionKey of keys) {
      appendEvent(t.db, { sessionKey, runId: null, type: 'system_event', payload: { text: `the prompt of ${sessionKey}` } }, new Date(at(0)));
    }
    const { chats } = await get<ChatsPage>(dashboard, '/api/chats?kind=activity');
    const titles = Object.fromEntries(chats.map((chat: ChatRow) => [chat.key, [chat.kind, chat.title, chat.preview]]));
    expect(titles['auto:a1:r1']).toEqual(['auto', 'Morning brief', null]);
    expect(titles['auto:gone:r2']).toEqual(['auto', 'gone', null]);
    expect(titles['consolidate:2026-10-12']).toEqual(['consolidate', 'Memory consolidation 2026-10-12', null]);
    expect(titles['workshop:w1']).toEqual(['workshop', 'Skill workshop', null]);
    expect(titles['poll:google']).toEqual(['poll', 'Poll: google', null]);
    expect(titles['cli-odd']).toEqual(['other', 'cli-odd', null]);
  });

  it('cuts a long title and a long preview and collapses their whitespace', async () => {
    const { t, dashboard, resetEventId } = await seedM1();
    await t.say('/new');
    const reset = Number(t.db.prepare("SELECT MAX(id) AS id FROM events WHERE type = 'session_reset'").get()!.id);
    expect(reset).toBeGreaterThan(resetEventId);
    appendEvent(t.db, { sessionKey: 'main', runId: null, type: 'user_message', payload: { text: `a\n\n  ${'x'.repeat(300)}`, channel: 'telegram', chatId: '1' } }, new Date(at(40_000)));
    const chat = (await get<ChatsPage>(dashboard, '/api/chats?kind=main')).chats.find((each) => each.key === `main@${reset}`)!;
    expect(chat.title).toBe(`a ${'x'.repeat(78)}`);
    expect(chat.preview).toBe(`a ${'x'.repeat(198)}`);
    expect(chat.channel).toBe('telegram');
    expect(chat.runs).toBe(0);
    expect(chat.costUsd).toBeNull();
    expect(chat.lastRunStatus).toBeNull();
  });
});

describe('the messages of a chat', () => {
  it('shows the delivered text of the segment after the reset', async () => {
    const { dashboard, resetEventId, ids } = await seedM1();
    const page = await get<ChatMessagesPage>(dashboard, `/api/chats/main%40${resetEventId}/messages`);
    expect(page.chat.key).toBe(`main@${resetEventId}`);
    expect(page.before).toBeNull();
    expect(page.messages.map((message) => [message.id, message.role])).toEqual([
      [resetEventId, 'system'],
      [ids.ownerEvent, 'owner'],
      [ids.replyEvent, 'agent'],
      [ids.noteEvent, 'note'],
    ]);
    const [reset, owner, reply, note] = page.messages;
    expect(reset!.text).toBe('Started a new session.');
    expect(owner).toMatchObject({ channel: 'web', text: 'plan the trip to the coast', guarded: false, runId: TRACE_RUN });
    expect(reply!.guarded).toBe(true);
    expect(reply!.text).not.toContain('owner-notes');
    expect(reply!.text).toContain(REMOVED_LINK);
    expect(reply!.text.startsWith('The 9:10 train fits.')).toBe(true);
    expect(GUARDED_REPLY).toContain('owner-notes');
    expect(note!.guarded).toBe(true);
    expect(note!.text.startsWith(REPLY_NOTE)).toBe(true);
  });

  it('pages with before and ends with null', async () => {
    const { dashboard } = await seedDashboard();
    const all = await get<ChatMessagesPage>(dashboard, messagesPath('main@0', '?limit=200'));
    expect(all.before).toBeNull();
    expect(all.chat.title).toBe('my goals: essay by 21:00, and gym');
    // the empty turn with tool calls, the tool results and the compaction are not chat messages.
    expect(all.messages.map((message) => message.role)).toEqual(['owner', 'agent', 'owner', 'agent', 'owner', 'owner', 'agent']);
    const ids = all.messages.map((message) => message.id);
    const seen: number[] = [];
    let before: number | null = null;
    do {
      const query: string = before ? `?limit=3&before=${before}` : '?limit=3';
      const page: ChatMessagesPage = await get<ChatMessagesPage>(dashboard, messagesPath('main@0', query));
      expect(page.messages.length).toBeGreaterThan(0);
      seen.unshift(...page.messages.map((message) => message.id));
      before = page.before;
    } while (before !== null && seen.length < 50);
    expect(seen).toEqual(ids);
    expect((await dashboard.request(messagesPath('main@0', '?before=abc'))).status).toBe(400);
    expect((await dashboard.request(messagesPath('main@0', '?before=0'))).status).toBe(400);
  });

  it('shows a background chat with its row', async () => {
    const { dashboard } = await seedM1();
    const page = await get<ChatMessagesPage>(dashboard, messagesPath(CHILD_SESSION));
    expect(page.chat).toMatchObject({ key: CHILD_SESSION, kind: 'sub', title: 'Sub-agent: research' });
    expect(page.messages.map((message) => [message.role, message.text])).toEqual([
      ['system', 'Your task from the parent agent:\nfind the ferry times'],
      ['agent', 'The ferry leaves at 11:00.'],
    ]);
  });

  it('answers 404 for a chat that does not exist', async () => {
    const { dashboard, ids } = await seedM1();
    for (const key of ['main@999999', 'main', 'nosuch:x', `main@${ids.ownerEvent}`, 'main@01', 'main@-1']) {
      expect((await dashboard.request(messagesPath(key))).status, key).toBe(404);
    }
  });

  it('links a turn to the approval that it asks for', async () => {
    const { t, dashboard, resetEventId, ids } = await seedM1();
    addRun(t.db, 'card-run');
    appendEvent(t.db, { sessionKey: 'main', runId: 'card-run', type: 'user_message', payload: { text: 'buy the ticket', channel: 'web', chatId: 'web' } }, new Date(at(30_000)));
    const ask = appendEvent(
      t.db,
      { sessionKey: 'main', runId: 'card-run', type: 'assistant_message', payload: agentTurn('', [{ id: 'tc-card', name: 'browser_submit', input: { button: 'Buy' } }]) },
      new Date(at(31_000)),
    );
    // a turn with no text and no approval is not a chat message.
    const quiet = appendEvent(
      t.db,
      { sessionKey: 'main', runId: 'card-run', type: 'assistant_message', payload: agentTurn('', [{ id: 'tc-other', name: 'now', input: {} }]) },
      new Date(at(31_500)),
    );
    addDecision(t.db, 'card-run', 'tc-other', 'now');
    addDecision(t.db, 'card-run', 'tc-card', 'browser_submit', { approvalId: ids.approvalId });
    appendEvent(t.db, { sessionKey: 'main', runId: 'card-run', type: 'tool_result', payload: { toolCallId: 'tc-card', name: 'browser_submit', content: 'done', isError: false } }, new Date(at(32_000)));
    appendEvent(t.db, { sessionKey: 'main', runId: 'card-run', type: 'assistant_message', payload: agentTurn('Bought it.') }, new Date(at(33_000)));

    const page = await get<ChatMessagesPage>(dashboard, messagesPath(`main@${resetEventId}`));
    const card = page.messages.find((message) => message.id === ask.id)!;
    expect(card).toMatchObject({ role: 'agent', text: '', approvalId: ids.approvalId, guarded: false });
    expect(page.messages.some((message) => message.id === quiet.id)).toBe(false);
    expect(page.messages.at(-1)).toMatchObject({ role: 'agent', text: 'Bought it.', approvalId: null });
    expect(page.chat.runs).toBe(2);
  });

  it('leaves out NO_REPLY, a reply that never reached the chat, and the events that the chat does not show', async () => {
    const { t, dashboard, resetEventId } = await seedM1();
    addRun(t.db, 'quiet-run');
    appendEvent(t.db, { sessionKey: 'main', runId: 'quiet-run', type: 'assistant_message', payload: agentTurn('  NO_REPLY\n') }, new Date(at(30_000)));
    // the guard wrote its decision, and the run ended before the review came back.
    addRun(t.db, 'held-run', 'main', 'failed');
    appendEvent(t.db, { sessionKey: 'main', runId: 'held-run', type: 'user_message', payload: { text: 'send the notes', channel: 'web', chatId: 'web' } }, new Date(at(31_000)));
    appendEvent(t.db, { sessionKey: 'main', runId: 'held-run', type: 'assistant_message', payload: agentTurn('Here: https://x.example/?d=secret') }, new Date(at(32_000)));
    addDecision(t.db, 'held-run', REPLY_CALL_ID, REPLY_TOOL);
    // the reviewer allowed this reply, so the chat got it as it is.
    addRun(t.db, 'allowed-run');
    appendEvent(t.db, { sessionKey: 'main', runId: 'allowed-run', type: 'assistant_message', payload: agentTurn('See https://y.example/?d=ok') }, new Date(at(33_000)));
    addDecision(t.db, 'allowed-run', REPLY_CALL_ID, REPLY_TOOL, { verdict: 'allow' });
    // a reply that got only the short notice.
    addRun(t.db, 'notice-run');
    appendEvent(t.db, { sessionKey: 'main', runId: 'notice-run', type: 'assistant_message', payload: agentTurn('Look at https://z.example/?d=all') }, new Date(at(34_000)));
    addDecision(t.db, 'notice-run', REPLY_CALL_ID, REPLY_TOOL, { verdict: 'hold' });
    appendEvent(
      t.db,
      { sessionKey: 'main', runId: 'notice-run', type: 'note', payload: { text: `${REPLY_NOTE}: the review failed, so the chat got only a short notice in its place.` } },
      new Date(at(34_500)),
    );
    appendEvent(t.db, { sessionKey: 'main', runId: null, type: 'context', payload: { text: 'the system prompt' } }, new Date(at(35_000)));
    appendEvent(t.db, { sessionKey: 'main', runId: null, type: 'system_event', payload: { text: 'The owner stopped the previous reply before it was done.' } }, new Date(at(36_000)));
    appendEvent(t.db, { sessionKey: 'main', runId: null, type: 'note', payload: { text: 'a plain note of the app' } }, new Date(at(37_000)));

    const page = await get<ChatMessagesPage>(dashboard, messagesPath(`main@${resetEventId}`, '?limit=5'));
    expect(page.messages.map((message) => [message.role, message.text, message.guarded])).toEqual([
      ['agent', 'See https://y.example/?d=ok', false],
      ['agent', REMOVED_REPLY, true],
      ['note', `${REPLY_NOTE}: the review failed, so the chat got only a short notice in its place.`, true],
      ['system', 'The owner stopped the previous reply before it was done.', false],
      ['note', 'a plain note of the app', false],
    ]);
    // the skipped rows do not make a page short: the page before holds the owner message and the earlier ones.
    expect(page.before).not.toBeNull();
    const older = await get<ChatMessagesPage>(dashboard, messagesPath(`main@${resetEventId}`, `?limit=2&before=${page.before}`));
    expect(older.messages.map((message) => message.role)).toEqual(['note', 'owner']);
    expect(older.messages[1]!.text).toBe('send the notes');
  });
});
