import type { Db } from '../db/index.js';
import { headOf } from '../text.js';

// a signal is one row of integration_events: a new mail, a calendar change, or an event that starts soon. the source
// is the service (gmail, calendar, later slack), and the account is the account of that service. the summary is
// outside text.
export interface NewSignal {
  source: string;
  account: string;
  externalId: string;
  kind: string;
  state?: 'new' | 'ready';
  summary?: string;
  occursAt?: string;
  runId?: string;
}

// a detector hit says in words why code thinks that a signal needs attention.
export interface DetectorHit {
  name: string;
  detail: string;
}

// BEGIN IMMEDIATE takes the write lock at the start, so the compare and set of a cursor sees the newest value also
// when a second process writes the same database.
export function inTransaction<T>(db: Db, work: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = work();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// the unique key makes each insert idempotent. a poll that runs again after a crash or a failed page adds nothing twice.
export function addSignals(db: Db, signals: NewSignal[], now: Date): number {
  const insert = db.prepare(
    `INSERT INTO integration_events (source, account, externalId, kind, state, summary, occursAt, runId, seenAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (source, account, externalId) DO NOTHING`,
  );
  let added = 0;
  for (const each of signals) {
    const result = insert.run(
      each.source,
      each.account,
      each.externalId,
      each.kind,
      each.state ?? 'ready',
      each.summary ?? null,
      each.occursAt ?? null,
      each.runId ?? null,
      now.toISOString(),
    );
    added += Number(result.changes);
  }
  return added;
}

// the detectors check a row one time. an empty list means that they checked it and found nothing.
export function saveHits(db: Db, id: number, hits: DetectorHit[]): void {
  db.prepare('UPDATE integration_events SET detectors = ? WHERE id = ? AND detectors IS NULL').run(JSON.stringify(hits), id);
}

// the c0 and c1 control characters and the two unicode line separators.
const CONTROL = new RegExp(`[${String.fromCharCode(0)}-${String.fromCharCode(0x1f)}${String.fromCharCode(0x7f)}-${String.fromCharCode(0x9f)}${String.fromCharCode(0x2028, 0x2029)}]+`, 'g');

// outside text can hold control characters and very long lines. a summary is one short line.
export function cleanLine(text: string, limit = 300): string {
  return headOf(text.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim(), limit);
}
