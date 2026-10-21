import type { BankFrequency } from '../dashboard/plaid-types.js';
import type { SubscriptionCadence } from '../dashboard/types.js';

// the frequencies of the bank next to the cadences of the receipts. the merge, the alerts and the pages share these.

// the part of one month that one charge of each frequency pays for. an unknown frequency has no monthly value.
export const BANK_MONTHLY_FACTOR: Record<BankFrequency, number | null> = {
  weekly: 52 / 12,
  biweekly: 26 / 12,
  semi_monthly: 2,
  monthly: 1,
  quarterly: 1 / 3,
  semi_annually: 1 / 6,
  annually: 1 / 12,
  unknown: null,
};

// the cadence of a receipt row that a frequency of the bank matches. a frequency that the receipts have no word for
// gives unknown, so a merged row never claims a cadence that it does not have.
export function cadenceOfFrequency(frequency: BankFrequency): SubscriptionCadence {
  switch (frequency) {
    case 'weekly':
      return 'weekly';
    case 'monthly':
      return 'monthly';
    case 'quarterly':
      return 'quarterly';
    case 'annually':
      return 'yearly';
    default:
      return 'unknown';
  }
}

// the frequency of plaid (for example MONTHLY or SEMI_MONTHLY) in lower case, or unknown for a value that this code
// does not know.
export function frequencyOf(value: string | null | undefined): BankFrequency {
  const lower = (value ?? '').toLowerCase();
  return Object.hasOwn(BANK_MONTHLY_FACTOR, lower) ? (lower as BankFrequency) : 'unknown';
}
