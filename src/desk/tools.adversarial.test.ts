import { afterEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../db/index.js';
import type { GoogleConfig } from '../google/config.js';
import { silentLogger } from '../observability/logger.js';
import type { Tool, ToolContext } from '../tools/registry.js';
import type { DeskContext } from './context.js';
import { getDelegation, listDelegationEvents, listDelegations } from './store.js';
import { createDeskTools } from './tools.js';

// tests that try to break the desk tools: hostile and odd input from the model, time zones and day boundaries, a
// retried call, and the status rules seen from the tools.

const TZ = 'America/Los_Angeles';
const link = (id: number) => `http://127.0.0.1:8787/#/desk?id=${id}`;

let db: Db | undefined;
afterEach(() => {
  db?.close();
  db = undefined;
});

function setup(options: { now?: Date; googleConfig?: GoogleConfig; timeZone?: string } = {}) {
  const target = (db = openDb(':memory:'));
  const clock = { now: options.now ?? new Date('2026-10-20T17:00:00.000Z') };
  const timeZone = options.timeZone ?? TZ;
  const ctx: DeskContext = {
    db: target,
    clock: () => clock.now,
    logger: silentLogger,
    timeZone,
    slots: {} as never,
    caller: () => ({}) as never,
    owner: { send: async () => {} } as never,
    deskLink: link,
    signal: new AbortController().signal,
    newId: () => 'id',
    ...(options.googleConfig ? { googleConfig: options.googleConfig } : {}),
  };
  const tools = new Map(createDeskTools(ctx).map((tool) => [tool.name, tool]));
  let calls = 0;
  const toolCtx = (sessionKey = 'main', runId = 'run-1'): ToolContext => ({
    runId,
    sessionKey,
    timeZone,
    clock: () => clock.now,
    signal: new AbortController().signal,
    toolCallId: `call-${++calls}`,
  });
  const call = async (name: string, input: unknown, context = toolCtx()) => {
    const tool = tools.get(name) as Tool;
    const parsed = tool.input.safeParse(input);
    if (!parsed.success) throw new Error(`invalid input: ${parsed.error.message}`);
    return tool.run(parsed.data, context);
  };
  const schema = (name: string, input: unknown) => (tools.get(name) as Tool).input.safeParse(input).success;
  return { db: target, clock, call, schema, toolCtx };
}

const idOf = (content: string) => Number(/#(\d+)/.exec(content)![1]);

describe('delegation_create with odd input', () => {
  it('refuses a title of only spaces and writes nothing', async () => {
    const { db, call } = setup();
    expect(await call('delegation_create', { title: ' \t\r\n ' })).toEqual({ content: 'the title is empty', isError: true });
    expect(listDelegations(db)).toEqual([]);
  });

  it('sees a retried call with other case and spaces as the same job', async () => {
    const { db, call } = setup();
    const first = await call('delegation_create', { title: 'Book the Denver flights' });
    const again = await call('delegation_create', { title: '  BOOK the denver FLIGHTS ' });
    expect(again.content).toContain(`Already on the desk as #${idOf(first.content)}`);
    expect(listDelegations(db)).toHaveLength(1);
  });

  it('makes a new delegation when the same title is closed', async () => {
    const { db, call } = setup();
    const first = await call('delegation_create', { title: 'Renew the passport' });
    await call('delegation_done', { id: idOf(first.content) });
    const second = await call('delegation_create', { title: 'Renew the passport' });
    expect(second.content).toMatch(/^Added to the desk as #2 /);
    expect(listDelegations(db)).toHaveLength(2);
  });

  it('refuses a waiting-on email with a header break or a second mailbox', async () => {
    const { db, call } = setup();
    for (const email of ['dana@landlord.example\r\nBcc: eve@evil.example', 'dana@landlord.example, eve@evil.example', 'Dana <dana@landlord.example>']) {
      const out = await call('delegation_create', { title: `x ${email.length}`, waitingOn: { email } });
      expect(out.isError, email).toBe(true);
    }
    expect(listDelegations(db)).toEqual([]);
  });

  it('keeps a name with a line break as text, and names the person in one line of the answer', async () => {
    const { db, call } = setup();
    const out = await call('delegation_create', { title: 'Call the bank', waitingOn: { name: 'Dana\r\nPark', email: 'DANA@Landlord.Example' } });
    expect(out.isError).toBeUndefined();
    const d = getDelegation(db, idOf(out.content))!;
    expect(d.waitingOn).toEqual({ name: 'Dana\r\nPark', email: 'dana@landlord.example' });
  });

  it('reads a bare due day as the end of that day in the owner time zone, on the day the clocks go back', async () => {
    const { db, call } = setup({ now: new Date('2026-10-31T17:00:00.000Z') });
    const out = await call('delegation_create', { title: 'Pay the rent', dueAt: '2026-11-01', followUpAt: '2026-11-01' });
    const d = getDelegation(db, idOf(out.content))!;
    expect(d.dueAt).toBe('2026-11-02T07:59:00.000Z');
    expect(d.nextFollowUpAt).toBe('2026-11-01T17:00:00.000Z');
    expect(out.content).toContain('Due: Sunday, November 1, 2026 at 23:59 PST');
  });

  it('refuses a follow-up one millisecond in the past, and takes one a minute ahead', async () => {
    const { call } = setup({ now: new Date('2026-10-20T17:00:00.001Z') });
    expect((await call('delegation_create', { title: 'a', followUpAt: '2026-10-20T17:00:00.000Z' })).isError).toBe(true);
    expect((await call('delegation_create', { title: 'b', followUpAt: '2026-10-20 10:01' })).isError).toBeUndefined();
  });

  it('refuses a follow-up of today as a bare day once 09:00 local has passed', async () => {
    // 10:00 in los angeles: today at 09:00 is in the past.
    const { call } = setup();
    expect((await call('delegation_create', { title: 'a', followUpAt: '2026-10-20' })).isError).toBe(true);
    expect((await call('delegation_create', { title: 'b', followUpAt: '2026-10-21' })).isError).toBeUndefined();
  });

  it('refuses 21 links and an extra field at the schema', () => {
    const { schema } = setup();
    const links = Array.from({ length: 21 }, (_, i) => ({ kind: 'run', ref: `r${i}` }));
    expect(schema('delegation_create', { title: 'x', links })).toBe(false);
    expect(schema('delegation_create', { title: 'x', status: 'done' })).toBe(false);
    expect(schema('delegation_create', { title: 'x', links: [{ kind: 'video', ref: 'r' }] })).toBe(false);
  });

  it('keeps one run link when the model also gives the run id of the call', async () => {
    const { db, call } = setup();
    const out = await call('delegation_create', { title: 'x', links: [{ kind: 'run', ref: 'run-1' }] });
    const d = getDelegation(db, idOf(out.content))!;
    expect(d.links.filter((each) => each.kind === 'run')).toHaveLength(1);
  });
});

describe('delegation_wait_on at day boundaries', () => {
  it('sets the default follow-up to 09:00 two local days on, across the end of daylight saving time', async () => {
    // friday october 30 at 22:00 in los angeles is saturday 05:00 utc.
    const { db, call } = setup({ now: new Date('2026-10-31T05:00:00.000Z') });
    const made = await call('delegation_create', { title: 'Get the keys' });
    await call('delegation_wait_on', { id: idOf(made.content), waitingOn: { name: 'Dana' } });
    // sunday november 1 at 09:00 pst.
    expect(getDelegation(db, 1)!.nextFollowUpAt).toBe('2026-11-01T17:00:00.000Z');
  });

  it('counts the two days from the local day, not the utc day, just after midnight utc', async () => {
    // 17:30 in los angeles on october 20 is 00:30 utc on october 21.
    const { db, call } = setup({ now: new Date('2026-10-21T00:30:00.000Z') });
    await call('delegation_create', { title: 'Get the keys' });
    await call('delegation_wait_on', { id: 1, waitingOn: { name: 'Dana' } });
    expect(getDelegation(db, 1)!.nextFollowUpAt).toBe('2026-10-22T16:00:00.000Z');
  });

  it('uses the time zone of the app in tokyo', async () => {
    // 08:00 in tokyo on october 21.
    const { db, call } = setup({ now: new Date('2026-10-20T23:00:00.000Z'), timeZone: 'Asia/Tokyo' });
    await call('delegation_create', { title: 'Get the keys' });
    await call('delegation_wait_on', { id: 1, waitingOn: { name: 'Dana' } });
    expect(getDelegation(db, 1)!.nextFollowUpAt).toBe('2026-10-23T00:00:00.000Z');
  });

  it('moves a blocked delegation to waiting, and restarts the wait for a second call', async () => {
    const { db, clock, call } = setup();
    await call('delegation_create', { title: 'Get the keys' });
    await call('delegation_update', { id: 1, status: 'blocked' });
    await call('delegation_wait_on', { id: 1, waitingOn: { email: 'dana@landlord.example' } });
    expect(getDelegation(db, 1)).toMatchObject({ status: 'waiting', waitingSince: clock.now.toISOString() });
    clock.now = new Date(clock.now.getTime() + 3_600_000);
    await call('delegation_wait_on', { id: 1, waitingOn: { email: 'lee@school.example' } });
    expect(getDelegation(db, 1)!.waitingSince).toBe(clock.now.toISOString());
  });

  it('refuses a thread of an account that the google config does not have', async () => {
    const googleConfig = { accounts: [{ alias: 'personal', email: 'me@example.com' }] } as unknown as GoogleConfig;
    const { db, call } = setup({ googleConfig });
    await call('delegation_create', { title: 'Get the keys' });
    const out = await call('delegation_wait_on', { id: 1, waitingOn: { name: 'Dana' }, thread: { account: 'Personal', threadId: 't-1' } });
    expect(out.isError).toBe(true);
    expect(getDelegation(db, 1)!.status).toBe('open');
  });
});

describe('delegation_update and delegation_done from a model that retries', () => {
  it('clears the due and the follow-up time with null', async () => {
    const { db, call } = setup();
    await call('delegation_create', { title: 'x', dueAt: '2026-10-25', followUpAt: '2026-10-22' });
    const out = await call('delegation_update', { id: 1, dueAt: null, followUpAt: null });
    expect(out.content).toContain('due time cleared');
    expect(out.content).toContain('follow-up cleared');
    expect(getDelegation(db, 1)).toMatchObject({ dueAt: null, nextFollowUpAt: null });
  });

  // the owner closed it, so only the owner reopens it, on the desk. a retry or a mail cannot undo that decision.
  it('does not open a done delegation again with status open', async () => {
    const { db, call } = setup();
    await call('delegation_create', { title: 'x' });
    await call('delegation_done', { id: 1, outcome: 'dropped' });
    const out = await call('delegation_update', { id: 1, status: 'open' });
    expect(out).toMatchObject({ isError: true });
    expect(out.content).toContain('only the owner can reopen it from the desk');
    expect(getDelegation(db, 1)).toMatchObject({ status: 'dropped' });
    expect(getDelegation(db, 1)!.closedAt).not.toBeNull();
  });

  it('says nothing changed for a note of only spaces', async () => {
    const { db, call } = setup();
    await call('delegation_create', { title: 'x' });
    expect((await call('delegation_update', { id: 1, note: '   ' })).content).toBe('Nothing changed on #1.');
    expect(listDelegationEvents(db, 1).map((each) => each.kind)).toEqual(['created', 'link_added']);
  });

  it('closes once when the model calls done two times', async () => {
    const { db, call } = setup();
    await call('delegation_create', { title: 'x' });
    expect((await call('delegation_done', { id: 1 })).isError).toBeUndefined();
    expect((await call('delegation_done', { id: 1, outcome: 'dropped' })).isError).toBe(true);
    expect(getDelegation(db, 1)!.status).toBe('done');
    expect(listDelegationEvents(db, 1).filter((each) => each.kind === 'status')).toHaveLength(1);
  });

  it('refuses ids that are not positive whole numbers at the schema', () => {
    const { schema } = setup();
    for (const id of [0, -1, 1.5, '1', Number.NaN, null]) expect(schema('delegation_update', { id }), String(id)).toBe(false);
  });

  it('names the agent run and tool call on each history row', async () => {
    const { db, call, toolCtx } = setup();
    await call('delegation_create', { title: 'x' }, toolCtx('main', 'run-a'));
    await call('delegation_update', { id: 1, note: 'did it' }, toolCtx('main', 'run-b'));
    const rows = listDelegationEvents(db, 1);
    expect(rows.map((each) => [each.kind, each.actor, each.runId])).toEqual([
      ['created', 'agent', 'run-a'],
      ['link_added', 'agent', 'run-a'],
      ['note', 'agent', 'run-b'],
    ]);
    expect(rows.every((each) => /^call-\d+$/.test(String(each.toolCallId)))).toBe(true);
  });
});

describe('delegation_list filters', () => {
  it('finds a person by an email in another case', async () => {
    const { call } = setup();
    await call('delegation_create', { title: 'x', waitingOn: { name: 'Dana Park', email: 'dana@landlord.example' } });
    expect((await call('delegation_list', { person: '  DANA@Landlord.EXAMPLE ' })).content).toContain('#1 waiting "x"');
  });

  it('finds a person with an email by a part of the name', async () => {
    const { call } = setup();
    await call('delegation_create', { title: 'x', waitingOn: { name: 'Dana Park', email: 'dana@landlord.example' } });
    expect((await call('delegation_list', { person: 'park' })).content).toContain('#1 waiting "x"');
  });

  it('keeps to the limit', async () => {
    const { call } = setup();
    for (let i = 0; i < 5; i++) await call('delegation_create', { title: `job ${i}` });
    expect((await call('delegation_list', { limit: 2 })).content.split('\n')).toHaveLength(2);
  });

  it('marks no row as untrusted on a desk that only the owner and a clean session wrote', async () => {
    const { call } = setup();
    await call('delegation_create', { title: 'x' });
    expect((await call('delegation_list', {})).untrustedSource).toBeUndefined();
  });
});
