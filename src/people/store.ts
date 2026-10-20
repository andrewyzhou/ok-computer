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
import { likePattern } from '../search/fts.js';
import { inTransaction } from '../signals/store.js';
import { normalizeEmail } from './address.js';
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
  error: string | null;
}

// a row of node:sqlite, read with these helpers so that a null stays null.
type Row = Record<string, unknown>;
const text = (value: unknown): string => String(value);
const textOrNull = (value: unknown): string | null => (value === null || value === undefined ? null : String(value));
const count = (value: unknown): number => Number(value ?? 0);

// a caller that is already in a transaction keeps its own, so the store can run inside a poll's transaction.
function atomically<T>(db: Db, work: () => T): T {
  return db.isTransaction ? work() : inTransaction(db, work);
}

function recordOne(db: Db, observation: Observation, now: string): Recorded {
  const email = normalizeEmail(observation.address.email);
  if (!email) throw new Error(`not a valid email address: ${JSON.stringify(observation.address.email)}`);
  const contact = observation.contact;
  const name = observation.address.name?.trim() || null;
  const organization = observation.organization;

  let createdPerson = false;
  let personId: number;
  const known = db.prepare('SELECT personId FROM person_emails WHERE email = ?').get(email);
  if (known) {
    personId = count(known.personId);
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
  if (createdPerson) {
    // the first address of a person is its primary one. an address that a person gets later (only through a merge)
    // is not.
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
export function recordObservation(db: Db, observation: Observation, now: Date): Recorded {
  return atomically(db, () => recordOne(db, observation, now.toISOString()));
}

// recordObservations writes many observations in one transaction and gives one result for each, in order.
export function recordObservations(db: Db, observations: readonly Observation[], now: Date): Recorded[] {
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

// the summary columns of every person, from aggregated subqueries. :now splits the past from the upcoming. a cancelled
// meeting never counts, and a mail is never cancelled.
const SUMMARY_FROM = `
  FROM people p
  LEFT JOIN (
    SELECT personId,
      sum(kind = 'mail' AND at <= :now) AS mailCount,
      sum(kind = 'meeting' AND at <= :now AND cancelled = 0) AS meetingCount,
      min(CASE WHEN at <= :now AND cancelled = 0 THEN at END) AS firstContactAt,
      max(CASE WHEN at <= :now AND cancelled = 0 THEN at END) AS lastContactAt,
      min(CASE WHEN kind = 'meeting' AND at > :now AND cancelled = 0 THEN at END) AS nextMeetingAt
    FROM person_contacts GROUP BY personId
  ) c ON c.personId = p.id
  LEFT JOIN (
    SELECT personId, json_group_array(email ORDER BY isPrimary DESC, firstSeenAt ASC, email ASC) AS emails
    FROM person_emails GROUP BY personId
  ) e ON e.personId = p.id`;

const SUMMARY_SELECT = `
  SELECT * FROM (
    SELECT p.id, p.name, p.organization, p.organizationDomain,
      coalesce(e.emails, '[]') AS emails,
      coalesce(json_extract(e.emails, '$[0]'), '') AS primaryEmail,
      coalesce(p.name, json_extract(e.emails, '$[0]'), '') AS displayName,
      coalesce(c.mailCount, 0) AS mailCount, coalesce(c.meetingCount, 0) AS meetingCount,
      c.firstContactAt, c.lastContactAt, c.nextMeetingAt
    ${SUMMARY_FROM}
  ) s`;

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

function summaryById(db: Db, id: number, now: string): PersonSummary | undefined {
  const row = db.prepare(`${SUMMARY_SELECT} WHERE s.id = :id`).get({ now, id });
  return row ? summaryOf(row) : undefined;
}

const ORDER: Record<PersonSort, string> = {
  recent: 's.lastContactAt IS NULL, s.lastContactAt DESC, s.id ASC',
  frequent: '(s.mailCount + s.meetingCount) DESC, s.id ASC',
  name: 'lower(s.displayName) ASC, s.id ASC',
};

// a person matches when the text is in its name, in any name that a header gave, in any of its addresses or in its
// organization.
const MATCH = `(:pattern IS NULL
  OR s.name LIKE :pattern ESCAPE '\\'
  OR s.organization LIKE :pattern ESCAPE '\\'
  OR EXISTS (SELECT 1 FROM person_names n WHERE n.personId = s.id AND n.name LIKE :pattern ESCAPE '\\')
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
  const pattern = q === '' ? null : likePattern(q);
  const sort = input.sort ?? 'recent';
  const order = ORDER[sort] ?? ORDER.recent;
  const offset = input.cursor === undefined ? 0 : decodeCursor(input.cursor);
  const at = now.toISOString();
  const total = count(db.prepare(`SELECT count(*) AS n FROM people s WHERE ${MATCH}`).get({ pattern })?.n);
  const rows = db
    .prepare(`${SUMMARY_SELECT} WHERE ${MATCH} ORDER BY ${order} LIMIT :limit OFFSET :offset`)
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

const DELEGATION_COLUMNS = ['id', 'title', 'status', 'waitingOn', 'dueAt'];

// the delegations of the desk (track t3) that wait on one of these addresses. the desk may not be there, or its table
// may have another shape, so this reads it with care and gives an empty list instead of an error.
function delegationsOf(db: Db, emails: readonly string[]): PersonDelegationView[] {
  if (emails.length === 0) return [];
  try {
    const table = db.prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'delegations'").get();
    if (!table) return [];
    const columns = new Set(db.prepare("SELECT name FROM pragma_table_info('delegations')").all().map((row) => text(row.name)));
    if (!DELEGATION_COLUMNS.every((column) => columns.has(column))) return [];
    // a delegation that is done or dropped waits on nobody.
    const rows = db
      .prepare(
        `SELECT id, title, status, dueAt FROM delegations
         WHERE lower(trim(waitingOn)) IN (${emails.map(() => '?').join(', ')})
           AND coalesce(status, '') NOT IN ('done', 'dropped')
         ORDER BY dueAt IS NULL, dueAt ASC, id ASC`,
      )
      .all(...emails.map((email) => email.toLowerCase()));
    return rows.map((row) => ({ id: count(row.id), title: text(row.title), status: text(row.status), dueAt: textOrNull(row.dueAt) }));
  } catch {
    return [];
  }
}

// getPerson gives the profile of a person, or undefined for an unknown id.
export function getPerson(db: Db, id: number, now: Date): PersonProfile | undefined {
  const at = now.toISOString();
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
  const meetings = (where: string, order: string, limit: number) =>
    db
      .prepare(
        `SELECT account, externalId, subject, at, endAt, role FROM person_contacts
         WHERE personId = ? AND kind = 'meeting' AND cancelled = 0 AND ${where} ORDER BY ${order} LIMIT ${limit}`,
      )
      .all(id, at)
      .map(meetingOf);
  const notes = db
    .prepare(
      `SELECT id, kind, text, author, runId, createdAt FROM person_notes n
       WHERE personId = ? AND NOT EXISTS (SELECT 1 FROM person_notes later WHERE later.supersedes = n.id)
       ORDER BY createdAt DESC, id DESC`,
    )
    .all(id)
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
    delegations: delegationsOf(db, summary.emails),
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
// of the same person. the text is trimmed, and it must be 1 to 2000 characters (the caller checks the length first).
export function addNote(db: Db, input: NoteInput, now: Date): PersonNoteView {
  if (!db.prepare('SELECT 1 AS found FROM people WHERE id = ?').get(input.personId)) throw new PersonNotFound();
  if (input.supersedes !== undefined) {
    const earlier = db.prepare('SELECT 1 AS found FROM person_notes WHERE id = ? AND personId = ?').get(input.supersedes, input.personId);
    if (!earlier) throw new PersonNotFound('note');
  }
  const body = input.text.trim();
  if (body.length === 0) throw new Error('the note is empty');
  if (body.length > NOTE_LIMIT) throw new Error(`the note is longer than ${NOTE_LIMIT} characters`);
  const row = db
    .prepare(
      `INSERT INTO person_notes (personId, kind, text, author, supersedes, runId, toolCallId, createdAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id, kind, text, author, runId, createdAt`,
    )
    .get(input.personId, input.kind, body, input.author, input.supersedes ?? null, input.runId ?? null, input.toolCallId ?? null, now.toISOString());
  return noteOf(row as Row);
}

// the number of people, for the status route.
export function countPeople(db: Db): number {
  return count(db.prepare('SELECT count(*) AS n FROM people').get()?.n);
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
    error: textOrNull(row.error),
  };
}

const ensureBackfillRow = (db: Db, account: string, now: string) =>
  db.prepare("INSERT INTO people_accounts (account, backfill, updatedAt) VALUES (?, 'pending', ?) ON CONFLICT (account) DO NOTHING").run(account, now);

// backfillStateOf gives the people_accounts row of an account, made as pending when it is missing.
export function backfillStateOf(db: Db, account: string, now: Date): BackfillState {
  ensureBackfillRow(db, account, now.toISOString());
  return backfillOf(db.prepare('SELECT * FROM people_accounts WHERE account = ?').get(account) as Row);
}

// the columns that saveBackfillState may change. the names go into the sql, so only these are taken.
const BACKFILL_FIELDS = ['backfill', 'backfillPage', 'backfillMessages', 'backfillEvents', 'backfilledAt', 'sentAfter', 'error'] as const;

// saveBackfillState changes the given fields of the people_accounts row of an account and sets updatedAt.
export function saveBackfillState(db: Db, account: string, change: Partial<Omit<BackfillState, 'account'>>, now: Date): void {
  const at = now.toISOString();
  const fields = BACKFILL_FIELDS.filter((field) => change[field] !== undefined);
  atomically(db, () => {
    ensureBackfillRow(db, account, at);
    db.prepare(`UPDATE people_accounts SET ${[...fields.map((field) => `${field} = ?`), 'updatedAt = ?'].join(', ')} WHERE account = ?`).run(
      ...fields.map((field) => change[field] ?? null),
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
