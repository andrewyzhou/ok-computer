import { describe, expect, it } from 'vitest';
import { openDb } from '../db/index.js';
import { createAutomation, deleteAutomation, listAutomations, updateAutomation } from '../scheduler/store.js';
import { BRIEF_AUTOMATION_NAME } from './context.js';
import { briefAutomation, briefSchedule, installBrief, setBriefTime } from './install.js';

const TZ = 'America/Los_Angeles';
// 07:29 on monday 2026-10-12 in pdt.
const NOW = new Date('2026-10-12T14:29:00Z');
const config = { timeZone: TZ };

describe('brief automation', () => {
  it('installs the brief one time, at 07:30 each day on the utility slot', () => {
    const db = openDb(':memory:');
    expect(briefSchedule(db, TZ, false)).toEqual({ automationId: null, time: null, enabled: false, nextRunAt: null, running: false });
    expect(installBrief(db, config, NOW)).toBe(true);
    expect(installBrief(db, config, NOW)).toBe(false);
    const briefs = listAutomations(db).filter((each) => each.payload.type === 'brief');
    expect(briefs).toHaveLength(1);
    expect(briefs[0]).toMatchObject({
      name: BRIEF_AUTOMATION_NAME,
      schedule: { kind: 'cron', expr: '30 7 * * *', tz: TZ },
      payload: { type: 'brief' },
      slot: 'utility',
      sessionMode: 'isolated',
      createdBy: 'system',
      enabled: true,
      nextRunAt: '2026-10-12T14:30:00.000Z',
    });
    expect(briefSchedule(db, TZ, true)).toEqual({ automationId: briefs[0]!.id, time: '07:30', enabled: true, nextRunAt: '2026-10-12T14:30:00.000Z', running: true });
  });

  it('does not bring back an automation that the owner deleted', () => {
    const db = openDb(':memory:');
    installBrief(db, config, NOW);
    expect(deleteAutomation(db, briefAutomation(db)!.id)).toBe(true);
    expect(installBrief(db, config, NOW)).toBe(false);
    expect(briefAutomation(db)).toBeUndefined();
  });

  it('keeps a brief automation that is already there', () => {
    const db = openDb(':memory:');
    const own = createAutomation(db, { name: 'my brief', schedule: { kind: 'cron', expr: '0 6 * * 1-5', tz: TZ }, payload: { type: 'brief' }, createdBy: 'owner' }, NOW, TZ);
    if (!own.ok) throw new Error(own.error);
    expect(installBrief(db, config, NOW)).toBe(false);
    expect(listAutomations(db).filter((each) => each.payload.type === 'brief').map((each) => each.id)).toEqual([own.value.id]);
    // a schedule that does not run one time each day has no time.
    expect(briefSchedule(db, TZ, false)).toMatchObject({ automationId: own.value.id, time: null, enabled: true });
  });

  it('moves the brief, turns it on and makes it again when it is missing', () => {
    const db = openDb(':memory:');
    installBrief(db, config, NOW);
    const id = briefAutomation(db)!.id;
    updateAutomation(db, id, { enabled: false }, NOW, TZ);
    expect(briefSchedule(db, TZ, false)).toMatchObject({ enabled: false, nextRunAt: null });

    const moved = setBriefTime(db, '08:00', NOW, TZ);
    expect(moved).toEqual({ ok: true, value: { automationId: id, time: '08:00', enabled: true, nextRunAt: '2026-10-12T15:00:00.000Z', running: false } });
    expect(briefAutomation(db)?.schedule).toEqual({ kind: 'cron', expr: '0 8 * * *', tz: TZ });

    deleteAutomation(db, id);
    const again = setBriefTime(db, '06:05', NOW, TZ);
    if (!again.ok) throw new Error(again.error);
    expect(again.value).toMatchObject({ time: '06:05', enabled: true, nextRunAt: '2026-10-13T13:05:00.000Z' });
    expect(again.value.automationId).not.toBe(id);
    expect(briefAutomation(db)).toMatchObject({ name: BRIEF_AUTOMATION_NAME, slot: 'utility', createdBy: 'system' });
  });

  it('refuses a time that is not HH:MM of one day', () => {
    const db = openDb(':memory:');
    installBrief(db, config, NOW);
    for (const time of ['24:00', '7:30', '07:60', '0730', '']) expect(setBriefTime(db, time, NOW, TZ)).toEqual({ ok: false, error: expect.stringContaining('HH:MM') });
    expect(briefSchedule(db, TZ, false).time).toBe('07:30');
    expect(setBriefTime(db, '23:59', NOW, TZ)).toMatchObject({ ok: true, value: { time: '23:59' } });
    expect(setBriefTime(db, '00:00', NOW, TZ)).toMatchObject({ ok: true, value: { time: '00:00', nextRunAt: '2026-10-13T07:00:00.000Z' } });
  });
});
