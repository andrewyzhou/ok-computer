import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Result } from '../config/load.js';
import type { Slot } from '../config/schema.js';
import type { Db } from '../db/index.js';
import { nextRun, type Schedule } from './schedule.js';

export const payloadSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('agent'),
    prompt: z.string().min(1),
    // the run is skipped without a model call when goals for today exist.
    condition: z.literal('no_goals_today').optional(),
  }),
  z.object({ type: z.literal('system_event'), text: z.string().min(1) }),
  z.object({ type: z.literal('heartbeat') }),
  z.object({ type: z.literal('goal_checkin'), goalId: z.number().int() }),
  z.object({ type: z.literal('goals_results') }),
  z.object({ type: z.literal('consolidation') }),
]);
export type Payload = z.infer<typeof payloadSchema>;

export type SessionMode = 'isolated' | 'main';
export type CreatedBy = 'owner' | 'agent' | 'system';

export interface Automation {
  id: string;
  name: string;
  schedule: Schedule;
  payload: Payload;
  sessionMode: SessionMode;
  slot: Slot;
  enabled: boolean;
  createdBy: CreatedBy;
  createdAt: string;
  updatedAt: string;
  nextRunAt: string | null;
  lastRunAt: string | null;
  consecutiveFailures: number;
}

export interface NewAutomation {
  name: string;
  schedule: Schedule;
  payload: Payload;
  sessionMode?: SessionMode;
  slot?: Slot;
  enabled?: boolean;
  createdBy: CreatedBy;
}

export type AutomationPatch = Partial<Pick<Automation, 'name' | 'schedule' | 'payload' | 'sessionMode' | 'slot' | 'enabled'>>;

const PAST = 'the time of this one-shot automation is in the past';

export function createAutomation(db: Db, input: NewAutomation, now: Date, timeZone: string): Result<Automation> {
  const enabled = input.enabled ?? true;
  const next = enabled ? nextRun(input.schedule, now, now, timeZone) : null;
  if (enabled && !next) return { ok: false, error: PAST };
  // a short id is easy for the owner and the model to repeat.
  const id = randomUUID().slice(0, 8);
  db.prepare(
    `INSERT INTO automations (id, name, schedule, payload, sessionMode, slot, enabled, createdBy, createdAt, updatedAt,
       nextRunAt, consecutiveFailures)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
  ).run(
    id,
    input.name,
    JSON.stringify(input.schedule),
    JSON.stringify(input.payload),
    input.sessionMode ?? 'isolated',
    input.slot ?? 'main',
    enabled ? 1 : 0,
    input.createdBy,
    now.toISOString(),
    now.toISOString(),
    next?.toISOString() ?? null,
  );
  return { ok: true, value: getAutomation(db, id)! };
}

export function updateAutomation(
  db: Db,
  id: string,
  patch: AutomationPatch,
  now: Date,
  timeZone: string,
): Result<Automation> {
  const current = getAutomation(db, id);
  if (!current) return { ok: false, error: `no automation has the id ${id}` };
  const merged = { ...current, ...patch };
  let nextRunAt = merged.enabled ? current.nextRunAt : null;
  let failures = current.consecutiveFailures;
  if (merged.enabled && (patch.schedule || !current.enabled)) {
    const next = nextRun(merged.schedule, now, new Date(current.createdAt), timeZone);
    if (!next) return { ok: false, error: PAST };
    nextRunAt = next.toISOString();
    if (!current.enabled) failures = 0;
  }
  db.prepare(
    `UPDATE automations SET name = ?, schedule = ?, payload = ?, sessionMode = ?, slot = ?, enabled = ?, updatedAt = ?,
       nextRunAt = ?, consecutiveFailures = ? WHERE id = ?`,
  ).run(
    merged.name,
    JSON.stringify(merged.schedule),
    JSON.stringify(merged.payload),
    merged.sessionMode,
    merged.slot,
    merged.enabled ? 1 : 0,
    now.toISOString(),
    nextRunAt,
    failures,
    id,
  );
  return { ok: true, value: getAutomation(db, id)! };
}

export function deleteAutomation(db: Db, id: string): boolean {
  return db.prepare('DELETE FROM automations WHERE id = ?').run(id).changes > 0;
}

export function getAutomation(db: Db, id: string): Automation | undefined {
  const row = db.prepare('SELECT * FROM automations WHERE id = ?').get(id);
  return row ? toAutomation(row) : undefined;
}

export function listAutomations(db: Db): Automation[] {
  return db.prepare('SELECT * FROM automations ORDER BY nextRunAt IS NULL, nextRunAt, name').all().map(toAutomation);
}

export function dueAutomations(db: Db, now: Date): Automation[] {
  return db
    .prepare('SELECT * FROM automations WHERE enabled = 1 AND nextRunAt <= ? ORDER BY nextRunAt')
    .all(now.toISOString())
    .map(toAutomation);
}

export function earliestRunAt(db: Db): Date | null {
  const row = db.prepare('SELECT MIN(nextRunAt) AS next FROM automations WHERE enabled = 1').get();
  return row?.next ? new Date(String(row.next)) : null;
}

function toAutomation(row: Record<string, unknown>): Automation {
  return {
    id: String(row.id),
    name: String(row.name),
    schedule: JSON.parse(String(row.schedule)),
    payload: JSON.parse(String(row.payload)),
    sessionMode: row.sessionMode as SessionMode,
    slot: row.slot as Slot,
    enabled: row.enabled === 1,
    createdBy: row.createdBy as CreatedBy,
    createdAt: String(row.createdAt),
    updatedAt: String(row.updatedAt),
    nextRunAt: row.nextRunAt === null ? null : String(row.nextRunAt),
    lastRunAt: row.lastRunAt === null ? null : String(row.lastRunAt),
    consecutiveFailures: Number(row.consecutiveFailures),
  };
}
