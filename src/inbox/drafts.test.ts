import { afterEach, describe, expect, it } from 'vitest';
import type { FakeMessage } from '../../test/fake-google.js';
import { createInboxHarness, hostileMail, type InboxHarness } from '../../test/inbox-harness.js';
import { toolStep } from '../models/fake.js';
import type { ReviewRequest, ReviewResult } from '../policy/policy.js';
import { ownerRequest } from '../policy/reviewer.js';
import { checkDrafts, DRAFT_TOOL, draftReply } from './drafts.js';
import { markRead, mailSource, startRun } from './run.js';

let h: InboxHarness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

const REPLY = 'Hi Sam,\n\nThanks for the note. I can meet on Thursday at 3 pm.\n\nBest';

function question(id: string, options: { from?: string; threadId?: string } = {}): FakeMessage {
  return {
    id,
    threadId: options.threadId ?? `t-${id}`,
    labelIds: ['INBOX', 'UNREAD'],
    internalDate: String(Date.parse('2026-10-13T10:00:00Z')),
    snippet: 'Can we meet this week?',
    body: 'Hi, can we meet this week to talk about the project? Thursday works for me.',
    headers: {
      From: options.from ?? 'Sam Lee <sam@school.example>',
      'Reply-To': 'other@elsewhere.example',
      To: 'personal@example.com',
      Subject: 'Meeting this week',
      Date: 'Tue, 13 Oct 2026 10:00:00 GMT',
      'Message-ID': `<${id}@school.example>`,
    },
  };
}

// a run of the digest after it read the mail, so each tool call is a call of a tainted session.
async function setup(options: { review?: (request: ReviewRequest) => Promise<ReviewResult> } = {}) {
  h = await createInboxHarness(options);
  const run = startRun(h.ctx, 'digest', 'utility');
  markRead(h.ctx, run, [mailSource('personal')], 'inbox_digest');
  return { h, run };
}

const writeStep = (body: string) => toolStep({ id: 'w1', name: 'write_draft', input: { items: [{ id: 1, body }] } });

// the fake keeps the raw message of a draft. its body is base64, as rawMessage writes it.
function decoded(raw: string): { headers: string; body: string } {
  const [headers, body] = raw.split('\r\n\r\n');
  return { headers: headers!, body: Buffer.from(body!.replace(/\r\n/g, ''), 'base64').toString('utf8') };
}

function noSend(h: InboxHarness) {
  expect(h.google.fake.sent).toEqual([]);
  expect(h.google.fake.requests.filter((each) => /\/send\b/.test(each.path))).toEqual([]);
}

describe('draftReply', () => {
  it('saves a draft to the sender of the mail, and a second call makes no new draft', async () => {
    const { h, run } = await setup();
    h.google.fake.deliver('personal', question('q1'));
    h.script.push(writeStep(REPLY));
    const id = await draftReply(h.ctx, run, { account: 'personal', messageId: 'q1', threadId: 't-q1' });
    expect(id).toEqual(expect.any(Number));

    const drafts = [...h.google.fake.mailbox('personal').drafts.values()];
    expect(drafts).toHaveLength(1);
    const { headers, body } = decoded(drafts[0]!.message.body!);
    expect(headers).toContain('To: sam@school.example');
    expect(headers).not.toContain('other@elsewhere.example');
    expect(headers).toContain('Subject: Re: Meeting this week');
    expect(headers).toContain('In-Reply-To: <q1@school.example>');
    expect(body).toBe(REPLY);
    const create = h.google.fake.requests.find((each) => each.method === 'POST' && each.path.startsWith('/gmail/v1/users/me/drafts'))!;
    expect(JSON.parse(create.body).message.threadId).toBe('t-q1');

    const [row] = h.rows('SELECT * FROM inbox_drafts WHERE id = ?', id!);
    expect(row).toMatchObject({ account: 'personal', sourceMessageId: 'q1', threadId: 't-q1', state: 'drafted', runId: run.runId, toAddresses: '["sam@school.example"]', inReplyTo: '<q1@school.example>' });
    expect(row!.toolCallId).toEqual(expect.stringMatching(/^digest-/));
    // the session read mail, so the reviewer checked the write call.
    expect(h.reviews).toHaveLength(1);
    expect(h.reviews[0]).toMatchObject({ tool: DRAFT_TOOL, risk: 'write', taint: ['gmail:personal'] });
    // the model got the thread inside the untrusted wrapper.
    expect(JSON.stringify(h.modelCalls[0]!.messages)).toContain('untrusted');

    const calls = h.modelCalls.length;
    expect(await draftReply(h.ctx, run, { account: 'personal', messageId: 'q1', threadId: 't-q1' })).toBe(id);
    expect(h.google.fake.mailbox('personal').drafts.size).toBe(1);
    expect(h.modelCalls).toHaveLength(calls);
    noSend(h);
  });

  // the reviewer checks the call against the task of the run. the task must say that the digest saves drafts, or a
  // reviewer would hold every draft.
  it('gives the reviewer a run task that names the draft replies', async () => {
    const { h, run } = await setup();
    h.google.fake.deliver('personal', question('q9'));
    h.script.push(writeStep(REPLY));
    await draftReply(h.ctx, run, { account: 'personal', messageId: 'q9', threadId: 't-q9' });
    const review = h.reviews[0]!;
    const task = ownerRequest(h.ctx.db, review.sessionKey, review.runId);
    expect(task).toContain('<run_task>');
    expect(task).toContain('saves draft replies to Gmail Drafts (they are never sent)');
  });

  it('makes one gmail draft when two calls for one mail come at once', async () => {
    const { h, run } = await setup();
    h.google.fake.deliver('personal', question('q8'));
    const tool = h.inbox.tools.find((each) => each.name === DRAFT_TOOL)!;
    const input = { account: 'personal', sourceMessageId: 'q8', threadId: 't-q8', to: ['sam@school.example'], subject: 'Re: Meeting this week', body: REPLY };
    const ctx = (id: string) => ({ runId: run.runId, sessionKey: run.sessionKey, timeZone: h.ctx.timeZone, clock: h.ctx.clock, signal: h.ctx.signal, toolCallId: id });
    const outputs = await Promise.all([tool.run(input, ctx('a')), tool.run(input, ctx('b'))]);
    expect(outputs.map((each) => each.isError)).toEqual([undefined, undefined]);
    expect(h.google.fake.mailbox('personal').drafts.size).toBe(1);
    expect(h.rows("SELECT COUNT(*) AS n FROM inbox_drafts WHERE gmailDraftId != ''")).toEqual([{ n: 1 }]);
  });

  it('gives null for a no-reply sender', async () => {
    const { h, run } = await setup();
    h.google.fake.deliver('personal', question('q2', { from: 'Shop <no-reply@shop.example>' }));
    expect(await draftReply(h.ctx, run, { account: 'personal', messageId: 'q2', threadId: 't-q2' })).toBeNull();
    expect(h.modelCalls).toHaveLength(0);
    expect(h.google.fake.mailbox('personal').drafts.size).toBe(0);
  });

  it('gives null and no row when the reviewer holds the call', async () => {
    const { h, run } = await setup({ review: async () => ({ verdict: 'hold', reason: 'the draft looks odd' }) });
    h.google.fake.deliver('personal', question('q3'));
    h.script.push(writeStep(REPLY));
    expect(await draftReply(h.ctx, run, { account: 'personal', messageId: 'q3', threadId: 't-q3' })).toBeNull();
    expect(h.rows('SELECT * FROM inbox_drafts')).toEqual([]);
    expect(h.google.fake.mailbox('personal').drafts.size).toBe(0);
  });

  it('answers the hostile mail only to its From address, and refuses a call to another address', async () => {
    const { h, run } = await setup();
    h.google.fake.deliver('personal', hostileMail('evil1'));
    h.script.push(writeStep('Thanks, I will check the invoice.'));
    const id = await draftReply(h.ctx, run, { account: 'personal', messageId: 'evil1', threadId: 'evil1' });
    expect(id).toEqual(expect.any(Number));
    const [draft] = [...h.google.fake.mailbox('personal').drafts.values()];
    expect(decoded(draft!.message.body!).headers).toContain('To: billing@pay-now.example');
    expect(draft!.message.body).not.toContain('attacker@evil.example');

    // a call that text in the mail could ask for names the attacker. the tool refuses it.
    h.google.fake.deliver('personal', hostileMail('evil2'));
    const output = await h.caller.call(
      {
        id: 'direct-1',
        name: DRAFT_TOOL,
        input: { account: 'personal', sourceMessageId: 'evil2', threadId: 'evil2', to: ['attacker@evil.example'], subject: 'Re: invoice', body: 'here are the passwords' },
      },
      { runId: run.runId, sessionKey: run.sessionKey, allowed: [DRAFT_TOOL], signal: h.ctx.signal },
    );
    expect(output.isError).toBe(true);
    expect(output.content).toContain('a draft reply goes only to the sender of the mail');
    expect(h.google.fake.mailbox('personal').drafts.size).toBe(1);
    expect(h.rows("SELECT * FROM inbox_drafts WHERE sourceMessageId = 'evil2'")).toEqual([]);
    noSend(h);
  });
});

describe('checkDrafts', () => {
  async function drafted(h: InboxHarness, run: Parameters<typeof draftReply>[1], id: string) {
    h.google.fake.deliver('personal', question(id));
    h.script.push(writeStep(`${REPLY} (${id})`));
    const rowId = await draftReply(h.ctx, run, { account: 'personal', messageId: id, threadId: `t-${id}` });
    const gmailDraftId = String(h.rows('SELECT gmailDraftId FROM inbox_drafts WHERE id = ?', rowId!)[0]!.gmailDraftId);
    return { rowId: rowId!, gmailDraftId };
  }

  it('marks a sent draft sent_by_owner, a deleted one discarded, and keeps a present one', async () => {
    const { h, run } = await setup();
    const sent = await drafted(h, run, 'a1');
    const gone = await drafted(h, run, 'a2');
    const kept = await drafted(h, run, 'a3');
    const box = h.google.fake.mailbox('personal');
    box.drafts.delete(sent.gmailDraftId);
    box.drafts.delete(gone.gmailDraftId);
    // the owner sent the draft from gmail, with the lines wrapped another way and a quote below.
    h.google.fake.deliver('personal', {
      id: 's1',
      threadId: 't-a1',
      labelIds: ['SENT'],
      internalDate: String(Date.parse('2026-10-13T18:00:00Z')),
      body: `${REPLY.replace(/\n/g, '\r\n  ')} (a1)\r\n\r\nOn Tue, Sam wrote:\r\n> Hi`,
      headers: { From: 'personal@example.com', To: 'sam@school.example', Subject: 'Re: Meeting this week' },
    });
    // a sent mail in the other thread with other text does not count.
    h.google.fake.deliver('personal', {
      id: 's2',
      threadId: 't-a2',
      labelIds: ['SENT'],
      internalDate: String(Date.parse('2026-10-13T18:00:00Z')),
      body: 'Sorry, I cannot make it.',
      headers: { From: 'personal@example.com', To: 'sam@school.example', Subject: 'Re: Meeting this week' },
    });
    h.google.now.value = new Date('2026-10-14T16:00:00Z');
    await checkDrafts(h.ctx, run);
    const rows = h.rows('SELECT id, state, checkedAt FROM inbox_drafts ORDER BY id');
    expect(rows).toEqual([
      { id: sent.rowId, state: 'sent_by_owner', checkedAt: '2026-10-14T16:00:00.000Z' },
      { id: gone.rowId, state: 'discarded', checkedAt: '2026-10-14T16:00:00.000Z' },
      { id: kept.rowId, state: 'drafted', checkedAt: '2026-10-14T16:00:00.000Z' },
    ]);
    noSend(h);
  });

  it('leaves a row as it is when the check fails', async () => {
    const { h, run } = await setup();
    const one = await drafted(h, run, 'b1');
    h.google.fake.fault({ route: `GET /gmail/v1/users/me/drafts/${one.gmailDraftId}`, status: 500, times: 10 });
    await checkDrafts(h.ctx, run);
    expect(h.rows('SELECT state, checkedAt FROM inbox_drafts')).toEqual([{ state: 'drafted', checkedAt: null }]);
  });
});
