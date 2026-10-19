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
