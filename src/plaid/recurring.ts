import type { BankPriceChange } from '../dashboard/plaid-types.js';
import type { PlaidStreamWire, PlaidTransactionWire } from './client.js';
import { NOT_BUILT } from './names.js';
import type { StreamInput } from './streams.js';

// the recurring streams of an item, in the shape that streams.ts writes. plaid gives them through
// /transactions/recurring/get when the plan includes it. the free trial plan lists transactions but not recurring
// transactions, so detectStreams finds them in the transactions of the window instead, with the gap rules of the
// receipts (judgeSubscription of src/inbox/receipts.ts).

// the outflow streams of plaid, without an inflow (a paycheck) and without a stream of an account that the item does
// not list. accountRows maps the account id of plaid to the row id. transactions are the ones of the sync, by id, so a
// stream keeps the charges that it names. amounts of plaid are positive for money out.
export function streamsFromPlaid(
  outflow: readonly PlaidStreamWire[],
  accountRows: ReadonlyMap<string, number>,
  transactions: ReadonlyMap<string, PlaidTransactionWire>,
): StreamInput[] {
  void outflow;
  void accountRows;
  void transactions;
  throw new Error(NOT_BUILT);
}

// the streams that the code finds in the transactions of one item: the outflows of one merchant key on one account
// that repeat at a steady gap (weekly to yearly), at least two charges, the newest first. a pending transaction does
// not count for the gap. a transfer, a loan payment or a payment of a credit card (personal_finance_category
// TRANSFER_OUT, LOAN_PAYMENTS, or a name of the owner's own accounts) is never a subscription.
export function detectStreams(transactions: readonly PlaidTransactionWire[], accountRows: ReadonlyMap<string, number>, now: Date): StreamInput[] {
  void transactions;
  void accountRows;
  void now;
  throw new Error(NOT_BUILT);
}

// the price changes of a stream from its settled charges, oldest first: a charge whose amount differs from the one
// before it by more than one cent and by more than 1 percent starts a change. a pending charge never counts.
export function priceChangesOf(charges: ReadonlyArray<{ date: string; amount: number; pending: boolean }>, currency: string | null): Array<Omit<BankPriceChange, 'id' | 'detectedAt'>> {
  void charges;
  void currency;
  throw new Error(NOT_BUILT);
}
