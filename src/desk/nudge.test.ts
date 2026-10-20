import { afterEach, describe, expect, it } from 'vitest';
import { createDeskHarness, D, H, type DeskHarness } from '../../test/desk-harness.js';
import type { Delegation } from '../dashboard/desk-types.js';
import { addressesOf, createNudgeTools, fallbackNudge } from './nudge.js';
import { listDelegationEvents, updateDelegation } from './store.js';

let h: DeskHarness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

const iso = (h: DeskHarness, ms: number) => new Date(h.now().getTime() + ms).toISOString();

// a delegation that waits on Dana, with its thread: the owner asked, and Sam is in Cc.
async function setup() {
  h = await createDeskHarness();
  const d = h.seed({ thread: { account: 'personal', ref: 't-lease' } });
  h.deliver('personal', {
    id: 'm1',
    threadId: 't-lease',
    from: 'Owner <personal@example.com>',
    to: 'Dana Park <dana@landlord.example>',
    cc: '"Lee, Sam" <sam@landlord.example>',
    at: iso(h, -4 * D),
    labelIds: ['SENT'],
  });
  // a mail of another thread names an address that the nudge must never reach.
  h.deliver('personal', { id: 'x1', threadId: 't-other', from: 'Mallory <mallory@evil.example>', at: iso(h, -D) });
  return { h, d };
}

const input = (d: Delegation, change: Record<string, unknown> = {}) => ({
  account: 'personal',
  delegationId: d.id,
  threadId: 't-lease',
  followUpAt: d.nextFollowUpAt!,
  to: ['dana@landlord.example'],
  subject: 'Re: Lease renewal',
  inReplyTo: '<m1@mail.example>',
  sourceMessageId: 'm1',
  body: 'Hi Dana, could you let me know where the renewal stands?',
  ...change,
});

function nothingSaved(h: DeskHarness) {
  expect(h.rows('SELECT id FROM delegation_nudges')).toEqual([]);
  expect(h.drafts('personal')).toEqual([]);
  expect(h.google.fake.sent).toEqual([]);
}

describe('the nudge tool', () => {
  it('gives no tool without google', async () => {
    h = await createDeskHarness();
    expect(createNudgeTools({ ...h.ctx, google: undefined, googleConfig: undefined } as never)).toEqual([]);
    expect(createNudgeTools(h.ctx).map((tool) => tool.name)).toEqual(['desk_draft_nudge']);
  });

  it('saves a draft in the thread with its claim row and its history row, and never sends it', async () => {
    const { h, d } = await setup();
    const output = await h.nudge(input(d));
    expect(output.isError).toBeFalsy();
    expect(output.content).toContain('It is not sent.');
    const [draft] = h.drafts('personal');
    expect(draft!.headers).toContain('To: dana@landlord.example');
    expect(draft!.headers).toContain('In-Reply-To: <m1@mail.example>');
    const [row] = h.rows('SELECT * FROM delegation_nudges');
    expect(row).toMatchObject({ delegationId: d.id, followUpAt: d.nextFollowUpAt, toAddress: 'dana@landlord.example', sourceMessageId: 'm1', runId: 'nudge-run-1' });
    expect(row!.gmailDraftId).toMatch(/^d\d+$/);
    const event = listDelegationEvents(h.google.db, d.id).at(-1)!;
    expect(event).toMatchObject({ kind: 'nudge_drafted', actor: 'system', runId: 'nudge-run-1', data: { nudgeId: row!.id, gmailDraftId: row!.gmailDraftId, account: 'personal', threadId: 't-lease' } });
    // the tool reads the thread with the address headers only, and asks nothing to send.
    const read = h.google.fake.requests.find((each) => each.path.startsWith('/gmail/v1/users/me/threads/t-lease'))!;
    expect(read.path).toContain('format=metadata');
    expect(h.google.fake.requests.filter((each) => /\/send\b/.test(each.path))).toEqual([]);
    expect(h.google.fake.sent).toEqual([]);
    // markChecked is the job's, so the tool leaves the count alone.
    expect(h.get(d.id).nudgeCount).toBe(0);
  });

  it('takes an address from the Cc of the thread', async () => {
    const { h, d } = await setup();
    expect((await h.nudge(input(d, { to: ['Sam@Landlord.example'] }))).isError).toBeFalsy();
    expect(h.drafts('personal')[0]!.headers).toContain('To: sam@landlord.example');
  });

  it('refuses a follow-up time that is not the one of the delegation', async () => {
    const { h, d } = await setup();
    const output = await h.nudge(input(d, { followUpAt: iso(h, 2 * D) }));
    expect(output).toMatchObject({ isError: true });
    expect(output.content).toContain('Only the follow-up job saves a nudge.');
    nothingSaved(h);
  });

  it('refuses a delegation without a follow-up time, a closed one and a missing one', async () => {
    const { h, d } = await setup();
    const quiet = h.seed({ title: 'No follow-up', thread: { account: 'personal', ref: 't-lease' }, followUpAt: null });
    expect((await h.nudge(input(quiet, { followUpAt: d.nextFollowUpAt }))).content).toContain('Only the follow-up job saves a nudge.');
    expect((await h.nudge(input(d, { delegationId: 999 }))).content).toContain('delegation #999 not found');
    const closed = updateDelegation(h.google.db, d.id, { status: 'done' }, { actor: 'owner' }, h.now());
    expect(closed.ok).toBe(true);
    const output = await h.nudge(input(d));
    expect(output).toMatchObject({ isError: true });
    expect(output.content).toContain(`delegation #${d.id} is done`);
    nothingSaved(h);
  });

  it('refuses a thread that is not linked to the delegation, also in another account', async () => {
    const { h, d } = await setup();
    const other = await h.nudge(input(d, { threadId: 't-other', to: ['mallory@evil.example'] }));
    expect(other.content).toContain('the thread is not linked');
    const school = await h.nudge(input(d, { account: 'school' }));
    expect(school.content).toContain('the thread is not linked');
    nothingSaved(h);
  });

  it('refuses a recipient outside the thread, a no-reply address and a header with a mailbox list', async () => {
    const { h, d } = await setup();
    const outside = await h.nudge(input(d, { to: ['mallory@evil.example'] }));
    expect(outside).toMatchObject({ isError: true });
    expect(outside.content).toContain('a nudge goes only to an address in the From, To or Cc of the thread');
    expect((await h.nudge(input(d, { to: ['noreply@landlord.example'] }))).content).toContain('takes no replies');
    const list = await h.nudge(input(d, { to: ['dana@landlord.example, mallory@evil.example'] }));
    expect(list).toMatchObject({ isError: true });
    expect(list.content).toContain('is not a plain email address');
    nothingSaved(h);
  });

  it('refuses a subject or a reply id with a line break, a second recipient and an extra field', async () => {
    const { h, d } = await setup();
    for (const change of [
      { subject: 'Re: Lease\r\nBcc: mallory@evil.example' },
      { subject: 'Re: Lease\nBcc: mallory@evil.example' },
      { inReplyTo: '<m1@mail.example>\r\nBcc: mallory@evil.example' },
      { to: ['dana@landlord.example', 'sam@landlord.example'] },
      { body: 'x'.repeat(2001) },
      { cc: ['mallory@evil.example'] },
    ]) {
      const output = await h.nudge(input(d, change));
      expect(output.isError, JSON.stringify(change)).toBe(true);
    }
    nothingSaved(h);
  });

  it('makes one draft for one follow-up time, and a second call says that the nudge exists', async () => {
    const { h, d } = await setup();
    expect((await h.nudge(input(d))).isError).toBeFalsy();
    const second = await h.nudge(input(d, { body: 'A second text.' }));
    expect(second.isError).toBeFalsy();
    expect(second.content).toBe(`a nudge for this follow-up of delegation #${d.id} already exists. It is not sent.`);
    expect(h.drafts('personal')).toHaveLength(1);
    expect(h.rows('SELECT id FROM delegation_nudges')).toHaveLength(1);
    expect(listDelegationEvents(h.google.db, d.id).filter((each) => each.kind === 'nudge_drafted')).toHaveLength(1);
  });

  it('removes the claim when the draft create fails, so a later call can save it', async () => {
    const { h, d } = await setup();
    h.google.fake.fault({ route: 'POST /gmail/v1/users/me/drafts', status: 500, times: 1 });
    const output = await h.nudge(input(d));
    expect(output).toMatchObject({ isError: true });
    expect(output.content).toContain('desk_draft_nudge failed for personal');
    nothingSaved(h);
    expect(listDelegationEvents(h.google.db, d.id).map((each) => each.kind)).not.toContain('nudge_drafted');
    expect((await h.nudge(input(d))).isError).toBeFalsy();
    expect(h.drafts('personal')).toHaveLength(1);
  });

  it('replaces a claim of a call that stopped long ago', async () => {
    const { h, d } = await setup();
    h.google.db
      .prepare(
        `INSERT INTO delegation_nudges (delegationId, account, threadId, gmailDraftId, toAddress, subject, body, followUpAt, createdAt)
         VALUES (?, 'personal', 't-lease', '', 'dana@landlord.example', 's', 'b', ?, ?)`,
      )
      .run(d.id, d.nextFollowUpAt!, iso(h, -H));
    expect((await h.nudge(input(d))).isError).toBeFalsy();
    expect(h.drafts('personal')).toHaveLength(1);
    expect(h.rows("SELECT id FROM delegation_nudges WHERE gmailDraftId != ''")).toHaveLength(1);
  });
});

describe('the nudge text', () => {
  it('reads the addresses of a list header, also with a comma in a quoted name', () => {
    expect(addressesOf('"Lee, Sam" <Sam@x.example>, b@y.example, not an address')).toEqual(['sam@x.example', 'b@y.example']);
    expect(addressesOf('')).toEqual([]);
  });

  it('greets by the first name, or by there', () => {
    expect(fallbackNudge({ title: 'the lease', waitingOn: { name: 'Dana Park', email: null } })).toMatch(/^Hi Dana,\n\nI wanted to follow up on the lease\./);
    expect(fallbackNudge({ title: 'the lease', waitingOn: null })).toMatch(/^Hi there,/);
  });
});
