import type { PlaidSyncTrigger, PlaidSyncView } from '../dashboard/plaid-types.js';
import type { Db } from '../db/index.js';

// the log of syncs (plaid_syncs of 030_plaid.sql). a row starts when a sync of an item starts and ends one time. the
// scaffold builds it, because the sync writes it and the status page reads it.

const text = (value: unknown) => (value === null || value === undefined ? null : String(value));

function toSync(row: Record<string, unknown>): PlaidSyncView {
  return {
    id: Number(row.id),
    itemId: row.itemId === null ? null : Number(row.itemId),
    runId: text(row.runId),
    trigger: row.trigger as PlaidSyncTrigger,
    startedAt: String(row.startedAt),
    endedAt: text(row.endedAt),
    added: Number(row.added),
    modified: Number(row.modified),
    removed: Number(row.removed),
    streams: Number(row.streams),
    error: text(row.error),
  };
}

export function startSync(db: Db, input: { itemId: number | null; runId: string | null; trigger: PlaidSyncTrigger }, now: Date): number {
  const result = db.prepare('INSERT INTO plaid_syncs (itemId, runId, trigger, startedAt) VALUES (?, ?, ?, ?)').run(input.itemId, input.runId, input.trigger, now.toISOString());
  return Number(result.lastInsertRowid);
}

export interface SyncEnd {
  added: number;
  modified: number;
  removed: number;
  streams: number;
  error: string | null;
}

// the end of a row. a second end throws, because the table allows one.
export function endSync(db: Db, id: number, end: SyncEnd, now: Date): void {
  db.prepare('UPDATE plaid_syncs SET endedAt = ?, added = ?, modified = ?, removed = ?, streams = ?, error = ? WHERE id = ?').run(
    now.toISOString(),
    end.added,
    end.modified,
    end.removed,
    end.streams,
    end.error,
    id,
  );
}

// the newest sync, of one item or of any item.
export function lastSync(db: Db, itemId?: number): PlaidSyncView | null {
  const row =
    itemId === undefined
      ? db.prepare('SELECT * FROM plaid_syncs ORDER BY id DESC LIMIT 1').get()
      : db.prepare('SELECT * FROM plaid_syncs WHERE itemId = ? ORDER BY id DESC LIMIT 1').get(itemId);
  return row ? toSync(row) : null;
}

export function listSyncs(db: Db, limit = 20): PlaidSyncView[] {
  return db.prepare('SELECT * FROM plaid_syncs ORDER BY id DESC LIMIT ?').all(limit).map(toSync);
}
