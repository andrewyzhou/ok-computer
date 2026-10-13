import { describe, expect, it } from 'vitest';
import { openDb } from '../db/index.js';
import { silentLogger } from '../observability/logger.js';
import { describeSchedule, nextRun, scheduleSchema } from './schedule.js';
import { createScheduler, type JobResult } from './scheduler.js';
import { createAutomation, getAutomation, updateAutomation, type NewAutomation } from './store.js';

const TZ = 'America/Los_Angeles';
const MIN = 60_000;

function setup(results: Array<JobResult['status']> = []) {
  const db = openDb(':memory:');
  let now = new Date('2026-10-12T17:00:00Z');
  const clock = () => now;
  const executed: string[] = [];
  const notices: string[] = [];
  const timers: number[] = [];
  const scheduler = createScheduler({
    db,
    clock,
    logger: silentLogger,
    config: { timeZone: TZ, scheduler: { missedGraceMs: 2 * 60 * MIN } },
    async execute(automation) {
      executed.push(automation.name);
      const status = results.shift() ?? 'completed';
      return status === 'failed' ? { status, error: 'boom' } : { status };
    },
    async notifyOwner(text) {
      notices.push(text);
    },
    setTimer(_fn, ms) {
      timers.push(ms);
      return () => {};
    },
  });
  const create = (input: Partial<NewAutomation> & Pick<NewAutomation, 'schedule'>) => {
    const result = createAutomation(
      db,
      { name: 'job', payload: { type: 'system_event', text: 'hi' }, createdBy: 'owner', ...input },
      now,
      TZ,
    );
    if (!result.ok) throw new Error(result.error);
    return result.value;
  };
  const advance = (ms: number) => (now = new Date(now.getTime() + ms));
  const runs = () => db.prepare('SELECT status, error FROM automation_runs ORDER BY id').all();
  return { db, scheduler, create, advance, executed, notices, timers, runs, now: () => now };
}

describe('schedules', () => {
  it('computes the next time for each kind strictly after the given time', () => {
    const created = new Date('2026-10-12T17:00:00Z');
    const after = new Date('2026-10-12T17:45:00Z');
    expect(nextRun({ kind: 'at', at: '2026-10-12T18:00:00Z' }, after, created, TZ)?.toISOString()).toBe(
      '2026-10-12T18:00:00.000Z',
    );
    expect(nextRun({ kind: 'at', at: '2026-10-12T17:00:00Z' }, after, created, TZ)).toBeNull();
    expect(nextRun({ kind: 'every', everyMs: 30 * MIN }, after, created, TZ)?.toISOString()).toBe(
      '2026-10-12T18:00:00.000Z',
    );
    expect(nextRun({ kind: 'cron', expr: '0 19 * * *' }, after, created, TZ)?.toISOString()).toBe(
      '2026-10-13T02:00:00.000Z',
    );
    expect(nextRun({ kind: 'cron', expr: '0 19 * * *', tz: 'UTC' }, after, created, TZ)?.toISOString()).toBe(
      '2026-10-12T19:00:00.000Z',
    );
  });

  it('rejects bad input', () => {
    expect(scheduleSchema.safeParse({ kind: 'at', at: '2026-10-12T18:00:00' }).success).toBe(false);
    expect(scheduleSchema.safeParse({ kind: 'cron', expr: 'every day' }).success).toBe(false);
    expect(scheduleSchema.safeParse({ kind: 'every', everyMs: 1000 }).success).toBe(false);
  });

  it('describes schedules in plain words', () => {
    expect(describeSchedule({ kind: 'every', everyMs: 60 * MIN }, TZ)).toBe('every 1 h');
    expect(describeSchedule({ kind: 'every', everyMs: 15 * MIN }, TZ)).toBe('every 15 min');
  });
});

describe('scheduler', () => {
  it('runs a job at its time and not before', async () => {
    const { scheduler, create, advance, executed } = setup();
    create({ schedule: { kind: 'every', everyMs: 30 * MIN } });
    await scheduler.tick();
    expect(executed).toEqual([]);
    advance(30 * MIN);
    await scheduler.tick();
    await scheduler.tick();
    expect(executed).toEqual(['job']);
  });

  it('disables a one-shot job after a successful run', async () => {
    const { db, scheduler, create, advance, executed } = setup();
    const job = create({ schedule: { kind: 'at', at: '2026-10-12T17:10:00Z' } });
    advance(10 * MIN);
    await scheduler.tick();
    advance(60 * MIN);
    await scheduler.tick();
    expect(executed).toEqual(['job']);
    expect(getAutomation(db, job.id)).toMatchObject({ enabled: false, nextRunAt: null });
  });

  it('refuses a one-shot job in the past', () => {
    const { db, now } = setup();
    const result = createAutomation(
      db,
      { name: 'old', schedule: { kind: 'at', at: '2026-10-12T16:00:00Z' }, payload: { type: 'heartbeat' }, createdBy: 'agent' },
      now(),
      TZ,
    );
    expect(result).toEqual({ ok: false, error: 'the time of this one-shot automation is in the past' });
  });

  it('runs a missed job one time when it is inside the grace period, then plans from now', async () => {
    const { db, scheduler, create, advance, executed } = setup();
    const job = create({ schedule: { kind: 'every', everyMs: 30 * MIN } });
    advance(100 * MIN);
    await scheduler.tick();
    expect(executed).toEqual(['job']);
    expect(getAutomation(db, job.id)?.nextRunAt).toBe('2026-10-12T19:00:00.000Z');
  });

  it('skips a job that was missed by more than the grace period', async () => {
    const { db, scheduler, create, advance, executed, runs } = setup();
    const job = create({ schedule: { kind: 'cron', expr: '0 11 * * *' } });
    advance(5 * 60 * MIN);
    await scheduler.tick();
    expect(executed).toEqual([]);
    expect(runs()).toEqual([{ status: 'skipped', error: expect.stringContaining('missed by 240 min') }]);
    expect(getAutomation(db, job.id)?.nextRunAt).toBe('2026-10-13T18:00:00.000Z');
  });

  it('backs off after failures and disables the job after five failures in a row', async () => {
    const { db, scheduler, create, advance, executed, notices } = setup(['failed', 'failed', 'failed', 'failed', 'failed']);
    const job = create({ name: 'flaky', schedule: { kind: 'every', everyMs: 24 * 60 * MIN } });
    advance(24 * 60 * MIN);
    const retries: number[] = [];
    for (let i = 0; i < 5; i++) {
      await scheduler.tick();
      const current = getAutomation(db, job.id)!;
      if (current.nextRunAt) {
        retries.push(Date.parse(current.nextRunAt) - Date.parse(current.lastRunAt!));
        advance(Date.parse(current.nextRunAt) - Date.parse(current.lastRunAt!));
      }
    }
    expect(executed).toHaveLength(5);
    expect(retries).toEqual([30_000, 60_000, 5 * MIN, 15 * MIN]);
    expect(getAutomation(db, job.id)).toMatchObject({ enabled: false, consecutiveFailures: 5 });
    expect(notices).toEqual([expect.stringContaining('"flaky" failed 5 times in a row')]);
  });

  it('resets the failure count after a success', async () => {
    const { db, scheduler, create, advance } = setup(['failed', 'completed']);
    const job = create({ schedule: { kind: 'every', everyMs: 60 * MIN } });
    advance(60 * MIN);
    await scheduler.tick();
    expect(getAutomation(db, job.id)?.consecutiveFailures).toBe(1);
    advance(30_000);
    await scheduler.tick();
    expect(getAutomation(db, job.id)?.consecutiveFailures).toBe(0);
  });

  it('keeps a timer for the next job, at most one minute away', async () => {
    const { scheduler, create, timers } = setup();
    create({ schedule: { kind: 'at', at: '2026-10-12T17:00:20Z' } });
    await scheduler.start();
    create({ schedule: { kind: 'at', at: '2026-10-12T19:00:00Z' } });
    scheduler.replan();
    expect(timers.slice(-2)).toEqual([20_000, 20_000]);
    scheduler.stop();
  });

  it('plans the next run again when a job is enabled after a pause', async () => {
    const { db, create, advance, now } = setup();
    const job = create({ schedule: { kind: 'every', everyMs: 60 * MIN }, enabled: false });
    expect(job.nextRunAt).toBeNull();
    advance(90 * MIN);
    const result = updateAutomation(db, job.id, { enabled: true }, now(), TZ);
    expect(result.ok && result.value.nextRunAt).toBe('2026-10-12T19:00:00.000Z');
  });
});
