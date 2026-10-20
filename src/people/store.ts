import type { Db } from '../db/index.js';
import type {
  PeopleAccountStatus,
  PeoplePage,
  PersonNoteAuthor,
  PersonNoteKind,
  PersonNoteView,
  PersonProfile,
  PersonSort,
  PersonSummary,
} from '../dashboard/people-types.js';
import { notBuilt } from './not-built.js';
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
  void db;
  void observation;
  void now;
  return notBuilt('recordObservation');
}

// recordObservations writes many observations in one transaction and gives one result for each, in order.
export function recordObservations(db: Db, observations: readonly Observation[], now: Date): Recorded[] {
  void db;
  void observations;
  void now;
  return notBuilt('recordObservations');
}

// cancelMeetings sets cancelled on every meeting row of these events of an account, for every person, and gives the
// number of rows that changed. a sync list gives a cancelled event without its attendees, so the rows are found by
// the event id alone.
export function cancelMeetings(db: Db, account: string, eventIds: readonly string[], now: Date): number {
  void db;
  void account;
  void eventIds;
  void now;
  return notBuilt('cancelMeetings');
}

// searchPeople gives one page of people. the counts and contact times follow PersonSummary: only contacts at or
// before now count, and a cancelled meeting never counts.
export function searchPeople(db: Db, input: SearchInput, now: Date): PeoplePage {
  void db;
  void input;
  void now;
  return notBuilt('searchPeople');
}

// getPerson gives the profile of a person, or undefined for an unknown id.
export function getPerson(db: Db, id: number, now: Date): PersonProfile | undefined {
  void db;
  void id;
  void now;
  return notBuilt('getPerson');
}

// findPersonByEmail gives the summary of the person with this address (normalized first), or undefined.
export function findPersonByEmail(db: Db, email: string, now: Date): PersonSummary | undefined {
  void db;
  void email;
  void now;
  return notBuilt('findPersonByEmail');
}

// addNote appends a note. it throws PersonNotFound for an unknown person, or for a supersedes id that is not a note
// of the same person. the text is trimmed, and it must be 1 to 2000 characters (the caller checks the length first).
export function addNote(db: Db, input: NoteInput, now: Date): PersonNoteView {
  void db;
  void input;
  void now;
  return notBuilt('addNote');
}

// the number of people, for the status route.
export function countPeople(db: Db): number {
  void db;
  return notBuilt('countPeople');
}

// backfillStateOf gives the people_accounts row of an account, made as pending when it is missing.
export function backfillStateOf(db: Db, account: string, now: Date): BackfillState {
  void db;
  void account;
  void now;
  return notBuilt('backfillStateOf');
}

// saveBackfillState changes the given fields of the people_accounts row of an account and sets updatedAt.
export function saveBackfillState(db: Db, account: string, change: Partial<Omit<BackfillState, 'account'>>, now: Date): void {
  void db;
  void account;
  void change;
  void now;
  return notBuilt('saveBackfillState');
}

// the people_accounts rows of the given accounts, in their order. an account without a row shows as pending.
export function listBackfillStates(db: Db, accounts: readonly string[]): PeopleAccountStatus[] {
  void db;
  void accounts;
  return notBuilt('listBackfillStates');
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
