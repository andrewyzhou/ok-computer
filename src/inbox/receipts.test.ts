import { describe, expect, it } from 'vitest';
import { header } from '../google/mime.js';
import { mailText } from './mailtext.js';
import { amountsIn, judgeSubscription, merchantOf, payeeOf, receiptKindOf, registrableDomain, statedCadenceOf, type ChargeFact } from './receipts.js';
import { corpusMessages } from './testdata/corpus.js';
import { receiptMessages } from './testdata/receipts-corpus.js';

const one = (text: string) => amountsIn(text).map(({ amount, currency }) => ({ amount, currency }));

describe('amountsIn', () => {
  it('reads each format of an amount', () => {
    const cases: Array<[string, number, string]> = [
      ['$12.99', 12.99, 'USD'],
      ['USD 12.99', 12.99, 'USD'],
      ['12.99 USD', 12.99, 'USD'],
      ['US$12.99', 12.99, 'USD'],
      ['CA$5.00', 5, 'CAD'],
      ['A$7.50', 7.5, 'AUD'],
      ['€9,99', 9.99, 'EUR'],
      ['9,99 €', 9.99, 'EUR'],
      ['1.234,56 €', 1234.56, 'EUR'],
      ['$1,234.56', 1234.56, 'USD'],
      ['£4.50', 4.5, 'GBP'],
      ['¥1,200', 1200, 'JPY'],
      ['₹499', 499, 'INR'],
      ['$42.00 USD', 42, 'USD'],
      ['$12.00 CAD', 12, 'CAD'],
    ];
    for (const [text, amount, currency] of cases) expect(one(`Paid ${text} today.`), text).toEqual([{ amount, currency }]);
  });

  it('tells a decimal comma from a thousands comma', () => {
    expect(one('1.234,56 € and $1,234.56')).toEqual([
      { amount: 1234.56, currency: 'EUR' },
      { amount: 1234.56, currency: 'USD' },
    ]);
    expect(one('€1.234')).toEqual([{ amount: 1234, currency: 'EUR' }]);
    expect(one('¥1,200 and ¥120')).toEqual([
      { amount: 1200, currency: 'JPY' },
      { amount: 120, currency: 'JPY' },
    ]);
    // a shape that no locale writes is not an amount.
    expect(one('$1,2,3 and $12.345.6')).toEqual([]);
  });

  it('skips numbers without a currency and credits', () => {
    expect(one('Order #113-55 of 3 items on 10.10.2026, 2 left')).toEqual([]);
    expect(one('A credit of -$5.00 and $-5.00 and −€3,00 was applied.')).toEqual([]);
    expect(one('USDT 5 and MUSD 4')).toEqual([]);
    expect(amountsIn('Total charged $15.49')[0]!.text).toBe('$15.49');
  });

  it('marks an amount with a label on its line or on the line before as a total', () => {
    const totals = (text: string) => amountsIn(text).map((each) => [each.amount, each.total]);
    expect(totals('Premium plan $15.49/month\nTotal charged $15.49')).toEqual([
      [15.49, false],
      [15.49, true],
    ]);
    expect(totals('Total:\n$12.99')).toEqual([[12.99, true]]);
    expect(totals('Amount paid\n\n£4.50')).toEqual([[4.5, true]]);
    expect(totals('You paid $9.99')).toEqual([[9.99, true]]);
    expect(totals('Grand total: $20.00')).toEqual([[20, true]]);
    expect(totals('Subtotal $5.00\nTax $0.40')).toEqual([
      [5, false],
      [0.4, false],
    ]);
    // a label counts for the next amount of its line only, and a line before that holds an amount is not a label.
    expect(totals('Total $10.00 Tax $1.00')).toEqual([
      [10, true],
      [1, false],
    ]);
    expect(totals('Total $10.00\n$3.00')).toEqual([
      [10, true],
      [3, false],
    ]);
  });

  it('reads the lines of an html receipt', () => {
    const { message } = corpusMessages().get('monthly plan receipt, html only')!;
    expect(amountsIn(mailText(message).text)).toEqual([
      { amount: 15.49, currency: 'USD', text: '$15.49', total: false },
      { amount: 15.49, currency: 'USD', text: '$15.49', total: true },
    ]);
  });
});

describe('statedCadenceOf', () => {
  it('reads each cadence', () => {
    const cases: Array<[string, string | null]> = [
      ['$9.99 per month', 'monthly'],
      ['$9.99/mo', 'monthly'],
      ['$9.99 / month', 'monthly'],
      ['your monthly plan', 'monthly'],
      ['billed monthly', 'monthly'],
      ['renews every month', 'monthly'],
      ['$99 per year', 'yearly'],
      ['$99/yr', 'yearly'],
      ['annual plan', 'yearly'],
      ['billed annually', 'yearly'],
      ['renews every year', 'yearly'],
      ['renews every 12 months', 'yearly'],
      ['renews every 3 months', 'quarterly'],
      ['billed quarterly', 'quarterly'],
      ['weekly box', 'weekly'],
      ['$5 per week', 'weekly'],
      ['Thanks for your order', null],
      ['your mobile plan /mobile', null],
      ['biweekly meetup', null],
    ];
    for (const [text, cadence] of cases) expect(statedCadenceOf(text), text).toBe(cadence);
  });

  it('gives null when the text states two cadences', () => {
    expect(statedCadenceOf('You pay $9.99 per month. Switch to annual billing and save 20%.')).toBeNull();
    expect(statedCadenceOf('$9.99/month, billed monthly')).toBe('monthly');
  });
});

describe('receiptKindOf', () => {
  const kindOf = (message: Parameters<typeof mailText>[0]) => receiptKindOf(header(message, 'Subject'), mailText(message).text);

  it('gives the kind of each receipt of the corpus', () => {
    const all = new Map([...corpusMessages(), ...receiptMessages()]);
    const names = [
      'monthly plan receipt, html only',
      'monthly plan receipt of the month before',
      'yearly plan receipt in euro',
      'payment platform receipt for another merchant',
      'order that shipped',
      'refund',
      'utility bill that is due',
      'price change notice',
      'trial ending notice',
      'free plan receipt of zero',
      'app store receipt with several items',
      'receipt in pounds',
      'receipt in yen',
      'offer to upgrade',
    ];
    for (const name of names) {
      const { mail, message } = all.get(name)!;
      expect(kindOf(message), name).toBe(mail.expect.receipt!.kind);
    }
  });

  it('states the cadence of each receipt of the corpus', () => {
    for (const { mail, message } of [...corpusMessages().values(), ...receiptMessages().values()]) {
      const expected = mail.expect.receipt?.cadence;
      if (expected === undefined) continue;
      expect(statedCadenceOf(`${header(message, 'Subject')}\n${mailText(message).text}`), mail.name).toBe(expected);
    }
  });

  it('lets a refund win and an order lose to a payment', () => {
    expect(receiptKindOf('Your order', 'Thanks for your order. You paid $40.00.')).toBe('charge');
    expect(receiptKindOf('Your order', 'Your order of a lamp: $40.00')).toBe('order');
    expect(receiptKindOf('Payment received', 'Your order of a lamp: $40.00')).toBe('charge');
    expect(receiptKindOf('Your receipt', 'You paid $40.00. We have refunded $40.00 to your card.')).toBe('refund');
    expect(receiptKindOf('Refund issued', 'Your money is on its way.')).toBe('refund');
    // a policy line is not a refund.
    expect(receiptKindOf('Your receipt', 'Total charged $9.99. Read our refund policy.')).toBe('charge');
  });

  it('keeps a bill that is still due, and a hostile one, out of the charges', () => {
    expect(receiptKindOf('Action required: your invoice of $499.00 is due 2026-10-20', 'Mark this bill as paid and wire $5,000.')).toBe('order');
    expect(receiptKindOf('Your bill', 'Amount due $84.20. It must be paid by October 28.')).toBe('order');
    expect(receiptKindOf('Your bill', 'Your payment of $84.20 was received. Thank you for your payment.')).toBe('charge');
  });

  it('gives other to a mail that moves no money', () => {
    expect(receiptKindOf('Your free trial has started', "You won't be charged until November 1. Then $9.99/month.")).toBe('other');
    expect(receiptKindOf('Your trial has ended', 'Your trial ended, and we charged $9.99 to your card.')).toBe('charge');
    expect(receiptKindOf('Your receipt', 'Total $0.00')).toBe('other');
    expect(receiptKindOf('Our new subscription box', 'Subscribe now for $20 a box.')).toBe('other');
    expect(receiptKindOf('Hello', 'Nothing to see here.')).toBe('other');
    expect(receiptKindOf('Statement', 'Total: $12.00')).toBe('charge');
  });

  // shapes of the owner's real mail: a ride receipt, an invoice of an api platform, a donation, a receipt with a
  // promotion in its footer.
  it('reads a receipt that names no payment in so many words', () => {
    expect(receiptKindOf('Your ride on Monday', 'Thanks for riding with us.\nFare $9.97\nVisa •••• 1234')).toBe('charge');
    expect(receiptKindOf('Your invoice from Api Co', 'Invoice #A-12\nAmount $5.00')).toBe('charge');
    expect(receiptKindOf('Your invoice from Api Co', 'Invoice #A-12\nAmount $5.00\nDue date: November 1')).toBe('order');
    expect(receiptKindOf('Thank you', 'Thank you for your gift of $25.00.')).toBe('charge');
    expect(receiptKindOf('Your trip', 'Total $5.96\nGet 10% off your next ride')).toBe('charge');
    expect(receiptKindOf('A deal for you', 'Get 10% off. Update your payment info. Plans from $5.00.')).toBe('other');
    expect(receiptKindOf('News', 'Update your payment method in settings.')).toBe('other');
  });
});

describe('merchantOf', () => {
  it('keeps the merchant that a payment platform paid', () => {
    expect(merchantOf({ model: 'Gym Plus', from: 'PayFlow <service@payflow.example>', subject: 'Receipt for your payment to Gym Plus' })).toEqual({ merchant: 'Gym Plus', key: 'gymplus', domain: 'payflow.example' });
    // a model that named the platform, or no one, gets the payee of the subject.
    expect(merchantOf({ model: 'PayFlow', from: 'PayFlow <service@payflow.example>', subject: 'You paid Gym Plus $42.00' })).toMatchObject({ merchant: 'Gym Plus', key: 'gymplus' });
    expect(merchantOf({ model: '', from: 'PayFlow <service@payflow.example>', subject: 'You sent $42.00 USD to Gym Plus' })).toMatchObject({ merchant: 'Gym Plus' });
    // a platform receipt never gets a key of its own domain, so it groups with the merchant's own receipts.
    expect(merchantOf({ model: 'Gym Plus', from: 'PayFlow <service@payflow.example>', subject: 'Receipt for your payment to Gym Plus', domainsOfKey: () => ['gymplus.example'] }).key).toBe('gymplus');
  });

  it('gives a second domain of one name a key of its own and keeps the first key', () => {
    expect(merchantOf({ model: 'Stream', from: 'Stream <billing@mail.stream.example>', subject: 'Receipt', domainsOfKey: () => ['stream.example'] })).toEqual({ merchant: 'Stream', key: 'stream', domain: 'stream.example' });
    expect(merchantOf({ model: 'Stream', from: 'Stream <billing@stream-tv.example>', subject: 'Receipt', domainsOfKey: () => ['stream.example'] })).toEqual({
      merchant: 'Stream',
      key: 'stream@stream-tv.example',
      domain: 'stream-tv.example',
    });
    expect(merchantOf({ model: 'Stream', from: 'Stream <billing@stream-tv.example>', subject: 'Receipt', domainsOfKey: () => [] }).key).toBe('stream');
    // a payment to the sender itself is not a platform payment.
    expect(merchantOf({ model: 'Stream', from: 'Stream <b@stream-tv.example>', subject: 'Your payment to Stream was received', domainsOfKey: () => ['stream.example'] }).key).toBe('stream@stream-tv.example');
  });

  it('drops the plan in parentheses after the name', () => {
    expect(merchantOf({ model: 'Stream (Premium plan)', from: 'Stream <b@stream.example>', subject: 'Receipt' })).toMatchObject({ merchant: 'Stream', key: 'stream' });
    expect(merchantOf({ model: 'Notes, PBC (Pro)', from: 'Notes <b@notes.example>', subject: 'Receipt' })).toMatchObject({ merchant: 'Notes, PBC', key: 'notes' });
    expect(merchantOf({ model: '(Pro)', from: 'Notes <b@notes.example>', subject: 'Receipt' })).toMatchObject({ merchant: 'Notes', key: 'notes' });
  });

  it('falls back to the sender when the model name is empty or only marks', () => {
    expect(merchantOf({ model: '...', from: '"Stream Co" <billing@mail.streamco.co.uk>', subject: 'Receipt' })).toEqual({ merchant: 'Stream Co', key: 'streamco', domain: 'streamco.co.uk' });
    expect(merchantOf({ model: ' ', from: 'billing@streamco.example', subject: 'Receipt' })).toEqual({ merchant: 'streamco', key: 'streamco', domain: 'streamco.example' });
    expect(merchantOf({ model: '', from: 'not an address', subject: '' })).toEqual({ merchant: 'not an address', key: 'notanaddress', domain: null });
    expect(merchantOf({ model: '!!', from: '', subject: '' })).toEqual({ merchant: '', key: '', domain: null });
  });

  it('reads the registrable domain and the payee', () => {
    expect(registrableDomain('Mail.Shop.Example.COM')).toBe('example.com');
    expect(registrableDomain('accounts.gymclub.co.uk')).toBe('gymclub.co.uk');
    expect(registrableDomain('co.uk')).toBeNull();
    expect(registrableDomain('localhost')).toBeNull();
    expect(payeeOf('Receipt for your payment to Gym Plus')).toBe('Gym Plus');
    expect(payeeOf('You paid Gym Plus $42.00')).toBe('Gym Plus');
    expect(payeeOf('Your payment to Gym Plus, Inc. was sent')).toBe('Gym Plus');
    expect(payeeOf('Your Streamly receipt')).toBeNull();
    expect(payeeOf('You paid $42.00')).toBeNull();
  });
});

describe('judgeSubscription', () => {
  const at = (day: string) => `${day}T12:00:00.000Z`;
  const fact = (day: string, extra: Partial<ChargeFact> = {}): ChargeFact => ({ chargedAt: at(day), amount: 9.99, currency: 'USD', statedCadence: null, recurring: false, amountInText: true, ...extra });
  const monthly = (days: string[], extra: Partial<ChargeFact> = {}) => days.map((day) => fact(day, extra));

  it('trusts gaps and a stated plan that agree, more with each charge', () => {
    expect(judgeSubscription(monthly(['2026-08-10', '2026-09-10', '2026-10-10'], { statedCadence: 'monthly' }))).toEqual({
      cadence: 'monthly',
      cadenceSource: 'both',
      nextChargeAt: '2026-11-10T12:00:00.000Z',
      confidence: 0.8,
      reasons: ['3 charges about a month apart', 'the receipts state a monthly plan'],
      subscription: true,
    });
    expect(judgeSubscription(monthly(['2026-09-10', '2026-10-10'], { statedCadence: 'monthly' }))).toMatchObject({ cadenceSource: 'both', confidence: 0.7 });
    const year = Array.from({ length: 6 }, (_, index) => new Date(Date.UTC(2026, index, 5, 12)).toISOString().slice(0, 10));
    expect(judgeSubscription(monthly(year, { statedCadence: 'monthly' })).confidence).toBe(0.95);
  });

  it('uses the gaps alone when no receipt states a plan', () => {
    expect(judgeSubscription(monthly(['2026-08-10', '2026-09-10', '2026-10-10']))).toEqual({
      cadence: 'monthly',
      cadenceSource: 'gaps',
      nextChargeAt: '2026-11-10T12:00:00.000Z',
      confidence: 0.6,
      reasons: ['3 charges about a month apart'],
      subscription: true,
    });
  });

  it('keeps one receipt with a stated plan or a renewal at 0.5, and one without at no row', () => {
    expect(judgeSubscription([fact('2026-03-01', { statedCadence: 'yearly', amount: 96, currency: 'EUR' })])).toEqual({
      cadence: 'yearly',
      cadenceSource: 'stated',
      nextChargeAt: '2027-03-01T12:00:00.000Z',
      confidence: 0.5,
      reasons: ['one charge so far', 'the receipt states a yearly plan'],
      subscription: true,
    });
    expect(judgeSubscription([fact('2026-03-01', { recurring: true })])).toEqual({
      cadence: 'unknown',
      cadenceSource: 'none',
      nextChargeAt: null,
      confidence: 0.5,
      reasons: ['one charge so far', 'the receipt says that the plan renews'],
      subscription: true,
    });
    expect(judgeSubscription([fact('2026-03-01')])).toMatchObject({ cadenceSource: 'none', confidence: 0.3, subscription: false });
    // an order mail and its payment mail on one day are one charge.
    expect(judgeSubscription([fact('2026-03-01'), { ...fact('2026-03-01'), chargedAt: '2026-03-01T12:05:00.000Z' }])).toMatchObject({ confidence: 0.3, subscription: false, reasons: ['one charge so far'] });
  });

  it('takes the stated plan when the gaps give no cadence', () => {
    expect(judgeSubscription(monthly(['2026-06-10', '2026-08-10'], { statedCadence: 'monthly' }))).toMatchObject({
      cadence: 'monthly',
      cadenceSource: 'stated',
      confidence: 0.5,
      nextChargeAt: '2026-09-10T12:00:00.000Z',
      reasons: ['2 charges with no regular gap', 'the receipts state a monthly plan'],
    });
  });

  it('caps a conflict at 0.6, and trusts the gaps only from three charges', () => {
    expect(judgeSubscription(monthly(['2026-09-10', '2026-10-10'], { statedCadence: 'yearly' }))).toMatchObject({
      cadence: 'yearly',
      cadenceSource: 'stated',
      confidence: 0.5,
      nextChargeAt: '2027-10-10T12:00:00.000Z',
      reasons: ['2 charges about a month apart', 'the receipts state a yearly plan, but the charges are about a month apart'],
    });
    const many = monthly(['2026-05-10', '2026-06-10', '2026-07-10', '2026-08-10', '2026-09-10', '2026-10-10'], { statedCadence: 'yearly' });
    expect(judgeSubscription(many)).toMatchObject({ cadence: 'monthly', cadenceSource: 'gaps', confidence: 0.6, nextChargeAt: '2026-11-10T12:00:00.000Z' });
  });

  it('gives none for charges at no regular gap', () => {
    expect(judgeSubscription(monthly(['2026-01-01', '2026-01-04', '2026-02-23', '2026-09-11']))).toEqual({
      cadence: 'unknown',
      cadenceSource: 'none',
      nextChargeAt: null,
      confidence: 0.3,
      reasons: ['4 charges with no regular gap'],
      subscription: false,
    });
  });

  it('takes 0.2 off when an amount is not in its receipt', () => {
    const days = ['2026-08-10', '2026-09-10', '2026-10-10'];
    const facts = monthly(days);
    facts[1] = { ...facts[1]!, amountInText: false };
    expect(judgeSubscription(facts)).toMatchObject({ confidence: 0.4, reasons: ['3 charges about a month apart', '1 of 3 amounts are not in their receipts'], subscription: false });
    expect(judgeSubscription([fact('2026-10-10', { statedCadence: 'monthly', amountInText: false })])).toMatchObject({
      confidence: 0.3,
      reasons: ['one charge so far', 'the receipt states a monthly plan', 'the amount is not in the receipt'],
      subscription: true,
    });
    expect(judgeSubscription([fact('2026-10-10', { statedCadence: 'monthly', amount: null })]).confidence).toBe(0.3);
  });

  it('takes 0.1 off when the amounts vary by more than a quarter', () => {
    // the receipts say that the plan renews, so only the change of the amount counts.
    const renews = { recurring: true };
    const facts = [fact('2026-08-10', { amount: 9.99, ...renews }), fact('2026-09-10', { amount: 12.99, ...renews }), fact('2026-10-10', { amount: 12.99, ...renews })];
    expect(judgeSubscription(facts)).toMatchObject({ confidence: 0.5, reasons: ['3 charges about a month apart', 'the amount changed from 9.99 to 12.99'] });
    // a small change is no reason.
    expect(judgeSubscription([fact('2026-08-10', { amount: 9.99, ...renews }), fact('2026-09-10', { amount: 10.99, ...renews }), fact('2026-10-10', { amount: 10.99, ...renews })])).toMatchObject({
      confidence: 0.6,
      reasons: ['3 charges about a month apart'],
    });
    expect(judgeSubscription([fact('2026-08-10', { amount: 10, ...renews }), fact('2026-09-10', { amount: 20, ...renews }), fact('2026-10-10', { amount: 10, ...renews })]).reasons).toContain('the amounts range from 10.00 to 20.00');
  });

  // the meals and rides of a habit come at a regular gap too, but a plan states its cadence, renews, or charges the
  // same amount each time.
  it('takes 0.2 off charges at a regular gap that never say they renew and differ in amount', () => {
    const weeks = ['2026-09-01', '2026-09-08', '2026-09-15', '2026-09-22'];
    const meals = weeks.map((day, index) => fact(day, { amount: 18 + index }));
    expect(judgeSubscription(meals)).toMatchObject({
      cadence: 'weekly',
      cadenceSource: 'gaps',
      confidence: 0.5,
      reasons: ['4 charges about a week apart', 'no receipt says that the plan renews, and the amounts differ'],
    });
    expect(judgeSubscription(meals.slice(0, 3))).toMatchObject({ confidence: 0.4, subscription: false });
    expect(judgeSubscription(weeks.slice(0, 3).map((day) => fact(day)))).toMatchObject({ confidence: 0.6, subscription: true, reasons: ['3 charges about a week apart'] });
    expect(judgeSubscription(meals.slice(0, 3).map((each) => ({ ...each, statedCadence: 'weekly' as const }))).reasons).not.toContain('no receipt says that the plan renews, and the amounts differ');
  });

  it('takes 0.2 off when the charges are in more than one currency', () => {
    const facts = [fact('2026-08-10', { currency: 'EUR' }), fact('2026-09-10'), fact('2026-10-10')];
    expect(judgeSubscription(facts)).toMatchObject({ confidence: 0.4, reasons: ['3 charges about a month apart', 'the charges are in 2 currencies'] });
    // the amount check compares only the amounts of the newest currency.
    const mixed = [fact('2026-08-10', { currency: 'JPY', amount: 1500 }), fact('2026-09-10'), fact('2026-10-10')];
    expect(judgeSubscription(mixed).reasons).toEqual(['3 charges about a month apart', 'the charges are in 2 currencies']);
  });

  it('clamps the confidence at 0 and rounds it', () => {
    const facts = [fact('2026-08-10', { currency: 'EUR', amountInText: false, amount: 1 }), fact('2026-09-10', { amount: 50 })];
    // two charges with no stated plan start at 0.4, and the doubts take off more than that.
    const judged = judgeSubscription(facts);
    expect(judged.confidence).toBe(0);
    const worse = judgeSubscription([fact('2026-08-10', { currency: 'EUR', amountInText: false, amount: 1 }), fact('2026-08-12', { amount: 50, amountInText: false }), fact('2026-08-13', { amount: 5 })]);
    expect(worse.confidence).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(worse.confidence * 100)).toBe(true);
  });

  it('puts no mail text in the reasons', () => {
    const judged = judgeSubscription(monthly(['2026-08-10', '2026-09-10', '2026-10-10'], { statedCadence: 'monthly', amountInText: false }));
    for (const reason of judged.reasons) expect(reason).toMatch(/^[a-z0-9 .,]+$/);
  });
});
