import { afterEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../db/index.js';
import { PEOPLE_ACCOUNTS, PEOPLE_NOW, seedPeople } from '../../test/seed-people.js';
import {
  addNote,
  backfillStateOf,
  cancelMeetings,
  countPeople,
  findPersonByEmail,
  getPerson,
  InvalidCursor,
  listBackfillStates,
  PersonNotFound,
  recordObservation,
  recordObservations,
  saveBackfillState,
  searchPeople,
} from './store.js';
import type { Contact, Observation } from './types.js';

const at = (day: string, time = '16:00') => `2026-${day}T${time}:00.000Z`;

let db: Db;
afterEach(() => db?.close());

function seeded(): Db {
  db = openDb(':memory:');
  seedPeople(db);
  return db;
}

function empty(): Db {
  db = openDb(':memory:');
  return db;
}

function observation(email: string, name: string | null, contact: Partial<Contact> = {}, organization: Observation['organization'] = null): Observation {
  return {
    address: { email, name },
    organization,
    contact: {
      kind: 'mail',
      account: 'personal',
      externalId: 'm-1',
      threadId: 't-1',
      direction: 'in',
      role: 'from',
      subject: 'Hello',
      at: at('10-10'),
      endAt: null,
      cancelled: false,
      ...contact,
    },
  };
}

const acme = { name: 'Acme', domain: 'acme.example' };
const globex = { name: 'Globex', domain: 'globex.example' };

describe('the seeded people', () => {
  it('list in the recent order with the counts and times of the seed', () => {
    seeded();
    const page = searchPeople(db, { limit: 50 }, PEOPLE_NOW);
    expect(page.total).toBe(5);
    expect(page.next).toBeNull();
    expect(page.people.map((p) => p.id)).toEqual([1, 2, 3, 4, 5]);
    const byId = new Map(page.people.map((p) => [p.id, p]));
    expect(byId.get(1)).toMatchObject({
      name: 'Maya Lindqvist',
      displayName: 'Maya Lindqvist',
      primaryEmail: 'maya@northwind.example',
      emails: ['maya@northwind.example', 'maya.lindqvist@gmail.com'],
      organization: 'Northwind',
      organizationDomain: 'northwind.example',
      mailCount: 3,
      meetingCount: 1,
      firstContactAt: at('09-02'),
      lastContactAt: at('10-17', '17:00'),
      nextMeetingAt: at('10-21', '17:00'),
    });
    expect(byId.get(2)).toMatchObject({ organization: null, mailCount: 2, meetingCount: 0, firstContactAt: at('10-10'), lastContactAt: at('10-16'), nextMeetingAt: null });
    expect(byId.get(3)).toMatchObject({
      name: 'Priya',
      organization: 'Berkeley',
      mailCount: 1,
      meetingCount: 1,
      firstContactAt: at('10-01'),
      lastContactAt: at('10-14', '20:00'),
      nextMeetingAt: at('10-22', '20:00'),
    });
    expect(byId.get(4)).toMatchObject({
      name: null,
      displayName: 'k.osei@fabrikam.example',
      organization: 'Fabrikam',
      mailCount: 2,
      meetingCount: 0,
      firstContactAt: at('10-12'),
      lastContactAt: at('10-12', '18:00'),
      nextMeetingAt: null,
    });
    expect(byId.get(5)).toMatchObject({ mailCount: 0, meetingCount: 0, firstContactAt: null, lastContactAt: null, nextMeetingAt: at('10-25', '15:00') });
  });

  it('give the profile of person 1 with its addresses, names and the newest preference', () => {
    seeded();
    const maya = getPerson(db, 1, PEOPLE_NOW);
    expect(maya?.emailDetails.map((e) => [e.email, e.isPrimary])).toEqual([
      ['maya@northwind.example', true],
      ['maya.lindqvist@gmail.com', false],
    ]);
    expect(maya?.names.map((n) => [n.name, n.count])).toEqual([
      ['Maya Lindqvist', 4],
      ['Maya L.', 1],
    ]);
    expect(maya?.preferences.map((n) => n.id)).toEqual([3]);
    expect(maya?.preferences[0]).toMatchObject({ text: 'prefers meetings before 11:00', author: 'agent', runId: 'run-people-2' });
    expect(maya?.notes.map((n) => n.id)).toEqual([2]);
    expect(maya?.notes[0]?.runId).toBeNull();
    expect(maya?.openThreads).toEqual([]);
    expect(maya?.upcoming.map((m) => m.eventId)).toEqual(['e-202']);
    expect(maya?.recentMeetings).toEqual([
      { account: 'personal', eventId: 'e-201', title: 'Roadmap sync', startAt: at('10-17', '17:00'), endAt: at('10-17', '17:30'), role: 'organizer' },
    ]);
    expect(maya?.delegations).toEqual([]);
  });

  it('show the open thread of person 2', () => {
    seeded();
    expect(getPerson(db, 2, PEOPLE_NOW)?.openThreads).toEqual([
      { account: 'personal', threadId: 't-3', subject: 'Re: Lease for the new place', lastAt: at('10-16'), messages: 2 },
    ]);
  });

  it('leave the cancelled meeting of person 3 out', () => {
    seeded();
    const priya = getPerson(db, 3, PEOPLE_NOW);
    expect(priya?.upcoming.map((m) => m.eventId)).toEqual(['e-403']);
    expect(priya?.meetingCount).toBe(1);
    expect(priya?.openThreads).toEqual([]);
    expect(priya?.name).toBe('Priya');
  });

  it('give person 5 no past contact and an upcoming meeting', () => {
    seeded();
    const jonas = getPerson(db, 5, PEOPLE_NOW);
    expect(jonas).toMatchObject({ firstContactAt: null, lastContactAt: null, nextMeetingAt: at('10-25', '15:00') });
    expect(jonas?.upcoming[0]).toMatchObject({ eventId: 'e-601', title: 'Intro call', role: 'attendee' });
  });

  it('give undefined for an unknown id, and find a person by any address', () => {
    seeded();
    expect(getPerson(db, 99, PEOPLE_NOW)).toBeUndefined();
    expect(findPersonByEmail(db, ' <Maya.Lindqvist@Gmail.com> ', PEOPLE_NOW)?.id).toBe(1);
    expect(findPersonByEmail(db, 'nobody@nowhere.example', PEOPLE_NOW)).toBeUndefined();
    expect(findPersonByEmail(db, 'not an address', PEOPLE_NOW)).toBeUndefined();
    expect(countPeople(db)).toBe(5);
  });
});

describe('recordObservation', () => {
  it('makes a person, and counts a contact and its name once when the same mail comes again', () => {
    empty();
    const first = recordObservation(db, observation('Jane@Acme.example', 'Jane Doe', {}, acme), PEOPLE_NOW);
    expect(first).toEqual({ personId: first.personId, createdPerson: true, createdContact: true });
    const again = recordObservation(db, observation('jane@acme.example', 'Jane Doe', { subject: 'Hello again', at: at('10-11') }, acme), PEOPLE_NOW);
    expect(again).toEqual({ personId: first.personId, createdPerson: false, createdContact: false });
    expect(db.prepare('SELECT count(*) AS n FROM person_contacts').get()?.n).toBe(1);
    const jane = getPerson(db, first.personId, PEOPLE_NOW);
    expect(jane?.names).toEqual([{ name: 'Jane Doe', count: 1, lastSeenAt: at('10-10') }]);
    expect(jane).toMatchObject({ name: 'Jane Doe', primaryEmail: 'jane@acme.example', organization: 'Acme', organizationDomain: 'acme.example', mailCount: 1 });
    expect(jane?.lastContactAt).toBe(at('10-11'));
    expect(jane?.emailDetails).toEqual([{ email: 'jane@acme.example', isPrimary: true, firstSeenAt: at('10-10'), lastSeenAt: at('10-11') }]);
    expect(db.prepare('SELECT subject FROM person_contacts').get()?.subject).toBe('Hello again');
  });

  it('moves the first and last seen times of an address both ways', () => {
    empty();
    recordObservation(db, observation('jane@acme.example', null, { externalId: 'm-2', at: at('10-10') }), PEOPLE_NOW);
    recordObservation(db, observation('jane@acme.example', null, { externalId: 'm-3', at: at('10-14') }), PEOPLE_NOW);
    recordObservation(db, observation('jane@acme.example', null, { externalId: 'm-1', at: at('10-02') }), PEOPLE_NOW);
    const row = db.prepare('SELECT firstSeenAt, lastSeenAt FROM person_emails').get();
    expect(row).toEqual({ firstSeenAt: at('10-02'), lastSeenAt: at('10-14') });
  });

  it('refuses an address that is not valid', () => {
    empty();
    expect(() => recordObservation(db, observation('not an address', 'X'), PEOPLE_NOW)).toThrow(Error);
    expect(countPeople(db)).toBe(0);
  });

  it('takes the name seen most often, and never replaces a name the owner chose', () => {
    empty();
    const id = recordObservation(db, observation('jane@acme.example', 'Jane Doe', { externalId: 'm-1', at: at('10-01') }), PEOPLE_NOW).personId;
    recordObservation(db, observation('jane@acme.example', 'Jane Doe', { externalId: 'm-2', at: at('10-02') }), PEOPLE_NOW);
    recordObservation(db, observation('jane@acme.example', 'J. Doe', { externalId: 'm-3', at: at('10-03') }), PEOPLE_NOW);
    expect(getPerson(db, id, PEOPLE_NOW)?.name).toBe('Jane Doe');
    expect(getPerson(db, id, PEOPLE_NOW)?.names.map((n) => [n.name, n.count])).toEqual([
      ['Jane Doe', 2],
      ['J. Doe', 1],
    ]);
    // on a tie, the name seen last wins.
    recordObservation(db, observation('jane@acme.example', 'J. Doe', { externalId: 'm-4', at: at('10-04') }), PEOPLE_NOW);
    expect(getPerson(db, id, PEOPLE_NOW)?.name).toBe('J. Doe');

    db.prepare("UPDATE people SET name = 'Janie', nameSource = 'owner' WHERE id = ?").run(id);
    recordObservation(db, observation('jane@acme.example', 'Jane Doe', { externalId: 'm-5', at: at('10-05') }), PEOPLE_NOW);
    recordObservation(db, observation('jane@acme.example', 'Jane Doe', { externalId: 'm-6', at: at('10-06') }), PEOPLE_NOW);
    expect(getPerson(db, id, PEOPLE_NOW)?.name).toBe('Janie');
  });

  it('moves the organization to the newest contact, and never clears it with null', () => {
    empty();
    const id = recordObservation(db, observation('jane@acme.example', null, { externalId: 'm-1', at: at('10-05') }, acme), PEOPLE_NOW).personId;
    recordObservation(db, observation('jane@acme.example', null, { externalId: 'm-2', at: at('10-08') }, globex), PEOPLE_NOW);
    expect(getPerson(db, id, PEOPLE_NOW)).toMatchObject({ organization: 'Globex', organizationDomain: 'globex.example' });
    // an older mail that comes late does not move it back.
    recordObservation(db, observation('jane@acme.example', null, { externalId: 'm-0', at: at('10-01') }, acme), PEOPLE_NOW);
    expect(getPerson(db, id, PEOPLE_NOW)?.organization).toBe('Globex');
    recordObservation(db, observation('jane@acme.example', null, { externalId: 'm-3', at: at('10-09') }, null), PEOPLE_NOW);
    expect(getPerson(db, id, PEOPLE_NOW)).toMatchObject({ organization: 'Globex', organizationDomain: 'globex.example' });
  });

  it('writes many observations in one call, one result for each in order', () => {
    empty();
    const results = recordObservations(
      db,
      [
        observation('a@acme.example', 'A', { externalId: 'm-1' }),
        observation('b@acme.example', 'B', { externalId: 'm-1', role: 'to' }),
        observation('a@acme.example', 'A', { externalId: 'm-1' }),
      ],
      PEOPLE_NOW,
    );
    expect(results.map((r) => [r.createdPerson, r.createdContact])).toEqual([
      [true, true],
      [true, true],
      [false, false],
    ]);
    expect(results[2]?.personId).toBe(results[0]?.personId);
    expect(countPeople(db)).toBe(2);
    expect(recordObservations(db, [], PEOPLE_NOW)).toEqual([]);
  });

  it('writes nothing of a list when one observation is not valid', () => {
    empty();
    expect(() => recordObservations(db, [observation('a@acme.example', 'A'), observation('bad', 'B')], PEOPLE_NOW)).toThrow();
    expect(countPeople(db)).toBe(0);
  });
});

describe('cancelMeetings', () => {
  it('takes the event out of upcoming for every attendee', () => {
    empty();
    const meeting = { kind: 'meeting' as const, externalId: 'e-9', threadId: null, direction: null, role: 'attendee' as const, subject: 'Offsite', at: at('10-24'), endAt: at('10-24', '18:00') };
    const a = recordObservation(db, observation('a@acme.example', 'A', meeting), PEOPLE_NOW).personId;
    const b = recordObservation(db, observation('b@acme.example', 'B', { ...meeting, role: 'organizer' }), PEOPLE_NOW).personId;
    expect(getPerson(db, a, PEOPLE_NOW)?.upcoming.map((m) => m.eventId)).toEqual(['e-9']);
    expect(cancelMeetings(db, 'school', ['e-9'], PEOPLE_NOW)).toBe(0);
    expect(cancelMeetings(db, 'personal', [], PEOPLE_NOW)).toBe(0);
    expect(cancelMeetings(db, 'personal', ['e-9', 'e-missing'], PEOPLE_NOW)).toBe(2);
    for (const id of [a, b]) {
      expect(getPerson(db, id, PEOPLE_NOW)?.upcoming).toEqual([]);
      expect(getPerson(db, id, PEOPLE_NOW)?.nextMeetingAt).toBeNull();
    }
  });

  it('cancels a seeded meeting of person 1', () => {
    seeded();
    expect(cancelMeetings(db, 'personal', ['e-201', 'e-202'], PEOPLE_NOW)).toBe(2);
    expect(getPerson(db, 1, PEOPLE_NOW)).toMatchObject({ meetingCount: 0, nextMeetingAt: null, lastContactAt: at('10-17'), recentMeetings: [], upcoming: [] });
  });
});

describe('open threads', () => {
  it('close when the owner answered in the thread on the row of another person', () => {
    seeded();
    expect(getPerson(db, 2, PEOPLE_NOW)?.openThreads).toHaveLength(1);
    // the owner answered Tomas with a cc to Maya, so the reply is stored only on Maya.
    recordObservation(
      db,
      observation('maya@northwind.example', 'Maya Lindqvist', { externalId: 'm-303', threadId: 't-3', direction: 'out', role: 'cc', subject: 'Re: Lease', at: at('10-17') }),
      PEOPLE_NOW,
    );
    expect(getPerson(db, 2, PEOPLE_NOW)?.openThreads).toEqual([]);
  });

  it('leave out threads older than 30 days and mail without a thread', () => {
    empty();
    const id = recordObservation(db, observation('a@acme.example', 'A', { externalId: 'm-1', threadId: 't-old', at: at('09-10') }), PEOPLE_NOW).personId;
    recordObservation(db, observation('a@acme.example', 'A', { externalId: 'm-2', threadId: null, at: at('10-15') }), PEOPLE_NOW);
    recordObservation(db, observation('a@acme.example', 'A', { externalId: 'm-3', threadId: 't-new', subject: null, at: at('10-12') }), PEOPLE_NOW);
    expect(getPerson(db, id, PEOPLE_NOW)?.openThreads).toEqual([
      { account: 'personal', threadId: 't-new', subject: '(no subject)', lastAt: at('10-12'), messages: 1 },
    ]);
  });
});

describe('searchPeople', () => {
  const ids = (q: string, sort?: 'recent' | 'frequent' | 'name') => searchPeople(db, { q, sort, limit: 50 }, PEOPLE_NOW).people.map((p) => p.id);

  it('matches names, header names, addresses and organizations without case', () => {
    seeded();
    expect(ids('maya')).toEqual([1]);
    expect(ids('  RAMAN ')).toEqual([3]);
    expect(ids('k.OSEI')).toEqual([4]);
    expect(ids('fabrikam')).toEqual([4]);
    expect(ids('berkeley')).toEqual([3]);
    expect(ids('gmail.com')).toEqual([1, 2]);
    expect(ids('nobody')).toEqual([]);
    expect(searchPeople(db, { q: 'nobody', limit: 10 }, PEOPLE_NOW)).toEqual({ people: [], next: null, total: 0 });
    expect(ids('   ')).toEqual([1, 2, 3, 4, 5]);
  });

  it('takes % and _ in the text as plain characters', () => {
    seeded();
    expect(ids('%')).toEqual([]);
    expect(ids('maya_lindqvist')).toEqual([]);
    recordObservation(db, observation('100%_real@acme.example', null), PEOPLE_NOW);
    expect(searchPeople(db, { q: '%_', limit: 10 }, PEOPLE_NOW).people.map((p) => p.primaryEmail)).toEqual(['100%_real@acme.example']);
  });

  it('sorts by frequency and by name, with ties by id', () => {
    seeded();
    // 1: 4, 2: 2, 3: 2, 4: 2, 5: 0.
    expect(ids('', 'frequent')).toEqual([1, 2, 3, 4, 5]);
    // jonas weber, k.osei@fabrikam.example, maya lindqvist, priya, tomas okafor.
    expect(ids('', 'name')).toEqual([5, 4, 1, 3, 2]);
    db.prepare("UPDATE people SET name = 'maya lindqvist' WHERE id = 2").run();
    expect(ids('', 'name')).toEqual([5, 4, 1, 2, 3]);
  });

  it('walks every page with a stable total', () => {
    seeded();
    const seen: number[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = searchPeople(db, { cursor, limit: 2 }, PEOPLE_NOW);
      expect(page.total).toBe(5);
      seen.push(...page.people.map((p) => p.id));
      cursor = page.next ?? undefined;
      pages += 1;
    } while (cursor);
    expect(pages).toBe(3);
    expect(seen).toEqual([1, 2, 3, 4, 5]);
  });

  it('refuses a cursor that it did not give', () => {
    seeded();
    const bad = ['x', Buffer.from(JSON.stringify({ o: -1 })).toString('base64url'), Buffer.from(JSON.stringify({ o: 1.5 })).toString('base64url'), Buffer.from('null').toString('base64url')];
    for (const cursor of bad) expect(() => searchPeople(db, { cursor, limit: 2 }, PEOPLE_NOW), cursor).toThrow(InvalidCursor);
  });
});

describe('addNote', () => {
  it('appends a trimmed note that supersedes an earlier one', () => {
    seeded();
    const note = addNote(db, { personId: 2, kind: 'preference', text: '  prefers calls  ', author: 'owner' }, PEOPLE_NOW);
    expect(note).toEqual({ id: 5, kind: 'preference', text: 'prefers calls', author: 'owner', runId: null, createdAt: PEOPLE_NOW.toISOString() });
    const later = addNote(db, { personId: 2, kind: 'preference', text: 'prefers mail', author: 'agent', supersedes: 5, runId: 'run-1', toolCallId: 'call-1' }, PEOPLE_NOW);
    expect(later.runId).toBe('run-1');
    expect(getPerson(db, 2, PEOPLE_NOW)?.preferences.map((n) => n.text)).toEqual(['prefers mail']);
    expect(getPerson(db, 2, PEOPLE_NOW)?.notes.map((n) => n.id)).toEqual([4]);
  });

  it('refuses an unknown person, a note of another person, and a text that is blank or too long', () => {
    seeded();
    const base = { personId: 2, kind: 'note' as const, text: 'ok', author: 'owner' as const };
    expect(() => addNote(db, { ...base, personId: 99 }, PEOPLE_NOW)).toThrow(PersonNotFound);
    expect(() => addNote(db, { ...base, supersedes: 1 }, PEOPLE_NOW)).toThrow(/note not found/);
    expect(() => addNote(db, { ...base, supersedes: 99 }, PEOPLE_NOW)).toThrow(PersonNotFound);
    expect(() => addNote(db, { ...base, text: '   ' }, PEOPLE_NOW)).toThrow(Error);
    expect(() => addNote(db, { ...base, text: 'x'.repeat(2001) }, PEOPLE_NOW)).toThrow(Error);
    expect(addNote(db, { ...base, text: 'x'.repeat(2000) }, PEOPLE_NOW).text).toHaveLength(2000);
    expect(db.prepare('SELECT count(*) AS n FROM person_notes').get()?.n).toBe(5);
  });

  it('keeps the notes append-only', () => {
    seeded();
    expect(() => db.prepare("UPDATE person_notes SET text = 'changed' WHERE id = 1").run()).toThrow(/append-only/);
    expect(() => db.prepare('DELETE FROM person_notes WHERE id = 1').run()).toThrow(/append-only/);
  });
});

describe('the delegations of a person', () => {
  it('are empty without a delegations table', () => {
    seeded();
    expect(getPerson(db, 2, PEOPLE_NOW)?.delegations).toEqual([]);
  });

  it('are empty when the table has another shape', () => {
    seeded();
    db.exec('CREATE TABLE delegations (id INTEGER PRIMARY KEY, name TEXT, person TEXT)');
    db.prepare("INSERT INTO delegations (name, person) VALUES ('x', 'tomas.okafor@gmail.com')").run();
    expect(getPerson(db, 2, PEOPLE_NOW)?.delegations).toEqual([]);
  });

  it('show the open delegations that wait on one of the addresses', () => {
    seeded();
    db.exec('CREATE TABLE delegations (id INTEGER PRIMARY KEY, title TEXT, status TEXT, waitingOn TEXT, dueAt TEXT)');
    const insert = db.prepare('INSERT INTO delegations (title, status, waitingOn, dueAt) VALUES (?, ?, ?, ?)');
    insert.run('Get the signed lease', 'waiting', 'Tomas.Okafor@Gmail.com', at('10-20'));
    insert.run('An old one', 'done', 'tomas.okafor@gmail.com', null);
    insert.run('Someone else', 'waiting', 'maya@northwind.example', null);
    expect(getPerson(db, 2, PEOPLE_NOW)?.delegations).toEqual([{ id: 1, title: 'Get the signed lease', status: 'waiting', dueAt: at('10-20') }]);
  });
});

describe('the backfill state', () => {
  it('reads the seed in the order of the accounts, with a missing one as pending', () => {
    seeded();
    expect(listBackfillStates(db, ['school', ...PEOPLE_ACCOUNTS, 'work'])).toEqual([
      { account: 'school', backfill: 'running', backfillMessages: 250, backfillEvents: 0, backfilledAt: null, error: null },
      { account: 'personal', backfill: 'done', backfillMessages: 420, backfillEvents: 85, backfilledAt: at('10-15'), error: null },
      { account: 'school', backfill: 'running', backfillMessages: 250, backfillEvents: 0, backfilledAt: null, error: null },
      { account: 'work', backfill: 'pending', backfillMessages: 0, backfillEvents: 0, backfilledAt: null, error: null },
    ]);
    expect(listBackfillStates(db, [])).toEqual([]);
  });

  it('makes a pending row and changes only the given fields', () => {
    empty();
    const later = new Date('2026-10-19T08:00:00Z');
    expect(backfillStateOf(db, 'work', PEOPLE_NOW)).toEqual({
      account: 'work',
      backfill: 'pending',
      backfillPage: null,
      backfillMessages: 0,
      backfillEvents: 0,
      backfilledAt: null,
      sentAfter: null,
      error: null,
    });
    saveBackfillState(db, 'work', { backfill: 'running', backfillPage: '{"pageToken":"p-2"}', backfillMessages: 100 }, later);
    saveBackfillState(db, 'work', { sentAfter: at('10-18') }, later);
    expect(backfillStateOf(db, 'work', PEOPLE_NOW)).toMatchObject({ backfill: 'running', backfillPage: '{"pageToken":"p-2"}', backfillMessages: 100, sentAfter: at('10-18') });
    saveBackfillState(db, 'work', { backfill: 'done', backfillPage: null, backfilledAt: later.toISOString() }, later);
    expect(backfillStateOf(db, 'work', PEOPLE_NOW)).toMatchObject({ backfill: 'done', backfillPage: null, backfillMessages: 100, backfilledAt: later.toISOString() });
    expect(db.prepare('SELECT updatedAt FROM people_accounts WHERE account = ?').get('work')?.updatedAt).toBe(later.toISOString());
  });
});
