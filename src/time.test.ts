import { describe, expect, it } from 'vitest';
import { addDays, localDay, localTime, zonedToUtc } from './time.js';

const TZ = 'America/Los_Angeles';

describe('owner time helpers', () => {
  it('gives the local day and time', () => {
    const date = new Date('2026-10-13T03:15:00Z');
    expect(localDay(date, TZ)).toBe('2026-10-12');
    expect(localTime(date, TZ)).toBe('20:15');
  });

  it('converts a local time to utc on both sides of a daylight saving change', () => {
    expect(zonedToUtc('2026-10-12', '21:00', TZ).toISOString()).toBe('2026-10-13T04:00:00.000Z');
    expect(zonedToUtc('2026-12-01', '21:00', TZ).toISOString()).toBe('2026-12-02T05:00:00.000Z');
    expect(zonedToUtc('2026-11-01', '12:00', TZ).toISOString()).toBe('2026-11-01T20:00:00.000Z');
  });

  it('adds days across a month end', () => {
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01');
    expect(addDays('2026-10-01', -1)).toBe('2026-09-30');
  });
});
