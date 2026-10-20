import type { Db } from '../db/index.js';
import type {
  PeopleAccountStatus,
  PeoplePage,
  PersonDelegationView,
  PersonMeetingView,
  PersonNoteAuthor,
  PersonNoteKind,
  PersonNoteView,
  PersonProfile,
  PersonSort,
  PersonSummary,
  PersonThreadView,
} from '../dashboard/people-types.js';
import { listWaitingOn } from '../desk/index.js';
import { likePattern } from '../search/fts.js';
import { inTransaction } from '../signals/store.js';
import { isPersonalDomain, normalizeEmail, organizationOf } from './address.js';
import type { Observation, Recorded } from './types.js';

// the store of the people memory: every read and write of 023_people.sql goes through this file. the builder writes
// observations, the tools and the dashboard read people and write notes, and the backfill keeps its position in
// people_accounts. now is the clock of the caller: "until now" and "upcoming" are always split at it.

// a cursor that this store did not give, or that is damaged. the route answers 400 with its message.
export class InvalidCursor extends Error {
  constructor() {
    super('the cursor is not valid');
  }
}

// a note that names a person or a note to supersede that does not exist (or that belongs to another person).
export class PersonNotFound extends Error {
  constructor(what = 'person') {
    super(`${what} not found`);
  }
}

// an agent note that tries to supersede a note that the owner wrote. the owner's own words about a person stay
// until the owner changes them.
export class NotePermission extends Error {
  constructor() {
    super('a note of the owner can only be superseded by the owner');
  }
}

// a merge that names the same person twice, or a person that is gone or was merged already.
export class InvalidMerge extends Error {}

export interface SearchInput {
  // matched without case against every name, every email and the organization. empty or missing lists everyone.
  q?: string;
  // recent: the last contact first (people with no past contact last). frequent: mail and meetings together, most
  // first. name: by displayName without case. each sort breaks ties by id.
  sort?: PersonSort;
  cursor?: string;
  // 1 to 200, already clamped by the caller.
  limit: number;
}

export interface NoteInput {
  personId: number;
  kind: PersonNoteKind;
  text: string;
  author: PersonNoteAuthor;
  supersedes?: number;
  runId?: string | null;
  toolCallId?: string | null;
}

export interface BackfillState {
  account: string;
  backfill: PeopleAccountStatus['backfill'];
  // the json position that backfillStep wrote, or null.
  backfillPage: string | null;
  backfillMessages: number;
  backfillEvents: number;
  backfilledAt: string | null;
  sentAfter: string | null;
  // the send-as addresses of the account that gmail gave, or null before they were read.
  aliases: string[] | null;
  error: string | null;
}

// a row of node:sqlite, read with these helpers so that a null stays null.
type Row = Record<string, unknown>;
const text = (value: unknown): string => String(value);
const textOrNull = (value: unknown): string | null => (value === null || value === undefined ? null : String(value));
const count = (value: unknown): number => Number(value ?? 0);

// people_fold lowers the case of any text, not only of ascii letters as sqlite's lower and like do, so a search for
// élodie finds Élodie. node:sqlite registers a function per connection, so each one gets it once.
const folding = new WeakSet<Db>();
function withFold(db: Db): Db {
  if (!folding.has(db)) {
    db.function('people_fold', { deterministic: true }, (value) => (typeof value === 'string' ? value.toLowerCase() : value));
    folding.add(db);
  }
  return db;
}

// a caller that is already in a transaction keeps its own, so the store can run inside a poll's transaction.
function atomically<T>(db: Db, work: () => T): T {
  return db.isTransaction ? work() : inTransaction(db, work);
}

// a name of two words or more, compared without case, that exactly one person has: the person that a new address of
// that name belongs to, when the address is at that person's organization and that organization is not a personal
// domain. otherwise null, and the address makes a new person. a wrong join is worse than a split and cannot be undone,
// so a name that two people share never attaches, and an address at a personal domain never attaches by name: many
// people share a common name, and anyone can take an address at gmail. the owner joins those with a merge.
function attachTarget(db: Db, name: string | null, email: string): number | null {
  if (name === null || name.trim().split(/\s+/).length < 2) return null;
  const rows = withFold(db)
    .prepare(
      `SELECT DISTINCT p.id, p.organizationDomain FROM people p
       WHERE p.mergedInto IS NULL AND (
         people_fold(p.name) = people_fold(:name)
         OR EXISTS (SELECT 1 FROM person_names n WHERE n.personId = p.id AND people_fold(n.name) = people_fold(:name)))
       LIMIT 2`,
    )
    .all({ name: name.trim() });
  if (rows.length !== 1) return null;
  const organization = organizationOf(email.slice(email.lastIndexOf('@') + 1));
  const target = rows[0]!;
  const targetDomain = textOrNull(target.organizationDomain);
  if (organization === null || targetDomain === null || isPersonalDomain(targetDomain)) return null;
  return organization.domain === targetDomain ? count(target.id) : null;
}

function recordOne(db: Db, observation: Observation, now: string): Recorded | null {
  const email = normalizeEmail(observation.address.email);
  // the error names no address, because the log line of the builder must not hold one.
  if (!email) throw new Error('an observation has an address that is not valid');
  const contact = observation.contact;
  const name = observation.address.name?.trim() || null;
  const organization = observation.organization;

  let createdPerson = false;
  let personId: number;
  const known = db.prepare('SELECT personId FROM person_emails WHERE email = ?').get(email);
  const attachTo = known || observation.onlyKnown ? null : attachTarget(db, name, email);
  if (known) {
    personId = count(known.personId);
  } else if (observation.onlyKnown) {
    return null;
  } else if (attachTo !== null) {
    personId = attachTo;
  } else {
    const person = db
      .prepare(
        `INSERT INTO people (name, nameSource, organization, organizationDomain, createdAt, updatedAt)
         VALUES (?, 'header', ?, ?, ?, ?) RETURNING id`,
      )
      .get(name, organization?.name ?? null, organization?.domain ?? null, now, now);
    personId = count(person?.id);
    createdPerson = true;
  }
  if (!known) {
    // the first address of a person is its primary one. an address that a person gets later (through a name that
    // matches, or a merge) is not.
    db.prepare(
      `INSERT INTO person_emails (email, personId, isPrimary, firstSeenAt, lastSeenAt)
       VALUES (?, ?, NOT EXISTS (SELECT 1 FROM person_emails WHERE personId = ?), ?, ?)`,
    ).run(email, personId, personId, contact.at, contact.at);
  } else {
    db.prepare('UPDATE person_emails SET firstSeenAt = min(firstSeenAt, ?), lastSeenAt = max(lastSeenAt, ?) WHERE email = ?').run(
      contact.at,
      contact.at,
      email,
    );
  }

  const existing = db
    .prepare('SELECT id FROM person_contacts WHERE personId = ? AND kind = ? AND account = ? AND externalId = ?')
    .get(personId, contact.kind, contact.account, contact.externalId);
  db.prepare(
    `INSERT INTO person_contacts (personId, kind, account, externalId, threadId, direction, role, subject, at, endAt, cancelled, seenAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (personId, kind, account, externalId) DO UPDATE SET
       at = excluded.at, endAt = excluded.endAt, subject = excluded.subject, cancelled = excluded.cancelled,
       threadId = excluded.threadId, seenAt = excluded.seenAt
     RETURNING id`,
  ).get(
    personId,
    contact.kind,
    contact.account,
    contact.externalId,
    contact.threadId,
    contact.direction,
    contact.role,
    contact.subject,
    contact.at,
    contact.endAt,
    contact.cancelled ? 1 : 0,
    now,
  );
  const createdContact = existing === undefined;

  // a name counts once for each contact, so a header that comes again does not count again.
  if (createdContact && name !== null) {
    db.prepare(
      `INSERT INTO person_names (personId, name, count, firstSeenAt, lastSeenAt) VALUES (?, ?, 1, ?, ?)
       ON CONFLICT (personId, name) DO UPDATE SET
         count = count + 1, firstSeenAt = min(firstSeenAt, excluded.firstSeenAt), lastSeenAt = max(lastSeenAt, excluded.lastSeenAt)`,
    ).run(personId, name, contact.at, contact.at);
    db.prepare(
      `UPDATE people SET name = (
         SELECT name FROM person_names WHERE personId = ? ORDER BY count DESC, lastSeenAt DESC, name ASC LIMIT 1
       ) WHERE id = ? AND nameSource = 'header'`,
    ).run(personId, personId);
  }

  // the organization follows the newest contact of the person, so an older mail that a backfill reads late does not
  // move it back.
  if (organization) {
    db.prepare(
      `UPDATE people SET organization = ?, organizationDomain = ?
       WHERE id = ? AND ? >= (SELECT max(at) FROM person_contacts WHERE personId = ?)`,
    ).run(organization.name, organization.domain, personId, contact.at, personId);
  }
  db.prepare('UPDATE people SET updatedAt = ? WHERE id = ?').run(now, personId);
  return { personId, createdPerson, createdContact };
}

// recordObservation writes one observation in one transaction:
// - the email row: found by address, or made with a new people row (isPrimary 1 for the first address of a person).
//   lastSeenAt moves to the contact time when it is newer, firstSeenAt to it when it is older.
// - the contact row: inserted, or on the unique key (personId, kind, account, externalId) updated in place (at, endAt,
//   subject, cancelled, threadId and seenAt), never inserted twice.
// - the name: only when the contact row is new and the observation has a name, person_names counts it. a person whose
//   nameSource is header then takes the name with the highest count (the newest on a tie). an owner name stays.
// - the organization: set from the observation when it is not null and the contact is the newest of the person, so
//   a person who moved to a new company shows the new one. a null organization never clears one.
// - a new address with a name of two words or more that exactly one person has joins that person (attachTarget),
//   only when it is at that person's organization. an address at a personal domain never joins by name.
// - an observation with onlyKnown and a new address writes nothing and gives null.
export function recordObservation(db: Db, observation: Observation, now: Date): Recorded | null {
  return atomically(db, () => recordOne(db, observation, now.toISOString()));
}

// recordObservations writes many observations in one transaction and gives one result for each, in order.
export function recordObservations(db: Db, observations: readonly Observation[], now: Date): Array<Recorded | null> {
  if (observations.length === 0) return [];
  const at = now.toISOString();
  return atomically(db, () => observations.map((observation) => recordOne(db, observation, at)));
}

// the most ids in one IN list, well under the variable limit of sqlite.
const ID_CHUNK = 500;

// cancelMeetings sets cancelled on every meeting row of these events of an account, for every person, and gives the
// number of rows that changed. a sync list gives a cancelled event without its attendees, so the rows are found by
// the event id alone.
export function cancelMeetings(db: Db, account: string, eventIds: readonly string[], now: Date): number {
  if (eventIds.length === 0) return 0;
  const at = now.toISOString();
  return atomically(db, () => {
    let changed = 0;
    for (let start = 0; start < eventIds.length; start += ID_CHUNK) {
      const chunk = eventIds.slice(start, start + ID_CHUNK);
      const result = db
        .prepare(
          `UPDATE person_contacts SET cancelled = 1, seenAt = ?
           WHERE kind = 'meeting' AND account = ? AND externalId IN (${chunk.map(() => '?').join(', ')})`,
        )
        .run(at, account, ...chunk);
      changed += Number(result.changes);
    }
    return changed;
  });
}

// the summary columns of people, from aggregated subqueries. :now splits the past from the upcoming. a cancelled
// meeting never counts, and a mail is never cancelled. one event on the calendars of two of the owner's accounts has
// the same event id in both, so a meeting counts once for each event id. filter narrows each subquery: the read of one
// person gives "WHERE personId = :id", because sqlite does not push a filter of the outer query into a grouped
// subquery, and without it each read of one person would group every contact of everyone.
const summaryFrom = (filter: string) => `
  FROM people p
  LEFT JOIN (
    SELECT personId,
      sum(kind = 'mail' AND at <= :now) AS mailCount,
      count(DISTINCT CASE WHEN kind = 'meeting' AND at <= :now AND cancelled = 0 THEN externalId END) AS meetingCount,
      min(CASE WHEN at <= :now AND cancelled = 0 THEN at END) AS firstContactAt,
      max(CASE WHEN at <= :now AND cancelled = 0 THEN at END) AS lastContactAt,
      min(CASE WHEN kind = 'meeting' AND at > :now AND cancelled = 0 THEN at END) AS nextMeetingAt
    FROM person_contacts ${filter} GROUP BY personId
  ) c ON c.personId = p.id
  LEFT JOIN (
    SELECT personId, json_group_array(email ORDER BY isPrimary DESC, firstSeenAt ASC, email ASC) AS emails
    FROM person_emails ${filter} GROUP BY personId
  ) e ON e.personId = p.id`;

const summarySelect = (filter: string) => `
  SELECT * FROM (
    SELECT p.id, p.name, p.organization, p.organizationDomain, p.mergedInto,
      coalesce(e.emails, '[]') AS emails,
      coalesce(json_extract(e.emails, '$[0]'), '') AS primaryEmail,
      coalesce(p.name, json_extract(e.emails, '$[0]'), '') AS displayName,
      coalesce(c.mailCount, 0) AS mailCount, coalesce(c.meetingCount, 0) AS meetingCount,
      c.firstContactAt, c.lastContactAt, c.nextMeetingAt
    ${summaryFrom(filter)}
    ${filter ? 'WHERE p.id = :id' : ''}
  ) s`;

const SUMMARY_ALL = summarySelect('');
const SUMMARY_ONE = summarySelect('WHERE personId = :id');

function summaryOf(row: Row): PersonSummary {
  return {
    id: count(row.id),
    name: textOrNull(row.name),
    displayName: text(row.displayName),
    primaryEmail: text(row.primaryEmail),
    emails: JSON.parse(text(row.emails)) as string[],
    organization: textOrNull(row.organization),
    organizationDomain: textOrNull(row.organizationDomain),
    mailCount: count(row.mailCount),
    meetingCount: count(row.meetingCount),
    firstContactAt: textOrNull(row.firstContactAt),
    lastContactAt: textOrNull(row.lastContactAt),
    nextMeetingAt: textOrNull(row.nextMeetingAt),
  };
}

// the id that a person has now: a person that the owner merged into another one is that other one. the merge keeps
// the chain flat, so this ends after one step, and the cap only guards against a damaged row.
function currentId(db: Db, id: number): number | undefined {
  let at = id;
  for (let step = 0; step < 8; step++) {
    const row = db.prepare('SELECT mergedInto FROM people WHERE id = ?').get(at);
    if (!row) return undefined;
    if (row.mergedInto === null || row.mergedInto === undefined) return at;
    at = count(row.mergedInto);
  }
  return undefined;
}

function summaryById(db: Db, id: number, now: string): PersonSummary | undefined {
  const row = db.prepare(SUMMARY_ONE).get({ now, id });
  return row ? summaryOf(row) : undefined;
}

const ORDER: Record<PersonSort, string> = {
  recent: 's.lastContactAt IS NULL, s.lastContactAt DESC, s.id ASC',
  frequent: '(s.mailCount + s.meetingCount) DESC, s.id ASC',
  name: 'lower(s.displayName) ASC, s.id ASC',
};

// a person matches when the text is in its name, in any name that a header gave, in any of its addresses or in its
// organization. the text and each field are folded to lower case first (people_fold), so the match ignores the case
// of any letter. a person that was merged into another one never shows.
const MATCH = `s.mergedInto IS NULL AND (:pattern IS NULL
  OR people_fold(s.name) LIKE :pattern ESCAPE '\\'
  OR people_fold(s.organization) LIKE :pattern ESCAPE '\\'
  OR EXISTS (SELECT 1 FROM person_names n WHERE n.personId = s.id AND people_fold(n.name) LIKE :pattern ESCAPE '\\')
  OR EXISTS (SELECT 1 FROM person_emails m WHERE m.personId = s.id AND m.email LIKE :pattern ESCAPE '\\'))`;

const encodeCursor = (offset: number) => Buffer.from(JSON.stringify({ o: offset })).toString('base64url');

function decodeCursor(cursor: string): number {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new InvalidCursor();
  }
  if (typeof parsed !== 'object' || parsed === null) throw new InvalidCursor();
  const offset = (parsed as { o?: unknown }).o;
  if (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0) throw new InvalidCursor();
  return offset;
}

// searchPeople gives one page of people. the counts and contact times follow PersonSummary: only contacts at or
// before now count, and a cancelled meeting never counts.
export function searchPeople(db: Db, input: SearchInput, now: Date): PeoplePage {
  const q = input.q?.trim() ?? '';
  const pattern = q === '' ? null : likePattern(q.toLowerCase());
  const sort = input.sort ?? 'recent';
  // the sort also comes through the read api, so a key that only the prototype has (constructor) must not reach the sql.
  const order = Object.hasOwn(ORDER, sort) ? ORDER[sort] : ORDER.recent;
  const offset = input.cursor === undefined ? 0 : decodeCursor(input.cursor);
  const at = now.toISOString();
  withFold(db);
  const total = count(db.prepare(`SELECT count(*) AS n FROM people s WHERE ${MATCH}`).get({ pattern })?.n);
  const rows = db
    .prepare(`${SUMMARY_ALL} WHERE ${MATCH} ORDER BY ${order} LIMIT :limit OFFSET :offset`)
    .all({ now: at, pattern, limit: input.limit, offset });
  const end = offset + rows.length;
  return { people: rows.map(summaryOf), next: rows.length > 0 && end < total ? encodeCursor(end) : null, total };
}

function meetingOf(row: Row): PersonMeetingView {
  return {
    account: text(row.account),
    eventId: text(row.externalId),
    title: textOrNull(row.subject) ?? '(no title)',
    startAt: text(row.at),
    endAt: textOrNull(row.endAt),
    role: text(row.role) as PersonMeetingView['role'],
  };
}

function noteOf(row: Row): PersonNoteView {
  return {
    id: count(row.id),
    kind: text(row.kind) as PersonNoteKind,
    text: text(row.text),
    author: text(row.author) as PersonNoteAuthor,
    runId: textOrNull(row.runId),
    createdAt: text(row.createdAt),
  };
}

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

// a thread is open when the newest mail of the person in it is from them, and nobody's row in the thread shows a
// mail from the owner after it. a reply of the owner can be stored on another person (a cc), so every row counts.
function openThreadsOf(db: Db, id: number, now: Date): PersonThreadView[] {
  const rows = db
    .prepare(
      `WITH mine AS (
         SELECT id, account, threadId, externalId, direction, role, subject, at,
           row_number() OVER (PARTITION BY account, threadId ORDER BY at DESC, id DESC) AS rank
         FROM person_contacts
         WHERE personId = :id AND kind = 'mail' AND threadId IS NOT NULL AND at >= :since AND at <= :now
       )
       SELECT n.account, n.threadId, n.subject, n.at,
         (SELECT count(DISTINCT x.externalId) FROM person_contacts x
          WHERE x.personId = :id AND x.kind = 'mail' AND x.account = n.account AND x.threadId = n.threadId AND x.at <= :now) AS messages
       FROM mine n
       WHERE n.rank = 1 AND n.direction = 'in' AND n.role = 'from'
         AND NOT EXISTS (
           SELECT 1 FROM person_contacts o
           WHERE o.kind = 'mail' AND o.account = n.account AND o.threadId = n.threadId AND o.direction = 'out' AND o.at > n.at
         )
       ORDER BY n.at DESC, n.id DESC
       LIMIT 10`,
    )
    .all({ id, now: now.toISOString(), since: new Date(now.getTime() - THIRTY_DAYS_MS).toISOString() });
  return rows.map((row) => ({
    account: text(row.account),
    threadId: text(row.threadId),
    subject: textOrNull(row.subject) ?? '(no subject)',
    lastAt: text(row.at),
    messages: count(row.messages),
  }));
}

// the delegations of the desk that wait on a person: on one of their addresses, or, for a delegation without an
// address, on their name when it has two words or more (a first name alone names too many people). the desk read api
// gives only active delegations, because a delegation that is done or dropped waits on nobody.
function delegationsOf(db: Db, emails: readonly string[], name: string | null): PersonDelegationView[] {
  if (emails.length === 0) return [];
  const fullName = name !== null && name.trim().split(/\s+/).length >= 2 ? name : null;
  return listWaitingOn(db, { emails, name: fullName }).map((each) => ({ id: each.id, title: each.title, status: each.status, dueAt: each.dueAt }));
}

// getPerson gives the profile of a person, or undefined for an unknown id. the id of a person that the owner merged
// into another one gives the profile of that other one.
export function getPerson(db: Db, requested: number, now: Date): PersonProfile | undefined {
  const at = now.toISOString();
  const id = currentId(db, requested);
  if (id === undefined) return undefined;
  const summary = summaryById(db, id, at);
  if (!summary) return undefined;
  const names = db
    .prepare('SELECT name, count, lastSeenAt FROM person_names WHERE personId = ? ORDER BY count DESC, lastSeenAt DESC, name ASC')
    .all(id)
    .map((row) => ({ name: text(row.name), count: count(row.count), lastSeenAt: text(row.lastSeenAt) }));
  const emailDetails = db
    .prepare('SELECT email, isPrimary, firstSeenAt, lastSeenAt FROM person_emails WHERE personId = ? ORDER BY isPrimary DESC, firstSeenAt ASC, email ASC')
    .all(id)
    .map((row) => ({ email: text(row.email), isPrimary: count(row.isPrimary) === 1, firstSeenAt: text(row.firstSeenAt), lastSeenAt: text(row.lastSeenAt) }));
  // one event on the calendars of two accounts shows once, with the row of the first account by name.
  const meetings = (where: string, order: string, limit: number) =>
    db
      .prepare(
        `SELECT account, externalId, subject, at, endAt, role FROM (
           SELECT *, row_number() OVER (PARTITION BY externalId ORDER BY account ASC, id ASC) AS copy
           FROM person_contacts
           WHERE personId = ? AND kind = 'meeting' AND cancelled = 0 AND ${where}
         ) WHERE copy = 1 ORDER BY ${order} LIMIT ${limit}`,
      )
      .all(id, at)
      .map(meetingOf);
  // the notes of a person that was merged into this one stay with their own person id, because a note never
  // changes, so the profile reads them through mergedInto.
  const notes = db
    .prepare(
      `SELECT id, kind, text, author, runId, createdAt FROM person_notes n
       WHERE personId IN (SELECT id FROM people WHERE id = :id OR mergedInto = :id)
         AND NOT EXISTS (SELECT 1 FROM person_notes later WHERE later.supersedes = n.id)
       ORDER BY createdAt DESC, id DESC`,
    )
    .all({ id })
    .map(noteOf);
  return {
    ...summary,
    names,
    emailDetails,
    upcoming: meetings('at > ?', 'at ASC, id ASC', 10),
    recentMeetings: meetings('at <= ?', 'at DESC, id DESC', 5),
    openThreads: openThreadsOf(db, id, now),
    notes: notes.filter((note) => note.kind === 'note'),
    preferences: notes.filter((note) => note.kind === 'preference'),
    delegations: delegationsOf(db, summary.emails, summary.name),
  };
}

// findPersonByEmail gives the summary of the person with this address (normalized first), or undefined.
export function findPersonByEmail(db: Db, email: string, now: Date): PersonSummary | undefined {
  const normalized = normalizeEmail(email);
  if (!normalized) return undefined;
  const row = db.prepare('SELECT personId FROM person_emails WHERE email = ?').get(normalized);
  return row ? summaryById(db, count(row.personId), now.toISOString()) : undefined;
}

const NOTE_LIMIT = 2000;

// addNote appends a note. it throws PersonNotFound for an unknown person, or for a supersedes id that is not a note
// of the same person, and NotePermission when the agent tries to supersede a note of the owner: text in a mail could
// otherwise make the agent hide what the owner said about a person. the text is trimmed, and it must be 1 to 2000
// characters (the caller checks the length first). a note for a person that was merged goes to the person it is now.
export function addNote(db: Db, input: NoteInput, now: Date): PersonNoteView {
  const personId = currentId(db, input.personId);
  if (personId === undefined) throw new PersonNotFound();
  if (input.supersedes !== undefined) {
    const earlier = db
      .prepare('SELECT author FROM person_notes WHERE id = :note AND personId IN (SELECT id FROM people WHERE id = :person OR mergedInto = :person)')
      .get({ note: input.supersedes, person: personId });
    if (!earlier) throw new PersonNotFound('note');
    if (input.author === 'agent' && text(earlier.author) === 'owner') throw new NotePermission();
  }
  const body = input.text.trim();
  if (body.length === 0) throw new Error('the note is empty');
  if (body.length > NOTE_LIMIT) throw new Error(`the note is longer than ${NOTE_LIMIT} characters`);
  const row = db
    .prepare(
      `INSERT INTO person_notes (personId, kind, text, author, supersedes, runId, toolCallId, createdAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id, kind, text, author, runId, createdAt`,
    )
    .get(personId, input.kind, body, input.author, input.supersedes ?? null, input.runId ?? null, input.toolCallId ?? null, now.toISOString());
  return noteOf(row as Row);
}

// cancelMissingGuests sets cancelled on the meeting rows of one event of an account whose person has none of these
// addresses, so a guest that was taken off an event loses the meeting. guests is the whole list of the event: its
// attendees and its organizer. it gives the number of rows that changed.
export function cancelMissingGuests(db: Db, account: string, eventId: string, guests: readonly string[], now: Date): number {
  const emails = [...new Set(guests.map((each) => normalizeEmail(each)).filter((each): each is string => each !== null))].slice(0, ID_CHUNK);
  const result = db
    .prepare(
      `UPDATE person_contacts SET cancelled = 1, seenAt = ?
       WHERE kind = 'meeting' AND account = ? AND externalId = ? AND cancelled = 0
         AND personId NOT IN (SELECT personId FROM person_emails WHERE email IN (${emails.length ? emails.map(() => '?').join(', ') : 'NULL'}))`,
    )
    .run(now.toISOString(), account, eventId, ...emails);
  return Number(result.changes);
}

// mergePeople joins other into keep, for the owner, when one human shows as two people: the addresses, the contacts
// and the header names move to keep, and other gets mergedInto, so an old id still finds the person. the notes stay
// where they are, because a note never changes, and the profile of keep reads them through mergedInto. a contact
// that both had (the same item seen at two addresses) stays once. it throws PersonNotFound for an unknown person and
// InvalidMerge for the same person twice. it gives the id of the person that stays.
export function mergePeople(db: Db, keepId: number, otherId: number, now: Date): number {
  const at = now.toISOString();
  return atomically(db, () => {
    const keep = currentId(db, keepId);
    const other = currentId(db, otherId);
    if (keep === undefined || other === undefined) throw new PersonNotFound();
    if (keep === other) throw new InvalidMerge('the two ids name the same person');
    db.prepare('UPDATE person_emails SET personId = ?, isPrimary = 0 WHERE personId = ?').run(keep, other);
    db.prepare(
      `DELETE FROM person_contacts WHERE personId = :other AND EXISTS (
         SELECT 1 FROM person_contacts k
         WHERE k.personId = :keep AND k.kind = person_contacts.kind AND k.account = person_contacts.account AND k.externalId = person_contacts.externalId)`,
    ).run({ keep, other });
    db.prepare('UPDATE person_contacts SET personId = ? WHERE personId = ?').run(keep, other);
    db.prepare(
      `INSERT INTO person_names (personId, name, count, firstSeenAt, lastSeenAt)
       SELECT ?, name, count, firstSeenAt, lastSeenAt FROM person_names WHERE personId = ? AND true
       ON CONFLICT (personId, name) DO UPDATE SET
         count = count + excluded.count, firstSeenAt = min(firstSeenAt, excluded.firstSeenAt), lastSeenAt = max(lastSeenAt, excluded.lastSeenAt)`,
    ).run(keep, other);
    db.prepare('DELETE FROM person_names WHERE personId = ?').run(other);
    db.prepare(
      `UPDATE people SET name = (
         SELECT name FROM person_names WHERE personId = :keep ORDER BY count DESC, lastSeenAt DESC, name ASC LIMIT 1
       ) WHERE id = :keep AND nameSource = 'header' AND EXISTS (SELECT 1 FROM person_names WHERE personId = :keep)`,
    ).run({ keep });
    db.prepare(
      `UPDATE people SET organization = (SELECT organization FROM people WHERE id = :other),
         organizationDomain = (SELECT organizationDomain FROM people WHERE id = :other)
       WHERE id = :keep AND organization IS NULL`,
    ).run({ keep, other });
    // a person that was merged into other earlier now points at keep too, so the chain stays one step long.
    db.prepare('UPDATE people SET mergedInto = :keep, updatedAt = :at WHERE id = :other OR mergedInto = :other').run({ keep, other, at });
    db.prepare('UPDATE people SET updatedAt = ? WHERE id = ?').run(at, keep);
    return keep;
  });
}

// the number of people, for the status route. a person that was merged into another one is not counted.
export function countPeople(db: Db): number {
  return count(db.prepare('SELECT count(*) AS n FROM people WHERE mergedInto IS NULL').get()?.n);
}

function backfillOf(row: Row): BackfillState {
  return {
    account: text(row.account),
    backfill: text(row.backfill) as BackfillState['backfill'],
    backfillPage: textOrNull(row.backfillPage),
    backfillMessages: count(row.backfillMessages),
    backfillEvents: count(row.backfillEvents),
    backfilledAt: textOrNull(row.backfilledAt),
    sentAfter: textOrNull(row.sentAfter),
    aliases: aliasList(row.aliases),
    error: textOrNull(row.error),
  };
}

// the json list of send-as addresses, or null when none was saved or it is damaged.
function aliasList(value: unknown): string[] | null {
  if (value === null || value === undefined) return null;
  try {
    const list: unknown = JSON.parse(String(value));
    return Array.isArray(list) ? list.filter((each): each is string => typeof each === 'string') : null;
  } catch {
    return null;
  }
}

const ensureBackfillRow = (db: Db, account: string, now: string) =>
  db.prepare("INSERT INTO people_accounts (account, backfill, updatedAt) VALUES (?, 'pending', ?) ON CONFLICT (account) DO NOTHING").run(account, now);

// backfillStateOf gives the people_accounts row of an account, made as pending when it is missing.
export function backfillStateOf(db: Db, account: string, now: Date): BackfillState {
  ensureBackfillRow(db, account, now.toISOString());
  return backfillOf(db.prepare('SELECT * FROM people_accounts WHERE account = ?').get(account) as Row);
}

// the columns that saveBackfillState may change. the names go into the sql, so only these are taken.
const BACKFILL_FIELDS = ['backfill', 'backfillPage', 'backfillMessages', 'backfillEvents', 'backfilledAt', 'sentAfter', 'aliases', 'error'] as const;

// saveBackfillState changes the given fields of the people_accounts row of an account and sets updatedAt.
export function saveBackfillState(db: Db, account: string, change: Partial<Omit<BackfillState, 'account'>>, now: Date): void {
  const at = now.toISOString();
  const fields = BACKFILL_FIELDS.filter((field) => change[field] !== undefined);
  atomically(db, () => {
    ensureBackfillRow(db, account, at);
    db.prepare(`UPDATE people_accounts SET ${[...fields.map((field) => `${field} = ?`), 'updatedAt = ?'].join(', ')} WHERE account = ?`).run(
      ...fields.map((field) => (field === 'aliases' ? (change.aliases ? JSON.stringify(change.aliases) : null) : (change[field] as string | number | null | undefined) ?? null)),
      at,
      account,
    );
  });
}

// the people_accounts rows of the given accounts, in their order. an account without a row shows as pending.
export function listBackfillStates(db: Db, accounts: readonly string[]): PeopleAccountStatus[] {
  if (accounts.length === 0) return [];
  const rows = new Map(
    db
      .prepare(`SELECT * FROM people_accounts WHERE account IN (${accounts.map(() => '?').join(', ')})`)
      .all(...accounts)
      .map((row) => [text(row.account), backfillOf(row)] as const),
  );
  return accounts.map((account) => {
    const state = rows.get(account);
    return {
      account,
      backfill: state?.backfill ?? 'pending',
      backfillMessages: state?.backfillMessages ?? 0,
      backfillEvents: state?.backfillEvents ?? 0,
      backfilledAt: state?.backfilledAt ?? null,
      error: state?.error ?? null,
    };
  });
}

// the store as one object. the builder, the backfill, the tools and the routes take it as an optional dependency
// with this default, so their tests can give a fake.
export const peopleStore = {
  recordObservation,
  recordObservations,
  cancelMeetings,
  cancelMissingGuests,
  mergePeople,
  searchPeople,
  getPerson,
  findPersonByEmail,
  addNote,
  countPeople,
  backfillStateOf,
  saveBackfillState,
  listBackfillStates,
};
export type PeopleStore = typeof peopleStore;
