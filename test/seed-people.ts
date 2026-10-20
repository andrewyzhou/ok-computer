import type { Db } from '../src/db/index.js';

// the people memory on a seeded database. the rows are written with sql, as the store would write them, so the
// routes, the tools and the views can be tested before the builder runs. the data below is stable: a test may depend
// on each id, count and time that the comments name. the people, the addresses and the companies are made up.
//
// the clock stands at PEOPLE_NOW, 2026-10-18 16:00 utc. the accounts are personal and school.
//
// people (id name organization mail meetings first last next):
//   1 Maya Lindqvist   Northwind (northwind.example)  3 mail 1 meeting   09-02 10-17  10-21 (no open thread: the owner wrote last)
//   2 Tomas Okafor     none (a personal domain)       2 mail 0 meetings  10-10 10-16  none   (one open thread)
//   3 Priya            Berkeley (berkeley.edu)        1 mail 1 meeting   10-01 10-14  10-22, and a cancelled one on 10-20
//   4 null name        Fabrikam (fabrikam.example)    2 mail 0 meetings  10-12 10-12  none   (shows its address)
//   5 Jonas Weber      none                           0 mail 0 meetings  null  null   10-25 (only an upcoming meeting)
// person 1 has two addresses (maya@northwind.example, the primary, and maya.lindqvist@gmail.com) and two names
// ("Maya Lindqvist" 4 times, "Maya L." once). person 3 has the owner's name "Priya" (nameSource owner), while its
// header name is "Priya Raman". person 3 has no open thread: its newest message has it in cc, not as the sender.
// notes (id person kind author supersedes):
//   1 1 preference agent  -  "prefers morning meetings"
//   2 1 note       owner  -  "met at the design offsite"
//   3 1 preference agent  1  "prefers meetings before 11:00"   (so note 1 no longer shows)
//   4 2 note       agent  -  "waiting on the signed lease from Tomas"
// people_accounts: personal done (420 messages, 85 events), school running (250 messages, 0 events).
// the owner's own addresses (google_accounts) are owner@personal.example and owner@school.example.

export const PEOPLE_NOW = new Date('2026-10-18T16:00:00Z');
export const PEOPLE_ACCOUNTS = ['personal', 'school'];

const at = (day: string, time = '16:00') => `2026-${day}T${time}:00.000Z`;

export function seedPeople(db: Db): void {
  const now = PEOPLE_NOW.toISOString();
  for (const [alias, email] of [
    ['personal', 'owner@personal.example'],
    ['school', 'owner@school.example'],
  ] as const) {
    db.prepare("INSERT OR IGNORE INTO google_accounts (alias, email, status, updatedAt) VALUES (?, ?, 'ok', ?)").run(alias, email, now);
    db.prepare('UPDATE google_accounts SET email = ? WHERE alias = ?').run(email, alias);
  }

  const person = db.prepare('INSERT INTO people (id, name, nameSource, organization, organizationDomain, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)');
  person.run(1, 'Maya Lindqvist', 'header', 'Northwind', 'northwind.example', at('09-02'), at('10-17'));
  person.run(2, 'Tomas Okafor', 'header', null, null, at('10-10'), at('10-16'));
  person.run(3, 'Priya', 'owner', 'Berkeley', 'berkeley.edu', at('10-01'), at('10-14'));
  person.run(4, null, 'header', 'Fabrikam', 'fabrikam.example', at('10-12'), at('10-12'));
  person.run(5, 'Jonas Weber', 'header', null, null, at('10-15'), at('10-15'));

  const email = db.prepare('INSERT INTO person_emails (email, personId, isPrimary, firstSeenAt, lastSeenAt) VALUES (?, ?, ?, ?, ?)');
  email.run('maya@northwind.example', 1, 1, at('09-02'), at('10-17'));
  email.run('maya.lindqvist@gmail.com', 1, 0, at('09-20'), at('09-20'));
  email.run('tomas.okafor@gmail.com', 2, 1, at('10-10'), at('10-16'));
  email.run('praman@berkeley.edu', 3, 1, at('10-01'), at('10-14'));
  email.run('k.osei@fabrikam.example', 4, 1, at('10-12'), at('10-12'));
  email.run('jonas.weber@outlook.com', 5, 1, at('10-15'), at('10-15'));

  const name = db.prepare('INSERT INTO person_names (personId, name, count, firstSeenAt, lastSeenAt) VALUES (?, ?, ?, ?, ?)');
  name.run(1, 'Maya Lindqvist', 4, at('09-02'), at('10-17'));
  name.run(1, 'Maya L.', 1, at('09-20'), at('09-20'));
  name.run(2, 'Tomas Okafor', 2, at('10-10'), at('10-16'));
  name.run(3, 'Priya Raman', 2, at('10-01'), at('10-14'));
  name.run(5, 'Jonas Weber', 1, at('10-15'), at('10-15'));

  const contact = db.prepare(
    `INSERT INTO person_contacts (personId, kind, account, externalId, threadId, direction, role, subject, at, endAt, cancelled, seenAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  // person 1: three mails in one thread that the owner answered last, a past meeting, an upcoming meeting.
  contact.run(1, 'mail', 'personal', 'm-101', 't-1', 'in', 'from', 'Q4 roadmap review', at('09-02'), null, 0, now);
  contact.run(1, 'mail', 'personal', 'm-102', 't-1', 'in', 'from', 'Re: Q4 roadmap review', at('10-16'), null, 0, now);
  contact.run(1, 'mail', 'personal', 'm-103', 't-1', 'out', 'to', 'Re: Q4 roadmap review', at('10-17'), null, 0, now);
  contact.run(1, 'meeting', 'personal', 'e-201', null, null, 'organizer', 'Roadmap sync', at('10-17', '17:00'), at('10-17', '17:30'), 0, now);
  contact.run(1, 'meeting', 'personal', 'e-202', null, null, 'attendee', 'Design review', at('10-21', '17:00'), at('10-21', '18:00'), 0, now);
  // person 2: a thread where Tomas wrote last, so it is open.
  contact.run(2, 'mail', 'personal', 'm-301', 't-3', 'out', 'to', 'Lease for the new place', at('10-10'), null, 0, now);
  contact.run(2, 'mail', 'personal', 'm-302', 't-3', 'in', 'from', 'Re: Lease for the new place', at('10-16'), null, 0, now);
  // person 3: a mail, a past meeting, an upcoming one and a cancelled one.
  contact.run(3, 'mail', 'school', 'm-401', 't-4', 'in', 'cc', 'Office hours moved', at('10-01'), null, 0, now);
  contact.run(3, 'meeting', 'school', 'e-401', null, null, 'organizer', 'Research meeting', at('10-14', '20:00'), at('10-14', '21:00'), 0, now);
  contact.run(3, 'meeting', 'school', 'e-402', null, null, 'organizer', 'Research meeting', at('10-20', '20:00'), at('10-20', '21:00'), 1, now);
  contact.run(3, 'meeting', 'school', 'e-403', null, null, 'organizer', 'Paper draft review', at('10-22', '20:00'), at('10-22', '21:00'), 0, now);
  // person 4: one invoice mail that the owner answered.
  contact.run(4, 'mail', 'personal', 'm-501', 't-5', 'in', 'from', 'Invoice 2291', at('10-12'), null, 0, now);
  contact.run(4, 'mail', 'personal', 'm-502', 't-5', 'out', 'to', 'Re: Invoice 2291', at('10-12', '18:00'), null, 0, now);
  // person 5: only an upcoming meeting.
  contact.run(5, 'meeting', 'personal', 'e-601', null, null, 'attendee', 'Intro call', at('10-25', '15:00'), at('10-25', '15:30'), 0, now);

  const note = db.prepare('INSERT INTO person_notes (id, personId, kind, text, author, supersedes, runId, toolCallId, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
  note.run(1, 1, 'preference', 'prefers morning meetings', 'agent', null, 'run-people-1', 'call-note-1', at('10-01'));
  note.run(2, 1, 'note', 'met at the design offsite', 'owner', null, null, null, at('10-05'));
  note.run(3, 1, 'preference', 'prefers meetings before 11:00', 'agent', 1, 'run-people-2', 'call-note-3', at('10-10'));
  note.run(4, 2, 'note', 'waiting on the signed lease from Tomas', 'agent', null, 'run-people-3', 'call-note-4', at('10-16'));

  const account = db.prepare(
    'INSERT INTO people_accounts (account, backfill, backfillPage, backfillMessages, backfillEvents, backfilledAt, sentAfter, error, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );
  account.run('personal', 'done', null, 420, 85, at('10-15'), at('10-17'), null, now);
  account.run('school', 'running', JSON.stringify({ phase: 'mail', pageToken: 'page-2' }), 250, 0, null, null, null, now);
}
