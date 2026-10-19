import { describe, expect, it } from 'vitest';
import { CHILD_RUN, CHILD_SESSION, seedM1, TRACE_RUN } from './seed-m1.js';

describe('the seed of phase 5 m1', () => {
  it('has a reset of main, a traced run after it, and the index of its text', async () => {
    const { t, resetEventId, ids } = await seedM1();
    const rows = (sql: string, ...params: Array<string | number>) => t.db.prepare(sql).all(...params);
    expect(rows("SELECT sessionKey FROM events WHERE id = ? AND type = 'session_reset'", resetEventId)).toEqual([{ sessionKey: 'main' }]);
    expect(ids.ownerEvent).toBeGreaterThan(resetEventId);
    expect(rows('SELECT id, status FROM runs WHERE id IN (?, ?) ORDER BY id', TRACE_RUN, CHILD_RUN)).toEqual([
      { id: TRACE_RUN, status: 'completed' },
      { id: CHILD_RUN, status: 'completed' },
    ]);
    expect(rows('SELECT COUNT(*) AS n FROM events WHERE sessionKey = ?', CHILD_SESSION)).toEqual([{ n: 2 }]);
    expect(rows("SELECT status FROM browser_tasks WHERE id = 'bt_live'")).toEqual([{ status: 'open' }]);
    // the trigger of migration 018 indexed the new events, and the backfill indexed none twice.
    expect(rows('SELECT COUNT(*) AS n FROM events_fts WHERE events_fts MATCH ?', '"coast"')).toEqual([{ n: 1 }]);
    expect(rows('SELECT COUNT(*) AS n FROM events_fts GROUP BY rowid HAVING n > 1')).toEqual([]);
  });
});
