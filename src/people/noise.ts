import { domainOf, normalizeEmail, parseAddressList } from './address.js';
import type { NoiseReason, ObservedAddress } from './types.js';

// the noise rules of the people memory. a person is someone the owner writes to or meets, so automated senders,
// mailing lists and very large meetings never make one. each rule says why, so the builder can count the reasons.

// a meeting with more attendees than this (the owner included) makes no person at all: an all-hands or a lecture.
export const MAX_MEETING_ATTENDEES = 25;
// a meeting with more attendees than this (and at most MAX_MEETING_ATTENDEES) makes no new person: it only adds the
// meeting to the people that mail or a smaller meeting made already, so a section or a seminar does not flood the list.
export const MAX_NEW_PERSON_ATTENDEES = 15;
// a mail with more To and Cc addresses than this keeps its From person but makes no person from its recipients.
export const MAX_MAIL_RECIPIENTS = 20;

// the headers of one mail that the noise rules read. a header that the message did not have is '' (or left out, for
// sender and messageId).
export interface MailNoiseHeaders {
  listId: string;
  // the Sender header: the system that sent a mail in the name of the From person, for example google calendar.
  sender?: string;
  messageId?: string;
  listUnsubscribe: string;
  precedence: string;
  autoSubmitted: string;
  // the gmail labels of the message, for example CATEGORY_PROMOTIONS.
  labels: readonly string[];
}

// addressNoise says why one address is not a person, or null when it can be one. it covers no-reply local parts
// (noreply, no-reply, donotreply, do-not-reply, bounce, mailer-daemon, postmaster), notification addresses
// (notifications@, notification@, alerts@, updates@, news@, newsletter@, digest@, calendar-notification@google.com,
// the github and drive notification senders), role addresses that no one person reads (info@, support@, billing@,
// team@, hello@, sales@, admin@, help@, receipts@, orders@, security@), the calendar resources and groups
// (resource.calendar.google.com, group.calendar.google.com, group.v.calendar.google.com, an attendee with resource
// set) and addresses with a long random tag (bounces+abc123...@). a name such as "Jane via Google Docs" or
// "Jane (via Slack)" is a notification too. comment is the text in parentheses of the header, which parseAddressList
// gives apart from the name, so "Jane (via Slack) <jane@x.com>" is caught as well.
export function addressNoise(address: ObservedAddress, options: { resource?: boolean; comment?: string | null } = {}): NoiseReason | null {
  const email = normalizeEmail(address.email);
  if (!email) return 'invalid';
  const domain = domainOf(email);
  if (options.resource || CALENDAR_DOMAIN.test(domain)) return 'calendar_resource';
  const local = email.slice(0, email.lastIndexOf('@'));
  // the plus tag is not part of the name of the mailbox: noreply+xyz is noreply.
  const plus = local.indexOf('+');
  const box = plus === -1 ? local : local.slice(0, plus);
  const tag = plus === -1 ? '' : local.slice(plus + 1);
  if (NO_REPLY.test(box) || NO_REPLY_PREFIX.test(box) || RANDOM_TAG.test(tag)) return 'no_reply';
  if (NOTIFICATION.test(box) || box === 'news' || NOTIFICATION_ADDRESSES.has(email) || NOTIFICATION_DOMAINS.has(domain) || SENDING_DOMAIN.test(domain)) {
    return 'notification';
  }
  const shown = `${address.name ?? ''} ${options.comment ? `(${options.comment})` : ''}`.trim();
  if (shown && (VIA_PAREN.test(shown) || VIA_WORD.test(shown))) return 'notification';
  if (ROLE_BOXES.has(box) || ROLE_PARTS.test(box)) return 'role_address';
  return null;
}

// a word of the mailbox name: the whole name, or a part of it between dots, dashes and underscores.
const segment = (words: string) => new RegExp(`(^|[.\\-_])(${words})($|[.\\-_])`, 'i');
const NO_REPLY = segment('no-?reply|no_reply|do-?not-?reply|do_not_reply|mailer-daemon|postmaster|bounces?');
// a mailbox name that starts with no-reply is no-reply also without a separator after it, for example noreplyteam@.
const NO_REPLY_PREFIX = /^(no-?reply|do-?not-?reply)/i;
const NOTIFICATION = segment('notifications?|notify|noti|alerts?|updates?|newsletters?|digest');
// a subdomain that a company keeps for its automated mail, for example notify@updates.acme.com or x@em123.acme.com.
const SENDING_DOMAIN = /^(updates?|notifications?|notify|alerts?|mailer|email|em\d*|news|bounces?|warnme)\./;
// a tag of 16 letters and digits or more is made by a machine for each mail, for example bounces+abc123...@.
const RANDOM_TAG = /^(?=.*\d)[a-z0-9=._-]{16,}$/i;
const NOTIFICATION_ADDRESSES = new Set(['calendar-notification@google.com', 'drive-shares-noreply@google.com', 'drive-shares-dm-noreply@google.com', 'comments-noreply@docs.google.com']);
const NOTIFICATION_DOMAINS = new Set(['reply.github.com', 'notifications.github.com']);
// the resources and the shared calendars of google calendar: rooms, groups and imported calendars.
const CALENDAR_DOMAIN = /(^|\.)calendar\.google\.com$/;
// "Jane (via Google Docs)" or "Jane via Slack": a product writes in the name of a person.
const VIA_PAREN = /\(via [^)]+\)/i;
const VIA_WORD = /\svia\s+[A-Z]/;
// mailboxes that a team reads, so no one person is behind them.
const ROLE_BOXES = new Set([
  'info',
  'support',
  'billing',
  'team',
  'hello',
  'sales',
  'admin',
  'help',
  'receipts',
  'orders',
  'security',
  'contact',
  'scheduling',
  'account',
  'accounts',
  'volunteer',
  'recruiting',
  'careers',
  'jobs',
  'noreply',
  'events',
]);
// a recruiting mailbox has many forms, for example university.recruiting@ or universityrecruiting2026@.
const ROLE_PARTS = /recruiting/;

// mailNoise says why a whole mail makes no person, or null when it can: a mail that google calendar sent for an
// invitation, an update or an answer (calendar_mail: its Sender is calendar-notification@google.com, or its Message-ID
// is <calendar-...@google.com>, while its From is the organizer or the owner), a List-Id (mailing_list), a List-Unsubscribe
// or the CATEGORY_PROMOTIONS, CATEGORY_UPDATES, CATEGORY_SOCIAL or CATEGORY_FORUMS label (bulk), Precedence bulk,
// list or junk (bulk), or Auto-Submitted with any value but "no" (auto_submitted).
export function mailNoise(headers: MailNoiseHeaders): NoiseReason | null {
  if (isCalendarMail(headers)) return 'calendar_mail';
  if (headers.listId.trim()) return 'mailing_list';
  if (headers.listUnsubscribe.trim() || headers.labels.some((label) => BULK_LABELS.has(label))) return 'bulk';
  if (BULK_PRECEDENCE.has(headers.precedence.trim().toLowerCase())) return 'bulk';
  const auto = headers.autoSubmitted.trim().toLowerCase();
  if (auto && auto !== 'no') return 'auto_submitted';
  return null;
}

const BULK_LABELS = new Set(['CATEGORY_PROMOTIONS', 'CATEGORY_UPDATES', 'CATEGORY_SOCIAL', 'CATEGORY_FORUMS']);
const BULK_PRECEDENCE = new Set(['bulk', 'list', 'junk']);

// the meeting of a calendar mail is already counted from the calendar read, so the mail would count it twice and look
// like an open thread.
function isCalendarMail(headers: MailNoiseHeaders): boolean {
  if (parseAddressList(headers.sender ?? '').some((each) => each.email === CALENDAR_SENDER)) return true;
  const id = (headers.messageId ?? '').trim().toLowerCase();
  return id.startsWith('<calendar-') && id.endsWith('@google.com>');
}

const CALENDAR_SENDER = 'calendar-notification@google.com';
