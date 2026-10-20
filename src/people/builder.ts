import type { calendar_v3 } from '@googleapis/calendar';
import type { gmail_v1 } from '@googleapis/gmail';
import type { PersonContactRole } from '../dashboard/people-types.js';
import type { Db } from '../db/index.js';
import type { Logger } from '../observability/logger.js';
import { cleanLine } from '../signals/store.js';
import { zonedToUtc, type Clock } from '../time.js';
import { cleanName, domainOf, normalizeEmail, organizationOf, parseAddressList } from './address.js';
import { addressNoise, mailNoise, MAX_MAIL_RECIPIENTS, MAX_MEETING_ATTENDEES, MAX_NEW_PERSON_ATTENDEES } from './noise.js';
import { peopleStore, type PeopleStore } from './store.js';
import type { Contact, NoiseReason, Observation, ObservedAddress } from './types.js';

// the builder turns google headers and attendees into observations for the store. it reads only header fields and
// attendee lists, never a body. the pure functions do the work, so the tests and the real-data check can run them on
// plain data. createPeopleBuilder wraps them for the polls and the backfill.

// the gmail metadata headers that the builder needs. the poll and the backfill ask gmail for these. the date is only
// read when a message has no internal date.
export const PEOPLE_HEADERS = ['From', 'To', 'Cc', 'Subject', 'Date', 'List-Id', 'List-Unsubscribe', 'Precedence', 'Auto-Submitted', 'Sender', 'Message-ID'] as const;

// the addresses of the owner, in lower case. a mail from one of them is direction out, and they never make a person.
export type OwnerAddresses = ReadonlySet<string>;

// isOwnerAddress checks an address against the owner's, also with its plus tag taken off: owner+receipts@example.com
// is the mailbox owner@example.com.
export function isOwnerAddress(owner: OwnerAddresses, email: string): boolean {
  if (owner.has(email)) return true;
  const at = email.lastIndexOf('@');
  const plus = email.indexOf('+');
  return plus > 0 && plus < at && owner.has(email.slice(0, plus) + email.slice(at));
}

// what one mail or one batch of events gave. skipped counts the left-out addresses (or the whole item for a mail or
// meeting reason) by reason, so a log line and the real-data check can show the noise without any address.
export interface BuildResult {
  observations: Observation[];
  skipped: Partial<Record<NoiseReason, number>>;
  // true when the store failed to write what was built, so the backfill keeps its position and tries again.
  failed?: boolean;
}

// ownerAddresses reads the owner's addresses: the email of every google_accounts row, the send-as addresses that the
// backfill read from gmail for each account (people_accounts.aliases), and the expected addresses of the config that
// the caller gives.
export function ownerAddresses(db: Db, extra: readonly string[] = []): OwnerAddresses {
  const rows = db.prepare('SELECT email FROM google_accounts WHERE email IS NOT NULL').all() as Array<{ email: string }>;
  const out = new Set<string>();
  for (const raw of [...rows.map((row) => row.email), ...aliasesOf(db), ...extra]) {
    const email = normalizeEmail(raw);
    if (email) out.add(email);
  }
  return out;
}

// the send-as addresses of every account, as the backfill saved them. a damaged list counts as none.
function aliasesOf(db: Db): string[] {
  const rows = db.prepare('SELECT aliases FROM people_accounts WHERE aliases IS NOT NULL').all() as Array<{ aliases: string }>;
  return rows.flatMap((row) => {
    try {
      const list: unknown = JSON.parse(row.aliases);
      return Array.isArray(list) ? list.filter((each): each is string => typeof each === 'string') : [];
    } catch {
      return [];
    }
  });
}

// mailObservations reads one gmail message in the metadata format with PEOPLE_HEADERS.
// - mailNoise on the headers and labels leaves the whole mail out. a message in SPAM or TRASH, or a draft, is out too.
// - a From address that is no-reply or a notification makes no person, and neither do the To and Cc addresses of that
//   mail: an automated sender that copies people does not make the owner know them.
// - a From address of the owner makes the mail direction out: each To and Cc address becomes a person with role to
//   or cc. any other From makes direction in: the From address gets role from, and the other To and Cc addresses
//   (not the owner) get role to or cc, so a person cc'd with the owner is known too.
// - more than MAX_MAIL_RECIPIENTS To and Cc addresses together: only the From person stays (too_many_recipients).
// - each address goes through addressNoise. the owner's addresses are skipped with reason owner.
// - kind mail, externalId the message id, threadId the thread id, at the internal date, subject the Subject cleaned
//   and cut to 200 characters (cleanLine of src/signals/store.ts), endAt null, cancelled false.
// - the organization of each address comes from organizationOf on its domain.
export function mailObservations(account: string, message: gmail_v1.Schema$Message, owner: OwnerAddresses): BuildResult {
  const result: BuildResult = { observations: [], skipped: {} };
  const labels = message.labelIds ?? [];
  if (labels.some((label) => DROPPED_LABELS.has(label))) return result;
  const header = headerReader(message);
  const at = mailTime(message.internalDate, header('Date'));
  const id = message.id;
  if (!id || !at) {
    count(result, 'invalid');
    return result;
  }
  const noise = mailNoise({
    listId: header('List-Id'),
    listUnsubscribe: header('List-Unsubscribe'),
    precedence: header('Precedence'),
    autoSubmitted: header('Auto-Submitted'),
    sender: header('Sender'),
    messageId: header('Message-ID'),
    labels,
  });
  if (noise) {
    count(result, noise);
    return result;
  }
  const from = parseAddressList(header('From'))[0];
  const to = parseAddressList(header('To', true));
  const cc = parseAddressList(header('Cc', true));
  const out = from !== undefined && isOwnerAddress(owner, from.email);
  const fromNoise = from !== undefined && !out ? noiseOf(from) : null;
  if (fromNoise === 'no_reply' || fromNoise === 'notification') {
    count(result, fromNoise);
    return result;
  }
  const subject = cleanLine(header('Subject'), 200) || null;
  const contact = (role: PersonContactRole): Contact => ({
    kind: 'mail',
    account,
    externalId: id,
    threadId: message.threadId ?? null,
    direction: out ? 'out' : 'in',
    role,
    subject,
    at,
    endAt: null,
    cancelled: false,
  });
  const candidates: Array<{ address: ObservedAddress; role: PersonContactRole }> = [];
  if (from) candidates.push({ address: from, role: 'from' });
  if (to.length + cc.length > MAX_MAIL_RECIPIENTS) count(result, 'too_many_recipients');
  else candidates.push(...to.map((address) => ({ address, role: 'to' as const })), ...cc.map((address) => ({ address, role: 'cc' as const })));
  // an address that is in more than one header is one person in this mail, with the first role that it had.
  const seen = new Set<string>();
  for (const { address, role } of candidates) {
    if (seen.has(address.email)) continue;
    seen.add(address.email);
    if (isOwnerAddress(owner, address.email)) {
      count(result, 'owner');
      continue;
    }
    const reason = noiseOf(address);
    if (reason) {
      count(result, reason);
      continue;
    }
    result.observations.push({ address, organization: organizationOf(domainOf(address.email)), contact: contact(role) });
  }
  return result;
}

// the noise of an address of a mail header, with the comment of its header part for the via rule.
const noiseOf = (address: ObservedAddress) => addressNoise(address, { comment: address.comment ?? null });

// a message in one of these labels is not mail between people: spam, the trash and the owner's own drafts.
const DROPPED_LABELS = new Set(['SPAM', 'TRASH', 'DRAFT']);

// headerReader finds a header by its name without case. a header that came more than once is joined with commas
// when join is set (to and cc), and is the first one otherwise. a missing header is ''.
function headerReader(message: gmail_v1.Schema$Message): (name: string, join?: boolean) => string {
  const headers = message.payload?.headers ?? [];
  return (name, join = false) => {
    const values = headers.filter((each) => each.name?.toLowerCase() === name.toLowerCase()).map((each) => each.value ?? '');
    return join ? values.join(', ') : (values[0] ?? '');
  };
}

// the time of a mail: the internal date in milliseconds, or else the date header, or null when neither is a time.
function mailTime(internalDate: string | null | undefined, dateHeader: string): string | null {
  const ms = Number(internalDate);
  if (internalDate && Number.isFinite(ms) && ms > 0) return new Date(ms).toISOString();
  const parsed = Date.parse(dateHeader);
  return dateHeader && Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function count(result: BuildResult, reason: NoiseReason, by = 1): void {
  result.skipped[reason] = (result.skipped[reason] ?? 0) + by;
}

// eventObservations reads events of calendar events.list (singleEvents true).
// - an event without an id or a start is left out. an event with more than MAX_MEETING_ATTENDEES attendees is left
//   out (large_meeting), and so is an event with no attendee but the owner (a hold makes no person).
// - the organizer (when it is not the owner and not a calendar group) gets role organizer, and each other attendee
//   gets role attendee. a resource attendee and each addressNoise address are skipped.
// - kind meeting, externalId the event id, threadId and direction null, subject the summary cleaned and cut to 200
//   characters, at the start (an all-day date becomes midnight in timeZone), endAt the end the same way.
// - cancelled is true when the event status is cancelled, when the owner declined it, or when that attendee declined.
//   a cancelled event in a sync list often has no attendees: it then gives no observation, and observeEvents marks
//   its rows with cancelMeetings of the store.
// - onlyKnown is set when the event was cancelled, when the owner declined it, or when it has more than
//   MAX_NEW_PERSON_ATTENDEES attendees: such an event updates the people that are known already and makes no new one,
//   so a spam invite, a declined meeting or a seminar does not fill the memory with strangers.
export function eventObservations(account: string, events: readonly calendar_v3.Schema$Event[], owner: OwnerAddresses, timeZone: string): BuildResult {
  const result: BuildResult = { observations: [], skipped: {} };
  for (const event of events) {
    const attendees = event.attendees ?? [];
    // a cancelled event of a sync list without its attendees is for cancelMeetings, not for a person.
    if (isBareCancel(event)) continue;
    const at = eventTime(event.start, timeZone);
    const id = event.id;
    if (!id || !at) {
      count(result, 'invalid');
      continue;
    }
    if (attendees.length > MAX_MEETING_ATTENDEES) {
      count(result, 'large_meeting');
      continue;
    }
    const isOwner = (email: string | null, self: boolean | null | undefined) => self === true || (email !== null && isOwnerAddress(owner, email));
    const organizerEmail = normalizeEmail(event.organizer?.email ?? '');
    const organizer =
      organizerEmail !== null && !isOwner(organizerEmail, event.organizer?.self) && addressNoise({ email: organizerEmail, name: null }) !== 'calendar_resource'
        ? organizerEmail
        : null;
    const others = attendees.filter((each) => !isOwner(normalizeEmail(each.email ?? ''), each.self));
    // a hold with only the owner makes no person, and counts nothing.
    if (organizer === null && others.length === 0) continue;
    const ownerDeclined = attendees.some((each) => isOwner(normalizeEmail(each.email ?? ''), each.self) && each.responseStatus === 'declined');
    const cancelledAll = event.status === 'cancelled' || ownerDeclined;
    const onlyKnown = cancelledAll || attendees.length > MAX_NEW_PERSON_ATTENDEES;
    const subject = cleanLine(event.summary ?? '', 200) || null;
    const endAt = eventTime(event.end, timeZone);
    const contact = (role: PersonContactRole, declined: boolean): Contact => ({
      kind: 'meeting',
      account,
      externalId: id,
      threadId: null,
      direction: null,
      role,
      subject,
      at,
      endAt,
      cancelled: cancelledAll || declined,
    });
    const observe = (address: ObservedAddress, email: string, made: Contact) =>
      result.observations.push({ address, organization: organizationOf(domainOf(email)), contact: made, ...(onlyKnown ? { onlyKnown: true } : {}) });
    const responseOf = (email: string) => attendees.find((each) => normalizeEmail(each.email ?? '') === email)?.responseStatus;
    const seen = new Set<string>();
    if (organizer !== null) {
      seen.add(organizer);
      const address = { email: organizer, name: cleanName(event.organizer?.displayName, organizer) };
      const reason = addressNoise(address);
      if (reason) count(result, reason);
      else observe(address, organizer, contact('organizer', responseOf(organizer) === 'declined'));
    }
    for (const attendee of attendees) {
      const email = normalizeEmail(attendee.email ?? '');
      if (email !== null && seen.has(email)) continue;
      if (email !== null) seen.add(email);
      if (isOwner(email, attendee.self)) {
        count(result, 'owner');
        continue;
      }
      if (email === null) {
        count(result, 'invalid');
        continue;
      }
      const address = { email, name: cleanName(attendee.displayName, email) };
      const reason = addressNoise(address, { resource: attendee.resource === true });
      if (reason) {
        count(result, reason);
        continue;
      }
      observe(address, email, contact('attendee', attendee.responseStatus === 'declined'));
    }
  }
  return result;
}

// the addresses of the guests and the organizer of an event whose whole list of attendees google gave, or null when
// the list is missing, cut short or too large to make people.
function guestsOf(event: calendar_v3.Schema$Event): string[] | null {
  const attendees = event.attendees ?? [];
  if (attendees.length === 0 || attendees.length > MAX_MEETING_ATTENDEES || event.attendeesOmitted) return null;
  const emails = [...attendees.map((each) => each.email), event.organizer?.email].map((each) => normalizeEmail(each ?? ''));
  return emails.filter((each): each is string => each !== null);
}

// a cancelled event that a sync list gives without its attendees.
function isBareCancel(event: calendar_v3.Schema$Event): boolean {
  return event.status === 'cancelled' && (event.attendees ?? []).length === 0;
}

// the time of an event start or end: the date and time, or an all-day date at midnight in the time zone. null when
// neither is a time.
function eventTime(time: calendar_v3.Schema$EventDateTime | undefined, timeZone: string): string | null {
  if (time?.dateTime) {
    const ms = Date.parse(time.dateTime);
    return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
  }
  if (time?.date && /^\d{4}-\d{2}-\d{2}$/.test(time.date)) {
    const date = zonedToUtc(time.date, '00:00', timeZone);
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
  }
  return null;
}

export interface PeopleBuilderDeps {
  db: Db;
  clock: Clock;
  logger: Logger;
  timeZone: string;
  // the expected addresses of the google accounts in the config, which also count as the owner's.
  ownerEmails?: readonly string[];
  // the default is the real store. the tests give a fake, which may leave out cancelMissingGuests.
  store?: Pick<PeopleStore, 'recordObservations' | 'cancelMeetings'> & Partial<Pick<PeopleStore, 'cancelMissingGuests'>>;
}

// the builder of the polls and the backfill. each method writes what it found through the store and never throws: a
// failure is logged with the account, the counts and the kind of the error (never its text, which can hold an address
// or a subject), the result has failed set, and the poll goes on.
export interface PeopleBuilder {
  observeMail(account: string, messages: readonly gmail_v1.Schema$Message[]): BuildResult;
  // the events of a read of the calendar. a cancelled event without attendees marks the meeting rows of that event as
  // cancelled, so a meeting that was called off leaves the upcoming list. an event with its list of attendees marks
  // the rows of the people that are no longer on it the same way.
  observeEvents(account: string, events: readonly calendar_v3.Schema$Event[]): BuildResult;
}

export function createPeopleBuilder(deps: PeopleBuilderDeps): PeopleBuilder {
  const store = deps.store ?? peopleStore;
  const owner = () => ownerAddresses(deps.db, deps.ownerEmails ?? []);
  // the result keeps what was built before a failure, so the caller still gets it.
  const guarded = (account: string, size: number, work: (result: BuildResult) => void): BuildResult => {
    const result: BuildResult = { observations: [], skipped: {} };
    try {
      work(result);
    } catch (err) {
      result.failed = true;
      const name = err instanceof Error ? err.name : typeof err;
      const code = (err as { code?: unknown } | null)?.code;
      deps.logger.warn('people builder failed', { account, count: size, error: name, ...(typeof code === 'string' ? { code } : {}) });
    }
    return result;
  };
  return {
    observeMail: (account, messages) =>
      guarded(account, messages.length, (result) => {
        const addresses = owner();
        for (const message of messages) merge(result, mailObservations(account, message, addresses));
        if (result.observations.length > 0) store.recordObservations(deps.db, result.observations, deps.clock());
      }),
    observeEvents: (account, events) =>
      guarded(account, events.length, (result) => {
        merge(result, eventObservations(account, events, owner(), deps.timeZone));
        const now = deps.clock();
        if (result.observations.length > 0) store.recordObservations(deps.db, result.observations, now);
        const cancelled = events.filter((event) => isBareCancel(event) && event.id).map((event) => event.id!);
        if (cancelled.length > 0) store.cancelMeetings(deps.db, account, cancelled, now);
        if (store.cancelMissingGuests) {
          for (const event of events) {
            const guests = guestsOf(event);
            if (event.id && guests) store.cancelMissingGuests(deps.db, account, event.id, guests, now);
          }
        }
      }),
  };
}

function merge(into: BuildResult, from: BuildResult): void {
  into.observations.push(...from.observations);
  for (const [reason, n] of Object.entries(from.skipped) as Array<[NoiseReason, number]>) count(into, reason, n);
}
