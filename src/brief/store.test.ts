import { describe, expect, it } from 'vitest';
import { openDb } from '../db/index.js';
import { BRIEF_FULL, BRIEF_QUIET } from '../../test/fixtures/today-data.js';
import { seedBriefRows } from '../../test/seed-today.js';
import { briefOfDay, getBrief, InvalidBriefCursor, listBriefs, recordDelivery, saveBrief } from './store.js';

describe('brief store', () => {
  it('reads the seeded briefs with their newest delivery', () => {
    const db = openDb(':memory:');
    seedBriefRows(db);
    expect(getBrief(db, 'latest')).toEqual(BRIEF_FULL);
    expect(getBrief(db, 1)).toEqual(BRIEF_QUIET);
    expect(getBrief(db, 9)).toBeUndefined();
    expect(briefOfDay(db, '2026-10-12')?.id).toBe(2);
    expect(briefOfDay(db, '2026-10-13')).toBeUndefined();
  });

  it('keeps every brief of a day and gives the newest one', () => {
    const db = openDb(':memory:');
    seedBriefRows(db);
    const again = saveBrief(db, { day: '2026-10-12', runId: 'run-x', shortText: 'again', content: BRIEF_FULL.content }, new Date('2026-10-12T15:00:00Z'));
    expect(again.delivery).toBeNull();
    expect(briefOfDay(db, '2026-10-12')?.id).toBe(again.id);
    recordDelivery(db, again.id, { channel: 'telegram', ok: false, error: 'the channel failed' }, new Date('2026-10-12T15:00:01Z'));
    recordDelivery(db, again.id, { channel: 'telegram', ok: true, error: null }, new Date('2026-10-12T15:01:00Z'));
    expect(getBrief(db, again.id)?.delivery).toEqual({ channel: 'telegram', ok: true, error: null, at: '2026-10-12T15:01:00.000Z' });
  });

  it('refuses to change or delete a stored brief', () => {
    const db = openDb(':memory:');
    seedBriefRows(db);
    expect(() => db.prepare("UPDATE briefs SET shortText = 'x' WHERE id = 1").run()).toThrow(/append-only/);
    expect(() => db.prepare('DELETE FROM brief_deliveries').run()).toThrow(/append-only/);
  });

  it('pages newest first with a cursor', () => {
    const db = openDb(':memory:');
    seedBriefRows(db);
    const first = listBriefs(db, { limit: 1 });
    expect(first.briefs).toEqual([{ id: 2, day: '2026-10-12', createdAt: BRIEF_FULL.createdAt, items: 25, sent: true }]);
    const second = listBriefs(db, { limit: 1, cursor: first.nextCursor! });
    expect(second).toEqual({ briefs: [{ id: 1, day: '2026-10-11', createdAt: BRIEF_QUIET.createdAt, items: 0, sent: false }], nextCursor: null });
    expect(() => listBriefs(db, { limit: 1, cursor: 'not a cursor' })).toThrow(InvalidBriefCursor);
  });
});
