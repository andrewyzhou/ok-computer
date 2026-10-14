import type { Config } from '../config/schema.js';
import type { Db } from '../db/index.js';
import type { Logger } from '../observability/logger.js';
import type { Clock } from '../time.js';
import { nextRun } from './schedule.js';
import { dueAutomations, getAutomation, listAutomations, type Automation } from './store.js';

export interface JobResult {
  status: 'completed' | 'failed' | 'skipped';
  runId?: string;
  error?: string;
}

export type SetTimer = (fn: () => void, ms: number) => () => void;

export interface SchedulerDeps {
  db: Db;
  clock: Clock;
  logger: Logger;
  config: Pick<Config, 'timeZone' | 'scheduler'>;
  execute(automation: Automation): Promise<JobResult>;
  notifyOwner(text: string): Promise<void>;
  setTimer?: SetTimer;
  // the scheduler calls this at the start of each tick, for small periodic work.
  onTick?: (now: Date) => void;
  // false for an automation that another process runs. this process then does not claim it, so it does not take the
  // run from that process. without it, the scheduler runs every automation.
  owns?: (automation: Automation) => boolean;
  // a job that started this long ago belongs to a process that stopped. the app uses the age limit of stale runs.
  staleMs: number;
}

export interface Scheduler {
  // start runs the due automations and then keeps a timer for the next ones.
  start(): Promise<void>;
  stop(): void;
  // tick runs the due automations now. tests call it after they move the fake clock.
  tick(): Promise<void>;
  // replan moves the timer after automations change.
  replan(): void;
  // runNow runs one automation at once. it does not change the schedule or the failure count.
  runNow(id: string): Promise<JobResult | undefined>;
}

export const BACKOFF_MS = [30_000, 60_000, 5 * 60_000, 15 * 60_000] as const;
export const MAX_FAILURES = 5;

// a timer can fire late after the pc sleeps, so the scheduler wakes at least one time each minute.
const MAX_SLEEP_MS = 60_000;

const realTimer: SetTimer = (fn, ms) => {
  const timer = setTimeout(fn, ms);
  return () => clearTimeout(timer);
};

export function createScheduler(deps: SchedulerDeps): Scheduler {
  const { db, clock, logger, config } = deps;
  const setTimer = deps.setTimer ?? realTimer;
  let cancel: (() => void) | undefined;
  let stopped = true;
  const owns = deps.owns ?? (() => true);
  const running = new Set<string>();

  const arm = () => {
    cancel?.();
    cancel = undefined;
    if (stopped) return;
    // an automation of another process can stay due here for a long time, so it does not set the timer.
    const earliest = listAutomations(db).find((automation) => automation.enabled && automation.nextRunAt !== null && owns(automation))?.nextRunAt;
    const delay = earliest ? Math.max(0, Date.parse(earliest) - clock().getTime()) : MAX_SLEEP_MS;
    const run = () => void tick().catch((err: unknown) => logger.error('scheduler tick failed', { err }));
    cancel = setTimer(run, Math.min(delay, MAX_SLEEP_MS));
  };

  // the claim moves nextRunAt before the job starts, so a second tick during a long job does not run it again. it is
  // a compare and set on the nextRunAt that the tick read. a second process on the same database (npm run chat)
  // ticks at the same time, and only one of the two claims wins.
  const claim = (automation: Automation, now: Date): boolean => {
    const next =
      automation.schedule.kind === 'at'
        ? null
        : nextRun(automation.schedule, now, new Date(automation.createdAt), config.timeZone);
    const claimed = db
      .prepare('UPDATE automations SET nextRunAt = ?, lastRunAt = ? WHERE id = ? AND nextRunAt IS ?')
      .run(next?.toISOString() ?? null, now.toISOString(), automation.id, automation.nextRunAt);
    return claimed.changes === 1;
  };

  const recordRun = (automation: Automation, startedAt: Date, result: JobResult): void => {
    db.prepare(
      'INSERT INTO automation_runs (automationId, runId, status, startedAt, endedAt, error) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(
      automation.id,
      result.runId ?? null,
      result.status,
      startedAt.toISOString(),
      clock().toISOString(),
      result.error ?? null,
    );
  };

  const execute = async (automation: Automation): Promise<JobResult> => {
    try {
      return await deps.execute(automation);
    } catch (err) {
      logger.error('automation crashed', { automationId: automation.id, err });
      return { status: 'failed', error: (err as Error).message };
    }
  };

  const fire = async (automation: Automation, now: Date): Promise<void> => {
    const lateMs = now.getTime() - Date.parse(automation.nextRunAt!);
    if (!claim(automation, now)) return;
    running.add(automation.id);
    try {
      await runClaimed(automation, now, lateMs);
    } finally {
      running.delete(automation.id);
    }
  };

  const runClaimed = async (automation: Automation, now: Date, lateMs: number): Promise<void> => {

    // the scheduler runs a missed job one time only. this prevents a burst of old reminders after the pc starts.
    if (lateMs > config.scheduler.missedGraceMs) {
      const error = `missed by ${Math.round(lateMs / 60_000)} min, which is more than the grace period`;
      logger.warn('automation missed', { automationId: automation.id, name: automation.name, lateMs });
      if (automation.schedule.kind === 'at') db.prepare('UPDATE automations SET enabled = 0 WHERE id = ?').run(automation.id);
      recordRun(automation, now, { status: 'skipped', error });
      return;
    }

    const result = await execute(automation);
    recordRun(automation, now, result);
    if (result.status !== 'failed') {
      if (automation.schedule.kind === 'at') {
        db.prepare('UPDATE automations SET enabled = 0, nextRunAt = NULL, consecutiveFailures = 0 WHERE id = ?').run(
          automation.id,
        );
      } else {
        db.prepare('UPDATE automations SET consecutiveFailures = 0 WHERE id = ?').run(automation.id);
      }
      return;
    }
    await onFailure(automation, result.error ?? 'unknown error');
  };

  const onFailure = async (automation: Automation, error: string): Promise<void> => {
    const failures = automation.consecutiveFailures + 1;
    logger.warn('automation failed', { automationId: automation.id, name: automation.name, failures, error });
    if (failures >= MAX_FAILURES) {
      db.prepare('UPDATE automations SET enabled = 0, nextRunAt = NULL, consecutiveFailures = ? WHERE id = ?').run(
        failures,
        automation.id,
      );
      await deps.notifyOwner(
        `The automation "${automation.name}" failed ${failures} times in a row, so I turned it off. The last error was: ${error}`,
      );
      return;
    }
    // a retry never comes later than the next normal run.
    const retry = new Date(clock().getTime() + BACKOFF_MS[failures - 1]!);
    const row = db.prepare('SELECT nextRunAt FROM automations WHERE id = ?').get(automation.id);
    const planned = row?.nextRunAt ? new Date(String(row.nextRunAt)) : null;
    const next = planned && planned < retry ? planned : retry;
    db.prepare('UPDATE automations SET nextRunAt = ?, consecutiveFailures = ? WHERE id = ?').run(
      next.toISOString(),
      failures,
      automation.id,
    );
  };

  // the claim of a one-shot job sets nextRunAt to null, and only the end of the run disables the job. when the process
  // stops during the run, the job stays enabled with no time and never runs. the job gets its planned time back. the
  // rule for missed jobs then runs it again or records it as missed.
  const reviveOneShots = (now: Date) => {
    const cutoff = now.getTime() - deps.staleMs;
    for (const automation of listAutomations(db)) {
      if (automation.schedule.kind !== 'at' || !automation.enabled || automation.nextRunAt !== null) continue;
      if (running.has(automation.id) || (automation.lastRunAt !== null && Date.parse(automation.lastRunAt) > cutoff)) continue;
      db.prepare('UPDATE automations SET nextRunAt = ? WHERE id = ? AND enabled = 1 AND nextRunAt IS NULL').run(
        new Date(automation.schedule.at).toISOString(),
        automation.id,
      );
    }
  };

  const tick = async (): Promise<void> => {
    const now = clock();
    deps.onTick?.(now);
    reviveOneShots(now);
    const runs = dueAutomations(db, now)
      .filter(owns)
      .map((automation) => fire(automation, now));
    arm();
    await Promise.all(runs);
    arm();
  };

  return {
    async start() {
      stopped = false;
      await tick();
    },
    stop() {
      stopped = true;
      arm();
    },
    tick,
    replan: arm,
    async runNow(id) {
      const automation = getAutomation(db, id);
      if (!automation) return undefined;
      const startedAt = clock();
      // some jobs take their day from nextRunAt. for a run now, the planned time is the current time.
      const result = await execute({ ...automation, nextRunAt: startedAt.toISOString() });
      recordRun(automation, startedAt, result);
      return result;
    },
  };
}
