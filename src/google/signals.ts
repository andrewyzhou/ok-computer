import type { Db } from '../db/index.js';
import type { TaintSource } from '../policy/policy.js';
import { headOf } from '../text.js';
import { wrapUntrusted } from '../tools/untrusted.js';

// a signal is one row of integration_events: a new mail, a calendar change, or a detector finding.
export interface NewSignal {
  source: 'gmail' | 'calendar' | 'detector';
  account: string;
  externalId: string;
  kind: string;
  state?: 'new' | 'ready';
  summary?: string;
  occursAt?: string;
}

export interface Signal {
  id: number;
  source: string;
  account: string;
  externalId: string;
  kind: string;
  summary: string;
  label: string | null;
  occursAt: string | null;
  seenAt: string;
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
    `INSERT INTO integration_events (source, account, externalId, kind, state, summary, occursAt, seenAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (source, account, externalId) DO NOTHING`,
  );
  let added = 0;
  for (const each of signals) {
    const result = insert.run(each.source, each.account, each.externalId, each.kind, each.state ?? 'ready', each.summary ?? null, each.occursAt ?? null, now.toISOString());
    added += Number(result.changes);
  }
  return added;
}

// the c0 and c1 control characters and the two unicode line separators.
const CONTROL = new RegExp(`[${String.fromCharCode(0)}-${String.fromCharCode(0x1f)}${String.fromCharCode(0x7f)}-${String.fromCharCode(0x9f)}${String.fromCharCode(0x2028, 0x2029)}]+`, 'g');

// outside text can hold control characters and very long lines. a summary is one short line.
export function cleanLine(text: string, limit = 300): string {
  return headOf(text.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim(), limit);
}

const DIGEST_LIMIT = 20;
// an unhandled signal older than this is no longer news. it is closed without a model call.
const STALE_MS = 3 * 24 * 60 * 60_000;
// these labels are not worth the owner's attention. a detector row has no label, so it always shows.
const QUIET = ['noise', 'newsletter'];

export interface Digest {
  ids: number[];
  text: string;
  taint: TaintSource[];
}

// the digest gives the heartbeat the newest unhandled signals, at most 20. every summary is outside text, so the
// digest is wrapped and carries a taint source for each account that it quotes.
export function signalDigest(db: Db, now: Date, timeZone: string): Digest | undefined {
  db.prepare("UPDATE integration_events SET handledAt = ?, handledBy = 'stale' WHERE handledAt IS NULL AND state = 'ready' AND seenAt < ?").run(
    now.toISOString(),
    new Date(now.getTime() - STALE_MS).toISOString(),
  );
  const rows = db
    .prepare(
      `SELECT id, source, account, kind, summary, label, occursAt FROM integration_events
       WHERE handledAt IS NULL AND state = 'ready' AND (label IS NULL OR label NOT IN (${QUIET.map(() => '?').join(', ')}))
       ORDER BY id DESC LIMIT ${DIGEST_LIMIT}`,
    )
    .all(...QUIET) as Array<Record<string, string | null>>;
  if (!rows.length) return undefined;
  const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString('en-US', { timeZone, dateStyle: 'medium', timeStyle: 'short' }) : '');
  const lines = rows.map((row) => `#${row.id} ${row.kind}${row.label ? `/${row.label}` : ''} ${row.account}${row.occursAt ? ` (${when(row.occursAt)})` : ''}: ${row.summary ?? ''}`);
  const sources = [...new Set(rows.map((row) => `${row.source === 'detector' ? 'google' : row.source}:${row.account}`))];
  const at = now.toISOString();
  return {
    ids: rows.map((row) => Number(row.id)),
    text: wrapUntrusted(sources.join(', '), lines.join('\n')),
    taint: sources.map((source) => ({ source, toolName: 'google_poll', runId: null, toolCallId: `signals:${rows[0]!.id}`, at })),
  };
}

// the heartbeat marks the signals of its digest after its run ends, so a failed run shows them again.
export function markHandled(db: Db, ids: number[], by: string, now: Date): void {
  const update = db.prepare('UPDATE integration_events SET handledAt = ?, handledBy = ? WHERE id = ? AND handledAt IS NULL');
  for (const id of ids) update.run(now.toISOString(), by, id);
}
