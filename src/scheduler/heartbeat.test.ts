import { describe, expect, it } from 'vitest';
import { openDb } from '../db/index.js';
import { inActiveHours, syncHeartbeat } from './heartbeat.js';
import { listAutomations, updateAutomation } from './store.js';

const TZ = 'America/Los_Angeles';
const at = (time: string) => new Date(`2026-10-12T${time}:00-07:00`);

describe('active hours', () => {
  it('includes the start and excludes the end', () => {
    const hours = { start: '08:00', end: '23:00' };
    expect(inActiveHours(at('07:59'), TZ, hours)).toBe(false);
    expect(inActiveHours(at('08:00'), TZ, hours)).toBe(true);
    expect(inActiveHours(at('22:59'), TZ, hours)).toBe(true);
    expect(inActiveHours(at('23:00'), TZ, hours)).toBe(false);
  });

  it('can cross midnight', () => {
    const hours = { start: '22:00', end: '02:00' };
    expect(inActiveHours(at('23:30'), TZ, hours)).toBe(true);
    expect(inActiveHours(at('01:00'), TZ, hours)).toBe(true);
    expect(inActiveHours(at('12:00'), TZ, hours)).toBe(false);
  });
});

describe('syncHeartbeat', () => {
  const config = (every: string) => ({ timeZone: TZ, heartbeat: { every, activeHours: { start: '08:00', end: '23:00' } } });

  it('creates the heartbeat, follows a new interval, and turns it off with 0', () => {
    const db = openDb(':memory:');
    syncHeartbeat(db, config('30m'), at('09:00'));
    syncHeartbeat(db, config('30m'), at('09:05'));
    expect(listAutomations(db)).toEqual([
      expect.objectContaining({ name: 'heartbeat', slot: 'heartbeat', createdBy: 'system', schedule: { kind: 'every', everyMs: 1_800_000 } }),
    ]);
    syncHeartbeat(db, config('1h'), at('09:10'));
    expect(listAutomations(db)[0]?.schedule).toEqual({ kind: 'every', everyMs: 3_600_000 });
    syncHeartbeat(db, config('0'), at('09:15'));
    expect(listAutomations(db)[0]?.enabled).toBe(false);
  });

  it('keeps the heartbeat off after the owner turns it off, while the interval stays the same', () => {
    const db = openDb(':memory:');
    syncHeartbeat(db, config('30m'), at('09:00'));
    updateAutomation(db, listAutomations(db)[0]!.id, { enabled: false }, at('09:01'), TZ);
    syncHeartbeat(db, config('30m'), at('10:00'));
    expect(listAutomations(db)[0]?.enabled).toBe(false);
  });

  it('turns the heartbeat on again when the config goes from 0 back to the same interval', () => {
    const db = openDb(':memory:');
    syncHeartbeat(db, config('30m'), at('09:00'));
    syncHeartbeat(db, config('0'), at('09:05'));
    syncHeartbeat(db, config('30m'), at('09:10'));
    expect(listAutomations(db)[0]).toMatchObject({ enabled: true, nextRunAt: expect.any(String) });
  });
});
