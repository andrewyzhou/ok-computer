import { afterEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../db/index.js';
import { appendEvent } from '../events/log.js';
import type { GoogleConfig } from '../google/config.js';
import { silentLogger } from '../observability/logger.js';
import { formatLocal } from '../time.js';
import type { Tool, ToolContext } from '../tools/registry.js';
import type { DeskContext } from './context.js';
import { DESK_INSTRUCTIONS } from './prompt.js';
import { LIMITS } from './shared.js';
import { appendDelegationEvent, getDelegation, listDelegationEvents } from './store.js';
import { createDeskTools } from './tools.js';

const TZ = 'America/Los_Angeles';
// tuesday, october 20, 2026 at 10:00 in los angeles.
const NOW = new Date('2026-10-20T17:00:00.000Z');
const link = (id: number) => `http://127.0.0.1:8787/#/desk?id=${id}`;

let db: Db | undefined;
afterEach(() => {
  db?.close();
  db = undefined;
});

function setup(options: { googleConfig?: GoogleConfig } = {}) {
  const target = (db = openDb(':memory:'));
  let ids = 0;
  const ctx: DeskContext = {
    db: target,
    clock: () => NOW,
    logger: silentLogger,
    timeZone: TZ,
    slots: {} as never,
    caller: () => ({}) as never,
    owner: { send: async () => {} } as never,
    deskLink: link,
    signal: new AbortController().signal,
    newId: () => `id-${++ids}`,
    ...(options.googleConfig ? { googleConfig: options.googleConfig } : {}),
  };
  const tools = new Map(createDeskTools(ctx).map((tool) => [tool.name, tool]));
  let calls = 0;
  const toolCtx = (sessionKey = 'main', runId = 'run-1'): ToolContext => ({
    runId,
    sessionKey,
    timeZone: TZ,
    clock: () => NOW,
    signal: new AbortController().signal,
    toolCallId: `call-${++calls}`,
  });
  // call checks the input with the schema of the tool first, as the registry does.
  const call = async (name: string, input: unknown, context = toolCtx()) => {
    const tool = tools.get(name) as Tool;
    const parsed = tool.input.safeParse(input);
    if (!parsed.success) throw new Error(`invalid input: ${parsed.error.message}`);
    return tool.run(parsed.data, context);
  };
  const schema = (name: string, input: unknown) => (tools.get(name) as Tool).input.safeParse(input).success;
  return { db: target, ctx, tools, toolCtx, call, schema };
}

const kinds = (target: Db, id: number) => listDelegationEvents(target, id).map((each) => `${each.kind}:${each.actor}`);

describe('delegation_create', () => {
  it('puts a job on the desk with a run link and names it with its link', async () => {
    const t = setup();
    const out = await t.call('delegation_create', {
      title: 'Book the Denver flights',
      nextStep: 'Compare the morning flights',
      dueAt: '2026-10-24',
      followUpAt: '2026-10-22 09:00',
      waitingOn: { name: 'Dana', email: 'Dana@Landlord.example' },
    });
    expect(out.isError).toBeUndefined();
    const lines = out.content.split('\n');
    expect(lines[0]).toBe(`Added to the desk as #1 "Book the Denver flights" (waiting). ${link(1)}`);
    expect(lines.slice(1)).toEqual([
      `Due: ${formatLocal(new Date('2026-10-25T06:59:00.000Z'), TZ)}`,
      'Waiting on: Dana <dana@landlord.example>',
      `Follow-up: ${formatLocal(new Date('2026-10-22T16:00:00.000Z'), TZ)}`,
    ]);
    const row = getDelegation(t.db, 1)!;
    expect(row).toMatchObject({ createdBy: 'agent', sessionKey: 'main', runId: 'run-1', nextStep: 'Compare the morning flights', dueAt: '2026-10-25T06:59:00.000Z' });
    expect(row.links).toEqual([{ kind: 'run', ref: 'run-1', account: null, label: 'The run that created it', href: 'runs/run-1' }]);
    const history = listDelegationEvents(t.db, 1);
    expect(history.map((each) => each.kind)).toEqual(['created', 'link_added']);
    expect(history.every((each) => each.actor === 'agent' && each.runId === 'run-1' && each.toolCallId === 'call-1')).toBe(true);
  });

  it('answers an open job without the fact lines, and allows a due time in the past', async () => {
    const t = setup();
    const out = await t.call('delegation_create', { title: 'Renew the passport', dueAt: '2026-10-01' });
    expect(out.content).toBe(`Added to the desk as #1 "Renew the passport" (open). ${link(1)}\nDue: ${formatLocal(new Date('2026-10-02T06:59:00.000Z'), TZ)}`);
  });

  it('does not put the same active title on the desk two times', async () => {
    const t = setup();
    await t.call('delegation_create', { title: 'Book the Denver flights' });
    const again = await t.call('delegation_create', { title: '  book the DENVER flights ' });
    expect(again).toEqual({ content: `Already on the desk as #1 "Book the Denver flights" (open). Nothing new was given, so nothing changed. ${link(1)}` });
    expect(t.db.prepare('SELECT count(*) AS n FROM delegations').get()!.n).toBe(1);

    // a closed delegation with the title does not block a new one.
    await t.call('delegation_done', { id: 1 });
    expect((await t.call('delegation_create', { title: 'Book the Denver flights' })).content).toContain('Added to the desk as #2');
  });

  it('refuses a follow-up time at or before now', async () => {
    const t = setup();
    const past = await t.call('delegation_create', { title: 'Call the bank', followUpAt: '2026-10-20 09:00' });
    expect(past.isError).toBe(true);
    expect(past.content).toContain('is not in the future');
    const exactlyNow = await t.call('delegation_create', { title: 'Call the bank', followUpAt: NOW.toISOString() });
    expect(exactlyNow.isError).toBe(true);
    expect(t.db.prepare('SELECT count(*) AS n FROM delegations').get()!.n).toBe(0);
  });

  it('refuses a day that is not on the calendar', async () => {
    const t = setup();
    const out = await t.call('delegation_create', { title: 'Pay the rent', dueAt: '2026-02-30' });
    expect(out).toEqual({ content: '2026-02-30 is not a day of the calendar', isError: true });
    expect((await t.call('delegation_create', { title: 'Pay the rent', followUpAt: 'next tuesday' })).isError).toBe(true);
  });

  it('refuses a bad email and a person with neither field', async () => {
    const t = setup();
    const bad = await t.call('delegation_create', { title: 'Ask about the lease', waitingOn: { email: 'a@b@c' } });
    expect(bad).toEqual({ content: '"a@b@c" is not one plain email address', isError: true });
    const empty = await t.call('delegation_create', { title: 'Ask about the lease', waitingOn: {} });
    expect(empty).toEqual({ content: 'waitingOn needs a name or an email', isError: true });
    expect(t.db.prepare('SELECT count(*) AS n FROM delegations').get()!.n).toBe(0);
  });

  it('needs the account of a thread link, and a known alias when google is set up', async () => {
    const t = setup();
    const missing = await t.call('delegation_create', { title: 'Reply to Sam', links: [{ kind: 'thread', ref: 't-1' }] });
    expect(missing.isError).toBe(true);
    expect(missing.content).toContain('a thread link needs the account');
    // without a google config any alias is taken.
    expect((await t.call('delegation_create', { title: 'Reply to Sam', links: [{ kind: 'thread', ref: 't-1', account: 'anything' }] })).isError).toBeUndefined();

    const google = setup({ googleConfig: { clientId: 'x.apps.googleusercontent.com', accounts: [{ alias: 'personal' }, { alias: 'school' }], send: false, sessions: ['main'], pollMinutes: 15 } });
    const unknown = await google.call('delegation_create', { title: 'Reply to Sam', links: [{ kind: 'event', ref: 'e-1', account: 'work' }] });
    expect(unknown).toEqual({ content: '"work" is not a Google account of the app. Use one of: personal, school', isError: true });
    const known = await google.call('delegation_create', { title: 'Reply to Sam', links: [{ kind: 'thread', ref: 't-1', account: 'school' }] });
    expect(known.isError).toBeUndefined();
    expect(getDelegation(google.db, 1)!.links.map((each) => `${each.kind}:${each.account ?? ''}:${each.ref}`)).toEqual(['run::run-1', 'thread:school:t-1']);
  });

  it('takes details of 4000 characters and refuses 4001 at the schema', () => {
    const t = setup();
    expect(t.schema('delegation_create', { title: 'Long', details: 'x'.repeat(LIMITS.details) })).toBe(true);
    expect(t.schema('delegation_create', { title: 'Long', details: 'x'.repeat(LIMITS.details + 1) })).toBe(false);
  });
});

describe('delegation_update', () => {
  it('changes fields, adds links and a note, and lists what changed', async () => {
    const t = setup();
    await t.call('delegation_create', { title: 'Book the Denver flights', dueAt: '2026-10-24' });
    const out = await t.call('delegation_update', {
      id: 1,
      nextStep: 'Ask the owner for the seat',
      status: 'blocked',
      dueAt: null,
      followUpAt: '2026-10-21',
      addLinks: [{ kind: 'doc', ref: 'doc-1', label: 'The trip plan' }],
      note: 'Waiting for the seat choice',
    });
    expect(out.content).toBe(
      `Updated #1 "Book the Denver flights": next step "Ask the owner for the seat", status blocked, due time cleared, follow-up ${formatLocal(new Date('2026-10-21T16:00:00.000Z'), TZ)}, 1 link added, a note in the history. ${link(1)}`,
    );
    expect(getDelegation(t.db, 1)).toMatchObject({ status: 'blocked', dueAt: null, nextFollowUpAt: '2026-10-21T16:00:00.000Z' });
    expect(kinds(t.db, 1).slice(2)).toEqual(['updated:agent', 'status:agent', 'link_added:agent', 'note:agent']);

    const removed = await t.call('delegation_update', { id: 1, removeLinks: [{ kind: 'doc', ref: 'doc-1' }], followUpAt: null });
    expect(removed.content).toBe(`Updated #1 "Book the Denver flights": follow-up cleared, 1 link removed. ${link(1)}`);
  });

  it('says that nothing changed and writes no history row', async () => {
    const t = setup();
    await t.call('delegation_create', { title: 'Book the Denver flights' });
    const before = listDelegationEvents(t.db, 1).length;
    expect(await t.call('delegation_update', { id: 1, title: 'Book the Denver flights' })).toEqual({ content: 'Nothing changed on #1.' });
    expect(listDelegationEvents(t.db, 1)).toHaveLength(before);
  });

  it('gives the 404 of a missing delegation', async () => {
    const t = setup();
    expect(await t.call('delegation_update', { id: 7, note: 'hello' })).toEqual({ content: 'delegation #7 not found', isError: true });
  });

  it('refuses the waiting status at the schema, a past follow-up, and a follow-up on a closed delegation', async () => {
    const t = setup();
    await t.call('delegation_create', { title: 'Book the Denver flights' });
    expect(t.schema('delegation_update', { id: 1, status: 'waiting' })).toBe(false);
    expect(t.schema('delegation_update', { id: 1, status: 'done' })).toBe(false);
    const past = await t.call('delegation_update', { id: 1, followUpAt: '2026-10-19' });
    expect(past.isError).toBe(true);
    expect(past.content).toContain('is not in the future');
    await t.call('delegation_done', { id: 1 });
    const closed = await t.call('delegation_update', { id: 1, followUpAt: '2026-10-22' });
    expect(closed).toEqual({ content: 'delegation #1 is done, so it takes no follow-up time', isError: true });
  });

  it('checks the added links like create', async () => {
    const t = setup();
    await t.call('delegation_create', { title: 'Book the Denver flights' });
    const out = await t.call('delegation_update', { id: 1, addLinks: [{ kind: 'thread', ref: 't-9' }] });
    expect(out.isError).toBe(true);
    expect(getDelegation(t.db, 1)!.links).toHaveLength(1);
  });
});

describe('delegation_wait_on', () => {
  it('waits on a person with a thread and the default follow-up, and says that nudges are only drafts', async () => {
    const t = setup();
    await t.call('delegation_create', { title: 'Fix the heater' });
    const out = await t.call('delegation_wait_on', {
      id: 1,
      waitingOn: { name: 'Dana', email: 'dana@landlord.example' },
      thread: { account: 'personal', threadId: 'thr-1' },
      note: 'Asked Dana for a date',
    });
    // two days from tuesday is thursday at 09:00 in los angeles.
    const followUp = '2026-10-22T16:00:00.000Z';
    expect(out.content).toBe(
      `#1 "Fix the heater" now waits on Dana <dana@landlord.example>. The follow-up is ${formatLocal(new Date(followUp), TZ)}: it checks the mail thread for a reply, and when none came it saves a nudge as a Gmail draft. A nudge is only ever saved as a Gmail draft, and it is never sent. ${link(1)}`,
    );
    expect(getDelegation(t.db, 1)).toMatchObject({ status: 'waiting', nextFollowUpAt: followUp, waitingSince: NOW.toISOString(), waitingOn: { name: 'Dana', email: 'dana@landlord.example' } });
    expect(getDelegation(t.db, 1)!.links.at(-1)).toMatchObject({ kind: 'thread', ref: 'thr-1', account: 'personal' });
    expect(kinds(t.db, 1).slice(2)).toEqual(['updated:agent', 'waiting_on:agent', 'status:agent', 'link_added:agent', 'note:agent']);
    expect(listDelegationEvents(t.db, 1).at(-1)!.text).toBe('Asked Dana for a date');
  });

  it('tells that the owner hears of a follow-up without a thread', async () => {
    const t = setup();
    await t.call('delegation_create', { title: 'Fix the heater' });
    const out = await t.call('delegation_wait_on', { id: 1, waitingOn: { name: 'Dana' }, followUpAt: '2026-10-21 14:30' });
    expect(out.content).toContain(`The follow-up is ${formatLocal(new Date('2026-10-21T21:30:00.000Z'), TZ)}: there is no mail thread to check`);
    expect(out.content).toContain('never sent');
  });

  it('changes nothing on a closed delegation, a missing one, or with bad input', async () => {
    const t = setup();
    await t.call('delegation_create', { title: 'Fix the heater' });
    expect((await t.call('delegation_wait_on', { id: 1, waitingOn: { email: 'a@b@c' } })).isError).toBe(true);
    expect((await t.call('delegation_wait_on', { id: 1, waitingOn: { name: 'Dana' }, followUpAt: '2026-10-20 08:00' })).isError).toBe(true);
    expect(await t.call('delegation_wait_on', { id: 4, waitingOn: { name: 'Dana' } })).toEqual({ content: 'delegation #4 not found', isError: true });
    await t.call('delegation_done', { id: 1, outcome: 'dropped' });
    const history = listDelegationEvents(t.db, 1).length;
    const closed = await t.call('delegation_wait_on', { id: 1, waitingOn: { name: 'Dana' } });
    expect(closed).toEqual({ content: '#1 "Fix the heater" is dropped, so it cannot wait on anyone. Nothing changed.', isError: true });
    expect(listDelegationEvents(t.db, 1)).toHaveLength(history);
    expect(getDelegation(t.db, 1)).toMatchObject({ status: 'dropped', waitingOn: null });
  });
});

describe('delegation_done', () => {
  it('closes a delegation one time, and refuses the second close', async () => {
    const t = setup();
    await t.call('delegation_create', { title: 'Book the Denver flights', followUpAt: '2026-10-22' });
    expect(await t.call('delegation_done', { id: 1, note: 'Booked the 8:05 flight' })).toEqual({ content: 'Closed #1 "Book the Denver flights" as done.' });
    expect(getDelegation(t.db, 1)).toMatchObject({ status: 'done', closedAt: NOW.toISOString(), nextFollowUpAt: null });
    expect(kinds(t.db, 1).slice(-3)).toEqual(['updated:agent', 'status:agent', 'note:agent']);
    const history = listDelegationEvents(t.db, 1).length;
    expect(await t.call('delegation_done', { id: 1, outcome: 'dropped' })).toEqual({ content: '#1 "Book the Denver flights" is already done. Nothing changed.', isError: true });
    expect(listDelegationEvents(t.db, 1)).toHaveLength(history);
    expect(await t.call('delegation_done', { id: 2 })).toEqual({ content: 'delegation #2 not found', isError: true });
  });
});

describe('delegation_list', () => {
  const seed = async (t: ReturnType<typeof setup>) => {
    await t.call('delegation_create', { title: 'Fix the heater', waitingOn: { name: 'Dana', email: 'dana@landlord.example' }, dueAt: '2026-10-23', nextStep: 'Wait for a date' });
    await t.call('delegation_create', { title: 'Book the Denver flights', dueAt: '2026-10-24' });
    await t.call('delegation_create', { title: 'Return the drill', waitingOn: { name: 'Sam' } });
    await t.call('delegation_create', { title: 'Old errand' });
    await t.call('delegation_done', { id: 4 });
  };

  it('lists the active delegations in one line each', async () => {
    const t = setup();
    await seed(t);
    const out = await t.call('delegation_list', {});
    expect(out.untrustedSource).toBeUndefined();
    expect(out.content.split('\n')).toEqual([
      `#1 waiting "Fix the heater" · waiting on Dana since ${formatLocal(NOW, TZ)} · due ${formatLocal(new Date('2026-10-24T06:59:00.000Z'), TZ)} · next: Wait for a date`,
      `#2 open "Book the Denver flights" · due ${formatLocal(new Date('2026-10-25T06:59:00.000Z'), TZ)}`,
      `#3 waiting "Return the drill" · waiting on Sam since ${formatLocal(NOW, TZ)}`,
    ]);
    expect((await t.call('delegation_list', { status: 'done' })).content).toBe('#4 done "Old errand"');
    expect((await t.call('delegation_list', { status: 'all' })).content.split('\n')).toHaveLength(4);
    expect((await t.call('delegation_list', { limit: 1 })).content.split('\n')).toHaveLength(1);
    expect((await t.call('delegation_list', { q: 'denver' })).content).toMatch(/^#2 open/);
  });

  it('filters by a name and by an email', async () => {
    const t = setup();
    await seed(t);
    expect((await t.call('delegation_list', { person: 'Dana' })).content).toMatch(/^#1 waiting "Fix the heater"[^\n]*$/);
    expect((await t.call('delegation_list', { person: 'dana@landlord.example' })).content).toMatch(/^#1 waiting "Fix the heater"[^\n]*$/);
    expect((await t.call('delegation_list', { person: 'DANA@Landlord.example' })).content).toMatch(/^#1 /);
    expect((await t.call('delegation_list', { person: 'sam' })).content).toMatch(/^#3 waiting "Return the drill"[^\n]*$/);
    expect(await t.call('delegation_list', { person: 'Lee' })).toEqual({ content: 'The desk has no active delegations for Lee.' });
  });

  it('says when the desk is empty', async () => {
    const t = setup();
    expect(await t.call('delegation_list', {})).toEqual({ content: 'The desk has no active delegations.' });
    expect(await t.call('delegation_list', { status: 'blocked' })).toEqual({ content: 'The desk has no blocked delegations.' });
    expect(await t.call('delegation_list', { status: 'all' })).toEqual({ content: 'The desk has no delegations.' });
  });

  it('marks the list as untrusted when a row came from a tainted session', async () => {
    const t = setup();
    appendEvent(
      t.db,
      { sessionKey: 'main', runId: 'run-1', type: 'tool_result', payload: { toolCallId: 'm1', name: 'gmail_read', content: 'mail', isError: false, untrustedSource: 'gmail:personal' } },
      NOW,
    );
    await t.call('delegation_create', { title: 'Answer the lease mail' });
    const out = await t.call('delegation_list', {});
    expect(out).toMatchObject({ untrustedSource: 'desk' });
    expect(out.content).toContain('"Answer the lease mail"');
  });

  it('marks the list as untrusted when the follow-up job wrote a history row', async () => {
    const t = setup();
    await t.call('delegation_create', { title: 'Fix the heater' }, t.toolCtx('owner-clean'));
    expect((await t.call('delegation_list', {})).untrustedSource).toBeUndefined();
    appendDelegationEvent(t.db, { delegationId: 1, kind: 'follow_up_checked', actor: 'system', data: { threadId: 't', account: 'personal' } }, NOW);
    expect((await t.call('delegation_list', {})).untrustedSource).toBe('desk');
  });
});

describe('the desk instructions', () => {
  it('tell the model when to make a delegation and that nothing is sent', () => {
    expect(DESK_INSTRUCTIONS).toContain('delegation_create');
    expect(DESK_INSTRUCTIONS).toContain('delegation_list first');
    expect(DESK_INSTRUCTIONS).toContain('delegation_wait_on');
    expect(DESK_INSTRUCTIONS).toContain('delegation_done');
    expect(DESK_INSTRUCTIONS).toContain('On the desk as #12 "Book the Denver flights"');
    expect(DESK_INSTRUCTIONS).toContain('never tell the owner that a mail was sent');
  });
});

describe('delegation_list by person', () => {
  it('finds a closed delegation by a name with status all', async () => {
    const { call } = setup();
    await call('delegation_create', { title: 'Lease', waitingOn: { name: 'Dana Park', email: 'dana@landlord.example' } });
    await call('delegation_done', { id: 1 });
    expect((await call('delegation_list', { status: 'all', person: 'Dana' })).content).toContain('#1 done "Lease"');
  });

  it('finds every delegation of a name, with and without an email', async () => {
    const { call } = setup();
    await call('delegation_create', { title: 'Lease', waitingOn: { name: 'Dana', email: 'dana@landlord.example' } });
    await call('delegation_create', { title: 'Parking', waitingOn: { name: 'Dana' } });
    const out = (await call('delegation_list', { person: 'Dana' })).content;
    expect(out).toContain('"Parking"');
    expect(out).toContain('"Lease"');
  });
});

describe('the desk tools and the owner', () => {
  it('refuses to reopen a closed delegation through delegation_update', async () => {
    const t = setup();
    await t.call('delegation_create', { title: 'Renew the passport' });
    await t.call('delegation_done', { id: 1, outcome: 'dropped' });
    const out = await t.call('delegation_update', { id: 1, status: 'open' });
    expect(out).toEqual({ content: '#1 "Renew the passport" is dropped, and only the owner can reopen it from the desk. Nothing changed.', isError: true });
    expect(getDelegation(t.db, 1)!.status).toBe('dropped');
    // a note on a closed delegation is still fine.
    expect((await t.call('delegation_update', { id: 1, note: 'The old one is still valid.' })).isError).toBeUndefined();
  });

  it('says which fields of a repeated create were not saved', async () => {
    const t = setup();
    await t.call('delegation_create', { title: 'Book the Denver flights' });
    const out = await t.call('delegation_create', { title: 'Book the Denver flights', dueAt: '2026-10-24', waitingOn: { name: 'Sam' } });
    expect(out.isError).toBe(true);
    expect(out.content).toContain('nothing was saved');
    expect(out.content).toContain('These fields differ from it: waitingOn, dueAt.');
    expect(out.content).toContain('delegation_update on #1');
    expect(getDelegation(t.db, 1)).toMatchObject({ dueAt: null, waitingOn: null });
  });

  it('keeps the untrusted mark after a reset of the tainted session that wrote the row', async () => {
    const t = setup();
    appendEvent(
      t.db,
      { sessionKey: 'main', runId: 'run-1', type: 'tool_result', payload: { toolCallId: 'm1', name: 'gmail_read', content: 'mail', isError: false, untrustedSource: 'gmail:personal' } },
      NOW,
    );
    await t.call('delegation_create', { title: 'Answer the lease mail' });
    appendEvent(t.db, { sessionKey: 'main', runId: null, type: 'session_reset', payload: {} } as never, NOW);
    expect((await t.call('delegation_list', {})).untrustedSource).toBe('desk');
  });

  it('marks the list as untrusted when another tainted session changed a clean row', async () => {
    const t = setup();
    await t.call('delegation_create', { title: 'Fix the heater' }, t.toolCtx('main'));
    expect((await t.call('delegation_list', {})).untrustedSource).toBeUndefined();
    appendEvent(
      t.db,
      { sessionKey: 'sub:1', runId: 'run-2', type: 'tool_result', payload: { toolCallId: 'm1', name: 'gmail_read', content: 'mail', isError: false, untrustedSource: 'gmail:personal' } },
      NOW,
    );
    await t.call('delegation_update', { id: 1, nextStep: 'Call the number in the mail' }, t.toolCtx('sub:1', 'run-2'));
    expect((await t.call('delegation_list', {})).untrustedSource).toBe('desk');
  });
});
