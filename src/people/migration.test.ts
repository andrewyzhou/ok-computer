import { describe, expect, it } from 'vitest';
import { openDb } from '../db/index.js';
import { seedPeople } from '../../test/seed-people.js';
import { normalizeEmail } from './address.js';

describe('the people tables', () => {
  it('take the seed, and keep the notes append-only', () => {
    const db = openDb(':memory:');
    seedPeople(db);
    expect(db.prepare('SELECT COUNT(*) AS n FROM people').get()?.n).toBe(5);
    expect(db.prepare('SELECT COUNT(*) AS n FROM person_contacts').get()?.n).toBe(14);
    expect(() => db.prepare("UPDATE person_notes SET text = 'changed' WHERE id = 1").run()).toThrow(/append-only/);
    expect(() => db.prepare('DELETE FROM person_notes WHERE id = 1').run()).toThrow(/append-only/);
    db.close();
  });

  it('refuses a contact that names a kind, a role or a direction it does not know', () => {
    const db = openDb(':memory:');
    seedPeople(db);
    const insert = (kind: string, role: string, direction: string | null) =>
      db
        .prepare(
          `INSERT INTO person_contacts (personId, kind, account, externalId, direction, role, at, seenAt)
           VALUES (1, ?, 'personal', 'x-1', ?, ?, '2026-10-18T00:00:00.000Z', '2026-10-18T00:00:00.000Z')`,
        )
        .run(kind, direction, role);
    expect(() => insert('chat', 'from', 'in')).toThrow();
    expect(() => insert('mail', 'bcc', 'in')).toThrow();
    expect(() => insert('mail', 'from', 'sideways')).toThrow();
    db.close();
  });
});

describe('normalizeEmail', () => {
  it('lowers the case and drops the angle brackets, and keeps dots and plus tags', () => {
    expect(normalizeEmail('  <Jane.Doe+work@Acme.COM> ')).toBe('jane.doe+work@acme.com');
  });

  it('refuses text that is not one address', () => {
    for (const raw of ['', 'jane', '@acme.com', 'jane@', 'jane@acme', 'a b@acme.com', 'jane@acme.com, joe@acme.com', 'Jane <jane@acme.com>']) {
      expect(normalizeEmail(raw), raw).toBeNull();
    }
  });
});
