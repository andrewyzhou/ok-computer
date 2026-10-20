// the shapes that phase 6 t2 adds to the inbox api, and the shape that the morning brief reads. the web pages import
// this file, so it holds types only and imports nothing. the shapes of phase 5 m8 stay in types.ts, which uses these.

// who wrote a mail, as the code decides it from the headers. person: a human wrote it to the owner. list: the mail of a
// mailing list or a newsletter, also when a human wrote it. automated: a machine sent it (a no-reply sender, a
// notification, a receipt, a security alert). only a person mail can be in needs_reply.
export type MailKind = 'person' | 'list' | 'automated';

// the counts of one account in one digest.
export interface DigestAccountStats {
  alias: string;
  // the messages that the digest search listed, and the messages that it read in full.
  listed: number;
  read: number;
  // true when the account had more mail than the read limit, so the digest saw only the newest part of it.
  capped: boolean;
  // the read mail of each kind.
  person: number;
  list: number;
  automated: number;
  // the read mail that no item shows, because a machine or a list sent it and it holds no deadline, bill or package.
  hidden: number;
  // the reason the account was not read, or null when it was read.
  error: string | null;
}

// the counts of one digest. accounts holds each configured account, also one that could not be read.
export interface DigestStats {
  accounts: DigestAccountStats[];
  // the deadlines that the model gave and the code dropped, because the mail does not state the date.
  droppedDates: number;
  // the deadlines and bills that the digest left out because their due time had passed. absent in an older digest.
  pastDue?: number;
  // the deadlines that the digest left out because the mail is a calendar invitation, which the calendar shows, or
  // confirms a thing that the owner already did, such as a submitted form. absent in an older digest.
  notDeadlines?: number;
}

// where the cadence of a subscription comes from. stated: the receipts say it. gaps: the time between the charges.
// both: the two agree. none: the cadence is unknown.
export type CadenceSource = 'stated' | 'gaps' | 'both' | 'none';

// one mail item of the brief. link is the hash route of the dashboard page that shows it.
export interface BriefInboxItem {
  account: string;
  messageId: string;
  threadId: string;
  from: string;
  subject: string;
  summary: string;
  dueAt: string | null;
  amount: number | null;
  currency: string | null;
  draftId: number | null;
  proposalId: number | null;
  link: string;
}

// the inbox part of the morning brief, read from the newest digest of a day. stale is true when the newest digest is
// from an earlier day, so the brief can say that the digest of today did not run. hidden is the sum of the hidden
// mail of all accounts. unread lists the accounts that the digest could not read.
export interface BriefInbox {
  digestId: number;
  day: string;
  createdAt: string;
  stale: boolean;
  accounts: string[];
  unread: string[];
  needsReply: BriefInboxItem[];
  deadlines: BriefInboxItem[];
  bills: BriefInboxItem[];
  packages: BriefInboxItem[];
  hidden: number;
}
