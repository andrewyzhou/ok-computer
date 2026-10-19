import { afterEach, describe, expect, it } from 'vitest';
import { createInboxHarness, hostileMail, type InboxHarness } from '../../test/inbox-harness.js';
import type { FakeMessage } from '../../test/fake-google.js';
import { toolStep } from '../models/fake.js';
import { ModelError } from '../models/types.js';
import { settleApprovals } from './actions.js';
import { cadenceOf, ignoreSubscription, merchantKeyOf, RECEIPT_QUERY, requestCancel, trustedCancelUrl } from './subscriptions.js';

const CANCEL = 'https://account.streamco.example/plan/cancel';

// a receipt of a monthly plan. the body holds the link to manage the plan, so the finder can keep it.
function receipt(id: string, date: string, options: { from?: string; subject?: string; body?: string } = {}): FakeMessage {
  return {
    id,
    labelIds: ['INBOX'],
    internalDate: String(Date.parse(date)),
    snippet: 'Your receipt',
    body: options.body ?? `Thanks for your payment of $9.99. Your plan renews every month.\nManage your plan: ${CANCEL}`,
    headers: {
      From: options.from ?? 'Stream Co <billing@streamco.example>',
      Subject: options.subject ?? 'Your Stream Co receipt',
      Date: new Date(date).toUTCString(),
    },
  };
}

// the charge that the scripted model gives for an item. chargedAt is left out, so it is the date of the mail.
const charge = (id: number, extra: Record<string, unknown> = {}) => ({ id, merchant: 'Stream Co.', amount: 9.99, currency: 'USD', recurring: true, cancelUrl: CANCEL, ...extra });
const step = (items: unknown[]) => toolStep({ id: `c-${Math.random()}`, name: 'record_charges', input: { items } });

describe('merchantKeyOf', () => {
  it('gives one key for the spellings of one merchant', () => {
    expect(merchantKeyOf('Stream Co.')).toBe('streamco');
    expect(merchantKeyOf('streamco')).toBe('streamco');
    expect(merchantKeyOf('Café Crème, Inc.')).toBe('cafecreme');
    expect(merchantKeyOf('Acme LLC')).toBe('acme');
    expect(merchantKeyOf('Widgets Ltd')).toBe('widgets');
    expect(merchantKeyOf('...')).toBe('');
  });
});

describe('cadenceOf', () => {
  it('finds a monthly charge and the next one', () => {
    expect(cadenceOf(['2026-10-10T12:00:00.000Z', '2026-08-10T12:00:00.000Z', '2026-09-10T12:00:00.000Z'])).toEqual({
      cadence: 'monthly',
      nextChargeAt: '2026-11-10T12:00:00.000Z',
      confidence: 0.6,
    });
  });

  it('finds a weekly charge', () => {
    const weeks = ['2026-09-01', '2026-09-08', '2026-09-15', '2026-09-22', '2026-09-29'].map((each) => `${each}T00:00:00.000Z`);
    expect(cadenceOf(weeks)).toEqual({ cadence: 'weekly', nextChargeAt: '2026-10-06T00:00:00.000Z', confidence: 0.8 });
  });

  it('finds a yearly and a quarterly charge with calendar months', () => {
    expect(cadenceOf(['2024-02-29T00:00:00.000Z', '2025-02-28T00:00:00.000Z'])).toEqual({ cadence: 'yearly', nextChargeAt: '2026-02-28T00:00:00.000Z', confidence: 0.5 });
    expect(cadenceOf(['2026-01-31T00:00:00.000Z', '2026-04-30T00:00:00.000Z', '2026-07-31T00:00:00.000Z'])).toEqual({
      cadence: 'quarterly',
      nextChargeAt: '2026-10-31T00:00:00.000Z',
      confidence: 0.6,
    });
    expect(cadenceOf(['2026-08-30T00:00:00.000Z', '2026-11-30T00:00:00.000Z']).nextChargeAt).toBe('2027-02-28T00:00:00.000Z');
  });

  it('clamps the day to the end of the month', () => {
    expect(cadenceOf(['2025-12-31T00:00:00.000Z', '2026-01-31T00:00:00.000Z']).nextChargeAt).toBe('2026-02-28T00:00:00.000Z');
    expect(cadenceOf(['2027-12-31T00:00:00.000Z', '2028-01-31T00:00:00.000Z']).nextChargeAt).toBe('2028-02-29T00:00:00.000Z');
  });

  it('gives unknown for one charge and for irregular charges', () => {
    expect(cadenceOf(['2026-10-01T00:00:00.000Z'])).toEqual({ cadence: 'unknown', nextChargeAt: null, confidence: 0.3 });
    expect(cadenceOf([])).toEqual({ cadence: 'unknown', nextChargeAt: null, confidence: 0.3 });
    // gaps of 3, 50 and 200 days: the median is 50, and two gaps are far from it.
    expect(cadenceOf(['2026-01-01T00:00:00Z', '2026-01-04T00:00:00Z', '2026-02-23T00:00:00Z', '2026-09-11T00:00:00Z'])).toEqual({ cadence: 'unknown', nextChargeAt: null, confidence: 0.3 });
  });

  it('caps the confidence and takes some off for a gap far from the median', () => {
    const months = Array.from({ length: 12 }, (_, index) => new Date(Date.UTC(2025, index, 5)).toISOString());
    expect(cadenceOf(months).confidence).toBe(0.95);
    // gaps of 30, 30, 30 and 90 days: monthly, three gaps near the median, one far from it.
    expect(cadenceOf(['2026-01-01T00:00:00Z', '2026-01-31T00:00:00Z', '2026-03-02T00:00:00Z', '2026-04-01T00:00:00Z', '2026-06-30T00:00:00Z'])).toMatchObject({ cadence: 'monthly', confidence: 0.5 });
  });
});

describe('trustedCancelUrl', () => {
  const text = 'links: https://streamco.example/c https://help.streamco.example/c https://evil.example/c http://streamco.example/c https://example/c';
  const from = 'Stream <billing@mail.streamco.example>';
  it('keeps an https link of the mail on the domain of the sender', () => {
    expect(trustedCancelUrl('https://streamco.example/c', text, from)).toBe('https://streamco.example/c');
    expect(trustedCancelUrl('https://help.streamco.example/c', text, 'billing@streamco.example')).toBe('https://help.streamco.example/c');
    expect(trustedCancelUrl('https://evil.example/c', text, from)).toBeNull();
    expect(trustedCancelUrl('http://streamco.example/c', text, from)).toBeNull();
    expect(trustedCancelUrl('https://example/c', text, 'a@example')).toBeNull();
    expect(trustedCancelUrl('https://streamco.example/invented', text, from)).toBeNull();
    expect(trustedCancelUrl(null, text, from)).toBeNull();
  });
});

describe('scanSubscriptions', () => {
  let h: InboxHarness;
  afterEach(async () => h?.close());

  async function setup(accounts = ['personal']) {
    h = await createInboxHarness({ accounts });
    h.google.fake.search = (_alias, q, messages) => (q === RECEIPT_QUERY ? messages : []);
    return h;
  }

  const deliverMonthly = () => {
    h.google.fake.deliver('personal', receipt('r1', '2026-08-10T12:00:00Z'));
    h.google.fake.deliver('personal', receipt('r2', '2026-09-10T12:00:00Z'));
    h.google.fake.deliver('personal', receipt('r3', '2026-10-10T12:00:00Z'));
  };

  it('builds a monthly subscription from three receipts and reads each receipt one time', async () => {
    await setup();
    deliverMonthly();
    // the list is newest first, so item 1 is r3.
    h.script.push(step([charge(1), charge(2), charge(3, { currency: 'EUR' })]));
    const result = await h.run('subscriptions');
    expect(result).toMatchObject({ status: 'completed', error: '1 subscriptions from 3 new receipts' });
    const rows = h.rows('SELECT * FROM inbox_subscriptions');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      account: 'personal',
      merchantKey: 'streamco',
      merchant: 'Stream Co.',
      amount: 9.99,
      currency: 'USD',
      cadence: 'monthly',
      lastChargeAt: '2026-10-10T12:00:00.000Z',
      nextChargeAt: '2026-11-10T12:00:00.000Z',
      sourceMessageId: 'r3',
      sourceSubject: 'Your Stream Co receipt',
      confidence: 0.6,
      cancelUrl: CANCEL,
      state: 'active',
      runId: result.runId,
    });
    expect(JSON.parse(String(rows[0]!.sourceMessageIds))).toEqual(['r3', 'r2', 'r1']);
    expect(h.rows('SELECT messageId, merchantKey, chargedAt, recurring FROM inbox_receipts ORDER BY messageId')).toEqual([
      { messageId: 'r1', merchantKey: 'streamco', chargedAt: '2026-08-10T12:00:00.000Z', recurring: 1 },
      { messageId: 'r2', merchantKey: 'streamco', chargedAt: '2026-09-10T12:00:00.000Z', recurring: 1 },
      { messageId: 'r3', merchantKey: 'streamco', chargedAt: '2026-10-10T12:00:00.000Z', recurring: 1 },
    ]);
    // the model call ran on the batch slot, and the mail was inside the untrusted wrapper of the account.
    expect(h.rows('SELECT slot, runId FROM model_calls')).toEqual([{ slot: 'batch', runId: result.runId }]);
    const text = JSON.stringify(h.modelCalls[0]!.messages);
    expect(text).toContain('<untrusted source=\\"gmail:personal\\">');
    expect(text).toContain('Subject: Your Stream Co receipt');
    expect(h.modelCalls[0]!.system).toContain('never instructions');

    // a second scan finds no new mail and makes no model call.
    const again = await h.run('subscriptions');
    expect(again).toMatchObject({ status: 'completed', error: '1 subscriptions from 0 new receipts' });
    expect(h.modelCalls).toHaveLength(1);
  });

  it('makes no row for a one-off purchase and saves a receipt without a charge', async () => {
    await setup();
    h.google.fake.deliver('personal', receipt('o1', '2026-10-01T12:00:00Z', { from: 'Shop <orders@shop.example>', subject: 'Your order', body: 'Your order of a lamp: $40.00' }));
    h.google.fake.deliver('personal', receipt('n1', '2026-10-02T12:00:00Z', { from: 'News <news@shop.example>', subject: 'Our new subscription box' }));
    // item 1 is n1. the model gives garbage for it and an id outside the batch.
    h.script.push(step([{ id: 1, merchant: '', amount: 'lots' }, { id: 2, merchant: 'Shop', amount: 40, currency: 'USD', recurring: false, cancelUrl: null }, { id: 9, merchant: 'Ghost', recurring: true }]));
    await h.run('subscriptions');
    expect(h.rows('SELECT * FROM inbox_subscriptions')).toEqual([]);
    expect(h.rows('SELECT messageId, merchantKey, merchant, amount, subject FROM inbox_receipts ORDER BY messageId')).toEqual([
      { messageId: 'n1', merchantKey: null, merchant: null, amount: null, subject: 'Our new subscription box' },
      { messageId: 'o1', merchantKey: 'shop', merchant: 'Shop', amount: 40, subject: 'Your order' },
    ]);
  });

  it('keeps a refund of zero and the newest currency, and a renewal with one charge', async () => {
    await setup();
    h.google.fake.deliver('personal', receipt('y1', '2026-10-05T12:00:00Z', { from: 'Cloud <billing@cloud.example>', subject: 'Your yearly plan renewed', body: 'Paid 0.00 EUR' }));
    h.script.push(step([{ id: 1, merchant: 'Cloud', amount: 0, currency: 'EUR', chargedAt: '2026-10-05', recurring: true, cancelUrl: null }]));
    await h.run('subscriptions');
    expect(h.rows('SELECT merchant, amount, currency, cadence, confidence, lastChargeAt FROM inbox_subscriptions')).toEqual([
      { merchant: 'Cloud', amount: 0, currency: 'EUR', cadence: 'unknown', confidence: 0.5, lastChargeAt: '2026-10-05T00:00:00.000Z' },
    ]);
  });

  it('leaves the receipts unread when the model call fails, and reads them on the next scan', async () => {
    await setup();
    deliverMonthly();
    h.script.push(new ModelError('request', 'bad request', 400));
    const failed = await h.run('subscriptions');
    expect(failed.status).toBe('completed');
    expect(failed.error).toContain('a model call failed');
    expect(h.rows('SELECT * FROM inbox_receipts')).toEqual([]);
    expect(h.rows('SELECT * FROM inbox_subscriptions')).toEqual([]);
    h.script.push(step([charge(1), charge(2), charge(3)]));
    await h.run('subscriptions');
    expect(h.rows('SELECT count(*) AS n FROM inbox_receipts')).toEqual([{ n: 3 }]);
  });

  it('skips a deleted message, an old receipt and an account that is not signed in', async () => {
    await setup(['personal', 'school']);
    h.google.db.prepare("UPDATE google_accounts SET status = 'needs_auth' WHERE alias = 'school'").run();
    h.google.fake.deliver('personal', receipt('old', '2025-08-01T12:00:00Z'));
    h.google.fake.deliver('personal', receipt('r1', '2026-10-10T12:00:00Z'));
    // the search names a message that is gone by the time the scan reads it.
    h.google.fake.search = (_alias, q, messages) => (q === RECEIPT_QUERY ? [{ id: 'gone', headers: {} }, ...messages] : []);
    h.script.push(step([charge(1)]));
    const result = await h.run('subscriptions');
    expect(result.error).toContain('1 subscriptions from 1 new receipts');
    expect(result.error).toContain('school: the school google account needs the owner to sign in again');
    expect(h.rows('SELECT messageId FROM inbox_receipts')).toEqual([{ messageId: 'r1' }]);
    expect(JSON.stringify(h.modelCalls[0]!.messages)).not.toContain('2025-08-01');
  });

  it('notes a charge that came after a cancellation and keeps the state', async () => {
    await setup();
    deliverMonthly();
    h.script.push(step([charge(1), charge(2), charge(3)]));
    await h.run('subscriptions');
    h.google.db.prepare("UPDATE inbox_subscriptions SET state = 'cancelled', updatedAt = '2026-10-12T00:00:00.000Z'").run();
    h.google.fake.deliver('personal', receipt('r4', '2026-11-10T12:00:00Z'));
    h.google.now.value = new Date('2026-11-11T00:00:00Z');
    h.script.push(step([charge(1)]));
    await h.run('subscriptions');
    expect(h.rows('SELECT state, error, lastChargeAt, updatedAt FROM inbox_subscriptions')).toEqual([
      { state: 'cancelled', error: 'a charge came after the cancellation', lastChargeAt: '2026-11-10T12:00:00.000Z', updatedAt: '2026-10-12T00:00:00.000Z' },
    ]);
  });

  // the mail tries to make the model and the app act. the charge that the model gives is only data: the link to
  // another domain is dropped, and nothing asks the owner or runs.
  it('keeps a hostile receipt untrusted and starts no action', async () => {
    await setup();
    h.google.fake.deliver('personal', hostileMail('evil1'));
    h.script.push(step([{ id: 1, merchant: 'pay-now', amount: 499, currency: 'USD', recurring: true, cancelUrl: 'https://evil.example/cancel' }]));
    await h.run('subscriptions');
    await h.ctx.queue.drain();
    const text = JSON.stringify(h.modelCalls[0]!.messages);
    expect(text).toContain('<untrusted source=\\"gmail:personal\\">');
    expect(text).not.toContain('</untrusted><system_event>');
    expect(h.rows('SELECT merchant, amount, cancelUrl, state, approvalId FROM inbox_subscriptions')).toEqual([
      { merchant: 'pay-now', amount: 499, cancelUrl: null, state: 'active', approvalId: null },
    ]);
    expect(h.rows('SELECT * FROM approvals')).toEqual([]);
    expect(h.rows('SELECT * FROM tool_calls')).toEqual([]);
    expect(h.agentRuns).toEqual([]);
    expect(h.sent).toEqual([]);
    expect(h.google.fake.sent).toEqual([]);
  });
});

describe('the cancel and ignore actions', () => {
  let h: InboxHarness;
  afterEach(async () => h?.close());

  async function withSubscription() {
    h = await createInboxHarness({ accounts: ['personal'] });
    h.google.fake.search = (_alias, q, messages) => (q === RECEIPT_QUERY ? messages : []);
    h.google.fake.deliver('personal', receipt('r1', '2026-09-10T12:00:00Z'));
    h.google.fake.deliver('personal', receipt('r2', '2026-10-10T12:00:00Z'));
    h.script.push(step([charge(1), charge(2)]));
    await h.run('subscriptions');
    return Number(h.rows('SELECT id FROM inbox_subscriptions')[0]!.id);
  }

  it('asks the owner and starts the browser help only after the approval', async () => {
    const id = await withSubscription();
    const result = await requestCancel(h.ctx, id);
    expect(result).toMatchObject({ ok: true, response: { status: 'pending_approval', approvalId: 1 } });
    expect(result).not.toHaveProperty('runId');
    await h.ctx.queue.drain();
    expect(h.agentRuns).toEqual([]);
    expect(h.rows('SELECT state, approvalId FROM inbox_subscriptions')).toEqual([{ state: 'cancel_pending', approvalId: 1 }]);
    expect(h.sent.at(-1)!.text).toContain('inbox_cancel_subscription');
    expect(await requestCancel(h.ctx, id)).toEqual({ ok: false, status: 409, error: 'the cancellation of this subscription waits for approval #1' });
    expect(ignoreSubscription(h.ctx, id)).toMatchObject({ ok: false, status: 409 });

    await h.approve(1);
    await h.ctx.queue.drain();
    expect(h.agentRuns).toHaveLength(1);
    const payload = h.agentRuns[0]!.events[0]!.payload as { text: string };
    expect(payload.text).toContain(`The owner approved this link: ${CANCEL}`);
    expect(payload.text).toContain('Help the owner cancel the paid plan of Stream Co.');
    const row = h.rows('SELECT state, helpSessionKey FROM inbox_subscriptions')[0]!;
    expect(row).toEqual({ state: 'cancelled', helpSessionKey: h.agentRuns[0]!.sessionKey });
    expect(await requestCancel(h.ctx, id)).toEqual({ ok: false, status: 409, error: 'this subscription is cancelled' });
    expect(h.google.fake.sent).toEqual([]);
  });

  it('gives the row back when the owner denies the cancellation', async () => {
    const id = await withSubscription();
    await requestCancel(h.ctx, id);
    await h.deny(1);
    settleApprovals(h.ctx.db, h.ctx.clock());
    expect(h.rows('SELECT state FROM inbox_subscriptions')).toEqual([{ state: 'active' }]);
    await h.ctx.queue.drain();
    expect(h.agentRuns).toEqual([]);
  });

  it('refuses a cancellation when the row changed after the request', async () => {
    const id = await withSubscription();
    await requestCancel(h.ctx, id);
    h.ctx.db.prepare("UPDATE inbox_subscriptions SET cancelUrl = 'https://streamco.example/other'").run();
    await h.approve(1);
    await h.ctx.queue.drain();
    expect(h.agentRuns).toEqual([]);
    expect(h.rows('SELECT state FROM inbox_subscriptions')).toEqual([{ state: 'cancel_pending' }]);
  });

  it('gives 404 for a missing row and hides a row on ignore', async () => {
    const id = await withSubscription();
    expect(await requestCancel(h.ctx, 999)).toEqual({ ok: false, status: 404, error: 'subscription not found' });
    expect(ignoreSubscription(h.ctx, 999)).toEqual({ ok: false, status: 404, error: 'subscription not found' });
    expect(ignoreSubscription(h.ctx, id)).toEqual({ ok: true, response: { status: 'done', approvalId: null, message: 'the subscription of Stream Co. is hidden' } });
    expect(await requestCancel(h.ctx, id)).toEqual({ ok: false, status: 409, error: 'this subscription is ignored' });
    // a later scan keeps the choice of the owner.
    h.google.fake.deliver('personal', receipt('r3', '2026-11-10T12:00:00Z'));
    h.script.push(step([charge(1)]));
    await h.run('subscriptions');
    expect(h.rows('SELECT state, sourceMessageId FROM inbox_subscriptions')).toEqual([{ state: 'ignored', sourceMessageId: 'r3' }]);
  });
});
