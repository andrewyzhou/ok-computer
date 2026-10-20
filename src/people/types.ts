import type { PersonContactRole } from '../dashboard/people-types.js';

// the shapes that the builder gives the store. the builder reads google headers and attendees, and the store writes
// 023_people.sql. neither side knows the other's details.

// an address from a header or an attendee. email is already in lower case and checked; name is the display name
// without quotes, or null when the header had none or the name was only the address again.
export interface ObservedAddress {
  email: string;
  name: string | null;
}

export interface Organization {
  // a name for people, for example "Acme" for acme.com.
  name: string;
  // the registrable domain, for example acme.com for mail.eu.acme.com.
  domain: string;
}

// one item that a person was in. the key of the item for a person is (kind, account, externalId).
export interface Contact {
  kind: 'mail' | 'meeting';
  account: string;
  externalId: string;
  threadId: string | null;
  direction: 'in' | 'out' | null;
  role: PersonContactRole;
  // the subject line or the event title, cleaned and cut to 200 characters, or null.
  subject: string | null;
  at: string;
  endAt: string | null;
  cancelled: boolean;
}

// one person in one item: what the builder gives the store for each address that is not noise.
export interface Observation {
  address: ObservedAddress;
  organization: Organization | null;
  contact: Contact;
}

// what the store did with one observation.
export interface Recorded {
  personId: number;
  // true when the email was new, so a person was made.
  createdPerson: boolean;
  // true when the contact row was new. false when the item came again and its row was only updated.
  createdContact: boolean;
}

// why an address or a mail was left out. the builder counts these for its log line and for the real-data check.
export type NoiseReason =
  | 'owner'
  | 'invalid'
  | 'no_reply'
  | 'notification'
  | 'role_address'
  | 'calendar_resource'
  | 'mailing_list'
  | 'bulk'
  | 'auto_submitted'
  | 'too_many_recipients'
  | 'large_meeting';
