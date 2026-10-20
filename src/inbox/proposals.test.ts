import { afterEach, describe, expect, it } from 'vitest';
import { createInboxHarness, hostileMail, type InboxHarness } from '../../test/inbox-harness.js';
import { settleApprovals } from './actions.js';
import type { JobRun } from './context.js';
import { EVENT_TOOL, eventIdOf, eventSalt, proposeEvent, type ProposalInput } from './proposals.js';
import { markRead, mailSource, startRun } from './run.js';

let h: InboxHarness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

// a run of the digest after it read the mail, so each tool call is a call of a tainted session.
async function setup(): Promise<{ h: InboxHarness; run: JobRun }> {
  h = await createInboxHarness();
  const run = startRun(h.ctx, 'digest', 'utility');
  markRead(h.ctx, run, [mailSource('personal')], 'inbox_digest');
  return { h, run };
}

const bill = (extra: Partial<ProposalInput> = {}): ProposalInput => ({
  account: 'personal',
  kind: 'bill',
  title: 'Pay the power bill',
  startAt: '2026-10-20T09:00:00-07:00',
  endAt: null,
  allDay: false,
  description: 'The bill of $82.10 is due.',
  sourceMessageId: 'm1',
  sourceSubject: 'Your bill is ready',
  ...extra,
});

const proposal = (h: InboxHarness, id: number) => h.rows('SELECT * FROM inbox_proposals WHERE id = ?', id)[0]!;
const inserts = (h: InboxHarness) => h.google.fake.requests.filter((each) => each.method === 'POST' && each.path.startsWith('/calendar/v3/calendars/primary/events'));

describe('proposeEvent', () => {
  it('asks the owner, and makes the event only after the approval', async () => {
    const { h, run } = await setup();
    const id = await proposeEvent(h.ctx, run, bill());
    expect(id).toEqual(expect.any(Number));
    const row = proposal(h, id!);
    expect(row).toMatchObject({
      state: 'proposed',
      calendarId: 'primary',
      startAt: '2026-10-20T16:00:00.000Z',
      endAt: '2026-10-20T16:30:00.000Z',
      allDay: 0,
      dedupeKey: 'm1:bill:2026-10-20T16:00:00.000Z',
      runId: run.runId,
      sourceSubject: 'Your bill is ready',
    });
    expect(row.approvalId).toEqual(expect.any(Number));
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]!.text).toContain(EVENT_TOOL);
    expect(h.google.fake.mailbox('personal').events.size).toBe(0);
    expect(inserts(h)).toEqual([]);

    await h.approve(Number(row.approvalId));
    const events = [...h.google.fake.mailbox('personal').events.values()];
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ id: eventIdOf(eventSalt(h.ctx), 'personal', 'm1:bill:2026-10-20T16:00:00.000Z'), summary: 'Pay the power bill', start: { dateTime: '2026-10-20T16:00:00.000Z' }, end: { dateTime: '2026-10-20T16:30:00.000Z' } });
    expect(events[0]!.attendees).toBeUndefined();
    expect(inserts(h)).toHaveLength(1);
    expect(inserts(h)[0]!.path).toContain('sendUpdates=none');
    expect(JSON.parse(inserts(h)[0]!.body)).not.toHaveProperty('attendees');
    expect(proposal(h, id!)).toMatchObject({ state: 'created', eventId: eventIdOf(eventSalt(h.ctx), 'personal', 'm1:bill:2026-10-20T16:00:00.000Z'), resolvedAt: expect.any(String) });

    // a second run of the same call finds the event and counts it as made.
    h.ctx.db.prepare("UPDATE inbox_proposals SET state = 'approved', eventId = NULL WHERE id = ?").run(id!);
    const tool = h.inbox.tools.find((each) => each.name === EVENT_TOOL)!;
    const input = { proposalId: id!, account: 'personal', kind: 'bill', title: 'Pay the power bill', startAt: '2026-10-20T16:00:00.000Z', endAt: '2026-10-20T16:30:00.000Z', allDay: false, description: 'The bill of $82.10 is due.' };
    const output = await tool.run(input, { runId: run.runId, sessionKey: run.sessionKey, timeZone: h.ctx.timeZone, clock: h.ctx.clock, signal: h.ctx.signal, toolCallId: 'again' });
    expect(output.isError).toBeUndefined();
    expect(output.content).toContain('already exists');
    expect(inserts(h)).toHaveLength(2);
    expect(h.google.fake.mailbox('personal').events.size).toBe(1);
    expect(proposal(h, id!)).toMatchObject({ state: 'created', eventId: eventIdOf(eventSalt(h.ctx), 'personal', 'm1:bill:2026-10-20T16:00:00.000Z') });

    // a call whose fields differ from the row is not the call that the owner saw.
    const changed = await tool.run({ ...input, title: 'wire $5,000' }, { runId: run.runId, sessionKey: run.sessionKey, timeZone: h.ctx.timeZone, clock: h.ctx.clock, signal: h.ctx.signal });
    expect(changed).toMatchObject({ isError: true });
    expect(changed.effect).toBeUndefined();
    expect(inserts(h)).toHaveLength(2);
  });

  it('gives declined after a deny', async () => {
    const { h, run } = await setup();
    const id = await proposeEvent(h.ctx, run, bill());
    await h.deny(Number(proposal(h, id!).approvalId));
    settleApprovals(h.ctx.db, h.ctx.clock());
    expect(proposal(h, id!)).toMatchObject({ state: 'declined', eventId: null });
    expect(h.google.fake.mailbox('personal').events.size).toBe(0);
  });

  it('gives null for a past or a far date, and the old id for the same mail, kind and start', async () => {
    const { h, run } = await setup();
    expect(await proposeEvent(h.ctx, run, bill({ startAt: '2026-10-01T09:00:00-07:00' }))).toBeNull();
    expect(await proposeEvent(h.ctx, run, bill({ startAt: '2028-10-01T09:00:00-07:00' }))).toBeNull();
    expect(await proposeEvent(h.ctx, run, bill({ startAt: 'next tuesday' }))).toBeNull();
    const id = await proposeEvent(h.ctx, run, bill());
    expect(await proposeEvent(h.ctx, run, bill({ startAt: '2026-10-20T16:00:00Z', title: 'Power bill' }))).toBe(id);
    expect(h.rows('SELECT id FROM inbox_proposals')).toHaveLength(1);
    expect(h.sent).toHaveLength(1);
  });

  it('gives null when the calendar has an event with the same title that day', async () => {
    const { h, run } = await setup();
    h.google.fake.upsertEvent('personal', { id: 'mine', summary: 'pay  the Power bill', start: { dateTime: '2026-10-20T20:00:00Z' }, end: { dateTime: '2026-10-20T21:00:00Z' } });
    expect(await proposeEvent(h.ctx, run, bill())).toBeNull();
    expect(h.rows('SELECT id FROM inbox_proposals')).toEqual([]);
    const list = h.google.fake.requests.find((each) => each.method === 'GET' && each.path.startsWith('/calendar/v3/calendars/primary/events'))!;
    // the day is the local day in the time zone of the app.
    expect(decodeURIComponent(list.path)).toContain('timeMin=2026-10-20T07:00:00.000Z');
    expect(decodeURIComponent(list.path)).toContain('timeMax=2026-10-21T07:00:00.000Z');
    expect(list.path).toContain('singleEvents=true');
    // another title on that day is no copy.
    expect(await proposeEvent(h.ctx, run, bill({ title: 'Course quiz', kind: 'course' }))).toEqual(expect.any(Number));
  });

  it('makes an all-day event with the date and the next day', async () => {
    const { h, run } = await setup();
    const id = await proposeEvent(h.ctx, run, bill({ kind: 'course', title: 'Essay due', startAt: '2026-10-22T00:00:00-07:00', allDay: true, endAt: '2026-10-22T23:59:00-07:00', description: null }));
    const row = proposal(h, id!);
    expect(row).toMatchObject({ startAt: '2026-10-22T07:00:00.000Z', endAt: null, allDay: 1, description: null });
    await h.approve(Number(row.approvalId));
    const [event] = [...h.google.fake.mailbox('personal').events.values()];
    expect(event).toMatchObject({ summary: 'Essay due', start: { date: '2026-10-22' }, end: { date: '2026-10-23' } });
    expect(JSON.parse(inserts(h)[0]!.body)).not.toHaveProperty('description');
  });

  it('proposes an all-day deadline of today', async () => {
    h = await createInboxHarness({ accounts: ['personal'] });
    const run = startRun(h.ctx, 'digest', 'utility');
    markRead(h.ctx, run, [mailSource('personal')], 'inbox_digest');
    // the clock is 2026-10-13 09:00 in los angeles. midnight of that day is 07:00 utc.
    const id = await proposeEvent(h.ctx, run, { account: 'personal', kind: 'course', title: 'Homework 5 due', startAt: '2026-10-13T07:00:00.000Z', endAt: null, allDay: true, description: null, sourceMessageId: 'c1', sourceSubject: 'Homework 5' });
    expect(id).toEqual(expect.any(Number));
  });

  // row ids start again after a reset of the database. the event of an old proposal #1 must not count as the event
  // of a new proposal #1 of another deadline.
  it('does not take the event of an older proposal with the same row id as its own', async () => {
    const { h, run } = await setup();
    const salt = eventSalt(h.ctx);
    const first = await proposeEvent(h.ctx, run, bill());
    await h.approve(Number(proposal(h, first!).approvalId));
    expect(h.google.fake.mailbox('personal').events.size).toBe(1);
    // a reset: the rows are gone, the salt stays, and a new deadline gets the row id 1 again.
    h.ctx.db.exec('DELETE FROM inbox_proposals');
    const second = await proposeEvent(h.ctx, run, bill({ sourceMessageId: 'm2', title: 'Pay the water bill', startAt: '2026-10-21T09:00:00-07:00' }));
    expect(second).toBe(first);
    await h.approve(Number(proposal(h, second!).approvalId));
    expect(h.google.fake.mailbox('personal').events.size).toBe(2);
    expect(proposal(h, second!)).toMatchObject({ state: 'created', eventId: eventIdOf(salt, 'personal', 'm2:bill:2026-10-21T16:00:00.000Z') });
    // an event with the id of a proposal that has another title is not the event of the proposal.
    h.google.fake.upsertEvent('personal', { id: eventIdOf(salt, 'personal', 'm3:bill:2026-10-22T16:00:00.000Z'), summary: 'Something else', start: { dateTime: '2026-10-22T16:00:00.000Z' }, end: { dateTime: '2026-10-22T16:30:00.000Z' } });
    const third = await proposeEvent(h.ctx, run, bill({ sourceMessageId: 'm3', title: 'Pay the gas bill', startAt: '2026-10-22T09:00:00-07:00' }));
    const reply = await h.approve(Number(proposal(h, third!).approvalId));
    expect(reply).toContain('another event with the id');
    expect(proposal(h, third!)).toMatchObject({ state: 'failed' });
  });
});

describe('the words of the mail on the approval card', () => {
  const words = 'The mail says: "due Oct 20 at 9am"';

  it('adds the words to the description, and the approved call still matches the row', async () => {
    const { h, run } = await setup();
    const id = await proposeEvent(h.ctx, run, bill({ dueText: 'due Oct 20 at 9am' }));
    const row = proposal(h, id!);
    expect(row).toMatchObject({ description: `The bill of $82.10 is due.\n\n${words}`, dueText: 'due Oct 20 at 9am', state: 'proposed' });
    // the card that the owner reads shows the evidence of the date.
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]!.text).toContain('The mail says:');
    expect(h.sent[0]!.text).toContain('due Oct 20 at 9am');
    // the approved call carries the same description as the row, so the match check of the tool passes.
    const reply = await h.approve(Number(row.approvalId));
    expect(reply).not.toContain('does not match');
    expect(proposal(h, id!)).toMatchObject({ state: 'created' });
    const [event] = [...h.google.fake.mailbox('personal').events.values()];
    expect(event).toMatchObject({ summary: 'Pay the power bill', description: `The bill of $82.10 is due.\n\n${words}` });
  });

  it('gives the same proposal on a second run, with one approval', async () => {
    const { h, run } = await setup();
    const first = await proposeEvent(h.ctx, run, bill({ dueText: 'due Oct 20 at 9am' }));
    const second = await proposeEvent(h.ctx, run, bill({ dueText: 'due Oct 20 at 9am' }));
    expect(second).toBe(first);
    // a second digest whose model copied other words is still the same deadline.
    expect(await proposeEvent(h.ctx, run, bill({ dueText: 'Oct 20, 9 AM' }))).toBe(first);
    expect(h.rows('SELECT id FROM inbox_proposals')).toHaveLength(1);
    expect(h.rows('SELECT id FROM approvals')).toHaveLength(1);
    expect(h.sent).toHaveLength(1);
  });

  it('refuses a call whose description lacks the words', async () => {
    const { h, run } = await setup();
    const id = await proposeEvent(h.ctx, run, bill({ dueText: 'due Oct 20 at 9am' }));
    const tool = h.inbox.tools.find((each) => each.name === EVENT_TOOL)!;
    const row = proposal(h, id!);
    const input = { proposalId: id!, account: 'personal', kind: 'bill', title: 'Pay the power bill', startAt: String(row.startAt), endAt: String(row.endAt), allDay: false, description: 'The bill of $82.10 is due.' };
    const output = await tool.run(input, { runId: run.runId, sessionKey: run.sessionKey, timeZone: h.ctx.timeZone, clock: h.ctx.clock, signal: h.ctx.signal });
    expect(output).toMatchObject({ isError: true });
    expect(output.content).toContain('does not match');
    expect(inserts(h)).toEqual([]);
  });

  it('keeps the words within the limit of the description, and cleans them', async () => {
    const { h, run } = await setup();
    const long = await proposeEvent(h.ctx, run, bill({ description: 'x'.repeat(5000), dueText: 'due\nOct 20\u0000 at 9am' }));
    const description = String(proposal(h, long!).description);
    expect(description.length).toBeLessThanOrEqual(2000);
    expect(description.endsWith(`\n\n${words}`)).toBe(true);
    const bare = await proposeEvent(h.ctx, run, bill({ sourceMessageId: 'm2', description: null, dueText: 'due Oct 20 at 9am' }));
    expect(proposal(h, bare!).description).toBe(words);
    // a caller without the words keeps the description as it was.
    const legacy = await proposeEvent(h.ctx, run, bill({ sourceMessageId: 'm3', dueText: null }));
    expect(proposal(h, legacy!)).toMatchObject({ description: 'The bill of $82.10 is due.', dueText: null });
    const empty = await proposeEvent(h.ctx, run, bill({ sourceMessageId: 'm4', dueText: '   ' }));
    expect(proposal(h, empty!)).toMatchObject({ description: 'The bill of $82.10 is due.', dueText: null });
  });
});

describe('a hostile bill mail', () => {
  it('gives a proposal whose card names the taint, and nothing is made before the approval', async () => {
    const { h, run } = await setup();
    const mail = hostileMail('evil1');
    h.google.fake.deliver('personal', mail);
    const id = await proposeEvent(h.ctx, run, bill({ title: 'Invoice of $499.00 due', startAt: '2026-10-20T00:00:00-07:00', allDay: true, description: null, sourceMessageId: 'evil1', sourceSubject: mail.headers.Subject! }));
    expect(id).toEqual(expect.any(Number));
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]!.text).toContain('Untrusted content in this session: gmail:personal');
    expect(proposal(h, id!).state).toBe('proposed');
    expect(inserts(h)).toEqual([]);
    expect(h.google.fake.mailbox('personal').events.size).toBe(0);
    expect(h.google.fake.sent).toEqual([]);
    await h.approve(Number(proposal(h, id!).approvalId));
    expect(h.google.fake.mailbox('personal').events.size).toBe(1);
  });
});
