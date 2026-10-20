import { describe, expect, it } from 'vitest';
import { cadenceOf, merchantKeyOf, monthlyTotals, nextChargeAfter } from './cadence.js';
import { amountsIn, judgeSubscription, merchantOf, receiptKindOf, statedCadenceOf, type ChargeFact } from './receipts.js';

// tests that try to break the reading of receipts: odd amounts, hostile text, the edges of months and years, and
// charges that look like a plan but are not one.

const amounts = (text: string) => amountsIn(text).map(({ amount, currency }) => ({ amount, currency }));

const charge = (chargedAt: string, extra: Partial<ChargeFact> = {}): ChargeFact => ({
  chargedAt,
  amount: 9.99,
  currency: 'USD',
  statedCadence: null,
  recurring: false,
  amountInText: true,
  ...extra,
});

describe('amountsIn against odd and hostile text', () => {
  it('skips a number without a currency, a currency code inside a word and a bare sign', () => {
    expect(amounts('Order 12345 shipped. USDT 5 and EURO 7. $ alone. €.')).toEqual([]);
  });

  it('skips a credit with a minus sign', () => {
    expect(amounts('Credit -$5.00\nTotal $4.99')).toEqual([{ amount: 4.99, currency: 'USD' }]);
  });

  it('reads an amount of a million with its groups and a japanese amount without decimals', () => {
    expect(amounts('Total: $1,234,567.89')).toEqual([{ amount: 1234567.89, currency: 'USD' }]);
    expect(amounts('合計 ¥12,800')).toEqual([{ amount: 12800, currency: 'JPY' }]);
  });

  it('marks the total on the line after its label, with one empty line between them', () => {
    const got = amountsIn('Subtotal $8.00\nTotal\n\n$9.99');
    expect(got.map((each) => [each.amount, each.total])).toEqual([
      [8, false],
      [9.99, true],
    ]);
  });

  it('reads a text of many thousands of digits and separators in linear time', () => {
    const text = `${'1,'.repeat(100_000)}$ ${'9.'.repeat(100_000)}€ ${'USD '.repeat(50_000)}`;
    const started = performance.now();
    amountsIn(text);
    expect(performance.now() - started).toBeLessThan(3000);
  });
});

describe('receiptKindOf', () => {
  it('reads a refund as a refund also when the mail says paid', () => {
    expect(receiptKindOf('Your refund', 'We have refunded the $9.99 you paid.')).toBe('refund');
  });

  it('reads a free trial with a total of zero as no charge', () => {
    expect(receiptKindOf('Your receipt', 'Thanks for subscribing. Total $0.00. Your free trial ends Nov 1.')).toBe('other');
  });

  it('reads a bill that is due as an order and not as a charge', () => {
    expect(receiptKindOf('Your statement is ready', 'Amount due: $80.00. Payment due by Oct 25.')).toBe('order');
  });
});

describe('statedCadenceOf', () => {
  it('states no cadence when a receipt names two of them', () => {
    expect(statedCadenceOf('Billed monthly. Save 20% when you switch to annual billing.')).toBeNull();
  });

  it('does not read a cadence inside a longer word', () => {
    expect(statedCadenceOf('Your annualized savings are shown below.')).toBeNull();
    expect(statedCadenceOf('$9.99/mo')).toBe('monthly');
  });
});

describe('merchantKeyOf and merchantOf', () => {
  it('gives one key for the names of one merchant with marks, case and a company suffix', () => {
    expect(merchantKeyOf('Café Zoë, Inc.')).toBe(merchantKeyOf('cafe zoe'));
    expect(merchantKeyOf('Stream Co')).toBe('streamco');
    expect(merchantKeyOf('Zinc')).toBe('zinc');
  });

  it('keeps two merchants with one name on two domains apart', () => {
    const domains = new Map<string, string[]>([['acme', ['acme.example']]]);
    const got = merchantOf({ model: 'Acme', from: 'Acme <billing@acme-other.example>', subject: 'Your receipt', domainsOfKey: (key) => domains.get(key) ?? [] });
    expect(got.key).toBe('acme@acme-other.example');
  });

  it('takes the payee of a payment platform and not the platform', () => {
    const got = merchantOf({ model: 'PayPlatform', from: 'PayPlatform <service@payplatform.example>', subject: 'Receipt for your payment to Gym Plus' });
    expect(got.merchant).toBe('Gym Plus');
  });

  it('gives no merchant for a sender with neither a name nor an address', () => {
    expect(merchantOf({ model: '', from: '', subject: 'Receipt' })).toEqual({ merchant: '', key: '', domain: null });
  });
});

describe('cadenceOf at the edges of months and years', () => {
  it('reads charges on the last day of short and long months as monthly', () => {
    const got = cadenceOf(['2026-01-31T12:00:00Z', '2026-02-28T12:00:00Z', '2026-03-31T12:00:00Z', '2026-04-30T12:00:00Z']);
    expect(got.cadence).toBe('monthly');
    expect(got.nextChargeAt).toBe('2026-05-30T12:00:00.000Z');
  });

  it('reads a yearly charge across a leap day', () => {
    const got = cadenceOf(['2027-02-28T12:00:00Z', '2028-02-29T12:00:00Z']);
    expect(got.cadence).toBe('yearly');
    expect(nextChargeAfter(Date.parse('2028-02-29T12:00:00Z'), 'yearly')).toBe('2029-02-28T12:00:00.000Z');
  });

  it('gives an unknown cadence and a low confidence for two charges at a random gap', () => {
    const got = cadenceOf(['2026-01-01T12:00:00Z', '2026-02-15T12:00:00Z']);
    expect(got.cadence).toBe('unknown');
    expect(got.confidence).toBeLessThan(0.5);
  });

  it('ignores charge times that do not parse and does not throw on an empty list', () => {
    expect(cadenceOf([])).toMatchObject({ cadence: 'unknown', nextChargeAt: null });
    expect(cadenceOf(['nonsense', '', '2026-01-01T00:00:00Z'])).toMatchObject({ cadence: 'unknown', nextChargeAt: null });
  });

  it('gives the same answer for the charges in any order', () => {
    const times = ['2026-03-01T12:00:00Z', '2026-01-01T12:00:00Z', '2026-02-01T12:00:00Z'];
    expect(cadenceOf(times)).toEqual(cadenceOf([...times].reverse()));
  });
});

describe('judgeSubscription reports confidence honestly', () => {
  it('stays below the top for two charges, also when a receipt states the plan', () => {
    const got = judgeSubscription([charge('2026-09-01T12:00:00Z', { statedCadence: 'monthly' }), charge('2026-10-01T12:00:00Z', { statedCadence: 'monthly' })]);
    expect(got.cadence).toBe('monthly');
    expect(got.confidence).toBeLessThanOrEqual(0.8);
  });

  it('lowers the confidence when no amount is in its receipt', () => {
    const shown = judgeSubscription([charge('2026-08-01T12:00:00Z'), charge('2026-09-01T12:00:00Z'), charge('2026-10-01T12:00:00Z')]);
    const hidden = judgeSubscription([charge('2026-08-01T12:00:00Z', { amountInText: false }), charge('2026-09-01T12:00:00Z', { amountInText: false }), charge('2026-10-01T12:00:00Z', { amountInText: false })]);
    expect(hidden.confidence).toBeLessThan(shown.confidence);
    expect(hidden.reasons.join(' ')).toContain('amounts are not in their receipts');
  });

  it('is not a subscription for meals at a monthly gap with different amounts and no word of a plan', () => {
    const got = judgeSubscription([
      charge('2026-08-03T19:00:00Z', { amount: 23.4 }),
      charge('2026-09-02T19:00:00Z', { amount: 41.1 }),
      charge('2026-10-02T19:00:00Z', { amount: 17.85 }),
    ]);
    expect(got.confidence).toBeLessThan(0.5);
    expect(got.subscription).toBe(false);
  });

  it('lowers the confidence when the charges are in two currencies', () => {
    const one = judgeSubscription([charge('2026-08-01T12:00:00Z'), charge('2026-09-01T12:00:00Z'), charge('2026-10-01T12:00:00Z')]);
    const two = judgeSubscription([charge('2026-08-01T12:00:00Z'), charge('2026-09-01T12:00:00Z', { currency: 'EUR' }), charge('2026-10-01T12:00:00Z')]);
    expect(two.confidence).toBeLessThan(one.confidence);
  });

  it('keeps every confidence between 0 and 1 for the worst charges', () => {
    const got = judgeSubscription([
      charge('2026-01-01T12:00:00Z', { amount: null, currency: null, amountInText: false }),
      charge('2026-01-20T12:00:00Z', { amount: 0, currency: 'EUR', amountInText: false }),
      charge('2026-06-01T12:00:00Z', { amount: 500, currency: 'USD', amountInText: false }),
    ]);
    expect(got.confidence).toBeGreaterThanOrEqual(0);
    expect(got.confidence).toBeLessThanOrEqual(1);
  });
});

describe('monthlyTotals', () => {
  it('leaves out rows with an unknown cadence or no amount and keeps each currency apart', () => {
    expect(
      monthlyTotals([
        { amount: 120, currency: 'USD', cadence: 'yearly' },
        { amount: 5, currency: 'USD', cadence: 'monthly' },
        { amount: 9, currency: 'EUR', cadence: 'monthly' },
        { amount: 99, currency: 'USD', cadence: 'unknown' },
        { amount: null, currency: 'USD', cadence: 'monthly' },
      ]),
    ).toEqual([
      { currency: 'EUR', amount: 9 },
      { currency: 'USD', amount: 15 },
    ]);
  });
});
