import { describe, expect, it } from 'vitest';
import { openDb, type Db } from '../db/index.js';
import { silentLogger } from '../observability/logger.js';
import { describeSchedule, nextRun, scheduleSchema } from './schedule.js';
import { createScheduler, type JobResult } from './scheduler.js';
import { createAutomation, getAutomation, updateAutomation, type Automation, type NewAutomation } from './store.js';

const TZ = 'America/Los_Angeles';
const MIN = 60_000;

function setup(results: Array<JobResult['status']> = [], during?: (db: Db, automation: Automation, now: Date) => void) {
  const db = openDb(':memory:');
  let now = new Date('2026-10-12T17:00:00Z');
  const clock = () => now;
  const executed: string[] = [];
  const planned: Array<string | null> = [];
  const notices: string[] = [];
  const timers: number[] = [];
  const scheduler = createScheduler({
    db,
    clock,
    logger: silentLogger,
    config: { timeZone: TZ, scheduler: { missedGraceMs: 2 * 60 * MIN } },
    staleMs: 40 * MIN,
    async execute(automation) {
      executed.push(automation.name);
      planned.push(automation.nextRunAt);
      during?.(db, automation, now);
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
  return { db, scheduler, create, advance, executed, planned, notices, timers, runs, now: () => now };
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

  // croner reads a sixth field as seconds, so this cron would run each five seconds.
  it('accepts a cron with five fields only', () => {
    expect(scheduleSchema.safeParse({ kind: 'cron', expr: ' */5 * * * * ' }).success).toBe(true);
    expect(scheduleSchema.safeParse({ kind: 'cron', expr: '*/5 * * * * *' }).success).toBe(false);
    expect(scheduleSchema.safeParse({ kind: 'cron', expr: '0 0 9 * * * 2027' }).success).toBe(false);
  });

  // "+255536-..." sorts before "2026-..." in the store, so a job past the year 9999 was due on each tick.
  it('refuses a time past the year 9999, and never plans a run past it', () => {
    const after = new Date('2026-10-12T17:00:00Z');
    expect(scheduleSchema.safeParse({ kind: 'at', at: '+020000-01-01T00:00:00Z' }).success).toBe(false);
    expect(scheduleSchema.safeParse({ kind: 'at', at: '9999-12-31T23:00:00Z' }).success).toBe(true);
    expect(scheduleSchema.safeParse({ kind: 'every', everyMs: 60 * MIN, anchor: '+010000-01-01T00:00:00Z' }).success).toBe(false);
    expect(scheduleSchema.safeParse({ kind: 'every', everyMs: 8e15 }).success).toBe(false);
    expect(scheduleSchema.safeParse({ kind: 'every', everyMs: 366 * 24 * 60 * MIN }).success).toBe(true);
    expect(nextRun({ kind: 'every', everyMs: 8e15 }, after, after, TZ)).toBeNull();
    expect(nextRun({ kind: 'at', at: '+020000-01-01T00:00:00Z' }, after, after, TZ)).toBeNull();
  });

  it('describes schedules in plain words', () => {
    expect(describeSchedule({ kind: 'every', everyMs: 60 * MIN }, TZ)).toBe('every 1 h');
    expect(describeSchedule({ kind: 'every', everyMs: 15 * MIN }, TZ)).toBe('every 15 min');
    expect(describeSchedule({ kind: 'cron', expr: '5 7 * * *' }, TZ)).toBe(
      'every day at 07:05, cron "5 7 * * *" (America/Los_Angeles)',
    );
    expect(describeSchedule({ kind: 'cron', expr: '0 9 * * 1' }, TZ)).toBe('cron "0 9 * * 1" (America/Los_Angeles)');
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

  // two processes on one database can arm their timer for the same nextRunAt, for example an older build without the
  // instance lock. the second process here reads the due jobs, and then the first process claims and runs them before
  // the second claims.
  it('runs a due job one time when a second process ticks at the same moment', async () => {
    const { db, create, executed, now } = setup();
    create({ name: 'once', schedule: { kind: 'at', at: new Date(now().getTime() + MIN).toISOString() } });
    create({ name: 'every', schedule: { kind: 'every', everyMs: MIN } });
    const later = new Date(now().getTime() + MIN);
    const scheduler = (name: string, onDue?: () => void) => {
      // the second process sees the database through a wrapper that lets the first process act after its read.
      const seen = onDue
        ? (new Proxy(db, {
            get: (target, key) =>
              key === 'prepare'
                ? (sql: string) => {
                    const statement = target.prepare(sql);
                    if (!sql.includes('nextRunAt <= ?')) return statement;
                    return { all: (...args: never[]) => [statement.all(...args), onDue()][0] };
                  }
                : Reflect.get(target, key, target),
          }) as typeof db)
        : db;
      return createScheduler({
        db: seen,
        clock: () => later,
        logger: silentLogger,
        config: { timeZone: TZ, scheduler: { missedGraceMs: 2 * 60 * MIN } },
        staleMs: 40 * MIN,
        async execute(automation) {
          executed.push(`${name} ran ${automation.name}`);
          return { status: 'completed' };
        },
        async notifyOwner() {},
        setTimer: () => () => {},
      });
    };
    const service = scheduler('service');
    let first: Promise<void> | undefined;
    const chat = scheduler('chat', () => (first = service.tick()));
    await chat.tick();
    await first;
    expect(executed.sort()).toEqual(['service ran every', 'service ran once']);
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

  it('keeps a one-shot job on when its run gives it a new time', async () => {
    const { db, scheduler, create, advance, executed } = setup([], (db, automation, now) => {
      updateAutomation(db, automation.id, { schedule: { kind: 'at', at: '2026-10-12T18:00:00Z' } }, now, TZ);
    });
    const job = create({ schedule: { kind: 'at', at: '2026-10-12T17:10:00Z' } });
    advance(10 * MIN);
    await scheduler.tick();
    expect(getAutomation(db, job.id)).toMatchObject({ enabled: true, nextRunAt: '2026-10-12T18:00:00.000Z' });
    advance(50 * MIN);
    await scheduler.tick();
    expect(executed).toEqual(['job', 'job']);
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

  it('backs off after failures, and keeps a recurring job on at its next normal time after five failures', async () => {
    const { db, scheduler, create, advance, executed, notices } = setup(['failed', 'failed', 'failed', 'failed', 'failed', 'failed']);
    const job = create({ name: 'flaky', schedule: { kind: 'every', everyMs: 24 * 60 * MIN } });
    advance(24 * 60 * MIN);
    const retries: number[] = [];
    for (let i = 0; i < 4; i++) {
      await scheduler.tick();
      const current = getAutomation(db, job.id)!;
      retries.push(Date.parse(current.nextRunAt!) - Date.parse(current.lastRunAt!));
      advance(Date.parse(current.nextRunAt!) - Date.parse(current.lastRunAt!));
    }
    await scheduler.tick();
    expect(executed).toHaveLength(5);
    expect(retries).toEqual([30_000, 60_000, 5 * MIN, 15 * MIN]);
    expect(getAutomation(db, job.id)).toMatchObject({ enabled: true, consecutiveFailures: 5, nextRunAt: '2026-10-14T17:00:00.000Z' });
    expect(notices).toEqual([expect.stringContaining('"flaky" failed 5 times in a row. I keep it on. It runs again at')]);

    // the next failure comes one day later and gives no second message.
    advance(Date.parse('2026-10-14T17:00:00Z') - Date.parse(getAutomation(db, job.id)!.lastRunAt!));
    await scheduler.tick();
    expect(executed).toHaveLength(6);
    expect(getAutomation(db, job.id)).toMatchObject({ enabled: true, consecutiveFailures: 6, nextRunAt: '2026-10-15T17:00:00.000Z' });
    expect(notices).toHaveLength(1);
  });

  it('turns a one-shot job off after five failures in a row', async () => {
    const { db, scheduler, create, advance, notices } = setup(['failed', 'failed', 'failed', 'failed', 'failed']);
    const job = create({ name: 'once', schedule: { kind: 'at', at: '2026-10-12T18:00:00Z' } });
    advance(60 * MIN);
    for (let i = 0; i < 5; i++) {
      await scheduler.tick();
      const next = getAutomation(db, job.id)!.nextRunAt;
      if (next) advance(Date.parse(next) - Date.parse(getAutomation(db, job.id)!.lastRunAt!));
    }
    expect(getAutomation(db, job.id)).toMatchObject({ enabled: false, nextRunAt: null, consecutiveFailures: 5 });
    expect(notices).toEqual([expect.stringContaining('"once" failed 5 times in a row, so I turned it off')]);
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

  it('runs a job now without a change to its schedule or failure count', async () => {
    const { db, scheduler, create, executed, runs } = setup(['failed']);
    const job = create({ schedule: { kind: 'every', everyMs: 60 * MIN }, enabled: false });
    expect(await scheduler.runNow(job.id)).toEqual({ status: 'failed', error: 'boom' });
    expect(executed).toEqual(['job']);
    expect(runs()).toEqual([{ status: 'failed', error: 'boom' }]);
    expect(getAutomation(db, job.id)).toMatchObject({ enabled: false, nextRunAt: null, consecutiveFailures: 0 });
    expect(await scheduler.runNow('missing')).toBeUndefined();
  });

  it('gives a job that runs now the current time as its planned time', async () => {
    const { db, scheduler, create, planned } = setup();
    const job = create({ schedule: { kind: 'every', everyMs: 60 * MIN } });
    await scheduler.runNow(job.id);
    expect(planned).toEqual(['2026-10-12T17:00:00.000Z']);
    expect(getAutomation(db, job.id)?.nextRunAt).toBe('2026-10-12T18:00:00.000Z');
  });
});

// okc stop ends the process at once. a one-shot job that runs at that moment had no time and stayed enabled.
describe('a one-shot job of a stopped process', () => {
  const start = new Date('2026-10-12T17:00:00Z');
  const processOn = (db: ReturnType<typeof openDb>, clock: () => Date, executed: string[], hang = false) =>
    createScheduler({
      db,
      clock,
      logger: silentLogger,
      config: { timeZone: TZ, scheduler: { missedGraceMs: 2 * 60 * MIN } },
      staleMs: 40 * MIN,
      execute: (automation) => (executed.push(automation.name), hang ? new Promise<JobResult>(() => {}) : Promise.resolve({ status: 'completed' })),
      notifyOwner: async () => {},
      setTimer: () => () => {},
    });
  const oneShot = (db: ReturnType<typeof openDb>) => {
    const created = createAutomation(db, { name: 'reminder', schedule: { kind: 'at', at: '2026-10-12T17:10:00Z' }, payload: { type: 'system_event', text: 'hi' }, createdBy: 'owner' }, start, TZ);
    if (!created.ok) throw new Error(created.error);
    return created.value.id;
  };

  it('runs again in the next process when the grace period allows it', async () => {
    const db = openDb(':memory:');
    let now = new Date(start.getTime() + 10 * MIN);
    const executed: string[] = [];
    const id = oneShot(db);
    void processOn(db, () => now, executed, true).tick();
    await Promise.resolve();
    expect(getAutomation(db, id)).toMatchObject({ enabled: true, nextRunAt: null });

    now = new Date(start.getTime() + 60 * MIN);
    await processOn(db, () => now, executed).tick();
    expect(executed).toEqual(['reminder', 'reminder']);
    expect(getAutomation(db, id)).toMatchObject({ enabled: false, nextRunAt: null });
  });

  it('is recorded as missed and turned off after the grace period', async () => {
    const db = openDb(':memory:');
    let now = new Date(start.getTime() + 10 * MIN);
    const executed: string[] = [];
    const id = oneShot(db);
    void processOn(db, () => now, executed, true).tick();
    await Promise.resolve();

    now = new Date(start.getTime() + 5 * 60 * MIN);
    await processOn(db, () => now, executed).tick();
    expect(executed).toEqual(['reminder']);
    expect(getAutomation(db, id)!.enabled).toBe(false);
    expect(db.prepare('SELECT status FROM automation_runs').all()).toEqual([{ status: 'skipped' }]);
  });

  it('stays claimed while its own process still runs it', async () => {
    const db = openDb(':memory:');
    let now = new Date(start.getTime() + 10 * MIN);
    const executed: string[] = [];
    const id = oneShot(db);
    const live = processOn(db, () => now, executed, true);
    void live.tick();
    await Promise.resolve();

    now = new Date(start.getTime() + 60 * MIN);
    await live.tick();
    expect(executed).toEqual(['reminder']);
    expect(getAutomation(db, id)!.nextRunAt).toBeNull();
  });
});
