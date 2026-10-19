import type { gmail_v1 } from '@googleapis/gmail';
import { afterEach, describe, expect, it } from 'vitest';
import { createInboxHarness, hostileMail, listMail, type InboxHarness } from '../../test/inbox-harness.js';
import type { FakeMessage } from '../../test/fake-google.js';
import type { OneClickResult } from '../google/unsubscribe.js';
import { settleApprovals } from './actions.js';
import { ARCHIVE_TOOL, keepSender, requestArchive, requestUnsubscribe, senderOf, SWEEP_QUERY, UNSUBSCRIBE_TOOL, unsubscribeOf } from './newsletters.js';

// a message as gmail gives it, with only the headers that a test names.
const message = (headers: Record<string, string>): gmail_v1.Schema$Message => ({ id: 'm', payload: { headers: Object.entries(headers).map(([name, value]) => ({ name, value })) } });

// the fake does not parse gmail search syntax, so this answers the sweep and the archive queries of this module.
function answerSearch(h: InboxHarness) {
  h.google.fake.search = (_alias, q, messages) => {
    if (q === SWEEP_QUERY) return messages;
    if (!q.startsWith('in:inbox')) return [];
    const older = /older_than:(\d+)d/.exec(q);
    const list = /list:(\S+)/.exec(q);
    const from = /from:(\S+)/.exec(q);
    const cutoff = older ? h.google.now.value.getTime() - Number(older[1]) * 86_400_000 : Infinity;
    return messages.filter(
      (each) =>
        (each.labelIds ?? ['INBOX']).includes('INBOX') &&
        Number(each.internalDate) < cutoff &&
        (!list || (each.headers['List-Id'] ?? '').toLowerCase().includes(list[1]!)) &&
        // gmail matches a from: search loosely, so the fake does too.
        (!from || (each.headers.From ?? '').toLowerCase().includes(from[1]!)),
    );
  };
}

describe('senderOf', () => {
  it('keys a list mail by its List-Id and a mail without one by its From address', () => {
    expect(senderOf(message({ From: '"Shop, Inc." <News@Shop.Example>', 'List-Id': '  Shop News   <  News.Shop.EXAMPLE >' }))).toEqual({
      senderKey: 'news.shop.example',
      listId: 'news.shop.example',
      fromAddress: 'news@shop.example',
      displayName: 'Shop, Inc.',
    });
    expect(senderOf(message({ From: 'club@club.example', 'List-Unsubscribe': '<https://club.example/u>' }))).toEqual({
      senderKey: 'club@club.example',
      listId: null,
      fromAddress: 'club@club.example',
      displayName: null,
    });
    // without a name in From, the phrase of the List-Id names the sender. a List-Id without brackets is the id.
    expect(senderOf(message({ From: '<a@list.example>', 'List-Id': '"Weekly Tips" <tips.list.example>' }))?.displayName).toBe('Weekly Tips');
    expect(senderOf(message({ From: 'a@list.example', 'List-Id': ' Tips.List.Example ' }))?.listId).toBe('tips.list.example');
  });

  it('skips mail that is not list mail, has no From, or names two mailboxes', () => {
    expect(senderOf(message({ From: 'friend@example.com' }))).toBeUndefined();
    expect(senderOf(message({ 'List-Id': '<a.example>' }))).toBeUndefined();
    expect(senderOf(message({ From: '"bank@x.example" <a@evil.example>, <b@evil.example>', 'List-Id': '<a.example>' }))).toBeUndefined();
  });
});

describe('unsubscribeOf', () => {
  it('finds one-click, https, mailto and none', () => {
    const both = '<mailto:u@shop.example>, <https://shop.example/u/1>';
    expect(unsubscribeOf(message({ 'List-Unsubscribe': both, 'List-Unsubscribe-Post': 'list-unsubscribe=one-click' }))).toEqual({ method: 'one_click', url: 'https://shop.example/u/1' });
    expect(unsubscribeOf(message({ 'List-Unsubscribe': both }))).toEqual({ method: 'https', url: 'https://shop.example/u/1' });
    expect(unsubscribeOf(message({ 'List-Unsubscribe': '<mailto:u@shop.example>, <http://shop.example/u>', 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' }))).toEqual({
      method: 'mailto',
      url: 'mailto:u@shop.example',
    });
    expect(unsubscribeOf(message({ 'List-Unsubscribe': '<http://shop.example/u>' }))).toEqual({ method: 'none', url: null });
    expect(unsubscribeOf(message({}))).toEqual({ method: 'none', url: null });
  });
});

describe('the newsletter sweep', () => {
  let h: InboxHarness;
  afterEach(async () => h?.close());

  const sender = (account: string, senderKey: string) => h.rows('SELECT * FROM inbox_senders WHERE account = ? AND senderKey = ?', account, senderKey)[0]!;

  it('groups the list mail of two accounts and counts what the owner read', async () => {
    h = await createInboxHarness();
    answerSearch(h);
    h.google.fake.deliver('personal', listMail('p1', { date: '2026-09-01T10:00:00Z' }));
    h.google.fake.deliver('personal', listMail('p2', { date: '2026-10-01T10:00:00Z', unread: true }));
    h.google.fake.deliver('personal', listMail('p3', { date: '2026-10-10T10:00:00Z', from: '"Shop News" <news@shop.example>' }));
    h.google.fake.deliver('personal', { id: 'p4', headers: { From: 'friend@example.com', Subject: 'hi' } });
    h.google.fake.deliver('school', listMail('s1', { from: 'Club <club@club.example>', listId: '', unread: true, oneClick: false }));
    const result = await h.run('newsletters');
    expect(result).toMatchObject({ status: 'completed', error: '2 senders in personal, school' });
    expect(sender('personal', 'news.shop.example')).toMatchObject({
      listId: 'news.shop.example',
      fromAddress: 'news@shop.example',
      displayName: 'Shop News',
      messages: 3,
      read: 2,
      firstAt: '2026-09-01T10:00:00.000Z',
      lastAt: '2026-10-10T10:00:00.000Z',
      unsubscribeMethod: 'one_click',
      unsubscribeUrl: 'https://shop.example/u/p3',
      unsubscribeMessageId: 'p3',
      state: 'active',
      runId: result.runId,
    });
    expect(sender('school', 'club@club.example')).toMatchObject({ listId: null, messages: 1, read: 0, unsubscribeMethod: 'https', unsubscribeUrl: 'https://club.example/u/s1' });
    expect(h.rows('SELECT COUNT(*) AS n FROM inbox_senders')[0]!.n).toBe(2);
    expect(h.modelCalls).toEqual([]);
    expect(h.rows('SELECT * FROM approvals')).toEqual([]);
    // the sweep read and changed nothing but the list and the metadata.
    expect(h.google.fake.requests.filter((each) => each.method !== 'GET' && each.path !== '/token')).toEqual([]);
  });

  it('counts a message once in a second sweep and updates what the owner read', async () => {
    h = await createInboxHarness({ accounts: ['personal'] });
    answerSearch(h);
    h.google.fake.deliver('personal', listMail('p1', { unread: true }));
    h.google.fake.deliver('personal', listMail('p2', { unread: true }));
    await h.run('newsletters');
    expect(sender('personal', 'news.shop.example')).toMatchObject({ messages: 2, read: 0 });
    h.google.fake.mailbox('personal').messages.get('p1')!.labelIds = ['INBOX'];
    await h.run('newsletters');
    expect(sender('personal', 'news.shop.example')).toMatchObject({ messages: 2, read: 1 });
    expect(h.rows("SELECT messageId, unread, inInbox FROM inbox_sender_messages ORDER BY messageId")).toEqual([
      { messageId: 'p1', unread: 0, inInbox: 1 },
      { messageId: 'p2', unread: 1, inInbox: 1 },
    ]);
  });

  it('leaves a kept sender out', async () => {
    h = await createInboxHarness({ accounts: ['personal'] });
    answerSearch(h);
    h.google.fake.deliver('personal', listMail('p1'));
    await h.run('newsletters');
    const { id, updatedAt } = sender('personal', 'news.shop.example');
    expect(keepSender(h.ctx, Number(id))).toEqual({ ok: true, response: { status: 'done', approvalId: null, message: 'news.shop.example is kept and leaves the later sweeps.' } });
    h.google.now.value = new Date('2026-10-14T16:00:00Z');
    h.google.fake.deliver('personal', listMail('p2'));
    await h.run('newsletters');
    expect(sender('personal', 'news.shop.example')).toMatchObject({ state: 'kept', messages: 1, updatedAt });
    expect(h.rows("SELECT messageId FROM inbox_sender_messages")).toEqual([{ messageId: 'p1' }]);
  });

  it('notes an account that is not signed in', async () => {
    h = await createInboxHarness();
    answerSearch(h);
    h.google.db.prepare("UPDATE google_accounts SET status = 'signed_out' WHERE alias = 'school'").run();
    h.google.fake.deliver('personal', listMail('p1'));
    const result = await h.run('newsletters');
    expect(result.status).toBe('completed');
    expect(result.error).toMatch(/^school: the school google account is not signed in yet/);
    expect(h.rows('SELECT account FROM inbox_senders')).toEqual([{ account: 'personal' }]);
  });

  it('fails the job when every account fails, and notes one account that fails', async () => {
    h = await createInboxHarness();
    answerSearch(h);
    h.google.fake.deliver('school', listMail('s1'));
    h.google.fake.fault({ route: 'GET /gmail/v1/users/me/messages', status: 400, times: 1 });
    const one = await h.run('newsletters');
    expect(one.status).toBe('completed');
    expect(one.error).toMatch(/^personal: /);
    expect(h.rows('SELECT account FROM inbox_senders')).toEqual([{ account: 'school' }]);
    h.google.fake.fault({ route: 'GET /gmail/v1/users/me/messages', status: 400 });
    const all = await h.run('newsletters');
    expect(all.status).toBe('failed');
    expect(all.error).toMatch(/^the newsletters job stopped: personal: .*; school: /);
    expect(h.modelCalls).toEqual([]);
  });
});

describe('the unsubscribe action', () => {
  let h: InboxHarness;
  afterEach(async () => h?.close());

  async function setup(options: { oneClick?: (target: string) => Promise<OneClickResult>; mail?: FakeMessage[] } = {}) {
    h = await createInboxHarness({ accounts: ['personal'], ...(options.oneClick ? { oneClick: options.oneClick } : {}) });
    answerSearch(h);
    for (const each of options.mail ?? [listMail('p1')]) h.google.fake.deliver('personal', each);
    await h.run('newsletters');
  }
  const row = (id = 1) => h.rows('SELECT * FROM inbox_senders WHERE id = ?', id)[0]!;

  it('asks for approval, and the approved call posts the one-click once', async () => {
    await setup();
    const result = await requestUnsubscribe(h.ctx, 1);
    expect(result).toMatchObject({ ok: true, response: { status: 'pending_approval', approvalId: 1 } });
    expect(result.ok && 'runId' in result.response).toBe(false);
    expect(h.rows('SELECT toolName, status FROM approvals')).toEqual([{ toolName: UNSUBSCRIBE_TOOL, status: 'pending' }]);
    expect(row()).toMatchObject({ state: 'unsubscribe_pending', approvalId: 1 });
    expect(h.oneClicks).toEqual([]);
    expect(h.sent.at(-1)!.text).toContain('Approval needed (#1)');
    await h.approve(1);
    expect(h.oneClicks).toEqual(['https://shop.example/u/p1']);
    expect(row()).toMatchObject({ state: 'unsubscribed', unsubscribedAt: h.google.now.value.toISOString(), error: null });
    expect(await requestUnsubscribe(h.ctx, 1)).toEqual({ ok: false, status: 409, error: 'this sender is already unsubscribed' });
  });

  it('refuses a pending, unknown, mailto or link-less sender', async () => {
    await setup({
      mail: [
        listMail('p1'),
        listMail('m1', { from: 'Mail <m@mail.example>', unsubscribe: '<mailto:stop@mail.example>' }),
        listMail('n1', { from: 'None <n@none.example>', unsubscribe: '<http://none.example/u>' }),
      ],
    });
    const id = (key: string) => Number(h.rows('SELECT id FROM inbox_senders WHERE senderKey = ?', key)[0]!.id);
    const [first, second] = await Promise.all([requestUnsubscribe(h.ctx, id('news.shop.example')), requestUnsubscribe(h.ctx, id('news.shop.example'))]);
    expect(first).toMatchObject({ ok: true });
    expect(second).toMatchObject({ ok: false, status: 409 });
    expect(await requestUnsubscribe(h.ctx, id('news.shop.example'))).toEqual({ ok: false, status: 409, error: 'the unsubscribe of this sender waits for approval #1' });
    expect(await requestUnsubscribe(h.ctx, 999)).toEqual({ ok: false, status: 404, error: 'sender not found' });
    expect(await requestUnsubscribe(h.ctx, id('news.mail.example'))).toMatchObject({ ok: false, status: 409, error: expect.stringContaining('ok computer never sends mail') });
    expect(await requestUnsubscribe(h.ctx, id('news.none.example'))).toEqual({ ok: false, status: 409, error: 'this sender offers no unsubscribe link' });
    expect(h.rows('SELECT COUNT(*) AS n FROM approvals')[0]!.n).toBe(1);
    expect(keepSender(h.ctx, id('news.shop.example'))).toMatchObject({ ok: false, status: 409 });
  });

  it('gives the row back after a denied or expired approval, so the owner can ask again', async () => {
    await setup();
    await requestUnsubscribe(h.ctx, 1);
    await h.deny(1);
    settleApprovals(h.ctx.db, h.ctx.clock());
    expect(row()).toMatchObject({ state: 'active' });
    expect(await requestUnsubscribe(h.ctx, 1)).toMatchObject({ ok: true, response: { approvalId: 2 } });
    h.google.db.prepare("UPDATE approvals SET status = 'expired' WHERE id = 2").run();
    expect(await requestUnsubscribe(h.ctx, 1)).toMatchObject({ ok: true, response: { approvalId: 3 } });
    expect(row()).toMatchObject({ state: 'unsubscribe_pending', approvalId: 3 });
    expect(h.oneClicks).toEqual([]);
  });

  it('keeps the row pending when the post did not leave', async () => {
    await setup({ oneClick: async () => ({ ok: false, sent: false, text: 'the connection was refused' }) });
    await requestUnsubscribe(h.ctx, 1);
    const reply = await h.approve(1);
    expect(reply).toContain('waits again');
    // effect none marks the call as one that did not leave.
    expect(h.rows('SELECT outcome FROM tool_calls WHERE name = ? ORDER BY rowid DESC LIMIT 1', UNSUBSCRIBE_TOOL)).toEqual([{ outcome: 'unsent' }]);
    expect(row()).toMatchObject({ state: 'unsubscribe_pending', error: 'the connection was refused' });
    expect(h.rows('SELECT status FROM approvals')).toEqual([{ status: 'pending' }]);
  });

  it('marks the row failed when the sender answers with an error', async () => {
    await setup({ oneClick: async () => ({ ok: false, sent: true, status: 500, text: 'the sender answered 500' }) });
    await requestUnsubscribe(h.ctx, 1);
    await h.approve(1);
    expect(row()).toMatchObject({ state: 'failed', error: 'the sender answered 500' });
  });

  it('starts one browser help run for an https link', async () => {
    await setup({ mail: [listMail('p1', { oneClick: false })] });
    expect(row()).toMatchObject({ unsubscribeMethod: 'https' });
    await requestUnsubscribe(h.ctx, 1);
    expect(h.agentRuns).toEqual([]);
    const reply = await h.approve(1);
    expect(reply).toContain('a browser task now helps');
    await h.ctx.queue.drain();
    expect(h.agentRuns).toHaveLength(1);
    expect(h.agentRuns[0]!.sessionKey).toMatch(/^auto:inbox:/);
    const text = (h.agentRuns[0]!.events[0]!.payload as { text: string }).text;
    expect(text).toContain('The owner approved the link in the block below.');
    expect(text).toContain('<untrusted source="gmail:personal">\nlist: news.shop.example\nlink: https://shop.example/u/p1\n</untrusted>');
    expect(h.oneClicks).toEqual([]);
    expect(row()).toMatchObject({ state: 'unsubscribed', helpSessionKey: h.agentRuns[0]!.sessionKey, unsubscribedAt: expect.any(String) });
  });

  it('keeps the sender pending while the help run works, and gives it back when the owner denies its form', async () => {
    let finish: () => void = () => {};
    h = await createInboxHarness({ accounts: ['personal'], agent: (input) => new Promise((resolve) => (finish = () => resolve({ runId: input.runId!, status: 'completed', text: '' }))) });
    answerSearch(h);
    h.google.fake.deliver('personal', listMail('p1', { oneClick: false }));
    await h.run('newsletters');
    await requestUnsubscribe(h.ctx, 1);
    await h.approve(1);
    for (let tries = 0; tries < 20 && !h.agentRuns.length; tries++) await new Promise((resolve) => setImmediate(resolve));
    expect(row()).toMatchObject({ state: 'unsubscribe_pending', unsubscribedAt: null });
    expect(await requestUnsubscribe(h.ctx, 1)).toEqual({ ok: false, status: 409, error: 'a browser task works on the unsubscribe of this sender' });
    // the help run asked the owner to send a form, and the owner said no.
    const help = h.agentRuns[0]!;
    h.ctx.db.prepare("INSERT INTO runs (id, sessionKey, trigger, slot, status, startedAt) VALUES (?, ?, 'automation', 'main', 'running', ?)").run(help.runId!, help.sessionKey, h.ctx.clock().toISOString());
    h.ctx.db
      .prepare("INSERT INTO approvals (runId, toolName, input, summary, status, requestedAt) VALUES (?, 'browser_submit', '{}', 'send the form', 'denied', ?)")
      .run(help.runId!, h.ctx.clock().toISOString());
    finish();
    await h.ctx.queue.drain();
    expect(row()).toMatchObject({ state: 'active', error: 'the owner did not approve a step of the browser help run' });
    expect(await requestUnsubscribe(h.ctx, 1)).toMatchObject({ ok: true, response: { approvalId: 3 } });
  });

  it('lets the owner ask again after a sweep changed the link while the approval waited', async () => {
    h = await createInboxHarness({ accounts: ['personal'] });
    h.google.fake.search = (_a, q, messages) => (q === SWEEP_QUERY ? messages : []);
    h.google.fake.deliver('personal', listMail('p1', { date: '2026-10-10T12:00:00Z' }));
    await h.run('newsletters');
    expect(await requestUnsubscribe(h.ctx, 1)).toMatchObject({ ok: true, response: { approvalId: 1 } });
    h.google.fake.deliver('personal', listMail('p2', { date: '2026-10-12T12:00:00Z' }));
    await h.run('newsletters');
    expect(await h.approve(1)).toContain('changed after the owner was asked');
    expect(h.oneClicks).toEqual([]);
    expect(await requestUnsubscribe(h.ctx, 1)).toMatchObject({ ok: true, response: { status: 'pending_approval', approvalId: 2 } });
  });

  it('gives a pending sender back when its approved tool refused', async () => {
    await setup();
    await requestUnsubscribe(h.ctx, 1);
    // a refusal that did not give the row back itself, for example from an older version of the tool.
    h.ctx.db.prepare("UPDATE inbox_senders SET unsubscribeMessageId = NULL WHERE id = 1").run();
    await h.approve(1);
    h.ctx.db.prepare("UPDATE inbox_senders SET state = 'unsubscribe_pending' WHERE id = 1").run();
    settleApprovals(h.ctx.db, h.ctx.clock());
    expect(row()).toMatchObject({ state: 'active' });
  });

  it('marks an unsubscribed sender failed when its mail still comes after 7 days', async () => {
    await setup();
    await requestUnsubscribe(h.ctx, 1);
    await h.approve(1);
    h.google.fake.deliver('personal', listMail('p2', { date: '2026-10-18T00:00:00Z' }));
    await h.run('newsletters');
    expect(row()).toMatchObject({ state: 'unsubscribed' });
    h.google.fake.deliver('personal', listMail('p3', { date: '2026-10-21T00:00:00Z' }));
    h.google.now.value = new Date('2026-10-21T01:00:00Z');
    await h.run('newsletters');
    expect(row()).toMatchObject({ state: 'failed', error: 'mail still comes more than 7 days after the unsubscribe' });
  });
});

describe('the archive and keep actions', () => {
  let h: InboxHarness;
  afterEach(async () => h?.close());

  it('archives the old mail of one sender with a label, and only that sender', async () => {
    h = await createInboxHarness({ accounts: ['personal'] });
    answerSearch(h);
    const deals = (id: string, date: string) => listMail(id, { from: 'Deals <deals@store.example>', listId: '', date });
    h.google.fake.deliver('personal', deals('d1', '2026-08-01T00:00:00Z'));
    h.google.fake.deliver('personal', deals('d2', '2026-08-20T00:00:00Z'));
    h.google.fake.deliver('personal', deals('d3', '2026-10-10T00:00:00Z'));
    // the from: search matches this sender too, but it is another sender.
    h.google.fake.deliver('personal', listMail('x1', { from: 'Other <deals@store.example.org>', listId: '', date: '2026-08-01T00:00:00Z' }));
    await h.run('newsletters');
    const id = Number(h.rows("SELECT id FROM inbox_senders WHERE senderKey = 'deals@store.example'")[0]!.id);
    const result = await requestArchive(h.ctx, id, { olderThanDays: 30, label: 'Newsletters' });
    expect(result).toMatchObject({ ok: true, response: { status: 'pending_approval', approvalId: 1 } });
    expect(h.rows('SELECT toolName FROM approvals')).toEqual([{ toolName: ARCHIVE_TOOL }]);
    expect(await requestArchive(h.ctx, id, { olderThanDays: 30 })).toMatchObject({ ok: false, status: 409 });
    const box = h.google.fake.mailbox('personal');
    expect(box.messages.get('d1')!.labelIds).toContain('INBOX');
    expect(await h.approve(1)).toContain('archived 2 messages of deals@store.example in personal');
    const label = box.labels.find((each) => each.name === 'Newsletters')!;
    expect(box.messages.get('d1')!.labelIds).toEqual(['CATEGORY_PROMOTIONS', label.id]);
    expect(box.messages.get('d2')!.labelIds).not.toContain('INBOX');
    expect(box.messages.get('d3')!.labelIds).toContain('INBOX');
    expect(box.messages.get('x1')!.labelIds).toContain('INBOX');
    expect(h.rows('SELECT archived, label, state FROM inbox_senders WHERE id = ?', id)).toEqual([{ archived: 2, label: 'Newsletters', state: 'active' }]);
    expect(h.rows("SELECT messageId FROM inbox_sender_messages WHERE inInbox = 0 ORDER BY messageId")).toEqual([{ messageId: 'd1' }, { messageId: 'd2' }]);
    // a second archive finds the label, so gmail gets it one time.
    await requestArchive(h.ctx, id, { olderThanDays: 0, label: 'Newsletters' });
    await h.approve(2);
    expect(box.messages.get('d3')!.labelIds).not.toContain('INBOX');
    expect(box.labels.filter((each) => each.name === 'Newsletters')).toHaveLength(1);
    expect(h.google.fake.requests.filter((each) => each.method === 'POST' && each.path.startsWith('/gmail/v1/users/me/labels'))).toHaveLength(1);
    expect(h.rows('SELECT archived FROM inbox_senders WHERE id = ?', id)).toEqual([{ archived: 3 }]);
  });

  it('refuses a system label and an unknown sender', async () => {
    h = await createInboxHarness({ accounts: ['personal'] });
    answerSearch(h);
    h.google.fake.deliver('personal', listMail('p1'));
    await h.run('newsletters');
    for (const label of ['inbox', 'Trash', 'CATEGORY_SOCIAL', 'category_updates']) {
      expect(await requestArchive(h.ctx, 1, { olderThanDays: 30, label })).toMatchObject({ ok: false, status: 409, error: expect.stringContaining('system label') });
    }
    expect(await requestArchive(h.ctx, 9, { olderThanDays: 30 })).toEqual({ ok: false, status: 404, error: 'sender not found' });
    expect(keepSender(h.ctx, 9)).toEqual({ ok: false, status: 404, error: 'sender not found' });
    expect(h.rows('SELECT * FROM approvals')).toEqual([]);
  });

  it('reuses a label that differs only in case', async () => {
    h = await createInboxHarness({ accounts: ['personal'] });
    answerSearch(h);
    h.google.fake.deliver('personal', listMail('p1', { date: '2026-08-01T00:00:00Z' }));
    await h.run('newsletters');
    const box = h.google.fake.mailbox('personal');
    box.labels.push({ id: 'Label_9', name: 'Newsletters' });
    const result = await requestArchive(h.ctx, 1, { olderThanDays: 30, label: 'newsletters' });
    if (!result.ok) throw new Error(result.error);
    await h.approve(result.response.approvalId!);
    expect(h.google.fake.requests.filter((each) => each.method === 'POST' && each.path === '/gmail/v1/users/me/labels')).toEqual([]);
    expect(box.messages.get('p1')!.labelIds).toContain('Label_9');
  });

  it('does not keep an unsubscribed sender', async () => {
    h = await createInboxHarness({ accounts: ['personal'] });
    answerSearch(h);
    h.google.fake.deliver('personal', listMail('p1'));
    await h.run('newsletters');
    await requestUnsubscribe(h.ctx, 1);
    await h.approve(1);
    expect(keepSender(h.ctx, 1)).toEqual({ ok: false, status: 409, error: 'this sender is unsubscribed, so it cannot be kept' });
    expect(h.rows('SELECT state FROM inbox_senders')).toEqual([{ state: 'unsubscribed' }]);
  });
});

describe('a forged https unsubscribe', () => {
  let h: InboxHarness;
  afterEach(async () => h?.close());

  // a mail with the list id and the from address of a real sender, but without its dkim signature, and with a link
  // of the forger without the post header.
  const forged = (id: string, date: string): FakeMessage => {
    const mail = listMail(id, { date, unsubscribe: '<https://evil.example/x>', oneClick: false });
    return { ...mail, headers: { ...mail.headers, 'Authentication-Results': 'mx.google.com; dkim=fail header.i=@shop.example; spf=softfail', 'DKIM-Signature': '' } };
  };

  it('cannot replace the signed link of the sender in a sweep', async () => {
    h = await createInboxHarness({ accounts: ['personal'] });
    answerSearch(h);
    h.google.fake.deliver('personal', listMail('p1', { date: '2026-10-01T00:00:00Z' }));
    h.google.fake.deliver('personal', forged('f1', '2026-10-12T00:00:00Z'));
    await h.run('newsletters');
    expect(h.rows('SELECT unsubscribeMethod, unsubscribeUrl, unsubscribeMessageId FROM inbox_senders')).toEqual([
      { unsubscribeMethod: 'one_click', unsubscribeUrl: 'https://shop.example/u/p1', unsubscribeMessageId: 'p1' },
    ]);
  });

  it('is refused at run time and starts no browser run', async () => {
    h = await createInboxHarness({ accounts: ['personal'] });
    answerSearch(h);
    h.google.fake.deliver('personal', forged('f1', '2026-10-12T00:00:00Z'));
    await h.run('newsletters');
    expect(h.rows('SELECT unsubscribeMethod, unsubscribeUrl FROM inbox_senders')).toEqual([{ unsubscribeMethod: 'https', unsubscribeUrl: 'https://evil.example/x' }]);
    await requestUnsubscribe(h.ctx, 1);
    expect(await h.approve(1)).toContain('dkim');
    await h.ctx.queue.drain();
    expect(h.agentRuns).toEqual([]);
    expect(h.rows('SELECT state, error FROM inbox_senders')).toEqual([{ state: 'failed', error: expect.stringContaining('dkim') }]);
  });
});

describe('a hostile mail', () => {
  let h: InboxHarness;
  afterEach(async () => h?.close());

  it('stays data: the sweep groups it, and its unsubscribe is refused at run time', async () => {
    h = await createInboxHarness({ accounts: ['personal'] });
    answerSearch(h);
    h.google.fake.deliver('personal', hostileMail('h1'));
    const result = await h.run('newsletters');
    expect(result.status).toBe('completed');
    const row = () => h.rows("SELECT * FROM inbox_senders WHERE senderKey = 'billing@pay-now.example'")[0]!;
    expect(row()).toMatchObject({ unsubscribeMethod: 'one_click', unsubscribeUrl: 'https://evil.example/unsub?all=1', state: 'active' });
    expect(h.modelCalls).toEqual([]);
    expect(h.rows('SELECT * FROM approvals')).toEqual([]);
    expect(h.agentRuns).toEqual([]);
    await requestUnsubscribe(h.ctx, Number(row().id));
    expect(h.oneClicks).toEqual([]);
    const reply = await h.approve(1);
    expect(reply).toContain('dkim');
    expect(h.oneClicks).toEqual([]);
    expect(row()).toMatchObject({ state: 'failed', error: expect.stringContaining('dkim') });
    expect(h.google.fake.sent).toEqual([]);
    expect(h.google.fake.requests.filter((each) => /drafts\/send|messages\/send/.test(each.path))).toEqual([]);
  });
});
