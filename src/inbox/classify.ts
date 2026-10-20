import type { gmail_v1 } from '@googleapis/gmail';
import type { MailKind } from '../dashboard/inbox-types.js';
import { fromAddress, header } from '../google/mime.js';

// who wrote a mail, decided in code from its headers before any model reads it. the digest shows a mail in
// needs_reply only when a person wrote it, so a notification, a receipt or a security alert never asks the owner for a
// reply, whatever the model says about it. the check reads the headers and the labels only, never the body, so the
// text of a mail cannot change its kind.

export interface MailClass {
  kind: MailKind;
  // true when an owner address is in To, so the mail is to the owner and not only a copy or a list mail.
  direct: boolean;
  // true when the mail is from an owner address.
  fromOwner: boolean;
  // short reasons in plain words, for example "no-reply sender" or "List-Id header", for the quality check. they
  // never hold text of the mail.
  reasons: string[];
}

// the local parts of senders that nobody reads the answers of, without "-" and "_" and in lower case. a "+tag" after
// the local part is left out before the check.
const MACHINE_LOCAL = new Set(['noreply', 'donotreply', 'notifications', 'notification', 'mailerdaemon', 'postmaster', 'bounce', 'bounces', 'alerts']);

// the local parts of the shared mailboxes that receipts, statements, shipping news and account mail come from. a
// person seldom writes from one, so a mail from one without list headers counts as automated. a mail from one with
// list headers stays a list mail, because a newsletter is often sent from such a box.
const ROLE_LOCAL = new Set([
  'account',
  'accounts',
  'autoconfirm',
  'billing',
  'bills',
  'ebill',
  'ebills',
  'hello',
  'info',
  'invoice',
  'invoices',
  'news',
  'newsletter',
  'notify',
  'order',
  'orders',
  'payment',
  'payments',
  'receipt',
  'receipts',
  'refund',
  'refunds',
  'returns',
  'security',
  'service',
  'shipconfirm',
  'shipment',
  'shipping',
  'statement',
  'statements',
  'updates',
]);

// the x- headers that bulk senders add to each mail they send: an id of a campaign, of a mailing or of a batch, the
// variables or the tag of the sending service, and its abuse and complaint addresses. a mail client of a person adds
// none of them. feedback-id is the header that bulk senders give the big mail providers.
const BULK_HEADER =
  /^(?:feedback-id|x-(?:campaign|campaign-?id|mailing-?id|bulk|newsletter|report-abuse|csa-complaints|smtpapi|mc-user)(?:-[a-z0-9-]+)?|x-[a-z0-9]+-(?:campaign(?:-?id)?|variables|outgoing|sid|tags?|mailing-?id|batch-?id|message-?info|esp))$/i;

// the auto-reply headers of the mail servers that write out-of-office answers.
const AUTO_REPLY_HEADER = /^x-auto-?re(?:ply|spond|sponse)$/i;

// the reply address of a notification: a local part of "reply" and a long token, so the answer reaches the thread.
const REPLY_TOKEN = /^reply[+=._-][a-z0-9_=.+-]{6,}$/i;

// the addresses of an address header such as To or Cc. a comma inside quotes or inside angle brackets does not end an
// address. a part that is not one plain address is left out.
export function addressesOf(value: string): string[] {
  const out: string[] = [];
  let part = '';
  let quoted = false;
  let angle = false;
  for (const char of value) {
    if (char === '"' && !angle) quoted = !quoted;
    else if (char === '<' && !quoted) angle = true;
    else if (char === '>' && !quoted) angle = false;
    if ((char === ',' || char === ';') && !quoted && !angle) {
      out.push(part);
      part = '';
    } else part += char;
  }
  out.push(part);
  return out.map((each) => fromAddress(each.trim())).filter((each): each is string => each !== undefined);
}

const rawLocal = (address: string) => address.slice(0, address.lastIndexOf('@'));
const localOf = (address: string) => rawLocal(address).replace(/\+.*$/, '');
const domainOf = (address: string) => address.slice(address.lastIndexOf('@') + 1);
const plainLocal = (address: string) => localOf(address).replace(/[-_.]/g, '').toLowerCase();

// true when a part of the message is a calendar invitation.
function hasCalendar(part: gmail_v1.Schema$MessagePart | undefined | null, depth = 0): boolean {
  if (!part || depth > 20) return false;
  const type = part.mimeType?.toLowerCase() ?? '';
  if (type === 'text/calendar' || type === 'application/ics') return true;
  return (part.parts ?? []).some((each) => hasCalendar(each, depth + 1));
}

// the names of the top-level headers, in lower case.
const headerNames = (message: gmail_v1.Schema$Message) => (message.payload?.headers ?? []).map((each) => (each.name ?? '').toLowerCase());

// the signals that a machine sent the mail. each gives one fixed reason.
function machineReasons(message: gmail_v1.Schema$Message, from: string | undefined): string[] {
  const reasons: string[] = [];
  if (from) {
    const local = plainLocal(from);
    if (MACHINE_LOCAL.has(local) || local.startsWith('noreply') || local.endsWith('noreply') || local.startsWith('donotreply')) reasons.push('no-reply sender');
  }
  const auto = header(message, 'Auto-Submitted').trim().toLowerCase();
  if (auto && auto !== 'no') reasons.push('Auto-Submitted');
  const names = headerNames(message);
  if (names.some((name) => AUTO_REPLY_HEADER.test(name))) reasons.push('auto-reply header');
  if (names.some((name) => BULK_HEADER.test(name))) reasons.push('bulk sender header');
  const precedence = header(message, 'Precedence').trim().toLowerCase();
  if (precedence === 'bulk' || precedence === 'junk') reasons.push('bulk precedence');
  if (names.includes('return-path') && /^<\s*>$/.test(header(message, 'Return-Path').trim())) reasons.push('empty return path');
  if (hasCalendar(message.payload)) reasons.push('calendar invite');
  const replyTo = addressesOf(header(message, 'Reply-To'))[0];
  if (replyTo && REPLY_TOKEN.test(rawLocal(replyTo)) && (!from || domainOf(replyTo) !== domainOf(from))) reasons.push('reply token address');
  return reasons;
}

// the signals that a list sent the mail.
function listReasons(message: gmail_v1.Schema$Message): string[] {
  const reasons: string[] = [];
  if (header(message, 'List-Id').trim()) reasons.push('List-Id header');
  if (header(message, 'List-Unsubscribe').trim()) reasons.push('List-Unsubscribe header');
  if (header(message, 'Precedence').trim().toLowerCase() === 'list') reasons.push('list precedence');
  if ((message.labelIds ?? []).includes('CATEGORY_FORUMS')) reasons.push('forums label');
  return reasons;
}

// classifyMail reads the headers of a message (From, To, Reply-To, List-Id, List-Unsubscribe, Precedence,
// Auto-Submitted, Return-Path and the X- headers of bulk senders), its part types and the labels of gmail. owner holds
// the owner's addresses in lower case, from ownerAddresses of accounts.ts. a signal of a machine wins over a signal of
// a list, and a list wins over the shared mailbox of a sender.
export function classifyMail(message: gmail_v1.Schema$Message, owner: ReadonlySet<string>): MailClass {
  const from = fromAddress(header(message, 'From'));
  const fromOwner = from !== undefined && owner.has(from);
  const machine = machineReasons(message, from);
  const list = listReasons(message);
  const toOwner = addressesOf(header(message, 'To')).some((each) => owner.has(each));
  // a mail that came through a list is not to the owner, also when the list puts the owner's address in To.
  const direct = toOwner && !list.length;
  if (machine.length) return { kind: 'automated', direct, fromOwner, reasons: [...machine, ...list] };
  if (list.length) return { kind: 'list', direct, fromOwner, reasons: list };
  if (from && !fromOwner && ROLE_LOCAL.has(plainLocal(from))) return { kind: 'automated', direct, fromOwner, reasons: ['shared mailbox sender'] };
  return { kind: 'person', direct, fromOwner, reasons: from ? [] : ['no plain sender address'] };
}
