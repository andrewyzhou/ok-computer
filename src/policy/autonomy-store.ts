import type { AutonomyActor, AutonomyChangeRow, AutonomyDomain, AutonomyLevel, AutonomyVia } from '../dashboard/autonomy-types.js';
import type { Db } from '../db/index.js';
import { redact } from '../observability/redact.js';
import { headOf } from '../text.js';
import { clampLevel, DOMAIN_IDS, domainSpec, isDomain, isLevel, levelRank } from './autonomy.js';

// the store of the trust ladder. 024_autonomy.sql makes autonomy_levels (the current level of each domain that the
// owner or the agent changed) and autonomy_changes (the append-only history). a domain with no row has its default
// level from DOMAINS in autonomy.ts.

// the reasons that a change is refused. the dashboard maps unknown_domain to 404, bad_level to 400, and the others to
// 409. the chat tool gives the text of the error to the model.
export type AutonomyErrorCode = 'unknown_domain' | 'bad_level' | 'fixed' | 'above_max' | 'not_lower' | 'stale';

export class AutonomyError extends Error {
  constructor(
    readonly code: AutonomyErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface LevelChange {
  domain: AutonomyDomain;
  level: AutonomyLevel;
  actor: AutonomyActor;
  via: AutonomyVia;
  // the level that the caller saw. a different current level refuses the change with stale.
  expected?: AutonomyLevel;
  runId?: string | null;
  toolCallId?: string | null;
  sessionKey?: string | null;
  note?: string | null;
  // the untrusted sources that the session of a change from chat had read.
  taint?: readonly string[];
}

export interface StoredLevel {
  level: AutonomyLevel;
  updatedAt: string | null;
  changeId: number | null;
}

export interface ChangeQuery {
  domain?: AutonomyDomain;
  // the id of the oldest row that the caller has. the answer holds older rows.
  before?: number;
  limit: number;
}

export const NOTE_LIMIT = 500;
// a session can read many sources. the row keeps the first ones, each cut to a limit, and the count of the others.
export const TAINT_LIMIT = 20;
export const TAINT_NAME_LIMIT = 200;
export const HISTORY_LIMIT = 200;

type Row = Record<string, unknown>;

const str = (value: unknown) => (value === null || value === undefined ? null : String(value));

export function toChangeRow(row: Row): AutonomyChangeRow {
  return {
    id: Number(row.id),
    domain: String(row.domain) as AutonomyDomain,
    fromLevel: String(row.fromLevel) as AutonomyLevel,
    toLevel: String(row.toLevel) as AutonomyLevel,
    actor: String(row.actor) as AutonomyActor,
    via: String(row.via) as AutonomyVia,
    runId: str(row.runId),
    toolCallId: str(row.toolCallId),
    sessionKey: str(row.sessionKey),
    note: str(row.note),
    taint: taintOf(row.taint),
    createdAt: String(row.createdAt),
  };
}

// a damaged taint cell reads as one source that says so, so the history never hides that the session was tainted.
function taintOf(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  try {
    const parsed: unknown = JSON.parse(String(value));
    if (Array.isArray(parsed)) return parsed.map(String);
  } catch {
    // the fallback below says that the cell did not parse.
  }
  return ['(the stored sources could not be read)'];
}

// the stored list of sources: the first TAINT_LIMIT names, each cut, then a line with the count of the others.
function storedTaint(taint: readonly string[] | undefined): string | null {
  if (!taint?.length) return null;
  const shown = taint.slice(0, TAINT_LIMIT).map((each) => headOf(redact(each), TAINT_NAME_LIMIT));
  const more = taint.length - shown.length;
  return JSON.stringify(more > 0 ? [...shown, `and ${more} more`] : shown);
}

function known(domain: AutonomyDomain): void {
  if (!isDomain(domain)) throw new AutonomyError('unknown_domain', `there is no autonomy domain ${JSON.stringify(domain)}`);
}

// the level of one domain, with the default level when no row exists. the policy engine calls it for each call in a
// domain, so it is one read by the primary key.
export function levelOf(db: Db, domain: AutonomyDomain): AutonomyLevel {
  known(domain);
  const spec = domainSpec(domain);
  const row = db.prepare('SELECT level FROM autonomy_levels WHERE domain = ?').get(domain);
  const level = row && isLevel(row.level) ? row.level : spec.defaultLevel;
  return clampLevel(level, spec.maxLevel);
}

// the level of each domain, with the time and the history row of its last change.
export function storedLevels(db: Db): Record<AutonomyDomain, StoredLevel> {
  const rows = new Map(db.prepare('SELECT domain, level, changeId, updatedAt FROM autonomy_levels').all().map((row) => [String(row.domain), row]));
  const out = {} as Record<AutonomyDomain, StoredLevel>;
  for (const domain of DOMAIN_IDS) {
    const spec = domainSpec(domain);
    const row = rows.get(domain);
    const level = row && isLevel(row.level) ? row.level : spec.defaultLevel;
    out[domain] = {
      level: clampLevel(level, spec.maxLevel),
      updatedAt: row ? String(row.updatedAt) : null,
      changeId: row ? Number(row.changeId) : null,
    };
  }
  return out;
}

// changeLevel writes the history row and the new level in one transaction. it gives null when the level is already the
// asked one, and writes nothing then. it throws an AutonomyError for a change that the rules refuse: only the owner on
// the dashboard can raise a level, a fixed domain stays at ask, and no level goes above the most of its domain.
export function changeLevel(db: Db, change: LevelChange, now: Date): AutonomyChangeRow | null {
  known(change.domain);
  if (!isLevel(change.level)) throw new AutonomyError('bad_level', `${JSON.stringify(change.level)} is not ask, review or auto`);
  if (change.expected !== undefined && !isLevel(change.expected)) throw new AutonomyError('bad_level', `${JSON.stringify(change.expected)} is not ask, review or auto`);
  const spec = domainSpec(change.domain);
  if (spec.fixedReason !== null && change.level !== 'ask') throw new AutonomyError('fixed', `${spec.label} always stays at ask: ${spec.fixedReason}`);
  if (levelRank(change.level) > levelRank(spec.maxLevel)) {
    throw new AutonomyError('above_max', `${spec.label} can go up to ${spec.maxLevel}, not to ${change.level}`);
  }
  const work = () => {
    const current = levelOf(db, change.domain);
    if (change.expected !== undefined && change.expected !== current) {
      throw new AutonomyError('stale', `${spec.label} is at ${current} now, not at ${change.expected}. Read the level again, then choose again.`);
    }
    if (change.level === current) return null;
    const raise = levelRank(change.level) > levelRank(current);
    if (raise && (change.actor !== 'owner' || change.via !== 'dashboard')) {
      throw new AutonomyError('not_lower', `only the owner can raise ${spec.label}, on the dashboard. It stays at ${current}`);
    }
    const note = change.note ? headOf(redact(change.note), NOTE_LIMIT) : null;
    const at = now.toISOString();
    const row = db
      .prepare(
        `INSERT INTO autonomy_changes (domain, fromLevel, toLevel, actor, via, runId, toolCallId, sessionKey, note, taint, createdAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
      )
      .get(
        change.domain,
        current,
        change.level,
        change.actor,
        change.via,
        change.runId ?? null,
        change.toolCallId ?? null,
        change.sessionKey ?? null,
        note,
        storedTaint(change.taint),
        at,
      )!;
    db.prepare(
      `INSERT INTO autonomy_levels (domain, level, changeId, updatedAt) VALUES (?, ?, ?, ?)
       ON CONFLICT (domain) DO UPDATE SET level = excluded.level, changeId = excluded.changeId, updatedAt = excluded.updatedAt`,
    ).run(change.domain, change.level, Number(row.id), at);
    return toChangeRow(row);
  };
  // BEGIN IMMEDIATE takes the write lock first, so the compare and set sees the newest level also when the agent and
  // the dashboard write at the same time. a caller that is already in a transaction keeps its own, and a savepoint
  // inside it takes back a half-written change, so a failed upsert does not leave a history row without its level.
  if (db.isTransaction) {
    db.exec('SAVEPOINT autonomy_change');
    try {
      const result = work();
      db.exec('RELEASE autonomy_change');
      return result;
    } catch (err) {
      // some errors, for example a full disk, end the whole transaction, and the savepoint is gone with it.
      if (db.isTransaction) {
        db.exec('ROLLBACK TO autonomy_change');
        db.exec('RELEASE autonomy_change');
      }
      throw err;
    }
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = work();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw err;
  }
}

// the history, newest first. the limit is clamped to 1 to HISTORY_LIMIT.
export function listChanges(db: Db, query: ChangeQuery): AutonomyChangeRow[] {
  const limit = Math.min(Math.max(Math.trunc(query.limit) || 1, 1), HISTORY_LIMIT);
  const where: string[] = [];
  const args: Array<string | number> = [];
  if (query.domain !== undefined) {
    where.push('domain = ?');
    args.push(query.domain);
  }
  if (query.before !== undefined) {
    where.push('id < ?');
    args.push(query.before);
  }
  return db
    .prepare(`SELECT * FROM autonomy_changes ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`)
    .all(...args, limit)
    .map(toChangeRow);
}
