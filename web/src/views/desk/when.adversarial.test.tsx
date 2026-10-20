import { afterEach, describe, expect, it } from 'vitest';
import { setTimeZone } from '../../format';
import { dueWords, monthDay } from './Board';
import { localParts, whenOf } from './DelegationForm';

// the due words of a card and the time inputs of the form at day, year and daylight saving boundaries, in time zones
// on both sides of utc. the words count days in the time zone of the app, never in utc.

afterEach(() => setTimeZone('UTC'));

describe('dueWords at the edges of the day', () => {
  it('counts days in los angeles when the utc day has already turned', () => {
    setTimeZone('America/Los_Angeles');
    // 17:30 pdt on october 20 is 00:30 utc on october 21.
    const now = new Date('2026-10-21T00:30:00.000Z');
    expect(dueWords('2026-10-21T06:59:00.000Z', now)).toBe('Due today');
    expect(dueWords('2026-10-21T07:00:00.000Z', now)).toBe('Due tomorrow');
    expect(dueWords('2026-10-20T23:00:00.000Z', now)).toBe('Overdue since 16:00');
    expect(dueWords('2026-10-20T06:00:00.000Z', now)).toBe('Overdue by 1 day');
  });

  it('counts days in tokyo when the utc day has not turned yet', () => {
    setTimeZone('Asia/Tokyo');
    // 08:00 on october 21 in tokyo is 23:00 utc on october 20.
    const now = new Date('2026-10-20T23:00:00.000Z');
    expect(dueWords('2026-10-21T14:59:00.000Z', now)).toBe('Due today');
    expect(dueWords('2026-10-21T15:00:00.000Z', now)).toBe('Due tomorrow');
    expect(dueWords('2026-10-19T14:00:00.000Z', now)).toBe('Overdue by 2 days');
  });

  it('counts across the new year and the end of daylight saving time', () => {
    setTimeZone('America/Los_Angeles');
    expect(dueWords('2027-01-01T07:59:00.000Z', new Date('2026-12-31T20:00:00.000Z'))).toBe('Due today');
    expect(dueWords('2027-01-01T08:00:00.000Z', new Date('2026-12-31T20:00:00.000Z'))).toBe('Due tomorrow');
    expect(dueWords('2027-01-02T08:00:00.000Z', new Date('2026-12-31T20:00:00.000Z'))).toBe('Due Jan 2');
    // saturday october 31 at 23:30 pdt, and a due time on sunday, a day of 25 hours.
    expect(dueWords('2026-11-02T07:59:00.000Z', new Date('2026-11-01T06:30:00.000Z'))).toBe('Due tomorrow');
  });

  it('gives null for no due time and the month and day in the app time zone', () => {
    setTimeZone('Pacific/Kiritimati');
    expect(dueWords(null, new Date())).toBeNull();
    expect(monthDay(new Date('2026-12-31T12:00:00.000Z'))).toBe('Jan 1');
  });
});

describe('the time inputs of the form', () => {
  it('sends a bare day as a day, and a day with a time as one exact instant', () => {
    expect(whenOf('', '10:00')).toBeNull();
    expect(whenOf('2026-10-22', '')).toBe('2026-10-22');
    const iso = whenOf('2026-10-22', '08:30')!;
    expect(iso).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00\.000Z$/);
    // the instant reads back as the same inputs in the browser.
    expect(localParts(iso)).toEqual({ date: '2026-10-22', time: '08:30' });
  });

  it('gives empty inputs for a missing or damaged time', () => {
    expect(localParts(null)).toEqual({ date: '', time: '' });
    expect(localParts('not a time')).toEqual({ date: '', time: '' });
    expect(whenOf('2026-02-30x', '10:00')).toBeNull();
  });
});
