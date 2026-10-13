import type { Config } from '../config/schema.js';
import type { Db } from '../db/index.js';
import type { Logger } from '../observability/logger.js';
import type { Clock } from '../time.js';
import { nextRun } from './schedule.js';
import { dueAutomations, earliestRunAt, getAutomation, type Automation } from './store.js';

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

  const arm = () => {
    cancel?.();
    cancel = undefined;
    if (stopped) return;
    const earliest = earliestRunAt(db);
    const delay = earliest ? Math.max(0, earliest.getTime() - clock().getTime()) : MAX_SLEEP_MS;
    const run = () => void tick().catch((err: unknown) => logger.error('scheduler tick failed', { err }));
    cancel = setTimer(run, Math.min(delay, MAX_SLEEP_MS));
  };

  // the claim moves nextRunAt before the job starts, so a second tick during a long job does not run it again.
  const claim = (automation: Automation, now: Date): void => {
    const next =
      automation.schedule.kind === 'at'
        ? null
        : nextRun(automation.schedule, now, new Date(automation.createdAt), config.timeZone);
    db.prepare('UPDATE automations SET nextRunAt = ?, lastRunAt = ? WHERE id = ?').run(
      next?.toISOString() ?? null,
      now.toISOString(),
      automation.id,
    );
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
    claim(automation, now);

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

  const tick = async (): Promise<void> => {
    const now = clock();
    deps.onTick?.(now);
    const runs = dueAutomations(db, now).map((automation) => fire(automation, now));
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
      const result = await execute(automation);
      recordRun(automation, startedAt, result);
      return result;
    },
  };
}
