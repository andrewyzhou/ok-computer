import type { CadenceSource } from '../dashboard/inbox-types.js';
import type { SubscriptionCadence } from '../dashboard/types.js';

// the facts of a receipt that the code checks, so the subscription table does not rest on the model alone: the
// amounts that the text states, the cadence that it states, the kind of the mail, and the merchant from the sender.
// the model still reads each receipt, and the code keeps a fact of the model only when the text supports it. the work
// package "subscriptions" builds this module.

// the version of the receipt reading. a scan reads a receipt again when its row has an older version (the parser column
// of 026_inbox_live.sql). raise it with each change that changes what a receipt row holds.
export const PARSER_VERSION = 1;

// charge: a payment that was made. refund: money back. order: an order, a shipment or a bill that is still due, with no
// payment yet. other: anything else (an offer, a trial start without a charge, a price change notice).
export type ReceiptKind = 'charge' | 'refund' | 'order' | 'other';

export type StatedCadence = Exclude<SubscriptionCadence, 'unknown'>;

// one amount that a text states. text is the words as they stand in the text, for example "$12.99" or "12,99 €".
export interface AmountMention {
  amount: number;
  // three capital letters. a bare "$" is USD.
  currency: string;
  text: string;
  // true when a label such as "total", "amount charged" or "you paid" stands on the line before the amount.
  total: boolean;
}

// amountsIn gives each amount of a text, in the order of the text. it reads "$12.99", "USD 12.99", "12.99 USD",
// "US$12.99", "€9,99", "9,99 €", "£4.50", "¥1,200", "1.234,56 €" and "$1,234.56", and skips numbers without a currency.
export function amountsIn(_text: string): AmountMention[] {
  throw new Error('not built: amountsIn (work package subscriptions)');
}

// statedCadenceOf gives the cadence that a receipt states, such as "per month", "/mo", "monthly plan", "billed
// annually", "renews every year" or "every 3 months", or null when it states none or states more than one.
export function statedCadenceOf(_text: string): StatedCadence | null {
  throw new Error('not built: statedCadenceOf (work package subscriptions)');
}

// receiptKindOf decides the kind of a mail from its subject and text.
export function receiptKindOf(_subject: string, _text: string): ReceiptKind {
  throw new Error('not built: receiptKindOf (work package subscriptions)');
}

// the merchant of a receipt. key is the merchant key of the subscription row (merchantKeyOf of subscriptions.ts, or
// a key that stays the same for the same merchant across its receipts), and domain is the registrable domain of the
// from address in lower case, or null.
export interface Merchant {
  merchant: string;
  key: string;
  domain: string | null;
}

// merchantOf picks the merchant from the name that the model gave, the from header and the subject. a payment platform
// that sends the receipt for another merchant keeps the name of that merchant, and two merchants with one name on two
// domains get two keys.
export function merchantOf(_input: { model: string; from: string; subject: string }): Merchant {
  throw new Error('not built: merchantOf (work package subscriptions)');
}

// one charge of a merchant, as the subscription row reads it from inbox_receipts.
export interface ChargeFact {
  chargedAt: string;
  amount: number | null;
  currency: string | null;
  statedCadence: StatedCadence | null;
  recurring: boolean;
  amountInText: boolean;
}

// how sure the finder is about a subscription, and why. reasons are short sentences such as "4 charges about a month
// apart" or "the amount changed from 9.99 to 12.99", which the page shows.
export interface SubscriptionJudgement {
  cadence: SubscriptionCadence;
  cadenceSource: CadenceSource;
  nextChargeAt: string | null;
  confidence: number;
  reasons: string[];
  // false when the charges are not a subscription, so the finder writes no row.
  subscription: boolean;
}

// judgeSubscription decides the cadence and the confidence of the charges of one merchant. it uses cadenceOf of
// subscriptions.ts for the gaps and the stated cadence of the receipts, and it lowers the confidence when they
// disagree, when the amounts differ a lot, or when an amount is not in its receipt.
export function judgeSubscription(_charges: readonly ChargeFact[]): SubscriptionJudgement {
  throw new Error('not built: judgeSubscription (work package subscriptions)');
}
