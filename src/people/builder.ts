import type { calendar_v3 } from '@googleapis/calendar';
import type { gmail_v1 } from '@googleapis/gmail';
import type { Db } from '../db/index.js';
import type { Logger } from '../observability/logger.js';
import type { Clock } from '../time.js';
import { notBuilt } from './not-built.js';
import type { PeopleStore } from './store.js';
import type { NoiseReason, Observation } from './types.js';

// the builder turns google headers and attendees into observations for the store. it reads only header fields and
// attendee lists, never a body. the pure functions do the work, so the tests and the real-data check can run them on
// plain data. createPeopleBuilder wraps them for the polls and the backfill.

// the gmail metadata headers that the builder needs. the poll and the backfill ask gmail for these.
export const PEOPLE_HEADERS = ['From', 'To', 'Cc', 'Subject', 'List-Id', 'List-Unsubscribe', 'Precedence', 'Auto-Submitted'] as const;

// the addresses of the owner, in lower case. a mail from one of them is direction out, and they never make a person.
export type OwnerAddresses = ReadonlySet<string>;

// what one mail or one batch of events gave. skipped counts the left-out addresses (or the whole item for a mail or
// meeting reason) by reason, so a log line and the real-data check can show the noise without any address.
export interface BuildResult {
  observations: Observation[];
  skipped: Partial<Record<NoiseReason, number>>;
}

// ownerAddresses reads the owner's addresses: the email of every google_accounts row, and the expected addresses of
// the config that the caller gives.
export function ownerAddresses(db: Db, extra: readonly string[] = []): OwnerAddresses {
  void db;
  void extra;
  return notBuilt('ownerAddresses');
}

// mailObservations reads one gmail message in the metadata format with PEOPLE_HEADERS.
// - mailNoise on the headers and labels leaves the whole mail out. a message in SPAM or TRASH, or a draft, is out too.
// - a From address of the owner makes the mail direction out: each To and Cc address becomes a person with role to
//   or cc. any other From makes direction in: the From address gets role from, and the other To and Cc addresses
//   (not the owner) get role to or cc, so a person cc'd with the owner is known too.
// - more than MAX_MAIL_RECIPIENTS To and Cc addresses together: only the From person stays (too_many_recipients).
// - each address goes through addressNoise. the owner's addresses are skipped with reason owner.
// - kind mail, externalId the message id, threadId the thread id, at the internal date, subject the Subject cleaned
//   and cut to 200 characters (cleanLine of src/signals/store.ts), endAt null, cancelled false.
// - the organization of each address comes from organizationOf on its domain.
export function mailObservations(account: string, message: gmail_v1.Schema$Message, owner: OwnerAddresses): BuildResult {
  void account;
  void message;
  void owner;
  return notBuilt('mailObservations');
}

// eventObservations reads events of calendar events.list (singleEvents true).
// - an event without an id or a start is left out. an event with more than MAX_MEETING_ATTENDEES attendees is left
//   out (large_meeting), and so is an event with no attendee but the owner (a hold makes no person).
// - the organizer (when it is not the owner and not a calendar group) gets role organizer, and each other attendee
//   gets role attendee. a resource attendee and each addressNoise address are skipped.
// - kind meeting, externalId the event id, threadId and direction null, subject the summary cleaned and cut to 200
//   characters, at the start (an all-day date becomes midnight in timeZone), endAt the end the same way.
// - cancelled is true when the event status is cancelled, or when that attendee declined. a cancelled event in a
//   sync list often has no attendees: it then gives no observation, and observeEvents marks its rows with cancelMeetings of the store.
export function eventObservations(account: string, events: readonly calendar_v3.Schema$Event[], owner: OwnerAddresses, timeZone: string): BuildResult {
  void account;
  void events;
  void owner;
  void timeZone;
  return notBuilt('eventObservations');
}

export interface PeopleBuilderDeps {
  db: Db;
  clock: Clock;
  logger: Logger;
  timeZone: string;
  // the expected addresses of the google accounts in the config, which also count as the owner's.
  ownerEmails?: readonly string[];
  // the default is the real store. the tests give a fake.
  store?: Pick<PeopleStore, 'recordObservations' | 'cancelMeetings'>;
}

// the builder of the polls and the backfill. each method writes what it found through the store and never throws: a
// failure is logged with the account and the counts (never an address or a subject), and the poll goes on.
export interface PeopleBuilder {
  observeMail(account: string, messages: readonly gmail_v1.Schema$Message[]): BuildResult;
  // the events of a read of the calendar. a cancelled event without attendees marks the meeting rows of that event as
  // cancelled, so a meeting that was called off leaves the upcoming list.
  observeEvents(account: string, events: readonly calendar_v3.Schema$Event[]): BuildResult;
}

export function createPeopleBuilder(deps: PeopleBuilderDeps): PeopleBuilder {
  void deps;
  return {
    observeMail: () => notBuilt('observeMail'),
    observeEvents: () => notBuilt('observeEvents'),
  };
}
