import { afterEach, describe, expect, it } from 'vitest';
import { createGoogleHarness, type GoogleHarness } from '../../test/google-harness.js';
import { createInboxHarness, listMail, type InboxHarness } from '../../test/inbox-harness.js';
import type { FakeMessage } from '../../test/fake-google.js';
import { openDb } from '../db/index.js';
import { getSetting } from '../db/settings.js';
import { toolStep } from '../models/fake.js';
import { createAutomation } from '../scheduler/store.js';
import { cadenceOf, merchantKeyOf } from './cadence.js';
import { classifyMail, mailboxOf } from './classify.js';
import { checkDue, findDates } from './deadlines.js';
import { independentKindOf, statesDay } from './eval/independent.js';
import { getMessages, readError, setGmailPaceForTests } from './gmail.js';
import { inboxAutomation, installInboxJobs } from './inbox.js';
import { htmlToText } from './mailtext.js';
import { SWEEP_QUERY } from './newsletters.js';
import { amountsIn, judgeSubscription, merchantOf, receiptKindOf, registrableDomain, type ChargeFact } from './receipts.js';
import { MOVED, moveDigestBeforeBrief, OLD_DIGEST_EXPR } from './schedule.js';
import { registrableDomain as senderDomain, senderIdentityOf } from './senders.js';
import { RECEIPT_QUERY } from './subscriptions.js';
import { mailMessage } from './testdata/build.js';
import { listSubscriptions } from './views.js';

// the cases that the owner's real mail and the review of the inbox track found: each one broke a job on real mail, or
// would have.

const TZ = 'America/Los_Angeles';

describe('the due date check on real mail', () => {
  it('drops "due Oct 2" when the mail says "due Oct 24"', () => {
    expect(checkDue({ dueAt: '2026-10-02', dueText: 'due Oct 2', text: 'Subject: hw\n\nHomework is due Oct 24.', sentAt: '2026-10-01T16:00:00Z', timeZone: TZ }).ok).toBe(false);
    expect(checkDue({ dueAt: '2026-12-03', dueText: 'by Dec 3', text: 'Subject: x\n\nPay by Dec 31.', sentAt: '2026-11-01T16:00:00Z', timeZone: TZ }).ok).toBe(false);
    expect(checkDue({ dueAt: '2026-10-02', dueText: 'due 10/2', text: 'Subject: x\n\nForms due 10/24.', sentAt: '2026-10-01T16:00:00Z', timeZone: TZ }).ok).toBe(false);
    // the whole words still pass.
    expect(checkDue({ dueAt: '2026-10-24', dueText: 'due Oct 24', text: 'Subject: hw\n\nHomework is due Oct 24.', sentAt: '2026-10-01T16:00:00Z', timeZone: TZ }).ok).toBe(true);
  });

  it('finds no date in a fraction or a score', () => {
    expect(findDates('Add 1/2 cup of milk', '2026-10-20T16:00:00Z', TZ)).toEqual([]);
    expect(checkDue({ dueAt: '2026-12-20', dueText: 'Score: 20/12', text: 'S: x\n\nScore: 20/12 on the quiz', sentAt: '2026-10-20T16:00:00Z', timeZone: TZ }).ok).toBe(false);
    expect(findDates('Read page 3/4 and go to Room 4/5', '2026-10-20T16:00:00Z', TZ)).toEqual([]);
    // a plain slash date and one with a year still count.
    expect(findDates('Forms are due 10/24.', '2026-10-20T16:00:00Z', TZ).map((each) => each.day)).toEqual(['2026-10-24']);
    expect(findDates('Score sheets due 11/2/2026', '2026-10-20T16:00:00Z', TZ).map((each) => each.day)).toEqual(['2026-11-02']);
  });
});

describe('receipts on real mail', () => {
  it('reads a failed payment as no charge', () => {
    expect(receiptKindOf('Payment failed', 'We could not charge your card for $9.99. Please update your payment method.')).not.toBe('charge');
    expect(receiptKindOf('Your payment was declined', 'Your payment of $9.99 was declined.')).not.toBe('charge');
    // a receipt that only offers to update the card in its footer is still a charge.
    expect(receiptKindOf('Your receipt', 'You paid $9.99.\nTo update your payment method, visit your account.')).toBe('charge');
  });

  it('reads a spaced group and skips a credit in parentheses', () => {
    expect(amountsIn('Total 1 234,56 €').map((each) => each.amount)).toEqual([1234.56]);
    expect(amountsIn('Credit ($5.00)\nTotal $4.99').map((each) => each.amount)).toEqual([4.99]);
    expect(amountsIn('Total 1 234,56 €').map((each) => each.amount)).toEqual([1234.56]);
  });

  it('gives a merchant key to a name that has no latin letter', () => {
    expect(merchantKeyOf('ネットフリックス')).not.toBe('');
    expect(merchantKeyOf('ネットフリックス')).not.toBe(merchantKeyOf('テレビ'));
    expect(merchantOf({ model: '爱奇艺', from: '爱奇艺 <vip@iqiyi.example>', subject: 'Receipt' }).key).not.toBe('');
    // a latin key is the same as before.
    expect(merchantKeyOf('Café Crème, Inc.')).toBe('cafecreme');
  });

  it('reads an order mail and its payment mail twenty minutes apart across utc midnight as one charge', () => {
    expect(cadenceOf(['2026-01-01T23:50:00Z', '2026-01-02T00:10:00Z', '2026-02-01T23:50:00Z', '2026-02-02T00:10:00Z', '2026-03-01T23:50:00Z', '2026-03-02T00:10:00Z']).cadence).toBe('monthly');
  });

  it('gives receipts and newsletters one registrable domain for a sender', () => {
    for (const host of ['shop.com.tw', 'mail.store.edu.au', 'news.brand.co.il', 'mail.shop.co.uk', 'example.com']) expect(registrableDomain(host)).toBe(senderDomain(host));
    expect(registrableDomain('co.uk')).toBeNull();
    expect(registrableDomain('localhost')).toBeNull();
  });

  const fact = (day: string, extra: Partial<ChargeFact> = {}): ChargeFact => ({ chargedAt: `${day}T12:00:00.000Z`, amount: 6.7, currency: 'USD', statedCadence: null, recurring: false, amountInText: true, ...extra });

  it('does not call two same-price purchases a week apart a weekly plan', () => {
    const judged = judgeSubscription([fact('2026-10-01'), fact('2026-10-07')]);
    expect(judged).toMatchObject({ cadence: 'weekly', subscription: false });
    expect(judged.confidence).toBeLessThan(0.5);
    expect(judged.reasons).toContain('only 2 charges, which can be two purchases');
    // a third charge at the same gap is a plan again.
    expect(judgeSubscription([fact('2026-10-01'), fact('2026-10-08'), fact('2026-10-15')]).subscription).toBe(true);
  });

  it('doubts a plan whose next charge is long past', () => {
    const now = new Date('2026-10-20T12:00:00Z');
    const lapsed = judgeSubscription([fact('2025-11-19', { statedCadence: 'monthly', amount: 30 })], now);
    expect(lapsed).toMatchObject({ cadence: 'monthly', subscription: true });
    expect(lapsed.confidence).toBeLessThanOrEqual(0.3);
    expect(lapsed.reasons).toContain('no charge since 2025-11-19, so it may have ended');
    // a plan whose next charge is not due yet keeps its confidence.
    expect(judgeSubscription([fact('2026-10-05', { statedCadence: 'monthly', amount: 30 })], now).confidence).toBe(0.5);
  });

  it('never gives a row that it keeps confidence 0, which marks a stale row', () => {
    const judged = judgeSubscription([fact('2026-08-10', { currency: 'EUR', amountInText: false, amount: 1, statedCadence: 'monthly' }), fact('2026-09-10', { amount: 50, amountInText: false })]);
    expect(judged.subscription).toBe(true);
    expect(judged.confidence).toBeGreaterThan(0);
  });
});

describe('mail text', () => {
  it('keeps the text around a "<" that a space follows', () => {
    expect(htmlToText('<p>Orders < $50 ship for $5 > 3 days</p>').text).toBe('Orders < $50 ship for $5 > 3 days');
    expect(htmlToText('<p>a <b>bold</b> word</p>').text).toBe('a bold word');
  });
});

describe('the owner addresses', () => {
  it('reads owner+tag as the owner', () => {
    const owner = new Set(['owner@example.com']);
    const m = (h: Record<string, string>) => mailMessage({ id: 'x', headers: { Subject: 's', Date: 'Mon, 19 Oct 2026 07:12:00 -0700', ...h }, plain: 'hi' });
    expect(classifyMail(m({ From: 'Sam <sam@friends.example>', To: 'owner+school@example.com' }), owner).direct).toBe(true);
    expect(classifyMail(m({ From: 'Owner <owner+notes@example.com>', To: 'owner@example.com' }), owner).fromOwner).toBe(true);
  });

  it('reads the dots of a gmail address as the same mailbox', () => {
    expect(mailboxOf('A.Owner+x@GoogleMail.com')).toBe('aowner@gmail.com');
    expect(mailboxOf('a.owner@school.example')).toBe('a.owner@school.example');
    const owner = new Set(['aowner@gmail.com']);
    expect(classifyMail(mailMessage({ id: 'x', headers: { From: 'Sam <sam@friends.example>', To: 'a.owner@gmail.com', Subject: 's', Date: 'Mon, 19 Oct 2026 07:12:00 -0700' }, plain: 'hi' }), owner).direct).toBe(true);
  });
});

describe('a discussion list', () => {
  const mail = (headers: Record<string, string>, labels?: string[]) =>
    mailMessage({ id: 'x', headers: { Subject: 'Question about hw 3', Date: 'Mon, 19 Oct 2026 07:12:00 -0700', ...headers }, plain: 'Can someone on staff help?', ...(labels ? { labels } : {}) });
  const staff = { From: 'Student Kim <kim@school.example.edu>', To: 'cs101-staff@school.example.edu', 'List-Id': '<cs101-staff.school.example.edu>', 'List-Unsubscribe': '<mailto:cs101-staff+unsubscribe@school.example.edu>' };

  it('reads a student mail to a staff list as a discussion list mail', () => {
    expect(classifyMail(mail(staff), new Set(['ta@school.example.edu']))).toMatchObject({ kind: 'list', discussion: true, direct: false });
  });

  it('reads bulk list mail as no discussion', () => {
    expect(classifyMail(mail({ ...staff, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' }), new Set()).discussion).toBe(false);
    expect(classifyMail(mail({ ...staff, From: 'Shop <orders@shop.example>' }), new Set()).discussion).toBe(false);
    expect(classifyMail(mail(staff, ['INBOX', 'CATEGORY_PROMOTIONS']), new Set()).discussion).toBe(false);
  });
});

describe('the plain view of the quality check', () => {
  const at = (headers: Record<string, string>, labels?: string[]) => mailMessage({ id: 'x', headers: { Subject: 's', Date: 'Mon, 19 Oct 2026 07:12:00 -0700', ...headers }, plain: 'hi', ...(labels ? { labels } : {}) });

  it('decides a kind without classifyMail', () => {
    const contacts = new Set([mailboxOf('sam@friends.example')]);
    const owner = new Set(['owner@example.com']);
    expect(independentKindOf(at({ From: 'Sam <sam@friends.example>' }, ['INBOX', 'CATEGORY_UPDATES']), contacts, owner)).toBe('person');
    expect(independentKindOf(at({ From: 'GitHub <notifications@github.com>' }), contacts, owner)).toBe('automated');
    expect(independentKindOf(at({ From: 'Google <no-reply@accounts.google.com>' }), contacts, owner)).toBe('automated');
    expect(independentKindOf(at({ From: 'Club <club@groups.example>' }, ['INBOX', 'CATEGORY_FORUMS']), contacts, owner)).toBe('list');
    expect(independentKindOf(at({ From: 'Lee <lee@else.example>' }), contacts, owner)).toBeNull();
  });

  it('finds a day in its plain forms, and not a day inside a longer number', () => {
    const sent = '2026-10-19T16:00:00Z';
    expect(statesDay('due Oct 24', '2026-10-24', sent, TZ)).toBe(true);
    expect(statesDay('due October 24th', '2026-10-24', sent, TZ)).toBe(true);
    expect(statesDay('forms due 10/24', '2026-10-24', sent, TZ)).toBe(true);
    expect(statesDay('due Oct 24', '2026-10-02', sent, TZ)).toBe(false);
    expect(statesDay('due 10/24', '2026-10-02', sent, TZ)).toBe(false);
    expect(statesDay('by Friday', '2026-10-23', sent, TZ)).toBe(true);
    expect(statesDay('by tomorrow', '2026-10-20', sent, TZ)).toBe(true);
    expect(statesDay('by tomorrow', '2026-10-21', sent, TZ)).toBe(false);
  });
});

describe('the pace of the gmail reads', () => {
  let h: GoogleHarness | undefined;
  afterEach(async () => {
    setGmailPaceForTests({ sleep: async () => {} });
    await h?.close();
    h = undefined;
  });

  const plain = (id: string): FakeMessage => ({ id, labelIds: ['INBOX'], internalDate: String(Date.parse('2026-10-10T12:00:00Z')), snippet: 'hi', body: 'hi', headers: { From: 'Sam <sam@friends.example>', Subject: 'hi', Date: 'Sat, 10 Oct 2026 12:00:00 GMT' } });
  const rate = { status: 403, body: { error: { code: 403, message: "Quota exceeded for quota metric 'Queries' and limit 'Queries per minute per user' of service 'gmail.googleapis.com' for consumer 'project_number:123456'.", errors: [{ reason: 'rateLimitExceeded' }] } } };

  it('reads a message again after google limits the rate', async () => {
    const waits: number[] = [];
    h = await createGoogleHarness({ accounts: ['personal'] });
    h.signedIn('personal');
    setGmailPaceForTests({ burst: 1e9, sleep: async (ms) => void waits.push(ms) });
    h.fake.deliver('personal', plain('m1'));
    h.fake.fault({ route: 'GET /gmail/v1/users/me/messages/m1', ...rate, times: 4 });
    const messages = await h.accounts.run('personal', (apis) => getMessages(apis, ['m1'], { format: 'full' }));
    expect(messages.map((each) => each.id)).toEqual(['m1']);
    // the client gets a new token after a 403 and tries once more itself, so each wait follows two refusals.
    expect(waits).toEqual([30_000, 60_000]);
  });

  it('throws after the last wait, and says why without the text of google', async () => {
    h = await createGoogleHarness({ accounts: ['personal'] });
    h.signedIn('personal');
    setGmailPaceForTests({ burst: 1e9, waits: [1, 2], sleep: async () => {} });
    h.fake.deliver('personal', plain('m1'));
    h.fake.fault({ route: 'GET /gmail/v1/users/me/messages/m1', ...rate, times: 10 });
    const error = await h.accounts.run('personal', (apis) => getMessages(apis, ['m1'], { format: 'full' })).catch((err: unknown) => err);
    expect(readError(error)).toBe('google limited the rate of reads, status 403');
    expect(readError(error)).not.toContain('project_number');
  });

  it('keeps the reads of one account under the limit of gmail', async () => {
    let now = 0;
    const waits: number[] = [];
    h = await createGoogleHarness({ accounts: ['personal'] });
    h.signedIn('personal');
    setGmailPaceForTests({
      now: () => now,
      sleep: async (ms) => {
        waits.push(ms);
        now += ms;
      },
    });
    const ids = Array.from({ length: 60 }, (_, index) => `m${index}`);
    for (const id of ids) h.fake.deliver('personal', plain(id));
    const messages = await h.accounts.run('personal', (apis) => getMessages(apis, ids, { format: 'metadata', headers: ['From'] }));
    expect(messages).toHaveLength(60);
    // 20 start at once, and the other 40 at 2 a second.
    expect(now).toBeGreaterThanOrEqual(19_000);
    expect(now).toBeLessThanOrEqual(21_000);
  });

  it('stops the waits when the job is aborted', async () => {
    h = await createGoogleHarness({ accounts: ['personal'] });
    h.signedIn('personal');
    setGmailPaceForTests({ burst: 1e9, sleep: (ms, signal) => new Promise((resolve, reject) => (signal?.aborted ? reject(new Error('aborted')) : setTimeout(resolve, 1))) });
    h.fake.deliver('personal', plain('m1'));
    h.fake.fault({ route: 'GET /gmail/v1/users/me/messages/m1', ...rate, times: 10 });
    const stop = new AbortController();
    stop.abort();
    await expect(h.accounts.run('personal', (apis) => getMessages(apis, ['m1'], { format: 'full', signal: stop.signal }))).rejects.toThrow();
  });
});

describe('the newsletter sweep on real lists', () => {
  let h: InboxHarness | undefined;
  afterEach(async () => {
    await h?.close();
    h = undefined;
  });

  const senders = () => h!.rows('SELECT id, senderKey, messages, archived, firstAt FROM inbox_senders ORDER BY id');

  it('keeps the row of phase 5 on a list of its own domain when one member writes from another domain', async () => {
    h = await createInboxHarness({ accounts: ['personal'] });
    h.google.fake.search = (_alias, q, messages) => (q === SWEEP_QUERY ? messages : []);
    const key = 'staff.school.example';
    const row = h.ctx.db
      .prepare(
        `INSERT INTO inbox_senders (account, senderKey, listId, fromAddress, displayName, firstAt, lastAt, state, archived, updatedAt)
         VALUES ('personal', ?, ?, 'head@school.example', 'Staff', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z', 'active', 4, '2026-08-01T00:00:00.000Z') RETURNING id`,
      )
      .get(key, key)!;
    const list = `Staff <${key}>`;
    h.google.fake.deliver('personal', listMail('s1', { from: 'Head <head@school.example>', listId: list }));
    h.google.fake.deliver('personal', listMail('s2', { from: 'Aide <aide@school.example>', listId: list }));
    h.google.fake.deliver('personal', listMail('s3', { from: 'Member <member@othermail.example>', listId: list }));
    await h.run('newsletters');
    expect(senders()).toEqual([
      { id: Number(row.id), senderKey: key, messages: 2, archived: 4, firstAt: '2026-08-01T00:00:00.000Z' },
      { id: expect.any(Number), senderKey: `${key}#othermail.example`, messages: 1, archived: 0, firstAt: expect.any(String) },
    ]);
  });

  it('gives one row to a group that takes its own unsubscribe, with the name of the list', () => {
    const post = (from: string) =>
      senderIdentityOf(
        mailMessage({
          id: 'g',
          headers: {
            From: from,
            Subject: 'x',
            Date: 'Mon, 19 Oct 2026 07:12:00 -0700',
            'List-Id': 'current <current.club.school.example.edu>',
            'List-Unsubscribe': '<mailto:current+unsubscribe@club.school.example.edu>',
          },
          plain: 'hi',
        }),
      )!;
    const a = post("'Sam Lee' via current <sam@mail.example>");
    const b = post("'Ari Kim' via current <ari@startup.example>");
    expect(a.senderKey).toBe('current.club.school.example.edu');
    expect(b.senderKey).toBe(a.senderKey);
    expect(a.displayName).toBe('current');
  });
});

describe('the subscriptions on real receipts', () => {
  let h: InboxHarness | undefined;
  afterEach(async () => {
    await h?.close();
    h = undefined;
  });

  const receipt = (id: string, date: string, body: string): FakeMessage => ({
    id,
    labelIds: ['INBOX'],
    internalDate: String(Date.parse(date)),
    snippet: 'Your receipt',
    body,
    headers: { From: 'Stream Co <billing@streamco.example>', Subject: 'Your Stream Co receipt', Date: new Date(date).toUTCString() },
  });

  it('keeps the amount of the newest receipt that states one, and leaves doubtful rows out of the totals', async () => {
    h = await createInboxHarness({ accounts: ['personal'] });
    h.google.fake.search = (_alias, q, messages) => (q === RECEIPT_QUERY ? messages : []);
    h.google.now.value = new Date('2026-10-13T16:00:00Z');
    h.google.fake.deliver('personal', receipt('r1', '2026-07-10T12:00:00Z', 'Thanks for your payment of $100.00. Your plan renews every month.'));
    h.google.fake.deliver('personal', receipt('r2', '2026-08-10T12:00:00Z', 'Thanks for your payment of $100.00. Your plan renews every month.'));
    h.google.fake.deliver('personal', receipt('r3', '2026-09-10T12:00:00Z', 'Thanks for your payment of $92.27. Your plan renews every month.'));
    h.google.fake.deliver('personal', receipt('r4', '2026-10-10T12:00:00Z', 'Thanks for your payment. Your plan renews every month.'));
    const charge = (id: number, amount: number | null) => ({ id, merchant: 'Stream Co', amount, currency: amount === null ? null : 'USD', recurring: true, cancelUrl: null });
    // the list is newest first, so the model reads r4 first.
    h.script.push(toolStep({ id: 'c1', name: 'record_charges', input: { items: [charge(1, null), charge(2, 92.27), charge(3, 100), charge(4, 100)] } }));
    await h.run('subscriptions');
    const rows = h.rows('SELECT amount, currency, sourceMessageId, confidence FROM inbox_subscriptions');
    expect(rows).toEqual([{ amount: 92.27, currency: 'USD', sourceMessageId: 'r4', confidence: expect.any(Number) }]);
    const page = listSubscriptions(h.ctx.db, {});
    expect(page.monthlyTotals).toEqual(Number(rows[0]!.confidence) >= 0.5 ? [{ currency: 'USD', amount: 92.27 }] : []);
  });
});

describe('the move of the digest', () => {
  it('logs a failed move and tries again on the next start, without stopping the start', () => {
    const db = openDb(':memory:');
    const now = new Date('2026-10-13T16:00:00Z');
    const created = createAutomation(db, { name: 'inbox: daily digest', schedule: { kind: 'cron', expr: OLD_DIGEST_EXPR, tz: TZ }, payload: { type: 'inbox', job: 'digest' }, slot: 'utility', createdBy: 'system' }, now, TZ);
    expect(created.ok).toBe(true);
    const warnings: string[] = [];
    const logger = { warn: (text: string) => void warnings.push(text) };
    // a trigger makes the update of the automation fail, as a full disk or a broken row would.
    db.exec("CREATE TRIGGER no_move BEFORE UPDATE ON automations BEGIN SELECT RAISE(ABORT, 'the disk is full'); END");
    expect(moveDigestBeforeBrief(db, { timeZone: TZ }, now, logger)).toBe(false);
    expect(getSetting(db, MOVED)).toBeFalsy();
    expect(() => installInboxJobs(db, { timeZone: TZ }, now, logger)).not.toThrow();
    expect(warnings.length).toBeGreaterThan(0);
    db.exec('DROP TRIGGER no_move');
    expect(moveDigestBeforeBrief(db, { timeZone: TZ }, now, logger)).toBe(true);
    expect(inboxAutomation(db, 'digest')!.schedule).toMatchObject({ expr: '0 7 * * *' });
    db.close();
  });
});
