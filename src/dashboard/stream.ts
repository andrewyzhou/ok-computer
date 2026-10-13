import type { Db } from '../db/index.js';
import type { LogLine, StreamMessage } from './types.js';
import { getRun, toEventRow } from './queries.js';

// the feed reads the database and the log file again on each poll. it needs no hooks in the code that writes them,
// so it also sees rows from another process.
export function createFeed(db: Db, tail: () => LogLine[]): () => StreamMessage[] {
  let lastEventId = Number(db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM events').get()!.id);
  let lastRunRow = Number(db.prepare('SELECT COALESCE(MAX(rowid), 0) AS id FROM runs').get()!.id);
  const running = new Set(
    db
      .prepare("SELECT id FROM runs WHERE status = 'running'")
      .all()
      .map((row) => String(row.id)),
  );

  return () => {
    const messages: StreamMessage[] = [];
    const changed = new Set<string>();
    for (const row of db.prepare('SELECT rowid AS rowNumber, id FROM runs WHERE rowid > ? ORDER BY rowid').all(lastRunRow)) {
      lastRunRow = Number(row.rowNumber);
      changed.add(String(row.id));
    }
    for (const id of running) changed.add(id);
    for (const id of changed) {
      const run = getRun(db, id);
      if (!run) continue;
      const known = running.has(id);
      if (run.status === 'running') running.add(id);
      else running.delete(id);
      // a known run that still runs did not change, so the feed does not send it again.
      if (!(known && run.status === 'running')) messages.push({ kind: 'run', run });
    }
    for (const row of db.prepare('SELECT * FROM events WHERE id > ? ORDER BY id').all(lastEventId)) {
      const event = toEventRow(row);
      lastEventId = event.id;
      messages.push({ kind: 'event', event });
    }
    for (const line of tail()) messages.push({ kind: 'log', line });
    return messages;
  };
}
