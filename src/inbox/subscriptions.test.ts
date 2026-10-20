import { afterEach, describe, expect, it } from 'vitest';
import { createInboxHarness, hostileMail, type InboxHarness } from '../../test/inbox-harness.js';
import type { FakeMessage } from '../../test/fake-google.js';
import { fakeResponse, toolStep, type FakeStep } from '../models/fake.js';
import { ModelError } from '../models/types.js';
import { settleApprovals } from './actions.js';
import { PARSER_VERSION } from './receipts.js';
import { cadenceOf, ignoreSubscription, merchantKeyOf, RECEIPT_QUERY, requestCancel, trustedCancelUrl } from './subscriptions.js';
import { listSubscriptions } from './views.js';

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
    expect(merchantKeyOf('Notes, PBC')).toBe('notes');
    expect(merchantKeyOf('Acme Corp.')).toBe('acme');
    expect(merchantKeyOf('...')).toBe('');
  });

  it('cuts a company suffix only when it is a word of its own', () => {
    expect(merchantKeyOf('Zinc')).toBe('zinc');
    expect(merchantKeyOf('Z Inc')).toBe('z');
    expect(merchantKeyOf('Healthinc')).not.toBe(merchantKeyOf('Health'));
    expect(merchantKeyOf('Acme LLC')).toBe('acme');
  });
});

describe('one purchase', () => {
  let h: InboxHarness;
  afterEach(async () => h?.close());

  it('does not list one purchase with two mails as a subscription', async () => {
    expect(cadenceOf(['2026-10-01T10:00:00Z', '2026-10-01T10:05:00Z']).confidence).toBeLessThan(0.5);
    expect(cadenceOf(['2026-10-01T10:00:00Z', '2026-10-04T10:00:00Z']).confidence).toBeLessThan(0.5);
    h = await createInboxHarness({ accounts: ['personal'] });
    h.google.fake.search = (_a, q, messages) => (q === RECEIPT_QUERY ? messages : []);
    const mail = (id: string, date: string, subject: string): FakeMessage => ({ id, labelIds: ['INBOX'], internalDate: String(Date.parse(date)), snippet: subject, body: 'Your order of a lamp: $40.00', headers: { From: 'Shop <orders@shop.example>', Subject: subject, Date: new Date(date).toUTCString() } });
    h.google.fake.deliver('personal', mail('o1', '2026-10-01T10:00:00Z', 'Your order'));
    h.google.fake.deliver('personal', mail('o2', '2026-10-01T10:05:00Z', 'Payment received'));
    const charge = (id: number) => ({ id, merchant: 'Shop', amount: 40, currency: 'USD', recurring: false, cancelUrl: null });
    h.script.push(toolStep({ id: 'c1', name: 'record_charges', input: { items: [charge(1), charge(2)] } }));
    await h.run('subscriptions');
    expect(h.rows('SELECT * FROM inbox_subscriptions')).toEqual([]);
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
    expect(trustedCancelUrl('https://streamco.example/c', text, 'billing@streamco.example')).toBe('https://streamco.example/c');
    expect(trustedCancelUrl('https://help.streamco.example/c', text, 'billing@streamco.example')).toBe('https://help.streamco.example/c');
    // a parent of the from domain can be another organisation: a public suffix, or a platform that hosts the sender.
    expect(trustedCancelUrl('https://streamco.example/c', text, from)).toBeNull();
    expect(trustedCancelUrl('https://co.uk/c', 'https://co.uk/c', 'billing@shop.co.uk')).toBeNull();
    expect(trustedCancelUrl('https://platform.example/c', 'https://platform.example/c', 'a@x.platform.example')).toBeNull();
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
      // the receipts and the gaps agree on a monthly plan, but the oldest charge is in another currency than its text.
      cadenceSource: 'both',
      confidence: 0.4,
      cancelUrl: CANCEL,
      state: 'active',
      runId: result.runId,
    });
    expect(JSON.parse(String(rows[0]!.reasons))).toEqual(['3 charges about a month apart', 'the receipts state a monthly plan', '1 of 3 amounts are not in their receipts', 'the charges are in 2 currencies']);
    expect(JSON.parse(String(rows[0]!.sourceMessageIds))).toEqual(['r3', 'r2', 'r1']);
    const facts = { merchantKey: 'streamco', recurring: 1, parser: PARSER_VERSION, kind: 'charge', statedCadence: 'monthly', senderDomain: 'streamco.example' };
    expect(h.rows('SELECT messageId, merchantKey, chargedAt, recurring, parser, kind, statedCadence, senderDomain, currency, amountInText FROM inbox_receipts ORDER BY messageId')).toEqual([
      { messageId: 'r1', chargedAt: '2026-08-10T12:00:00.000Z', ...facts, currency: 'EUR', amountInText: 0 },
      { messageId: 'r2', chargedAt: '2026-09-10T12:00:00.000Z', ...facts, currency: 'USD', amountInText: 1 },
      { messageId: 'r3', chargedAt: '2026-10-10T12:00:00.000Z', ...facts, currency: 'USD', amountInText: 1 },
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
    expect(h.rows('SELECT messageId, merchantKey, merchant, amount, subject, kind, parser FROM inbox_receipts ORDER BY messageId')).toEqual([
      { messageId: 'n1', merchantKey: null, merchant: null, amount: null, subject: 'Our new subscription box', kind: 'charge', parser: PARSER_VERSION },
      { messageId: 'o1', merchantKey: 'shop', merchant: 'Shop', amount: 40, subject: 'Your order', kind: 'order', parser: PARSER_VERSION },
    ]);
  });

  it('keeps a renewal with one charge, and makes no row for a renewal of zero', async () => {
    await setup();
    h.google.fake.deliver('personal', receipt('y1', '2026-10-05T12:00:00Z', { from: 'Cloud <billing@cloud.example>', subject: 'Your yearly plan renewed', body: 'Paid 0.00 EUR' }));
    h.google.fake.deliver('personal', receipt('y2', '2026-10-06T12:00:00Z', { from: 'Drive <billing@drive.example>', subject: 'Your plan renewed', body: 'Paid 24.00 EUR. Your plan renews on October 6, 2027.' }));
    h.script.push(
      step([
        { id: 1, merchant: 'Drive', amount: 24, currency: 'EUR', chargedAt: '2026-10-06', recurring: true, cancelUrl: null },
        { id: 2, merchant: 'Cloud', amount: 0, currency: 'EUR', chargedAt: '2026-10-05', recurring: true, cancelUrl: null },
      ]),
    );
    await h.run('subscriptions');
    expect(h.rows('SELECT merchant, amount, currency, cadence, cadenceSource, confidence, lastChargeAt, reasons FROM inbox_subscriptions')).toEqual([
      { merchant: 'Drive', amount: 24, currency: 'EUR', cadence: 'unknown', cadenceSource: 'none', confidence: 0.5, lastChargeAt: '2026-10-06T00:00:00.000Z', reasons: JSON.stringify(['one charge so far', 'the receipt says that the plan renews']) },
    ]);
    expect(h.rows("SELECT kind FROM inbox_receipts WHERE messageId = 'y1'")).toEqual([{ kind: 'other' }]);
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

  it('makes a cancelled row active again when a charge came after the cancellation', async () => {
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
      { state: 'active', error: 'a charge came after the cancellation', lastChargeAt: '2026-11-10T12:00:00.000Z', updatedAt: '2026-11-11T00:00:00.000Z' },
    ]);
  });

  it('keeps a cancelled row cancelled when no charge came after the cancellation', async () => {
    await setup();
    deliverMonthly();
    h.script.push(step([charge(1), charge(2), charge(3)]));
    await h.run('subscriptions');
    h.google.db.prepare("UPDATE inbox_subscriptions SET state = 'cancelled', updatedAt = '2026-11-12T00:00:00.000Z'").run();
    h.google.fake.deliver('personal', receipt('r4', '2026-11-10T12:00:00Z'));
    h.google.now.value = new Date('2026-11-13T00:00:00Z');
    h.script.push(step([charge(1)]));
    await h.run('subscriptions');
    expect(h.rows('SELECT state, error, updatedAt FROM inbox_subscriptions')).toEqual([{ state: 'cancelled', error: null, updatedAt: '2026-11-12T00:00:00.000Z' }]);
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
    // the mail is a bill that is due, not a payment, so the code makes it an order whatever the model says.
    expect(h.rows('SELECT merchant, amount, cancelUrl, kind FROM inbox_receipts')).toEqual([{ merchant: 'pay-now', amount: 499, cancelUrl: null, kind: 'order' }]);
    expect(h.rows('SELECT * FROM inbox_subscriptions')).toEqual([]);
    expect(h.rows('SELECT * FROM approvals')).toEqual([]);
    expect(h.rows('SELECT * FROM tool_calls')).toEqual([]);
    expect(h.agentRuns).toEqual([]);
    expect(h.sent).toEqual([]);
    expect(h.google.fake.sent).toEqual([]);
  });
});

// receipts as much real mail sends them: html only, with the amounts in table cells and the cancel link behind a label.
describe('scanSubscriptions with html receipts', () => {
  let h: InboxHarness;
  afterEach(async () => h?.close());

  const STREAMLY_CANCEL = 'https://streamly.example/account/cancel';
  const htmlReceipt = (id: string, date: string, options: { amount?: string; html?: string; subject?: string; from?: string } = {}): FakeMessage => ({
    id,
    labelIds: ['INBOX'],
    internalDate: String(Date.parse(date)),
    snippet: 'receipt',
    html:
      options.html ??
      `<table><tr><td>Premium plan</td><td>${options.amount ?? '$15.49'}/month</td></tr><tr><td><b>Total charged</b></td><td><b>${options.amount ?? '$15.49'}</b></td></tr></table><p><a href="${STREAMLY_CANCEL}">Manage or cancel</a></p>`,
    headers: { From: options.from ?? 'Streamly <billing@streamly.example>', Subject: options.subject ?? 'Your Streamly receipt', Date: new Date(date).toUTCString() },
  });
  const months = ['2026-07-03T10:00:00Z', '2026-08-03T10:00:00Z', '2026-09-03T10:00:00Z', '2026-10-03T10:00:00Z'];
  // the model gives a wrong amount for the newest receipt and no currency for any. the code takes the one total of
  // the text and its currency.
  const streamly = (id: number, extra: Record<string, unknown> = {}) => ({ id, merchant: 'Streamly', amount: 15.49, recurring: true, cancelUrl: STREAMLY_CANCEL, ...extra });

  async function setup() {
    h = await createInboxHarness({ accounts: ['personal'] });
    h.google.fake.search = (_alias, q, messages) => (q === RECEIPT_QUERY ? messages : []);
    return h;
  }

  it('reads amount, currency and cadence of a monthly plan from html receipts', async () => {
    await setup();
    months.forEach((date, index) => h.google.fake.deliver('personal', htmlReceipt(`s${index}`, date)));
    h.script.push(step([streamly(1, { amount: 15 }), streamly(2), streamly(3), streamly(4)]));
    await h.run('subscriptions');
    const rows = h.rows('SELECT merchant, merchantKey, amount, currency, cadence, cadenceSource, confidence, reasons, cancelUrl, nextChargeAt FROM inbox_subscriptions');
    expect(rows).toEqual([
      {
        merchant: 'Streamly',
        merchantKey: 'streamly',
        amount: 15.49,
        currency: 'USD',
        cadence: 'monthly',
        cadenceSource: 'both',
        confidence: 0.9,
        reasons: JSON.stringify(['4 charges about a month apart', 'the receipts state a monthly plan']),
        // the link stands behind its label in the html, and mailText writes it into the text, so the check finds it.
        cancelUrl: STREAMLY_CANCEL,
        nextChargeAt: '2026-11-03T10:00:00.000Z',
      },
    ]);
    expect(h.rows('SELECT amount, currency, amountInText FROM inbox_receipts GROUP BY amount, currency, amountInText')).toEqual([{ amount: 15.49, currency: 'USD', amountInText: 1 }]);
    expect(JSON.stringify(h.modelCalls[0]!.messages)).toContain(`<${STREAMLY_CANCEL}>`);
  });

  it('never makes a row from refunds or orders, whatever the model says', async () => {
    await setup();
    months.forEach((date, index) => h.google.fake.deliver('personal', htmlReceipt(`f${index}`, date, { subject: 'Your refund was issued', html: '<p>We have issued a refund of <b>$15.49</b> to your card.</p>' })));
    h.google.fake.deliver('personal', htmlReceipt('o1', '2026-10-10T10:00:00Z', { subject: 'Your order has shipped', html: '<p>Order total: $23.80</p><p>Track package</p>' }));
    h.script.push(step([streamly(1, { kind: 'charge' }), streamly(2), streamly(3), streamly(4), streamly(5, { kind: 'charge' })]));
    await h.run('subscriptions');
    expect(h.rows('SELECT * FROM inbox_subscriptions')).toEqual([]);
    expect(h.rows('SELECT kind, count(*) AS n FROM inbox_receipts GROUP BY kind ORDER BY kind')).toEqual([
      { kind: 'order', n: 1 },
      { kind: 'refund', n: 4 },
    ]);
  });

  // the first scan of a large account reads hundreds of receipts, so it reads them one batch at a time. a read that
  // fails keeps the batches that were saved, and the next scan reads the rest.
  it('reads the receipts one batch at a time and keeps what it saved when a read fails', async () => {
    await setup();
    const days = Array.from({ length: 12 }, (_, index) => new Date(Date.UTC(2025, 10 + index, 3, 10)).toISOString());
    days.forEach((date, index) => h.google.fake.deliver('personal', htmlReceipt(`m${String(index).padStart(2, '0')}`, date)));
    // the list is newest first, so the second batch starts with m01.
    h.google.fake.fault({ route: 'GET /gmail/v1/users/me/messages/m01', status: 400, times: 10 });
    h.script.push(step(Array.from({ length: 10 }, (_, index) => streamly(index + 1))));
    const first = await h.run('subscriptions');
    expect(first.status).toBe('completed');
    expect(first.error).toContain('1 subscriptions from 10 new receipts');
    expect(first.error).toContain('personal: some receipts could not be read, so they wait for the next scan');
    expect(h.rows('SELECT count(*) AS n FROM inbox_receipts')).toEqual([{ n: 10 }]);
    h.google.fake.clearFaults();
    h.script.push(step([streamly(1), streamly(2)]));
    const second = await h.run('subscriptions');
    expect(second.error).toBe('1 subscriptions from 2 new receipts');
    expect(h.rows('SELECT confidence, cadenceSource FROM inbox_subscriptions')).toEqual([{ confidence: 0.95, cadenceSource: 'both' }]);
  });

  it('keeps a cancel link of an html receipt only on the sender domain', async () => {
    await setup();
    const manage = 'https://help.streamly.example/cancel?id=1&x=2';
    const html = '<p>Paid <b>$5.00</b> per month.</p><p><a href="https://evil.example/cancel">Cancel</a> or <a href="https://help.streamly.example/cancel?id=1&amp;x=2">manage</a></p>';
    h.google.fake.deliver('personal', htmlReceipt('c1', '2026-09-03T10:00:00Z', { html }));
    h.google.fake.deliver('personal', htmlReceipt('c2', '2026-10-03T10:00:00Z', { html }));
    // item 1 is c2, the newest.
    h.script.push(step([streamly(1, { amount: 5, cancelUrl: manage }), streamly(2, { amount: 5, cancelUrl: 'https://evil.example/cancel' })]));
    await h.run('subscriptions');
    expect(h.rows('SELECT messageId, cancelUrl FROM inbox_receipts ORDER BY messageId')).toEqual([
      { messageId: 'c1', cancelUrl: null },
      { messageId: 'c2', cancelUrl: manage },
    ]);
    expect(h.rows('SELECT cancelUrl, cadence, cadenceSource, confidence FROM inbox_subscriptions')).toEqual([{ cancelUrl: manage, cadence: 'monthly', cadenceSource: 'both', confidence: 0.7 }]);
  });

  // a row of phase 5 has parser 0 and no kind. the next scan reads its mail again and replaces it, so a fix of the
  // reading also fixes the old rows.
  it('reads a receipt of phase 5 again and replaces its row', async () => {
    await setup();
    months.forEach((date, index) => h.google.fake.deliver('personal', htmlReceipt(`s${index}`, date)));
    const old = h.ctx.db.prepare(
      "INSERT INTO inbox_receipts (account, messageId, merchantKey, merchant, amount, currency, chargedAt, recurring, subject, readAt) VALUES ('personal', ?, 'streamly', 'Streamly', 99, 'USD', ?, 1, 'Your Streamly receipt', '2026-10-04T00:00:00.000Z')",
    );
    months.forEach((date, index) => old.run(`s${index}`, new Date(date).toISOString()));
    h.ctx.db
      .prepare(
        "INSERT INTO inbox_subscriptions (account, merchantKey, merchant, amount, currency, cadence, sourceMessageId, confidence, updatedAt) VALUES ('personal', 'streamly', 'Streamly', 99, 'USD', 'monthly', 's3', 0.8, '2026-10-04T00:00:00.000Z')",
      )
      .run();
    h.script.push(step([streamly(1), streamly(2), streamly(3), streamly(4)]));
    await h.run('subscriptions');
    expect(h.modelCalls).toHaveLength(1);
    expect(h.rows('SELECT DISTINCT parser, kind, amount, amountInText, statedCadence, senderDomain FROM inbox_receipts')).toEqual([
      { parser: PARSER_VERSION, kind: 'charge', amount: 15.49, amountInText: 1, statedCadence: 'monthly', senderDomain: 'streamly.example' },
    ]);
    expect(h.rows('SELECT id, amount, cadenceSource, confidence FROM inbox_subscriptions')).toEqual([{ id: 1, amount: 15.49, cadenceSource: 'both', confidence: 0.9 }]);
    // the rows are current now, so the next scan reads nothing again.
    await h.run('subscriptions');
    expect(h.modelCalls).toHaveLength(1);
  });

  // a model step that names the sender of each item as its merchant, for a scan of more receipts than one batch.
  const bySender = (): FakeStep => async (call) => {
    const text = JSON.stringify(call.messages);
    const items = [...text.matchAll(/item (\d+):\\nFrom: ([^<\\]+) </g)].map((match) => ({ id: Number(match[1]), merchant: match[2]!.trim(), amount: 9.99, currency: 'USD', recurring: true, cancelUrl: null }));
    return fakeResponse({ toolCalls: [{ id: `c-${Math.random()}`, name: 'record_charges', input: { items } }] });
  };

  it('keeps the state of a row the owner acted on, and gives a stale active row confidence 0', async () => {
    await setup();
    const insertSubscription = h.ctx.db.prepare(
      `INSERT INTO inbox_subscriptions (account, merchantKey, merchant, amount, currency, cadence, sourceMessageId, confidence, state, approvalId, updatedAt, cadenceSource, reasons)
       VALUES ('personal', ?, ?, 9.99, 'USD', 'monthly', ?, 0.8, ?, ?, '2026-10-01T00:00:00.000Z', 'gaps', '[]')`,
    );
    const insertReceipt = h.ctx.db.prepare(
      "INSERT INTO inbox_receipts (account, messageId, merchantKey, merchant, amount, currency, chargedAt, recurring, subject, readAt) VALUES ('personal', ?, ?, ?, 9.99, 'USD', ?, 1, 'Receipt', '2026-10-04T00:00:00.000Z')",
    );
    const merchants = [
      { key: 'kept', name: 'Kept', state: 'active', approvalId: null },
      { key: 'hidden', name: 'Hidden', state: 'ignored', approvalId: null },
      { key: 'gone', name: 'Gone', state: 'cancelled', approvalId: null },
      { key: 'asked', name: 'Asked', state: 'cancel_pending', approvalId: 7 },
      { key: 'stale', name: 'Stale', state: 'active', approvalId: null },
    ];
    // each merchant had a row and three receipts of phase 5. read again, only the receipts of the kept merchant are
    // charges. the others are refunds, so their merchants have no charge left.
    for (const { key, name, state, approvalId } of merchants) {
      insertSubscription.run(key, name, `${key}3`, state, approvalId);
      months.slice(1).forEach((date, index) => {
        const id = `${key}${index + 1}`;
        insertReceipt.run(id, key, name, new Date(date).toISOString());
        const from = `${name} <billing@${key}.example>`;
        h.google.fake.deliver(
          'personal',
          key === 'kept'
            ? htmlReceipt(id, date, { amount: '$9.99', from, subject: 'Your Kept receipt' })
            : htmlReceipt(id, date, { from, subject: 'Your refund was issued', html: '<p>We have issued a refund of $9.99.</p>' }),
        );
      });
    }
    h.script.push(bySender(), bySender());
    await h.run('subscriptions');
    expect(h.modelCalls).toHaveLength(2);
    const rows = h.rows('SELECT merchantKey, state, approvalId, cadence, cadenceSource, confidence, reasons FROM inbox_subscriptions ORDER BY id');
    expect(rows).toEqual([
      { merchantKey: 'kept', state: 'active', approvalId: null, cadence: 'monthly', cadenceSource: 'both', confidence: 0.8, reasons: JSON.stringify(['3 charges about a month apart', 'the receipts state a monthly plan']) },
      { merchantKey: 'hidden', state: 'ignored', approvalId: null, cadence: 'monthly', cadenceSource: 'gaps', confidence: 0.8, reasons: '[]' },
      { merchantKey: 'gone', state: 'cancelled', approvalId: null, cadence: 'monthly', cadenceSource: 'gaps', confidence: 0.8, reasons: '[]' },
      { merchantKey: 'asked', state: 'cancel_pending', approvalId: 7, cadence: 'monthly', cadenceSource: 'gaps', confidence: 0.8, reasons: '[]' },
      { merchantKey: 'stale', state: 'active', approvalId: null, cadence: 'unknown', cadenceSource: 'none', confidence: 0, reasons: JSON.stringify(['the new reading found no repeating charge']) },
    ]);
    // the stale row is kept, so the owner still sees it, and the totals leave it out.
    expect(listSubscriptions(h.ctx.db, {}).monthlyTotals).toEqual([{ currency: 'USD', amount: 19.98 }]);
    // a second scan leaves the stale row as it is.
    const before = h.rows("SELECT updatedAt FROM inbox_subscriptions WHERE merchantKey = 'stale'");
    h.google.now.value = new Date(h.google.now.value.getTime() + 60_000);
    await h.run('subscriptions');
    expect(h.rows("SELECT updatedAt FROM inbox_subscriptions WHERE merchantKey = 'stale'")).toEqual(before);
  });

  it('counts an order mail and its payment mail of one day as one charge, and splits one name on two domains', async () => {
    await setup();
    // a receipt of phase 6 from another sender of the same name already exists.
    h.ctx.db
      .prepare(
        "INSERT INTO inbox_receipts (account, messageId, merchantKey, merchant, amount, currency, chargedAt, recurring, subject, readAt, parser, senderDomain, kind) VALUES ('personal', 'other', 'streamly', 'Streamly', 3, 'USD', '2026-06-01T00:00:00.000Z', 0, 'Receipt', '2026-06-01T00:00:00.000Z', ?, 'streamly-games.example', 'charge')",
      )
      .run(PARSER_VERSION);
    months.forEach((date, index) => h.google.fake.deliver('personal', htmlReceipt(`s${index}`, date)));
    h.google.fake.deliver('personal', htmlReceipt('order', '2026-10-03T09:00:00Z', { subject: 'Thanks for your order', html: '<p>Thanks for your order. You paid <b>$15.49</b>.</p>' }));
    h.script.push(step([streamly(1), streamly(2), streamly(3), streamly(4), streamly(5)]));
    await h.run('subscriptions');
    expect(h.rows('SELECT merchantKey, cadence, confidence, sourceMessageIds FROM inbox_subscriptions')).toEqual([
      { merchantKey: 'streamly@streamly.example', cadence: 'monthly', confidence: 0.9, sourceMessageIds: JSON.stringify(['s3', 'order', 's2', 's1', 's0']) },
    ]);
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
    expect(payload.text).toContain('The owner approved the link in the block below.');
    expect(payload.text).toContain('Help the owner cancel the paid plan of the merchant in the block below.');
    // the merchant and the link come from mail, so they are in the untrusted block.
    expect(payload.text).toContain(`<untrusted source="gmail:personal">\nmerchant: Stream Co.\nlink: ${CANCEL}\n</untrusted>`);
    const row = h.rows('SELECT state, helpSessionKey FROM inbox_subscriptions')[0]!;
    expect(row).toEqual({ state: 'cancelled', helpSessionKey: h.agentRuns[0]!.sessionKey });
    expect(await requestCancel(h.ctx, id)).toEqual({ ok: false, status: 409, error: 'this subscription is cancelled' });
    expect(h.google.fake.sent).toEqual([]);
  });

  // a help run that reached a login wall tells the owner with message_owner and completes with no approval. the row is
  // cancelled then, and the next charge shows that it was not, so the owner can ask again.
  it('lets the owner ask again when a charge came after a help run that could not cancel', async () => {
    const id = await withSubscription();
    await requestCancel(h.ctx, id);
    await h.approve(1);
    await h.ctx.queue.drain();
    expect(h.agentRuns).toHaveLength(1);
    expect(h.rows('SELECT state FROM inbox_subscriptions')).toEqual([{ state: 'cancelled' }]);
    expect(await requestCancel(h.ctx, id)).toEqual({ ok: false, status: 409, error: 'this subscription is cancelled' });
    h.google.fake.deliver('personal', receipt('r3', '2026-11-10T12:00:00Z'));
    h.google.now.value = new Date('2026-11-11T00:00:00Z');
    h.script.push(step([charge(1)]));
    await h.run('subscriptions');
    expect(h.rows('SELECT state, error, approvalId, helpSessionKey FROM inbox_subscriptions')).toEqual([
      { state: 'active', error: 'a charge came after the cancellation', approvalId: null, helpSessionKey: null },
    ]);
    expect(await requestCancel(h.ctx, id)).toMatchObject({ ok: true, response: { status: 'pending_approval', approvalId: 2 } });
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
    // the refusal gives the row back, so the owner can ask again with the row as it is now.
    expect(h.rows('SELECT state FROM inbox_subscriptions')).toEqual([{ state: 'active' }]);
  });

  it('lets the owner ask again after a scan changed the row while the approval waited', async () => {
    h = await createInboxHarness({ accounts: ['personal'] });
    h.google.fake.search = (_a, q, messages) => (q === RECEIPT_QUERY ? messages : []);
    const mail = (id: string, date: string): FakeMessage => ({ id, labelIds: ['INBOX'], internalDate: String(Date.parse(date)), snippet: 'receipt', body: 'Paid $9.99. Renews monthly.', headers: { From: 'Stream <billing@streamco.example>', Subject: 'Receipt', Date: new Date(date).toUTCString() } });
    h.google.fake.deliver('personal', mail('r1', '2026-08-10T12:00:00Z'));
    h.google.fake.deliver('personal', mail('r2', '2026-09-10T12:00:00Z'));
    const charge = (id: number, merchant = 'Stream') => ({ id, merchant, amount: 9.99, currency: 'USD', recurring: true, cancelUrl: null });
    h.script.push(toolStep({ id: 'c1', name: 'record_charges', input: { items: [charge(1), charge(2)] } }));
    await h.run('subscriptions');
    expect(await requestCancel(h.ctx, 1)).toMatchObject({ ok: true, response: { approvalId: 1 } });
    h.google.fake.deliver('personal', mail('r3', '2026-10-10T12:00:00Z'));
    h.script.push(toolStep({ id: 'c2', name: 'record_charges', input: { items: [charge(1, 'Stream.')] } }));
    await h.run('subscriptions');
    await h.approve(1);
    await h.ctx.queue.drain();
    expect(h.agentRuns).toEqual([]);
    expect(await requestCancel(h.ctx, 1)).toMatchObject({ ok: true, response: { status: 'pending_approval', approvalId: 2 } });
  });

  it('keeps the row pending while the help run works, and gives it back when the run fails', async () => {
    let finish: (status: 'completed' | 'failed') => void = () => {};
    h = await createInboxHarness({
      accounts: ['personal'],
      agent: (input) => new Promise((resolve) => (finish = (status) => resolve({ runId: input.runId!, status, text: '', ...(status === 'failed' ? { error: 'the page did not load' } : {}) }))),
    });
    h.google.fake.search = (_alias, q, messages) => (q === RECEIPT_QUERY ? messages : []);
    h.google.fake.deliver('personal', receipt('r1', '2026-09-10T12:00:00Z'));
    h.google.fake.deliver('personal', receipt('r2', '2026-10-10T12:00:00Z'));
    h.script.push(step([charge(1), charge(2)]));
    await h.run('subscriptions');
    const id = Number(h.rows('SELECT id FROM inbox_subscriptions')[0]!.id);
    await requestCancel(h.ctx, id);
    await h.approve(1);
    // the help run starts on the queue of its session.
    for (let tries = 0; tries < 20 && !h.agentRuns.length; tries++) await new Promise((resolve) => setImmediate(resolve));
    expect(h.agentRuns).toHaveLength(1);
    expect(h.rows('SELECT state FROM inbox_subscriptions')).toEqual([{ state: 'cancel_pending' }]);
    expect(await requestCancel(h.ctx, id)).toEqual({ ok: false, status: 409, error: 'a browser task works on the cancellation of this subscription' });
    finish('failed');
    await h.ctx.queue.drain();
    expect(h.rows('SELECT state, error FROM inbox_subscriptions')).toEqual([{ state: 'active', error: 'the browser help run ended as failed: the page did not load' }]);
    expect(await requestCancel(h.ctx, id)).toMatchObject({ ok: true, response: { approvalId: 2 } });
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
