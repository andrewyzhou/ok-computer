import { afterEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../db/index.js';
import { findPersonByEmail, getPerson, searchPeople } from './store.js';

// the read of one person must not grow with the whole memory. a 90-day backfill of five accounts gives a few thousand
// people with tens of thousands of contacts, and the person chip reads one person for each guest of an event. the
// budget is wide, because the machine runs many tests at once, and the slow form took about 500 ms for each read.

const NOW = new Date('2026-10-18T16:00:00Z');
const PEOPLE = 3_000;
const CONTACTS_EACH = 10;

let db: Db | undefined;
afterEach(() => {
  db?.close();
  db = undefined;
});

function seeded(): Db {
  db = openDb(':memory:');
  const d = db;
  const person = d.prepare("INSERT INTO people (id, name, nameSource, createdAt, updatedAt) VALUES (?, ?, 'header', 'x', 'x')");
  const email = d.prepare('INSERT INTO person_emails (email, personId, isPrimary, firstSeenAt, lastSeenAt) VALUES (?, ?, 1, ?, ?)');
  const contact = d.prepare(
    `INSERT INTO person_contacts (personId, kind, account, externalId, threadId, direction, role, subject, at, cancelled, seenAt)
     VALUES (?, ?, 'personal', ?, ?, 'in', ?, 'Hello', ?, 0, 'x')`,
  );
  d.exec('BEGIN');
  for (let id = 1; id <= PEOPLE; id++) {
    person.run(id, `Person ${id}`);
    email.run(`p${id}@acme.example`, id, '2026-07-01T00:00:00.000Z', '2026-10-17T00:00:00.000Z');
    for (let n = 0; n < CONTACTS_EACH; n++) {
      const meeting = n % 4 === 0;
      const at = new Date(NOW.getTime() - (n + 1) * 86_400_000 + (meeting ? 5 * 86_400_000 : 0)).toISOString();
      contact.run(id, meeting ? 'meeting' : 'mail', `x-${id}-${n}`, meeting ? null : `t-${id}`, meeting ? 'attendee' : 'from', at);
    }
  }
  d.exec('COMMIT');
  return d;
}

describe('the read of one person on a large memory', () => {
  it('stays fast for findPersonByEmail and getPerson', () => {
    const d = seeded();
    // the first read prepares the statements.
    expect(findPersonByEmail(d, 'p1@acme.example', NOW)?.mailCount).toBe(7);
    const start = performance.now();
    for (let i = 0; i < 20; i++) {
      const person = findPersonByEmail(d, `p${1 + i * 137}@acme.example`, NOW)!;
      expect(person.mailCount + person.meetingCount).toBeGreaterThan(0);
      expect(getPerson(d, person.id, NOW)!.emails).toHaveLength(1);
    }
    const ms = performance.now() - start;
    expect(ms).toBeLessThan(1_000);
    // the list still reads everyone in one grouped query.
    expect(searchPeople(d, { limit: 5, sort: 'frequent' }, NOW).total).toBe(PEOPLE);
  });
});
