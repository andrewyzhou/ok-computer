import type { SubscriptionCadence } from '../dashboard/types.js';

// the part of one month that one charge of each cadence pays for. an unknown cadence has no monthly value.
export const MONTHLY_FACTOR: Record<SubscriptionCadence, number | null> = {
  weekly: 52 / 12,
  monthly: 1,
  quarterly: 1 / 3,
  yearly: 1 / 12,
  unknown: null,
};

// the monthly estimate of each currency, rounded to the cent. a row with no amount, no currency or an
// unknown cadence is left out, as the contract says. the currencies are in alphabetical order.
export function monthlyTotals(rows: ReadonlyArray<{ amount: number | null; currency: string | null; cadence: SubscriptionCadence }>): Array<{ currency: string; amount: number }> {
  const totals = new Map<string, number>();
  for (const row of rows) {
    const factor = MONTHLY_FACTOR[row.cadence];
    if (row.amount === null || !row.currency || factor === null) continue;
    totals.set(row.currency, (totals.get(row.currency) ?? 0) + row.amount * factor);
  }
  return [...totals.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([currency, amount]) => ({ currency, amount: Math.round(amount * 100) / 100 }));
}

// the merchant key and the cadence of the gaps live here, so receipts.ts and subscriptions.ts share them without
// importing each other.
const DAY_MS = 24 * 60 * 60 * 1000;

// the merchant key: the name in lower case, without spaces and marks, so "Stream Co." and "streamco" are one row. a
// company suffix goes first, and only as a word of its own, so "Zinc" stays "zinc" and is not "Z Inc". "co" is not one,
// because a name such as "Stream Co" needs it.
export function merchantKeyOf(merchant: string): string {
  return merchant
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .trim()
    .replace(/[\s,.]+(inc|llc|ltd|pbc|corp|corporation|plc|gmbh)\.?$/, '')
    .replace(/[^a-z0-9]/g, '');
}

const median = (sorted: readonly number[]) => {
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
};

// the cadence of the median gap in days. the ranges leave room for short months and a late charge.
function cadenceOfGap(days: number): SubscriptionCadence {
  if (days >= 5 && days <= 9) return 'weekly';
  if (days >= 26 && days <= 35) return 'monthly';
  if (days >= 80 && days <= 100) return 'quarterly';
  if (days >= 350 && days <= 380) return 'yearly';
  return 'unknown';
}

// the same time some calendar months later in utc. a day that the month does not have becomes its last day, so
// january 31 plus one month is the last day of february.
function addMonths(at: Date, months: number): Date {
  const year = at.getUTCFullYear();
  const month = at.getUTCMonth() + months;
  const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, month, Math.min(at.getUTCDate(), last), at.getUTCHours(), at.getUTCMinutes(), at.getUTCSeconds(), at.getUTCMilliseconds()));
}

const MONTHS: Partial<Record<SubscriptionCadence, number>> = { monthly: 1, quarterly: 3, yearly: 12 };

// the time of the charge after a charge at a time (milliseconds), or null when the cadence is unknown.
export function nextChargeAfter(at: number, cadence: SubscriptionCadence): string | null {
  if (cadence === 'weekly') return new Date(at + 7 * DAY_MS).toISOString();
  const months = MONTHS[cadence];
  return months ? addMonths(new Date(at), months).toISOString() : null;
}

// the cadence of a list of charge times (iso, any order), the next charge after the last one, and the confidence
// that the charge repeats (0 to 1). the charges of one day count as one, because an order mail and its payment mail
// are one charge. a cadence that fits no range stays below 0.5, so two charges at a random gap are not a subscription.
export function cadenceOf(charges: readonly string[]): { cadence: SubscriptionCadence; nextChargeAt: string | null; confidence: number } {
  const sorted = charges
    .map((each) => Date.parse(each))
    .filter((each) => Number.isFinite(each))
    .sort((a, b) => a - b);
  const times = sorted.filter((each, index) => index === 0 || Math.floor(each / DAY_MS) !== Math.floor(sorted[index - 1]! / DAY_MS));
  if (times.length < 2) return { cadence: 'unknown', nextChargeAt: null, confidence: 0.3 };
  const gaps = times.slice(1).map((each, index) => (each - times[index]!) / DAY_MS);
  const middle = median([...gaps].sort((a, b) => a - b));
  const cadence = cadenceOfGap(middle);
  const nextChargeAt = nextChargeAfter(times.at(-1)!, cadence);
  // two charges give one gap and 0.5. each further gap near the median adds to it.
  const near = gaps.filter((gap) => Math.abs(gap - middle) <= 0.2 * middle).length;
  let confidence = Math.min(0.95, 0.5 + 0.1 * Math.max(0, near - 1));
  if (gaps.some((gap) => Math.abs(gap - middle) > 0.5 * middle)) confidence = Math.max(0.1, confidence - 0.2);
  if (cadence === 'unknown') confidence = Math.min(confidence, 0.3);
  return { cadence, nextChargeAt, confidence: Math.round(confidence * 100) / 100 };
}
