import { notBuilt } from './not-built.js';
import type { NoiseReason, ObservedAddress } from './types.js';

// the noise rules of the people memory. a person is someone the owner writes to or meets, so automated senders,
// mailing lists and very large meetings never make one. each rule says why, so the builder can count the reasons.

// a meeting with more attendees than this (the owner included) makes no person at all: an all-hands or a lecture.
export const MAX_MEETING_ATTENDEES = 25;
// a mail with more To and Cc addresses than this keeps its From person but makes no person from its recipients.
export const MAX_MAIL_RECIPIENTS = 20;

// the headers of one mail that the noise rules read. a header that the message did not have is ''.
export interface MailNoiseHeaders {
  listId: string;
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
// "Jane (via Slack)" is a notification too.
export function addressNoise(address: ObservedAddress, options: { resource?: boolean } = {}): NoiseReason | null {
  void address;
  void options;
  return notBuilt('addressNoise');
}

// mailNoise says why a whole mail makes no person, or null when it can: a List-Id (mailing_list), a List-Unsubscribe
// or the CATEGORY_PROMOTIONS, CATEGORY_UPDATES, CATEGORY_SOCIAL or CATEGORY_FORUMS label (bulk), Precedence bulk,
// list or junk (bulk), or Auto-Submitted with any value but "no" (auto_submitted).
export function mailNoise(headers: MailNoiseHeaders): NoiseReason | null {
  void headers;
  return notBuilt('mailNoise');
}
