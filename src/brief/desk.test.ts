import { describe, expect, it } from 'vitest';
import { openDb } from '../db/index.js';
import { createDelegation } from '../desk/store.js';
import { readDelegations } from './desk.js';

const END = new Date('2026-10-13T06:59:59.999Z');
const NOW = new Date('2026-10-12T14:00:00.000Z');

describe('brief delegations', () => {
  it('reads a delegation that the real desk store made', () => {
    const db = openDb(':memory:');
    const made = createDelegation(
      db,
      { title: 'Get the refund', waitingOn: { name: 'Dana', email: 'dana@example.com' }, dueAt: '2026-10-12T20:00:00.000Z', nextStep: 'call the office', createdBy: 'owner' },
      { actor: 'owner' },
      NOW,
    );
    expect(made.ok).toBe(true);
    expect(readDelegations(db, END, NOW)).toEqual([
      { id: expect.any(Number), title: 'Get the refund', status: 'waiting', nextStep: 'call the office', waitingOn: 'Dana', dueAt: '2026-10-12T20:00:00.000Z', followUpAt: null },
    ]);
  });

  it('gives an empty list for an empty desk, and throws when the desk cannot be read', () => {
    const db = openDb(':memory:');
    expect(readDelegations(db, END, NOW)).toEqual([]);
    db.exec('DROP TABLE delegation_links; DROP TABLE delegation_nudges; DROP TABLE delegation_events; DROP TABLE delegations');
    expect(() => readDelegations(db, END, NOW)).toThrow(/delegations/);
  });
});
