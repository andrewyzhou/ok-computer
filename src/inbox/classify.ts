import type { gmail_v1 } from '@googleapis/gmail';
import type { MailKind } from '../dashboard/inbox-types.js';

// who wrote a mail, decided in code from its headers before any model reads it. the digest shows a mail in
// needs_reply only when a person wrote it, so a notification, a receipt or a security alert never asks the owner for a
// reply, whatever the model says about it. the work package "digest" builds this module.

export interface MailClass {
  kind: MailKind;
  // true when an owner address is in To, so the mail is to the owner and not only a copy or a list mail.
  direct: boolean;
  // true when the owner wrote the last mail of the thread or the mail is from an owner address.
  fromOwner: boolean;
  // short reasons in plain words, for example "no-reply sender" or "List-Id header", for the quality check. they
  // never hold text of the mail.
  reasons: string[];
}

// classifyMail reads the headers of a message (From, To, Cc, Reply-To, List-Id, List-Unsubscribe, Precedence,
// Auto-Submitted, Return-Path, Sender and the X- headers of bulk senders) and the labels of gmail. owner holds the
// owner's addresses in lower case, from ownerAddresses of accounts.ts.
export function classifyMail(_message: gmail_v1.Schema$Message, _owner: ReadonlySet<string>): MailClass {
  throw new Error('not built: classifyMail (work package digest)');
}
