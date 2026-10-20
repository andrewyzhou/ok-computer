import { afterEach, describe, expect, it } from 'vitest';
import { createDeskHarness, D, deskLink, H, nudgeStep, threadMessage, type DeskHarness } from '../../test/desk-harness.js';
import { sessionTaint } from '../policy/store.js';
import { runFollowUps } from './followups.js';
import { listDelegationEvents, updateDelegation } from './store.js';

let h: DeskHarness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

const NUDGE = 'Hi Dana,\n\nI wanted to check on the lease renewal. Could you let me know where it stands?\n\nThank you.';
const OWNER = 'Owner <personal@example.com>';
const DANA = 'Dana Park <dana@landlord.example>';

async function setup(options: Parameters<typeof createDeskHarness>[0] = {}) {
  h = await createDeskHarness(options);
  return h;
}

const iso = (h: DeskHarness, ms: number) => new Date(h.now().getTime() + ms).toISOString();

// the owner asked in the thread four days ago, and nobody answered.
function asked(h: DeskHarness, threadId = 't-lease', account = 'personal', to = 'dana@landlord.example') {
  h.deliver(account, { id: `${threadId}-1`, threadId, from: OWNER, to, at: iso(h, -4 * D + 60_000), labelIds: ['SENT'], body: 'Could you send the lease renewal?' });
}

function events(h: DeskHarness, id: number) {
  return listDelegationEvents(h.google.db, id);
}

function noSend(h: DeskHarness) {
  expect(h.google.fake.sent).toEqual([]);
  expect(h.google.fake.requests.filter((each) => /\/send\b/.test(each.path))).toEqual([]);
}

describe('runFollowUps', () => {
  it('skips with no run when no follow-up is due', async () => {
    const h = await setup();
    h.seed({ thread: { account: 'personal', ref: 't-lease' }, followUpAt: iso(h, H) });
    h.seed({ title: 'Closed one', followUpAt: null });
    expect(await h.run()).toEqual({ status: 'skipped', error: 'no follow-up is due', decisions: [] });
    expect(h.rows('SELECT id FROM runs')).toEqual([]);
    expect(h.sent).toEqual([]);
  });

  it('tells the owner when a due delegation has no thread, and clears the follow-up', async () => {
    const h = await setup();
    const d = h.seed({ title: 'Book the flights', waitingOn: null });
    const result = await h.run();
    expect(result).toMatchObject({ status: 'completed', runId: 'id-1', decisions: [{ delegationId: d.id, action: 'no_thread' }] });
    const [event] = events(h, d.id).filter((each) => each.kind === 'follow_up_due');
    expect(event).toMatchObject({ actor: 'system', runId: 'id-1', text: 'The follow-up came, and there is no mail thread to check.' });
    expect(h.get(d.id)).toMatchObject({ nextFollowUpAt: null, lastCheckedAt: h.now().toISOString() });
    expect(h.sent).toEqual([`Desk follow-ups:\n#${d.id} "Book the flights": the follow-up is due, and there is no mail thread to check. ${deskLink(d.id)}`]);
    const [run] = h.rows('SELECT sessionKey, trigger, slot, status FROM runs');
    expect(run).toEqual({ sessionKey: 'desk:followups:id-1', trigger: 'automation', slot: 'utility', status: 'completed' });
    const [first] = h.rows("SELECT payload FROM events WHERE sessionKey = 'desk:followups:id-1' ORDER BY seq");
    expect(JSON.parse(String(first!.payload)).text).toContain('Drafts are never sent.');
    expect(h.ctx.activeRuns?.size).toBe(0);
  });

  it('tells the owner when the app has no google, and reads nothing', async () => {
    const h = await setup({ google: false });
    expect(h.desk.tools.map((tool) => tool.name)).not.toContain('desk_draft_nudge');
    const d = h.seed({ thread: { account: 'personal', ref: 't-lease' } });
    const result = await h.run();
    expect(result.decisions).toEqual([{ delegationId: d.id, action: 'no_google' }]);
    expect(h.history(d.id)).toContain('follow_up_due');
    expect(h.get(d.id).nextFollowUpAt).toBeNull();
    expect(h.sent[0]).toContain('google is not set up');
    expect(h.google.fake.requests).toEqual([]);
  });

  it('records a signed-out account and tries again in a day', async () => {
    const h = await setup();
    h.google.db.prepare("UPDATE google_accounts SET status = 'needs_auth' WHERE alias = 'school'").run();
    const d = h.seed({ thread: { account: 'school', ref: 't-lease' } });
    const result = await h.run();
    expect(result).toMatchObject({ status: 'completed', decisions: [{ action: 'unavailable', account: 'school' }] });
    const failed = events(h, d.id).find((each) => each.kind === 'follow_up_failed')!;
    expect(failed.text).toContain('needs the owner to sign in again');
    expect(h.get(d.id).nextFollowUpAt).toBe(iso(h, D));
    expect(h.sent[0]).toContain('the thread could not be checked');
    expect(h.google.fake.requests.filter((each) => each.path.includes('/threads/'))).toEqual([]);
  });

  it('stops the follow-up when the thread is gone', async () => {
    const h = await setup();
    const d = h.seed({ thread: { account: 'personal', ref: 't-missing' } });
    const result = await h.run();
    expect(result).toMatchObject({ status: 'completed', decisions: [{ action: 'thread_gone' }] });
    expect(events(h, d.id).find((each) => each.kind === 'follow_up_failed')!.text).toBe('the thread is gone');
    expect(h.get(d.id).nextFollowUpAt).toBeNull();
    expect(h.sent[0]).toContain('the mail thread is gone');
  });

  it('records a reply after the wait started, and opens the delegation', async () => {
    const h = await setup();
    const d = h.seed({ thread: { account: 'personal', ref: 't-lease' } });
    // a mail from before the wait and a draft are no reply.
    h.deliver('personal', { id: 'old', threadId: 't-lease', from: DANA, at: iso(h, -5 * D) });
    asked(h);
    h.deliver('personal', { id: 'draft', threadId: 't-lease', from: OWNER, at: iso(h, -2 * D), labelIds: ['DRAFT'] });
    h.deliver('personal', { id: 'reply', threadId: 't-lease', from: DANA, at: iso(h, -3 * D), body: 'Here it is.' });
    const result = await h.run();
    expect(result.decisions).toEqual([{ delegationId: d.id, action: 'reply_seen', account: 'personal' }]);
    expect(h.get(d.id)).toMatchObject({ status: 'open', nextStep: `Read the reply from ${DANA}`, nextFollowUpAt: null, waitingSince: null, nudgeCount: 0 });
    const seen = events(h, d.id).find((each) => each.kind === 'reply_seen')!;
    expect(seen).toMatchObject({ actor: 'system', runId: result.runId, data: { threadId: 't-lease', account: 'personal', messageId: 'reply', from: DANA } });
    expect(events(h, d.id).find((each) => each.kind === 'status')).toMatchObject({ actor: 'system', data: { from: 'waiting', to: 'open' } });
    expect(h.sent).toEqual([`Desk follow-ups:\n#${d.id} "Get the lease renewal from Dana": ${DANA} replied. Read the reply. ${deskLink(d.id)}`]);
    expect(h.drafts('personal')).toEqual([]);
    // the run read mail, so its session carries the taint of the account.
    expect(sessionTaint(h.google.db, `desk:followups:${result.runId}`).map((each) => each.source)).toEqual(['gmail:personal']);
  });

  it('waits a day when the owner wrote in the thread less than a day ago', async () => {
    const h = await setup();
    const d = h.seed({ thread: { account: 'personal', ref: 't-lease' } });
    asked(h);
    h.deliver('personal', { id: 'again', threadId: 't-lease', from: OWNER, to: 'dana@landlord.example', at: iso(h, -2 * H), labelIds: ['SENT'] });
    const result = await h.run();
    expect(result.decisions).toEqual([{ delegationId: d.id, action: 'owner_wrote', account: 'personal' }]);
    expect(h.history(d.id).at(-1)).toBe('follow_up_checked');
    expect(h.get(d.id)).toMatchObject({ status: 'waiting', nextFollowUpAt: iso(h, D), nudgeCount: 0 });
    expect(h.drafts('personal')).toEqual([]);
    expect(h.sent).toEqual([]);
    expect(h.modelCalls).toEqual([]);
  });

  it('blocks the delegation after the last nudge, and drafts nothing', async () => {
    const h = await setup();
    const d = h.seed({ thread: { account: 'personal', ref: 't-lease' }, nudges: 3 });
    asked(h);
    const result = await h.run();
    expect(result.decisions).toEqual([{ delegationId: d.id, action: 'blocked', account: 'personal' }]);
    expect(h.get(d.id)).toMatchObject({ status: 'blocked', nextStep: 'No reply from Dana Park after 3 nudges. Decide what to do next.', nextFollowUpAt: null });
    expect(h.sent[0]).toContain('no reply from Dana Park after 3 nudges');
    expect(h.drafts('personal')).toEqual([]);
    expect(h.modelCalls).toEqual([]);
  });

  it('saves a nudge in Gmail Drafts, never sends it, and moves the follow-up three days on', async () => {
    const h = await setup();
    const d = h.seed({ thread: { account: 'personal', ref: 't-lease' } });
    const followUpAt = d.nextFollowUpAt!;
    asked(h);
    h.script.push(nudgeStep(NUDGE));
    const result = await h.run();
    expect(result).toMatchObject({ status: 'completed', decisions: [{ delegationId: d.id, action: 'nudged', account: 'personal', to: 'dana@landlord.example' }] });

    const [draft] = h.drafts('personal');
    expect(draft!.headers).toContain('To: dana@landlord.example');
    expect(draft!.headers).toContain('Subject: Re: Lease renewal');
    expect(draft!.headers).toContain('In-Reply-To: <t-lease-1@mail.example>');
    expect(draft!.body).toBe(NUDGE);
    const create = h.google.fake.requests.find((each) => each.method === 'POST' && each.path.startsWith('/gmail/v1/users/me/drafts'))!;
    expect(JSON.parse(create.body).message.threadId).toBe('t-lease');
    noSend(h);

    expect(h.get(d.id)).toMatchObject({ status: 'waiting', nudgeCount: 1, nextFollowUpAt: iso(h, 3 * D), lastCheckedAt: h.now().toISOString() });
    const [nudge] = h.rows('SELECT * FROM delegation_nudges');
    expect(nudge).toMatchObject({ delegationId: d.id, account: 'personal', threadId: 't-lease', sourceMessageId: 't-lease-1', toAddress: 'dana@landlord.example', followUpAt, runId: result.runId, body: NUDGE });
    expect(nudge!.gmailDraftId).not.toBe('');
    const drafted = events(h, d.id).find((each) => each.kind === 'nudge_drafted')!;
    expect(drafted).toMatchObject({ actor: 'system', runId: result.runId, text: 'Saved a nudge to dana@landlord.example in Gmail Drafts. It is not sent.' });
    expect(drafted.data).toEqual({ nudgeId: nudge!.id, gmailDraftId: nudge!.gmailDraftId, account: 'personal', threadId: 't-lease' });
    expect(drafted.toolCallId).toMatch(/^followups-/);

    // the thread went to the model inside the untrusted wrapper of its account, and the reviewer checked the call of
    // the tainted session.
    const text = JSON.stringify(h.modelCalls[0]!.messages);
    expect(text).toContain('gmail:personal');
    expect(text).toContain('Could you send the lease renewal?');
    expect(h.reviews).toHaveLength(1);
    expect(h.reviews[0]!.tool).toBe('desk_draft_nudge');
    expect(sessionTaint(h.google.db, `desk:followups:${result.runId}`).map((each) => each.source)).toEqual(['gmail:personal']);
    expect(h.sent).toEqual([
      `Desk follow-ups:\n#${d.id} "Get the lease renewal from Dana": no reply from Dana Park yet, so a nudge to dana@landlord.example is in Gmail Drafts. It is not sent. ${deskLink(d.id)}`,
    ]);

    // a second run at the same time finds nothing due.
    expect((await h.run()).status).toBe('skipped');
    expect(h.drafts('personal')).toHaveLength(1);
  });

  it('writes the fixed nudge when the model gives no text', async () => {
    const h = await setup();
    h.seed({ thread: { account: 'personal', ref: 't-lease' } });
    asked(h);
    await h.run();
    expect(h.drafts('personal')[0]!.body).toBe('Hi Dana,\n\nI wanted to follow up on Get the lease renewal from Dana. Could you let me know where this stands?\n\nThank you.');
  });

  it('nudges the sender of the newest mail when the delegation has no email, and skips a no-reply address', async () => {
    const h = await setup();
    const d = h.seed({ thread: { account: 'personal', ref: 't-desk' }, waitingOn: { name: 'The front desk', email: 'no-reply@dentist.example' } });
    h.deliver('personal', { id: 'm1', threadId: 't-desk', from: 'Front Desk <front@dentist.example>', at: iso(h, -6 * D), subject: 'Re: Appointment' });
    h.deliver('personal', { id: 'm2', threadId: 't-desk', from: OWNER, to: 'front@dentist.example', at: iso(h, -5 * D), labelIds: ['SENT'], subject: 'Re: Appointment' });
    h.script.push(nudgeStep('Hello, could you confirm the new time?'));
    const result = await h.run();
    expect(result.decisions).toEqual([{ delegationId: d.id, action: 'nudged', account: 'personal', to: 'front@dentist.example' }]);
    const [draft] = h.drafts('personal');
    expect(draft!.headers).toContain('To: front@dentist.example');
    expect(draft!.headers).toContain('Subject: Re: Appointment\r\n');
    expect(draft!.headers).not.toContain('Re: Re:');
  });

  it('takes the first To address of the owner when nobody else wrote', async () => {
    const h = await setup();
    const d = h.seed({ thread: { account: 'personal', ref: 't-lease' }, waitingOn: { name: 'Dana' } });
    asked(h, 't-lease', 'personal', '"Park, Dana" <dana@landlord.example>, other@landlord.example');
    await h.run();
    expect(h.get(d.id).nudgeCount).toBe(1);
    expect(h.drafts('personal')[0]!.headers).toContain('To: dana@landlord.example\r\n');
  });

  it('stops the follow-up when there is no address to nudge', async () => {
    const h = await setup();
    const d = h.seed({ thread: { account: 'personal', ref: 't-bill' }, waitingOn: { name: 'The landlord' } });
    h.deliver('personal', { id: 'b1', threadId: 't-bill', from: 'Landlord <do-not-reply@landlord.example>', at: iso(h, -6 * D) });
    const result = await h.run();
    expect(result.decisions).toEqual([{ delegationId: d.id, action: 'no_address', account: 'personal' }]);
    expect(events(h, d.id).find((each) => each.kind === 'follow_up_failed')!.text).toBe('there is no address to nudge');
    expect(h.get(d.id).nextFollowUpAt).toBeNull();
    expect(h.sent[0]).toContain('there is no address to nudge');
    expect(h.drafts('personal')).toEqual([]);
  });

  it('records the hold when the reviewer holds the nudge, and tries again in a day', async () => {
    const h = await setup();
    h.hold.reason = 'the nudge does not match the task';
    const d = h.seed({ thread: { account: 'personal', ref: 't-lease' } });
    asked(h);
    h.script.push(nudgeStep(NUDGE));
    const result = await h.run();
    expect(result.decisions).toEqual([{ delegationId: d.id, action: 'nudge_failed', account: 'personal', to: 'dana@landlord.example' }]);
    // the reason of the reviewer can quote the mail, so the history and the owner message name the policy decision,
    // and the trace keeps the reason.
    const [decision] = h.rows("SELECT id, reviewerReason FROM policy_decisions WHERE toolName = 'desk_draft_nudge'");
    expect(decision!.reviewerReason).toBe('the nudge does not match the task');
    const failed = events(h, d.id).find((each) => each.kind === 'follow_up_failed')!;
    expect(failed.text).toBe(`The nudge was not saved: the reviewer held it or the tool refused it. See policy decision #${decision!.id} in the trace.`);
    expect(failed.data).toMatchObject({ decisionId: decision!.id });
    expect(h.get(d.id)).toMatchObject({ nudgeCount: 0, nextFollowUpAt: iso(h, D) });
    expect(h.rows('SELECT id FROM delegation_nudges')).toEqual([]);
    expect(h.drafts('personal')).toEqual([]);
    expect(h.sent[0]).toContain('the nudge was not saved');
    expect(h.sent[0]).not.toContain('does not match the task');
  });

  it('waits for the owner when the reviewer fails, and counts the nudge that the owner approved', async () => {
    const h = await setup({
      review: async () => {
        throw new Error('the reviewer is down');
      },
    });
    const d = h.seed({ thread: { account: 'personal', ref: 't-lease' } });
    const followUpAt = d.nextFollowUpAt!;
    asked(h);
    h.script.push(nudgeStep(NUDGE));
    const first = await h.run();
    expect(first.decisions).toEqual([{ delegationId: d.id, action: 'nudge_pending', account: 'personal', to: 'dana@landlord.example' }]);
    const [approval] = h.rows("SELECT id, status FROM approvals WHERE toolName = 'desk_draft_nudge'");
    expect(approval).toMatchObject({ status: 'pending' });
    // the follow-up time stays, so the approved call still matches it, and nothing is counted yet.
    expect(h.get(d.id)).toMatchObject({ nextFollowUpAt: followUpAt, nudgeCount: 0 });
    expect(events(h, d.id).at(-1)).toMatchObject({ kind: 'follow_up_checked', text: expect.stringContaining(`approval #${approval!.id}`) });
    expect(h.sent.join('\n')).toContain(`waits for your approval #${approval!.id}`);
    expect(h.drafts('personal')).toEqual([]);

    // a later run asks nothing again while the card waits. it only looks for a reply, in the headers of the thread.
    h.set(iso(h, 15 * 60_000));
    const reads = h.google.fake.requests.filter((each) => each.path.includes('/threads/')).length;
    const second = await h.run();
    expect(second.decisions).toEqual([{ delegationId: d.id, action: 'nudge_pending', account: 'personal', to: 'dana@landlord.example' }]);
    expect(h.rows("SELECT id FROM approvals WHERE toolName = 'desk_draft_nudge'")).toHaveLength(1);
    expect(h.modelCalls).toHaveLength(1);
    const read = h.google.fake.requests.filter((each) => each.path.includes('/threads/')).slice(reads);
    expect(read.map((each) => new URL(`http://fake${each.path}`).searchParams.get('format'))).toEqual(['metadata']);

    // the owner approves, the tool saves the draft, and the next run counts it.
    await h.approve(Number(approval!.id));
    expect(h.drafts('personal')).toHaveLength(1);
    expect(h.history(d.id)).toContain('nudge_drafted');
    h.set(iso(h, 15 * 60_000));
    const third = await h.run();
    expect(third.decisions).toEqual([{ delegationId: d.id, action: 'nudged', account: 'personal', to: 'dana@landlord.example' }]);
    expect(h.get(d.id)).toMatchObject({ nudgeCount: 1, nextFollowUpAt: iso(h, 3 * D) });
    expect(h.drafts('personal')).toHaveLength(1);
    noSend(h);
  });

  it('blocks the delegation when the owner denied the nudge, and asks no more', async () => {
    const h = await setup({
      review: async () => {
        throw new Error('the reviewer is down');
      },
    });
    const d = h.seed({ thread: { account: 'personal', ref: 't-lease' } });
    asked(h);
    await h.run();
    const [approval] = h.rows("SELECT id FROM approvals WHERE toolName = 'desk_draft_nudge'");
    await h.deny(Number(approval!.id));
    const result = await h.run();
    expect(result.decisions).toEqual([{ delegationId: d.id, action: 'nudge_denied', account: 'personal', to: 'dana@landlord.example' }]);
    expect(events(h, d.id).at(-1)).toMatchObject({ kind: 'follow_up_failed', text: `The owner declined the nudge of approval #${approval!.id}.` });
    expect(h.get(d.id)).toMatchObject({ status: 'blocked', nextStep: 'You declined the nudge to Dana Park. Decide what to do next.', nextFollowUpAt: null });
    expect(h.sent.at(-1)).toContain('you declined the nudge to Dana Park');
    expect(h.drafts('personal')).toEqual([]);
    // nothing is due any more, so no new card comes.
    h.set(iso(h, 2 * D));
    expect((await h.run()).status).toBe('skipped');
    expect(h.rows("SELECT id FROM approvals WHERE toolName = 'desk_draft_nudge'")).toHaveLength(1);
  });

  it('tries again in a day when the card of the nudge expired, and counts the try', async () => {
    const h = await setup({
      review: async () => {
        throw new Error('the reviewer is down');
      },
    });
    const d = h.seed({ thread: { account: 'personal', ref: 't-lease' } });
    asked(h);
    await h.run();
    h.google.db.prepare("UPDATE approvals SET status = 'expired' WHERE toolName = 'desk_draft_nudge'").run();
    const result = await h.run();
    expect(result.decisions).toEqual([{ delegationId: d.id, action: 'nudge_failed', account: 'personal', to: 'dana@landlord.example' }]);
    expect(h.get(d.id)).toMatchObject({ status: 'waiting', nudgeCount: 1, nextFollowUpAt: iso(h, D) });
  });

  it('goes on after one delegation fails, and sends one owner message with each desk link', async () => {
    const h = await setup();
    const bad = h.seed({ title: 'Broken thread', thread: { account: 'personal', ref: 't-bad' }, followUpAt: iso(h, -2 * H) });
    const good = h.seed({ thread: { account: 'personal', ref: 't-lease' } });
    const none = h.seed({ title: 'Call the bank', waitingOn: null });
    asked(h);
    h.deliver('personal', { id: 'x1', threadId: 't-bad', from: DANA, at: iso(h, -6 * D) });
    h.google.fake.fault({ route: 'GET /gmail/v1/users/me/threads/t-bad', status: 500, times: 1 });
    h.script.push(nudgeStep(NUDGE));
    const result = await h.run();
    expect(result.status).toBe('completed');
    expect(result.decisions.map((each) => [each.delegationId, each.action])).toEqual([
      [bad.id, 'read_failed'],
      [good.id, 'nudged'],
      [none.id, 'no_thread'],
    ]);
    expect(events(h, bad.id).find((each) => each.kind === 'follow_up_failed')!.text).toContain('the thread could not be read');
    expect(h.get(bad.id).nextFollowUpAt).toBe(iso(h, D));
    expect(h.logged.map((each) => each.msg)).toContain('the desk follow-up could not read the thread');
    expect(h.sent).toHaveLength(1);
    const lines = h.sent[0]!.split('\n');
    expect(lines[0]).toBe('Desk follow-ups:');
    expect(lines.slice(1).map((line) => line.split(':')[0])).toEqual([`#${good.id} "Get the lease renewal from Dana"`, `#${none.id} "Call the bank"`]);
    expect(lines[1]).toMatch(new RegExp(`${deskLink(good.id).replace(/[?.]/g, '\\$&')}$`));
    expect(lines[2]).toMatch(new RegExp(`${deskLink(none.id).replace(/[?.]/g, '\\$&')}$`));
  });

  it('fails the job when every thread read failed with a google error', async () => {
    const h = await setup();
    const d = h.seed({ thread: { account: 'personal', ref: 't-lease' } });
    asked(h);
    h.google.fake.fault({ route: 'GET /gmail/v1/users/me/threads/', status: 503, times: 5 });
    const result = await h.run();
    expect(result).toMatchObject({ status: 'failed', decisions: [{ delegationId: d.id, action: 'read_failed' }] });
    expect(result.error).toContain('every thread read failed');
    expect(h.rows('SELECT status FROM runs')).toEqual([{ status: 'failed' }]);
    expect(h.sent).toEqual([]);
    expect(h.ctx.activeRuns?.size).toBe(0);
  });

  it('records an unexpected error of one delegation and goes on', async () => {
    const h = await setup();
    const first = h.seed({ thread: { account: 'personal', ref: 't-lease' } });
    const second = h.seed({ title: 'Call the bank', waitingOn: null });
    asked(h);
    const broken = {
      ...h.ctx,
      caller: () => {
        throw new TypeError('the caller broke');
      },
    };
    const result = await runFollowUps(broken);
    expect(result.status).toBe('completed');
    expect(result.decisions.map((each) => each.action)).toEqual(['error', 'no_thread']);
    expect(events(h, first.id).find((each) => each.kind === 'follow_up_failed')!.text).toBe('the follow-up stopped: the caller broke');
    expect(h.get(first.id)).toMatchObject({ nudgeCount: 0, nextFollowUpAt: iso(h, D) });
    expect(h.history(second.id)).toContain('follow_up_due');
    expect(h.logged.map((each) => each.msg)).toContain('the desk follow-up of a delegation failed');
    expect(h.sent).toHaveLength(1);
  });

  it('reports the decisions of a dry run, and writes, drafts and sends nothing', async () => {
    const h = await setup();
    const nudged = h.seed({ thread: { account: 'personal', ref: 't-lease' } });
    const none = h.seed({ title: 'Call the bank', waitingOn: null });
    const replied = h.seed({ title: 'Get the form', thread: { account: 'school', ref: 't-form' }, waitingOn: { email: 'office@school.example' } });
    asked(h);
    h.deliver('school', { id: 'f1', threadId: 't-form', from: 'Office <office@school.example>', at: iso(h, -D) });
    const before = {
      delegations: h.rows('SELECT * FROM delegations ORDER BY id'),
      history: h.rows('SELECT COUNT(*) AS n FROM delegation_events'),
      events: h.rows('SELECT COUNT(*) AS n FROM events'),
    };
    const result = await h.run({ dryRun: true });
    expect(result.status).toBe('completed');
    expect(result.runId).toBeUndefined();
    expect(result.decisions).toEqual([
      { delegationId: nudged.id, action: 'would_nudge', account: 'personal', to: 'dana@landlord.example' },
      { delegationId: none.id, action: 'no_thread' },
      { delegationId: replied.id, action: 'reply_seen', account: 'school' },
    ]);
    expect(h.rows('SELECT * FROM delegations ORDER BY id')).toEqual(before.delegations);
    expect(h.rows('SELECT COUNT(*) AS n FROM delegation_events')).toEqual(before.history);
    expect(h.rows('SELECT COUNT(*) AS n FROM events')).toEqual(before.events);
    expect(h.rows('SELECT id FROM runs')).toEqual([]);
    expect(h.rows('SELECT id FROM delegation_nudges')).toEqual([]);
    expect(h.drafts('personal')).toEqual([]);
    expect(h.modelCalls).toEqual([]);
    expect(h.sent).toEqual([]);
    noSend(h);
  });
});

describe('runFollowUps and other kinds of mail', () => {
  it('does not take a bounce or a no-reply mail as the reply', async () => {
    const h = await setup();
    const d = h.seed({ thread: { account: 'personal', ref: 't-lease' } });
    asked(h);
    h.deliver('personal', { id: 'bounce', threadId: 't-lease', from: 'Mail Delivery Subsystem <mailer-daemon@googlemail.com>', at: iso(h, -4 * D + 120_000), subject: 'Delivery Status Notification (Failure)' });
    h.deliver('personal', { id: 'auto', threadId: 't-lease', from: 'Landlord Portal <no-reply@landlord.example>', at: iso(h, -3 * D), subject: 'We got your message' });
    const result = await h.run();
    expect(result.decisions[0]!.action).not.toBe('reply_seen');
    expect(h.get(d.id).status).toBe('waiting');
  });

  it('does not take an automatic answer as the reply', async () => {
    const h = await setup();
    const d = h.seed({ thread: { account: 'personal', ref: 't-lease' } });
    asked(h);
    const away = threadMessage({ id: 'away', threadId: 't-lease', from: DANA, at: iso(h, -3 * D), subject: 'Out of office' });
    h.google.fake.deliver('personal', { ...away, headers: { ...away.headers, 'Auto-Submitted': 'auto-replied' } });
    expect((await h.run()).decisions[0]!.action).toBe('nudged');
    expect(h.get(d.id).status).toBe('waiting');
  });

  it('nudges no one outside the thread, even when the delegation waits on that email', async () => {
    const h = await setup();
    const d = h.seed({ thread: { account: 'personal', ref: 't-lease' }, waitingOn: { name: 'Eve', email: 'eve@evil.example' } });
    asked(h);
    const result = await h.run();
    expect(result.decisions).toEqual([{ delegationId: d.id, action: 'nudged', account: 'personal', to: 'dana@landlord.example' }]);
    expect(h.drafts('personal')[0]!.headers).not.toContain('eve@evil.example');
  });
});

describe('runFollowUps and a delegation that is not waiting', () => {
  it('drafts no nudge for a blocked delegation with a thread, and tells the owner that it is due', async () => {
    const h = await setup();
    const d = h.seed({ thread: { account: 'personal', ref: 't-lease' } });
    h.google.db.prepare("UPDATE delegations SET status = 'blocked' WHERE id = ?").run(d.id);
    asked(h);
    const result = await h.run();
    expect(result.decisions).toEqual([{ delegationId: d.id, action: 'not_waiting' }]);
    expect(h.get(d.id)).toMatchObject({ status: 'blocked', nextFollowUpAt: null });
    expect(h.history(d.id).at(-1)).toBe('follow_up_due');
    expect(h.sent[0]).toContain('blocked and needs you, so no nudge was drafted');
    expect(h.drafts('personal')).toEqual([]);
    expect(h.google.fake.requests.filter((each) => each.path.includes('/threads/'))).toEqual([]);
  });
});

describe('runFollowUps while the owner changes the desk', () => {
  // the owner acts on the dashboard while the job waits on google.
  function duringRead(h: DeskHarness, act: () => void) {
    const accounts = h.ctx.google!.accounts;
    let done = false;
    const google = {
      accounts: {
        unavailable: (alias: string) => accounts.unavailable(alias),
        run: async (alias: string, work: never) => {
          const out = await accounts.run(alias, work);
          if (!done) {
            done = true;
            act();
          }
          return out;
        },
      },
    };
    return { ...h.ctx, google } as never;
  }

  it('does not reopen a delegation that the owner closed while the thread was read', async () => {
    const h = await setup();
    const d = h.seed({ thread: { account: 'personal', ref: 't-lease' } });
    asked(h);
    h.deliver('personal', { id: 'reply', threadId: 't-lease', from: DANA, at: iso(h, -D) });
    const result = await runFollowUps(duringRead(h, () => updateDelegation(h.google.db, d.id, { status: 'done' }, { actor: 'owner' }, h.now())));
    expect(result.decisions).toEqual([{ delegationId: d.id, action: 'changed' }]);
    expect(h.get(d.id)).toMatchObject({ status: 'done', nextFollowUpAt: null });
    expect(h.history(d.id)).not.toContain('reply_seen');
    expect(h.sent).toEqual([]);
  });

  it('keeps the follow-up time that the owner set while the thread was read', async () => {
    const h = await setup();
    const d = h.seed({ thread: { account: 'personal', ref: 't-lease' } });
    asked(h);
    const owners = iso(h, 5 * D);
    const result = await runFollowUps(duringRead(h, () => updateDelegation(h.google.db, d.id, { nextFollowUpAt: owners }, { actor: 'owner' }, h.now())));
    expect(result.decisions).toEqual([{ delegationId: d.id, action: 'changed' }]);
    expect(h.get(d.id)).toMatchObject({ status: 'waiting', nextFollowUpAt: owners, nudgeCount: 0 });
    expect(h.drafts('personal')).toEqual([]);
    expect(h.modelCalls).toEqual([]);
  });

  it('puts no follow-up time on a delegation that the owner dropped while the nudge was reviewed', async () => {
    let drop = () => {};
    const h = await setup({
      review: async () => {
        drop();
        return { verdict: 'allow', reason: 'fine' };
      },
    });
    const d = h.seed({ thread: { account: 'personal', ref: 't-lease' } });
    drop = () => {
      updateDelegation(h.google.db, d.id, { status: 'dropped' }, { actor: 'owner' }, h.now());
    };
    asked(h);
    const result = await h.run();
    expect(result.decisions).toEqual([{ delegationId: d.id, action: 'changed' }]);
    expect(h.get(d.id)).toMatchObject({ status: 'dropped', nextFollowUpAt: null, nudgeCount: 0 });
    expect(h.history(d.id)).not.toContain('follow_up_failed');
    expect(h.drafts('personal')).toEqual([]);
    expect(h.sent).toEqual([]);
  });

  it('nudges again after a new wait, without the nudges of the old one', async () => {
    const h = await setup();
    const d = h.seed({ thread: { account: 'personal', ref: 't-lease' }, nudges: 3 });
    asked(h);
    expect((await h.run()).decisions[0]!.action).toBe('blocked');
    // the owner waits on Dana again.
    updateDelegation(h.google.db, d.id, { status: 'waiting', nextFollowUpAt: iso(h, D) }, { actor: 'owner' }, h.now());
    expect(h.get(d.id).nudgeCount).toBe(0);
    h.set(iso(h, D));
    expect((await h.run()).decisions[0]!.action).toBe('nudged');
    expect(h.get(d.id)).toMatchObject({ status: 'waiting', nudgeCount: 1 });
  });
});
