import { describe, expect, it } from 'vitest';
import { matchRoute } from '../../routes';
import { calendarHash, sourceHash } from '../today/links';
import { allDayRow, layoutDay, safeColor, zonedMidnight, type Span } from './grid';

// adversarial cases of the links between the today and the calendar pages, and of the grid: event keys with the
// characters that a google calendar id holds, the night where the clock goes back, and colors that are not colors.

const TZ = 'America/Los_Angeles';

describe('the calendar hash of an event', () => {
  // a holiday calendar of google has a # in its id, and an event id can hold other characters of a url.
  const keys = [
    'personal/en.usa#holiday@group.v.calendar.google.com/20261012_abc',
    'school/a&b=c@group.calendar.google.com/x+y z',
    'personal/primary/évènement?x=1',
    'personal/primary/%2F..%2F',
  ];

  it('gives back the same key and day after the router reads the hash', () => {
    for (const key of keys) {
      const hash = calendarHash('2026-10-12', { mode: 'day', event: key });
      expect(hash.indexOf('#', 1), key).toBe(-1);
      const match = matchRoute(hash);
      expect(match?.route.path, key).toBe('calendar');
      expect(match?.query.get('event'), key).toBe(key);
      expect(match?.query.get('day'), key).toBe('2026-10-12');
      expect(match?.query.get('mode'), key).toBe('day');
    }
  });

  it('opens the day of an event from a brief item', () => {
    const hash = sourceHash({ kind: 'event', key: keys[0]!, day: '2026-10-12' });
    expect(matchRoute(hash)?.query.get('event')).toBe(keys[0]);
  });

  it('leaves the mode out for the week', () => {
    expect(calendarHash('2026-10-12')).toBe('#/calendar?day=2026-10-12');
    expect(calendarHash('2026-10-12', { mode: 'week' })).toBe('#/calendar?day=2026-10-12');
  });

  it('links each kind of source to a page that the router knows', () => {
    const sources = [
      { kind: 'thread', account: 'personal', threadId: 't1', digestId: 3 },
      { kind: 'digest', digestId: 3 },
      { kind: 'draft', draftId: 4 },
      { kind: 'proposal', proposalId: 5 },
      { kind: 'goal', goalId: 6 },
    ] as const;
    for (const source of sources) expect(matchRoute(sourceHash(source)), source.kind).toBeDefined();
  });
});

describe('the grid on odd input', () => {
  const timed = (key: string, startAt: string, endAt: string): Span => ({ key, startAt, endAt, allDay: false, startDay: startAt.slice(0, 10), endDay: endAt.slice(0, 10) });

  it('gives the hour that repeats when the clock goes back a block of its real length', () => {
    // 01:30 pdt and 01:30 pst are an hour apart, and both are on 2026-11-01.
    const first = timed('first', '2026-11-01T08:30:00.000Z', '2026-11-01T09:00:00.000Z');
    const second = timed('second', '2026-11-01T09:30:00.000Z', '2026-11-01T10:00:00.000Z');
    // an event from 01:45 pdt to 01:15 pst lasts 30 minutes, though the clock goes back.
    const across = timed('across', '2026-11-01T08:45:00.000Z', '2026-11-01T09:15:00.000Z');
    const blocks = Object.fromEntries(layoutDay([first, second, across], '2026-11-01', TZ).map((block) => [block.item.key, block]));
    expect(blocks.first!.height).toBe(30);
    expect(blocks.second!.height).toBe(30);
    expect(blocks.across!.height).toBe(30);
    for (const block of Object.values(blocks)) expect(block.top + block.height).toBeLessThanOrEqual(24 * 60);
  });

  it('keeps every block of the short spring day inside the day', () => {
    const late = timed('late', '2026-03-09T06:00:00.000Z', '2026-03-09T08:00:00.000Z');
    const blocks = layoutDay([late], '2026-03-08', TZ);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.top).toBe(23 * 60);
    expect(blocks[0]!.height).toBe(60);
    expect(blocks[0]!.clippedEnd).toBe(true);
    expect(zonedMidnight('2026-03-09', TZ)).toBe(Date.parse('2026-03-09T07:00:00.000Z'));
  });

  it('gives a bar whose end day is before its start day one day', () => {
    const odd: Span = { key: 'odd', startAt: '2026-10-13T07:00:00.000Z', endAt: '2026-10-14T07:00:00.000Z', allDay: true, startDay: '2026-10-13', endDay: '2026-10-11' };
    const bars = allDayRow([odd], ['2026-10-12', '2026-10-13', '2026-10-14']);
    expect(bars).toEqual([{ item: odd, start: 1, span: 1, lane: 0, continuesBefore: false, continuesAfter: false }]);
  });

  it('never puts a color that is not a hex color into a style', () => {
    for (const color of ['red', '#12345g', '#fff;background:url(x)', 'url(javascript:1)', '#1234567890', '', null, undefined]) {
      expect(safeColor(color), String(color)).toBe('#8a857c');
    }
    expect(safeColor('#ABCDEF')).toBe('#ABCDEF');
  });
});
