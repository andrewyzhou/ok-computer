import type { Db } from '../db/index.js';
import type { TaintSource } from '../policy/policy.js';
import { wrapUntrusted } from '../tools/untrusted.js';
import type { DetectorHit } from './store.js';

// the heartbeat runs on a small model, so the digest has a limit.
const DIGEST_LIMIT = 20;
// an unhandled signal older than this is no longer news. it is closed without a model call.
const STALE_MS = 3 * 24 * 60 * 60_000;

export interface Digest {
  // the signals that the heartbeat sees, newest first.
  shown: number[];
  // newsletters and noise without a detector hit, and events that already started. the owner never needs them, so
  // they are closed as filtered without a model call.
  filtered: number[];
  text: string;
  taint: TaintSource[];
}

interface Row {
  id: number;
  source: string;
  account: string;
  kind: string;
  summary: string | null;
  label: string | null;
  occursAt: string | null;
  detectors: string | null;
  seenAt: string;
}

// a row that the detectors did not check yet is never quiet, so a failed detector run shows more, never less.
const quiet = (row: Row, now: Date) =>
  (row.detectors === '[]' && (row.label === 'newsletter' || row.label === 'noise')) ||
  (row.kind === 'event_soon' && row.occursAt !== null && row.occursAt <= now.toISOString());

// the digest gives the heartbeat the newest unhandled signals. every summary is outside text, so the digest is wrapped
// and carries one taint source for each source and account that it quotes.
export function signalDigest(db: Db, now: Date, timeZone: string): Digest | undefined {
  db.prepare("UPDATE integration_events SET handledAt = ?, handledAs = 'stale' WHERE handledAt IS NULL AND state = 'ready' AND seenAt < ?").run(
    now.toISOString(),
    new Date(now.getTime() - STALE_MS).toISOString(),
  );
  // a poll makes a mail ready before its detectors run. a heartbeat in that gap would show the mail without its hit
  // and close it, so the hit would never reach the owner. a mail that the detectors did not check therefore waits
  // while a poll runs. after a failed detector run no poll runs, so the mail shows unchecked.
  const open = db
    .prepare(
      `SELECT id, source, account, kind, summary, label, occursAt, detectors, seenAt FROM integration_events
       WHERE handledAt IS NULL AND state = 'ready'
         AND NOT (source = 'gmail' AND detectors IS NULL AND EXISTS (SELECT 1 FROM runs WHERE trigger = 'poll' AND status = 'running'))
       ORDER BY id DESC`,
    )
    .all() as unknown as Row[];
  const filtered = open.filter((row) => quiet(row, now));
  const shown = open.filter((row) => !quiet(row, now)).slice(0, DIGEST_LIMIT);
  if (!shown.length && !filtered.length) return undefined;
  const when = (iso: string) => new Date(iso).toLocaleString('en-US', { timeZone, dateStyle: 'medium', timeStyle: 'short' });
  const lines = shown.map((row) => {
    const hits = row.detectors ? (JSON.parse(row.detectors) as DetectorHit[]) : [];
    return [
      `#${row.id} ${row.kind}${row.label ? `/${row.label}` : ''} ${row.source}:${row.account}${row.occursAt ? ` (${when(row.occursAt)})` : ''}: ${row.summary ?? ''}`,
      ...hits.map((hit) => `  detector ${hit.name}: ${hit.detail}`),
    ].join('\n');
  });
  const sources = [...new Set(shown.map((row) => `${row.source}:${row.account}`))];
  // the oldest shown signal of each source names where the text came from, like the first tool call of a source.
  const taint = sources.map((source) => {
    const first = [...shown].reverse().find((row) => `${row.source}:${row.account}` === source)!;
    return { source, toolName: `${first.source} poll`, runId: null, toolCallId: `signal:${first.id}`, at: first.seenAt };
  });
  return {
    shown: shown.map((row) => row.id),
    filtered: filtered.map((row) => row.id),
    text: shown.length ? wrapUntrusted(sources.join(', '), lines.join('\n')) : '',
    taint,
  };
}

// a completed heartbeat handles every signal of its digest: notified when it sent the owner a message, seen when it
// stayed silent. the heartbeat calls this after the send, so a crash before it shows the signals again. a failed
// heartbeat does not call it.
export function finishDigest(db: Db, digest: Digest, runId: string | null, notified: boolean, now: Date): void {
  const mark = db.prepare('UPDATE integration_events SET handledAt = ?, handledAs = ?, handledBy = ? WHERE id = ? AND handledAt IS NULL');
  const at = now.toISOString();
  for (const id of digest.shown) mark.run(at, notified ? 'notified' : 'seen', runId, id);
  for (const id of digest.filtered) mark.run(at, 'filtered', runId, id);
}
