import { describe, expect, it } from 'vitest';
import { openDb } from '../db/index.js';
import { listAutomations } from '../scheduler/store.js';
import { createToolRegistry } from '../tools/registry.js';
import { addGoal, goalStats, listCheckins, startCheckin, updateGoal } from './store.js';
import { createGoalTools } from './tools.js';

const TZ = 'America/Los_Angeles';
const NAMES = ['goals_set', 'goals_list', 'goal_update', 'goals_stats'];

function setup() {
  const db = openDb(':memory:');
  let now = new Date('2026-10-13T02:30:00Z');
  let replans = 0;
  const registry = createToolRegistry(createGoalTools({ db, replan: () => replans++ }));
  const call = (name: string, input: unknown) =>
    registry.run({ id: 't', name, input }, NAMES, {
      runId: 'r',
      sessionKey: 'main',
      timeZone: TZ,
      clock: () => now,
      signal: new AbortController().signal,
    });
  const checkins = () =>
    listAutomations(db)
      .filter((a) => a.payload.type === 'goal_checkin')
      .map((a) => ({ enabled: a.enabled, at: a.schedule.kind === 'at' ? a.schedule.at : '' }));
  return { db, call, checkins, replans: () => replans, setNow: (d: Date) => (now = d) };
}

describe('goal tools', () => {
  it('sets goals for today with local etas and plans one check-in for each eta', async () => {
    const { call, checkins, replans } = setup();
    const out = await call('goals_set', {
      goals: [{ title: 'finish essay', eta: '21:00' }, { title: 'gym', eta: '2026-10-12T22:30:00-07:00' }, { title: 'read' }],
    });
    expect(out.isError).toBeUndefined();
    expect(out.content).toBe(
      'goals for 2026-10-12:\n#1 finish essay [open, eta 21:00]\n#2 gym [open, eta 22:30]\n#3 read [open]',
    );
    expect(checkins()).toEqual([
      { enabled: true, at: '2026-10-13T04:00:00.000Z' },
      { enabled: true, at: '2026-10-13T05:30:00.000Z' },
    ]);
    expect(replans()).toBe(1);
  });

  it('rejects an eta that is not a clock time or an iso time with an offset', async () => {
    const { call } = setup();
    const out = await call('goals_set', { goals: [{ title: 'x', eta: 'tonight' }] });
    expect(out).toEqual({ content: expect.stringContaining('"tonight"'), isError: true });
  });

  it('moves the check-in when the eta changes and removes it when the goal is done', async () => {
    const { call, checkins } = setup();
    await call('goals_set', { goals: [{ title: 'essay', eta: '21:00' }] });
    await call('goal_update', { id: 1, eta: '22:00', note: 'started late' });
    expect(checkins()).toEqual([
      { enabled: true, at: '2026-10-13T05:00:00.000Z' },
      { enabled: false, at: '2026-10-13T04:00:00.000Z' },
    ]);
    const done = await call('goal_update', { id: 1, status: 'done' });
    expect(done.content).toBe('#1 essay [done, eta 22:00] (note: started late)');
    expect(checkins().filter((c) => c.enabled)).toEqual([]);
  });

  it('lists a range of days', async () => {
    const { call } = setup();
    await call('goals_set', { day: '2026-10-11', goals: [{ title: 'a' }] });
    await call('goals_set', { goals: [{ title: 'b' }] });
    expect((await call('goals_list', { from: '2026-10-11' })).content).toBe(
      '2026-10-11 #1 a [open]\n2026-10-12 #2 b [open]',
    );
    expect((await call('goals_list', {})).content).toBe('2026-10-12 #2 b [open]');
  });
});

describe('goal store', () => {
  it('records the answer of each check-in', () => {
    const db = openDb(':memory:');
    const now = new Date('2026-10-13T04:00:00Z');
    const goal = addGoal(db, { day: '2026-10-12', title: 'essay', eta: now.toISOString() }, now);
    startCheckin(db, goal.id, now);
    updateGoal(db, goal.id, { eta: '2026-10-13T05:00:00.000Z' }, now);
    startCheckin(db, goal.id, now);
    startCheckin(db, goal.id, now);
    updateGoal(db, goal.id, { status: 'done' }, now);
    expect(listCheckins(db, goal.id).map((c) => c.answer)).toEqual(['not_yet', 'no_answer', 'done']);
  });

  it('computes hit rate and streaks from the database', () => {
    const db = openDb(':memory:');
    const now = new Date('2026-10-13T04:00:00Z');
    const add = (day: string, status: 'open' | 'done' | 'dropped') => {
      const goal = addGoal(db, { day, title: 'g', eta: '2026-10-20T00:00:00.000Z' }, now);
      updateGoal(db, goal.id, { status }, now);
    };
    add('2026-10-08', 'open');
    add('2026-10-09', 'done');
    add('2026-10-10', 'done');
    add('2026-10-10', 'dropped');
    add('2026-10-11', 'done');
    expect(goalStats(db, '2026-10-06', '2026-10-12')).toEqual({
      from: '2026-10-06',
      to: '2026-10-12',
      daysWithGoals: 4,
      goals: 5,
      done: 3,
      doneOnTime: 3,
      dropped: 1,
      open: 1,
      hitRate: 0.6,
      setStreak: 4,
      allDoneStreak: 1,
    });
  });
});
