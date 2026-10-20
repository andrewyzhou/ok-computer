import type { gmail_v1 } from '@googleapis/gmail';
import type { UnsubscribeMethod } from '../dashboard/types.js';

// the grouping of the newsletter sweep on real mail. a group must never hold two senders: a List-Id that a platform
// shares between its customers, a no-reply address that sends for many organisers, and a sender that changes its
// display name must each end up right. the work package "newsletters" builds this module and moves senderOf and
// unsubscribeOf of newsletters.ts onto it.

// the identity of the sender of one list mail. senderKey is the key of inbox_senders: at most 200 characters, in lower
// case, and stable across sweeps, so a row that the owner kept or unsubscribed keeps its state.
export interface SenderIdentity {
  senderKey: string;
  listId: string | null;
  fromAddress: string;
  // the registrable domain of the from address, for example "example.co.uk" for "news@mail.example.co.uk".
  fromDomain: string;
  displayName: string | null;
}

// registrableDomain gives the domain under the public suffix of a host name, in lower case, from a short list of the
// common suffixes of two labels (co.uk, com.au, ac.uk, edu.au and the like). an ip address or a host with one label
// is given back as it is.
export function registrableDomain(_host: string): string {
  throw new Error('not built: registrableDomain (work package newsletters)');
}

// senderIdentityOf gives the identity of the sender of a list mail, or undefined for a mail that is not list mail (no
// List-Id and no List-Unsubscribe) or has no from address.
export function senderIdentityOf(_message: gmail_v1.Schema$Message): SenderIdentity | undefined {
  throw new Error('not built: senderIdentityOf (work package newsletters)');
}

// the unsubscribe of one message. url is always one of the targets that unsubscribeTargets of src/google/unsubscribe.ts
// gives for the same header, because the tool compares them at run time.
export interface UnsubscribeChoice {
  method: UnsubscribeMethod;
  url: string | null;
}

// unsubscribeChoiceOf reads List-Unsubscribe and List-Unsubscribe-Post of a message. it handles several targets in
// any order, folded header lines, spaces in the angle brackets, an http target (never used), a mailto target with a
// subject, a post header in another case, and a header without angle brackets.
export function unsubscribeChoiceOf(_message: gmail_v1.Schema$Message): UnsubscribeChoice {
  throw new Error('not built: unsubscribeChoiceOf (work package newsletters)');
}
