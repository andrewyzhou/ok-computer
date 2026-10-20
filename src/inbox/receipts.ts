import type { CadenceSource } from '../dashboard/inbox-types.js';
import type { SubscriptionCadence } from '../dashboard/types.js';
import { fromAddress } from '../google/mime.js';
import { cleanLine } from '../signals/store.js';
import { cadenceOf, chargeTimes, merchantKeyOf, nextChargeAfter } from './cadence.js';
import { ownedDomain } from './domains.js';

// the facts of a receipt that the code checks, so the subscription table does not rest on the model alone: the
// amounts that the text states, the cadence that it states, the kind of the mail, and the merchant from the sender.
// the model still reads each receipt, and the code keeps a fact of the model only when the text supports it. each
// pattern below runs on untrusted mail, so each one takes linear time in the size of the text.

// the version of the receipt reading. a scan reads a receipt again when its row has an older version (the parser column
// of 026_inbox_live.sql). raise it with each change that changes what a receipt row holds.
export const PARSER_VERSION = 2;

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
// "US$12.99", "€9,99", "9,99 €", "£4.50", "¥1,200", "1.234,56 €", "1 234,56 €" and "$1,234.56", and skips numbers
// without a currency. a negative amount such as "-$5.00" or "($5.00)" is a credit, so it is skipped too. total is true when a label stands before the
// amount on its line, or alone on the line before it.
export function amountsIn(text: string): AmountMention[] {
  const mentions: AmountMention[] = [];
  const lines = lineStarts(text);
  // the end of the last mention, so a label counts only for the next amount of its line.
  let lastEnd = -1;
  let lastLine = -1;
  for (const match of text.matchAll(AMOUNT)) {
    const groups = match.groups ?? {};
    const post = groups.post?.trim();
    const code = groups.code ?? (post && !SIGNS[post] ? post : undefined);
    const sign = groups.sign ?? (post && SIGNS[post] ? post : undefined);
    if (!sign && !code) continue;
    if (groups.minus || MINUS.has(text[match.index - 1] ?? '')) continue;
    // an amount in parentheses is a credit in the way accounts write it, as in "Credit ($5.00)".
    if (/\(\s*$/.test(text.slice(Math.max(0, match.index - 3), match.index)) && /^\s*\)/.test(text.slice(match.index + match[0].length))) continue;
    const currency = currencyOf(code, sign, groups.dollar);
    const amount = numberOf(groups.number ?? '');
    if (amount === null || !currency) continue;
    const start = match.index;
    const line = lineOf(lines, start);
    let total = TOTAL_LABEL.test(text.slice(line === lastLine ? lastEnd : lines[line]!, start));
    if (!total) {
      const previous = previousLine(text, lines, line);
      total = previous !== null && TOTAL_LABEL.test(previous) && !hasAmount(previous);
    }
    mentions.push({ amount, currency, text: match[0].trim(), total });
    lastEnd = start + match[0].length;
    lastLine = line;
  }
  return mentions;
}

// statedCadenceOf gives the cadence that a receipt states, such as "per month", "/mo", "monthly plan", "billed
// annually", "renews every year" or "every 3 months", or null when it states none or states more than one.
export function statedCadenceOf(text: string): StatedCadence | null {
  const found = STATED.filter(([, pattern]) => pattern.test(text)).map(([cadence]) => cadence);
  return found.length === 1 ? found[0]! : null;
}

// receiptKindOf decides the kind of a mail from its subject and text. a refund wins over every other kind, then a mail
// whose amounts are all zero, then a notice and an order, each only when the mail does not say that a payment was made.
// a mail with an amount and only a weak word of a payment ("receipt", "invoice", "payment"), such as a ride receipt
// or an invoice of an api platform, is a charge when it has no word of an order or a bill that is due. an offer in
// such a mail makes it a charge only when the mail states a total.
export function receiptKindOf(subject: string, text: string): ReceiptKind {
  const all = `${subject}\n${text}`;
  if (REFUND_SUBJECT.test(subject) || REFUND_TEXT.test(all)) return 'refund';
  // a payment that failed or was declined moved no money, and its retry a few days later is the real charge.
  if (FAILED.test(all)) return 'other';
  const mentions = amountsIn(all);
  const totals = mentions.filter((each) => each.total);
  const counted = totals.length ? totals : mentions;
  // a mail whose amounts are all zero moved no money, as a free trial or a free plan does.
  if (counted.length && counted.every((each) => each.amount === 0)) return 'other';
  const paid = PAID.test(all) || PAID_SUBJECT.test(subject);
  if (!paid && NOTICE.test(all)) return 'other';
  if (!paid && ORDER.test(all)) return 'order';
  if (paid) return 'charge';
  const total = totals.some((each) => each.amount > 0);
  if (total) return 'charge';
  if (OFFER.test(all)) return 'other';
  return WEAK_PAID.test(all) && mentions.some((each) => each.amount > 0) ? 'charge' : 'other';
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
//
// domainsOfKey gives the registrable domains of the other receipts of the same account with a merchant key, without
// the receipts of a payment platform. the first domain of a key keeps the plain key, so the keys of the rows that exist
// stay the same, and a later domain gets "key@domain". a model name that is empty or only marks falls back to the name
// of the sender, then to the first label of its domain.
export function merchantOf(input: { model: string; from: string; subject: string; domainsOfKey?: (key: string) => readonly string[] }): Merchant {
  const address = fromAddress(input.from);
  const domain = address ? registrableDomain(address.split('@')[1] ?? '') : null;
  const name = displayName(input.from);
  const label = domain ? domain.split('.')[0]! : '';
  const senderKeys = new Set([merchantKeyOf(name), merchantKeyOf(label)].filter(Boolean));
  const payee = payeeOf(input.subject);
  const payeeKey = payee ? merchantKeyOf(payee) : '';
  // a platform pays another merchant: the subject names a payee that is not the sender.
  const platform = Boolean(payeeKey) && !senderKeys.has(payeeKey);
  // a model often adds the plan or the product in parentheses, as in "Name (Pro plan)". the merchant is the name before
  // them, so the receipts of one merchant share a key.
  let merchant = cleanLine(input.model.replace(/\s*\([^()]*\)\s*$/, '').replace(/\s*\([^()]*\)\s*$/, ''), 100);
  let key = merchantKeyOf(merchant);
  // a model that named the platform instead of the merchant that it paid gets the payee.
  if (platform && (!key || senderKeys.has(key))) {
    merchant = cleanLine(payee!, 100);
    key = payeeKey;
  }
  if (!key) {
    merchant = cleanLine(name || label, 100);
    key = merchantKeyOf(merchant);
  }
  if (!key) return { merchant: '', key: '', domain };
  if (!platform && domain && input.domainsOfKey?.(key).some((each) => each !== domain)) key = `${key}@${domain}`;
  return { merchant, key, domain };
}

// payeeOf gives the merchant that a payment platform paid, from a subject such as "Receipt for your payment to Gym
// Plus" or "You paid Gym Plus", or null when the subject names no payee.
export function payeeOf(subject: string): string | null {
  const match = PAYEE.exec(subject);
  if (!match) return null;
  const name = match[1]!.split(PAYEE_END)[0]!.trim();
  return merchantKeyOf(name) ? name : null;
}

// registrableDomain gives the domain that one organisation registered, in lower case, with the same suffixes as the
// newsletter keys (domains.ts), so a sender has one domain in both. a host of one label or a suffix alone gives null.
export const registrableDomain = (host: string): string | null => ownedDomain(host);

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
//
// the charges of one day count as one, as in cadenceOf. the reasons hold only counts, amounts and cadences, never
// the text of a mail.
export function judgeSubscription(charges: readonly ChargeFact[], now?: Date): SubscriptionJudgement {
  const sorted = charges.filter((each) => Number.isFinite(Date.parse(each.chargedAt))).sort((a, b) => Date.parse(a.chargedAt) - Date.parse(b.chargedAt));
  const gaps = cadenceOf(sorted.map((each) => each.chargedAt));
  const days = chargeTimes(sorted.map((each) => each.chargedAt)).length;
  const stated = statedOf(sorted);
  const recurring = sorted.some((each) => each.recurring);
  const reasons: string[] = [];
  let confidence = gaps.confidence;
  let cadence: SubscriptionCadence = gaps.cadence;
  let source: CadenceSource;
  const states = sorted.length === 1 ? 'the receipt states' : 'the receipts state';

  if (days < 2) reasons.push('one charge so far');
  else if (gaps.cadence === 'unknown') reasons.push(`${days} charges with no regular gap`);
  else reasons.push(`${days} charges about ${GAP_WORDS[gaps.cadence]} apart`);

  if (stated && stated === gaps.cadence) {
    source = 'both';
    reasons.push(`${states} a ${stated} plan`);
    // the receipts and the gaps agree. only a third charge can take it to the top, because it shows the repeat twice.
    confidence = Math.min(days >= 3 ? 0.95 : 0.8, confidence + 0.2);
  } else if (stated && (days < 2 || gaps.cadence === 'unknown')) {
    source = 'stated';
    cadence = stated;
    reasons.push(`${states} a ${stated} plan`);
    confidence = UNCONFIRMED;
  } else if (stated) {
    // the receipts and the gaps disagree. three charges are enough to trust the gaps, two are not.
    cadence = days >= 3 ? gaps.cadence : stated;
    source = days >= 3 ? 'gaps' : 'stated';
    reasons.push(`${states} a ${stated} plan, but the charges are about ${GAP_WORDS[gaps.cadence as StatedCadence]} apart`);
    confidence = Math.min(0.6, confidence);
  } else if (gaps.cadence !== 'unknown') {
    source = 'gaps';
    // on the owner's real mail, two coffees of the same price a week apart looked like a weekly plan. one gap alone,
    // with no receipt that states a plan or says that it renews, can be two purchases.
    if (!recurring && days < 3) {
      confidence = Math.min(confidence, 0.4);
      reasons.push('only 2 charges, which can be two purchases');
    }
  } else {
    source = 'none';
    if (recurring && days < 2) confidence = UNCONFIRMED;
  }
  if (recurring && days < 2) reasons.push('the receipt says that the plan renews');

  const missing = sorted.filter((each) => each.amount === null || !each.amountInText).length;
  if (missing) {
    confidence -= 0.2;
    reasons.push(sorted.length === 1 ? 'the amount is not in the receipt' : `${missing} of ${sorted.length} amounts are not in their receipts`);
  }
  const amounts = sorted.filter((each) => each.amount !== null);
  const newest = amounts.at(-1);
  const same = amounts.filter((each) => each.currency === newest?.currency);
  if (newest && same.length > 1) {
    const values = same.map((each) => each.amount!);
    const low = Math.min(...values);
    const high = Math.max(...values);
    if (high > 0 && (low === 0 || (high - low) / low > 0.25)) {
      confidence -= 0.1;
      const first = values[0]!;
      const last = values.at(-1)!;
      reasons.push(first !== last ? `the amount changed from ${money(first)} to ${money(last)}` : `the amounts range from ${money(low)} to ${money(high)}`);
    }
  }
  // on the owner's real mail, the meals and the rides of a habit came at a weekly or monthly gap too. a plan states its
  // cadence, says that it renews, or charges the same amount each time, so charges that do none of these are doubtful.
  if (!stated && !recurring && new Set(same.map((each) => each.amount)).size > 1) {
    confidence -= 0.2;
    reasons.push('no receipt says that the plan renews, and the amounts differ');
  }
  const currencies = new Set(amounts.map((each) => each.currency ?? '?')).size;
  if (currencies > 1) {
    confidence -= 0.2;
    reasons.push(`the charges are in ${currencies} currencies`);
  }
  const last = sorted.at(-1);
  const nextChargeAt = cadence === gaps.cadence ? gaps.nextChargeAt : last ? nextChargeAfter(Date.parse(last.chargedAt), cadence) : null;
  // a plan whose next charge is well past with no new receipt may have ended. the owner's real rows held plans whose
  // last charge was months old, and they made the monthly total many times too high.
  if (now && last && nextChargeAt && cadence !== 'unknown' && Date.parse(nextChargeAt) + GRACE_DAYS[cadence] * DAY_MS < now.getTime()) {
    confidence = Math.min(confidence, 0.3);
    reasons.push(`no charge since ${last.chargedAt.slice(0, 10)}, so it may have ended`);
  }
  confidence = Math.round(Math.min(1, Math.max(0, confidence)) * 100) / 100;
  const subscription = confidence >= 0.5 || stated !== null || recurring;
  // a row that the finder keeps never has confidence 0. that value marks a row that the receipts no longer support,
  // which the page hides, so a kept row with many doubts stays in view.
  if (subscription) confidence = Math.max(MIN_KEPT, confidence);
  return { cadence, cadenceSource: source, nextChargeAt, confidence, reasons, subscription };
}

// the lowest confidence of a row that the finder keeps.
const MIN_KEPT = 0.05;
// the days after the expected next charge before a plan counts as possibly ended.
const GRACE_DAYS: Record<StatedCadence, number> = { weekly: 7, monthly: 10, quarterly: 20, yearly: 30 };

const DAY_MS = 24 * 60 * 60 * 1000;
// the confidence of a plan that the receipts state or that renews, which the gaps do not confirm yet.
const UNCONFIRMED = 0.5;

const GAP_WORDS: Record<StatedCadence, string> = { weekly: 'a week', monthly: 'a month', quarterly: '3 months', yearly: 'a year' };

const money = (amount: number) => amount.toFixed(2);

// the cadence that most receipts state. a tie goes to the newest receipt.
function statedOf(sorted: readonly ChargeFact[]): StatedCadence | null {
  const counts = new Map<StatedCadence, number>();
  for (const each of sorted) if (each.statedCadence) counts.set(each.statedCadence, (counts.get(each.statedCadence) ?? 0) + 1);
  let best: StatedCadence | null = null;
  let most = 0;
  for (const each of [...sorted].reverse()) {
    const count = each.statedCadence ? counts.get(each.statedCadence)! : 0;
    if (count > most) {
      best = each.statedCadence;
      most = count;
    }
  }
  return best;
}

// the currencies. a code is three capital letters as a word of its own, a sign is one character, and a dollar sign
// can have the letters of its country before it. a code wins over a sign, so "$12.00 CAD" is CAD.
const CODES = ['USD', 'EUR', 'GBP', 'JPY', 'CAD', 'AUD', 'NZD', 'INR', 'CHF', 'CNY', 'HKD', 'SGD', 'SEK', 'NOK', 'DKK', 'MXN', 'BRL', 'KRW', 'PLN', 'ZAR'];
const CODE = CODES.join('|');
const SIGNS: Record<string, string> = { '€': 'EUR', '£': 'GBP', '¥': 'JPY', '₹': 'INR', '₩': 'KRW' };
const DOLLARS: Record<string, string> = { '': 'USD', US: 'USD', CA: 'CAD', C: 'CAD', A: 'AUD', AU: 'AUD', NZ: 'NZD', HK: 'HKD', S: 'SGD' };
const MINUS = new Set(['-', '−']);
// one amount: an optional code and an optional sign before the number, and an optional sign or code after it. a
// number inside a longer number, or a code inside a word, does not start one.
const AMOUNT = new RegExp(
  String.raw`(?<![\d.,])(?:(?<!\p{L})(?<code>${CODE})(?!\p{L})\s?)?(?<sign>(?:(?<!\p{L})(?<dollar>US|CA|AU|NZ|HK|C|A|S))?\$|[€£¥₹₩])?\s?(?<minus>[-−]\s?)?(?<number>\d{1,3}(?:[   ]\d{3})+(?:,\d{1,2})?(?![\d.,])|\d[\d.,]*\d|\d)(?!\d)(?<post>\s?(?:[€£¥₹₩]|(?<!\p{L})(?:${CODE})(?!\p{L})))?`,
  'gu',
);
// the labels of the amount that was paid. "subtotal" is not one, because the word boundary keeps it out.
const TOTAL_LABEL = /\b(?:total|amount charged|you paid|amount paid)\b/i;

function currencyOf(code: string | undefined, sign: string | undefined, dollar: string | undefined): string | null {
  if (code) return code;
  if (!sign) return null;
  if (sign.endsWith('$')) return DOLLARS[dollar ?? ''] ?? null;
  return SIGNS[sign] ?? null;
}

// the value of a number with its separators. the last of two kinds of separator is the decimal one, so "1.234,56" and
// "1,234.56" are the same. a single separator with three digits after it groups thousands, so "¥1,200" is 1200, and
// with one or two digits after it, it is the decimal one, so "9,99" is 9.99. any other shape is not an amount.
function numberOf(spaced: string): number | null {
  // a space, a no-break space or a thin space between groups of three digits groups thousands, as in "1 234,56 €".
  const raw = spaced.replace(/[   ]/g, '');
  const dot = raw.lastIndexOf('.');
  const comma = raw.lastIndexOf(',');
  let decimal: string | null = null;
  if (dot >= 0 && comma >= 0) decimal = dot > comma ? '.' : ',';
  else if (dot >= 0 || comma >= 0) {
    const parts = raw.split(dot >= 0 ? '.' : ',');
    if (parts.length === 2 && parts[1]!.length <= 2) decimal = dot >= 0 ? '.' : ',';
  }
  let whole = raw;
  let fraction = '0';
  if (decimal) {
    const at = raw.lastIndexOf(decimal);
    whole = raw.slice(0, at);
    fraction = raw.slice(at + 1);
    if (!/^\d{1,2}$/.test(fraction)) return null;
  }
  const groups = whole.split(/[.,]/);
  if (groups.length > 1 && (!/^\d{1,3}$/.test(groups[0]!) || groups.slice(1).some((each) => !/^\d{3}$/.test(each)))) return null;
  const digits = groups.join('');
  if (!/^\d+$/.test(digits)) return null;
  return Number(`${digits}.${fraction}`);
}

// the offset where each line of a text starts.
function lineStarts(text: string): number[] {
  const starts = [0];
  for (let at = text.indexOf('\n'); at >= 0; at = text.indexOf('\n', at + 1)) starts.push(at + 1);
  return starts;
}

function lineOf(starts: readonly number[], offset: number): number {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (starts[middle]! <= offset) low = middle;
    else high = middle - 1;
  }
  return low;
}

// the nearest line before a line that holds text. one empty line can stand between them.
function previousLine(text: string, starts: readonly number[], line: number): string | null {
  for (let each = line - 1; each >= Math.max(0, line - 2); each--) {
    const value = text.slice(starts[each]!, starts[each + 1]! - 1);
    if (value.trim()) return value;
  }
  return null;
}

function hasAmount(line: string): boolean {
  for (const match of line.matchAll(AMOUNT)) if (match.groups?.sign || match.groups?.code || match.groups?.post) return true;
  return false;
}

// the cadences that a receipt can state. "every 12 months" is yearly and "every 3 months" is quarterly.
const STATED: Array<[StatedCadence, RegExp]> = [
  ['weekly', /\b(?:weekly|per week|every week|each week)\b|\/\s?(?:wk|week)\b/i],
  ['monthly', /\b(?:monthly|per month|every month|each month|month-to-month)\b|\/\s?(?:mo|mth|month)\b/i],
  ['quarterly', /\b(?:quarterly|per quarter|every (?:3|three) months)\b/i],
  ['yearly', /\b(?:yearly|annual|annually|per year|every year|each year|every (?:12|twelve) months)\b|\/\s?(?:yr|year)\b/i],
];

const REFUND_SUBJECT = /\brefund|\bmoney back\b/i;
const REFUND_TEXT =
  /\b(?:refund(?:ed)? (?:of|for)\b|(?:issued|processed|sent|initiated|approved) (?:a |your |the )?refund|refund (?:has been|was|is) (?:issued|processed|sent|approved|on its way)|(?:been|was|were) refunded|we(?:'ve| have) refunded|money back)/i;
// a payment that was made. "paid" alone counts, except in "to be paid", "not paid" or "mark it as paid".
const PAID =
  /\b(?:you paid|amount paid|total paid|(?<!\b(?:be|not|as|not been|n't been) )paid\b|payment (?:received|successful|was successful|processed|confirmed|complete|completed)|(?:was|were|been|we|we've|we have) (?:charged|billed)\b|charged to your|total charged|amount charged|thanks? (?:you )?for (?:your )?(?:payment|purchase|renewing|subscribing|gift|donation|contribution)|thanks for riding|(?:has|have|was|been) renewed|you sent|automatic payment|invoice paid)/i;
const PAID_SUBJECT = /\b(?:receipt|payment received|paid)\b/i;
// a notice that moves no money yet: a trial that ends or a price that changes.
const NOTICE = /\b(?:free trial|your trial|trial (?:ends|will end|is ending|ending|expires)|price (?:change|increase|update|is changing|will change|goes up)|new price|prices? (?:are|is) (?:going up|changing))\b/i;
// an offer, which a real receipt can also carry in its footer.
const OFFER = /\b(?:special offer|limited time|upgrade (?:now|today)|subscribe (?:now|today))\b|\d% off\b/i;
// a payment that did not go through. "update your payment method" alone is not one, because a real receipt often
// has it in its footer.
const FAILED =
  /\b(?:payment (?:has |was )?(?:failed|declined|unsuccessful)|(?:was|were|been) declined|could not (?:be )?(?:charged?|processed?)|couldn't (?:charge|process)|unable to (?:charge|process)|was not (?:processed|successful)|unsuccessful (?:payment|charge))\b/i;
// the words that a receipt or an invoice uses without saying that a payment was made.
const WEAK_PAID = /\b(?:receipt|invoice|payment)\b/i;
const ORDER =
  /\b(?:order confirm(?:ation|ed)?|order (?:has been )?(?:placed|received)|thanks? (?:you )?for your order|your order\b|shipped|shipment|out for delivery|(?:was|has been) delivered|arriving|track (?:your )?(?:package|order|shipment)|amount due|due date|payment due|balance due|past due|minimum payment|(?:is|are) due\b|due (?:on|by)\b|statement is (?:ready|available)|bill is (?:ready|available)|invoice is (?:ready|available)|pre-?order)/i;

// the payee of a payment platform: "payment to X", "paid X", "sent ... to X". the name ends at a word such as "for",
// at a mark or at an amount.
const PAYEE = /\b(?:payment to|(?:paid|sent) [^\n]{0,40}? to|you paid)\s+([^\n]{1,100})/i;
const PAYEE_END = /\s+(?:for|on|with|of|via)\s+|\s+(?:was|is|has|have|were)\b|\s+[-–—|]\s+|[,.!?:;()[\]$€£¥₹\d]/;

// the name of the from header without the address and the quotes.
function displayName(from: string): string {
  const name = cleanLine(from.replace(/<[^<>]*>\s*$/, ''), 100).replace(/^"|"$/g, '').trim();
  return name.includes('@') ? '' : name;
}
