import { describe, expect, it } from 'vitest';
import {
  addDays,
  allDayRow,
  dayOf,
  daysFrom,
  foldDense,
  hourRange,
  isDay,
  layoutDay,
  mondayOf,
  rangeTitle,
  safeColor,
  wallMinutes,
  zonedMidnight,
  type Span,
} from './grid';

// the pure helpers of the calendar grid: the columns of overlapping events, the clip at midnight, the day where the
// clock goes back, the all-day bars and the hours that the grid shows.

const TZ = 'America/Los_Angeles';
const MON = '2026-10-12';

// a local time of the fixture week (pdt, utc-7) as utc.
const pdt = (day: string, time: string) => new Date(`${day}T${time}:00-07:00`).toISOString();
const pst = (day: string, time: string) => new Date(`${day}T${time}:00-08:00`).toISOString();

function timed(key: string, startAt: string, endAt: string): Span {
  return { key, startAt, endAt, allDay: false, startDay: startAt.slice(0, 10), endDay: endAt.slice(0, 10) };
}

function allDay(key: string, startDay: string, endDay: string): Span {
  return { key, startAt: pdt(startDay, '00:00'), endAt: pdt(addDays(endDay, 1), '00:00'), allDay: true, startDay, endDay };
}

const layout = (spans: Span[], day = MON) =>
  Object.fromEntries(layoutDay(spans, day, TZ).map((block) => [block.item.key, block]));

describe('the days of the calendar', () => {
  it('starts a week on monday and steps by days', () => {
    expect(mondayOf('2026-10-12')).toBe('2026-10-12');
    expect(mondayOf('2026-10-18')).toBe('2026-10-12');
    expect(mondayOf('2026-10-14')).toBe('2026-10-12');
    expect(mondayOf('2026-11-01')).toBe('2026-10-26');
    expect(addDays('2026-12-29', 7)).toBe('2027-01-05');
    expect(daysFrom('2026-10-30', 3)).toEqual(['2026-10-30', '2026-10-31', '2026-11-01']);
  });

  it('reads only real days', () => {
    expect(isDay('2026-10-12')).toBe(true);
    expect(isDay('2026-02-30')).toBe(false);
    expect(isDay('2026-10-12T00:00')).toBe(false);
    expect(isDay('')).toBe(false);
    expect(isDay(null)).toBe(false);
  });

  it('titles a week in one month, across two months, across two years, and one day', () => {
    expect(rangeTitle('2026-10-12', '2026-10-18')).toBe('12 – 18 Oct 2026');
    expect(rangeTitle('2026-09-28', '2026-10-04')).toBe('28 Sep – 4 Oct 2026');
    expect(rangeTitle('2025-12-29', '2026-01-04')).toBe('29 Dec 2025 – 4 Jan 2026');
    expect(rangeTitle('2026-10-12', '2026-10-12')).toBe('Mon 12 Oct 2026');
  });

  it('finds midnight and the wall clock in the time zone', () => {
    expect(new Date(zonedMidnight(MON, TZ)).toISOString()).toBe('2026-10-12T07:00:00.000Z');
    expect(new Date(zonedMidnight('2026-11-02', TZ)).toISOString()).toBe('2026-11-02T08:00:00.000Z');
    expect(wallMinutes(Date.parse(pdt(MON, '09:05')), TZ)).toBe(545);
    expect(dayOf(Date.parse('2026-10-13T06:59:00Z'), TZ)).toBe(MON);
  });

  it('lets only a hex color reach a style', () => {
    expect(safeColor('#3b6fd8')).toBe('#3b6fd8');
    expect(safeColor('red; background: url(x)')).toBe('#8a857c');
    expect(safeColor(null)).toBe('#8a857c');
  });
});

describe('layoutDay', () => {
  it('places a lone event by the minutes of its wall clock', () => {
    const blocks = layout([timed('lab', pdt(MON, '09:00'), pdt(MON, '10:00'))]);
    expect(blocks.lab).toMatchObject({ top: 540, height: 60, column: 0, columns: 1, left: 0, width: 1, clippedStart: false, clippedEnd: false });
  });

  it('puts two events that start close together side by side', () => {
    const blocks = layout([timed('a', pdt(MON, '09:00'), pdt(MON, '10:00')), timed('b', pdt(MON, '09:15'), pdt(MON, '10:15'))]);
    expect(blocks.a).toMatchObject({ column: 0, columns: 2, left: 0, width: 0.5 });
    expect(blocks.b).toMatchObject({ column: 1, columns: 2, left: 0.5, width: 0.5 });
  });

  it('puts three overlapping events in three columns', () => {
    const blocks = layout([
      timed('a', pdt(MON, '09:00'), pdt(MON, '11:00')),
      timed('b', pdt(MON, '09:10'), pdt(MON, '10:00')),
      timed('c', pdt(MON, '09:20'), pdt(MON, '10:30')),
    ]);
    expect([blocks.a!.column, blocks.b!.column, blocks.c!.column]).toEqual([0, 1, 2]);
    expect([blocks.a!.columns, blocks.b!.columns, blocks.c!.columns]).toEqual([3, 3, 3]);
    expect(blocks.c!.left).toBeCloseTo(2 / 3);
    expect(blocks.c!.width).toBeCloseTo(1 / 3);
  });

  it('gives a chain A-B, B-C one cluster, and C takes the column that A left', () => {
    const blocks = layout([
      timed('a', pdt(MON, '09:00'), pdt(MON, '09:30')),
      timed('b', pdt(MON, '09:15'), pdt(MON, '10:00')),
      timed('c', pdt(MON, '09:40'), pdt(MON, '10:15')),
    ]);
    expect(blocks.a).toMatchObject({ column: 0, columns: 2, left: 0 });
    expect(blocks.b).toMatchObject({ column: 1, columns: 2, left: 0.5 });
    expect(blocks.c).toMatchObject({ column: 0, columns: 2, left: 0 });
    expect(new Set([blocks.a!.cluster, blocks.b!.cluster, blocks.c!.cluster]).size).toBe(1);
  });

  it('keeps events that do not overlap in their own clusters with the full width', () => {
    const blocks = layout([timed('a', pdt(MON, '09:00'), pdt(MON, '10:00')), timed('b', pdt(MON, '10:00'), pdt(MON, '11:00'))]);
    expect(blocks.a).toMatchObject({ columns: 1, width: 1 });
    expect(blocks.b).toMatchObject({ columns: 1, width: 1 });
    expect(blocks.a!.cluster).not.toBe(blocks.b!.cluster);
  });

  it('indents a staggered event over the one before it, and keeps the room of the earlier title', () => {
    // the lecture and the coffee of the fixture: the coffee starts 55 minutes after the lecture.
    const blocks = layout([timed('lecture', pdt(MON, '10:05'), pdt(MON, '11:30')), timed('coffee', pdt(MON, '11:00'), pdt(MON, '11:45'))]);
    expect(blocks.lecture).toMatchObject({ column: 0, columns: 2, left: 0, width: 1, room: 55 });
    expect(blocks.coffee!.column).toBe(1);
    expect(blocks.coffee!.left).toBeCloseTo(0.18);
    expect(blocks.coffee!.width).toBeCloseTo(0.82);
    expect(blocks.coffee!.room).toBe(45);
  });

  it('clips an event that crosses midnight on both days', () => {
    const late = timed('late', pdt(MON, '22:00'), pdt('2026-10-13', '02:00'));
    expect(layout([late])['late']).toMatchObject({ top: 1320, height: 120, clippedStart: false, clippedEnd: true });
    expect(layout([late], '2026-10-13')['late']).toMatchObject({ top: 0, height: 120, clippedStart: true, clippedEnd: false });
    expect(layout([late], '2026-10-14')['late']).toBeUndefined();
  });

  it('shows an event that ends at midnight only on its own day', () => {
    const evening = timed('evening', pdt(MON, '21:00'), pdt('2026-10-13', '00:00'));
    expect(layout([evening])['evening']).toMatchObject({ top: 1260, height: 180, clippedEnd: false });
    expect(layout([evening], '2026-10-13')['evening']).toBeUndefined();
  });

  it('handles 2026-11-01, the day of 25 hours where the clock goes back', () => {
    const day = '2026-11-01';
    expect(zonedMidnight('2026-11-02', TZ) - zonedMidnight(day, TZ)).toBe(25 * 3_600_000);
    const spans = [
      // 01:30 pdt to 01:30 pst: one hour, at the same wall clock.
      timed('repeat', pdt(day, '01:30'), pst(day, '01:30')),
      // 09:00 to 10:00 pst stays at 09:00 on the grid, as on each other day.
      timed('morning', pst(day, '09:00'), pst(day, '10:00')),
      // from 23:00 the night before to 03:00 pst: clipped at midnight, and drawn to 03:00.
      timed('night', pdt('2026-10-31', '23:00'), pst(day, '03:00')),
      // from 22:00 pst into the next day: clipped at the end of the 25 hours.
      timed('late', pst(day, '22:00'), pst('2026-11-02', '01:00')),
    ];
    const blocks = layout(spans, day);
    expect(blocks.repeat).toMatchObject({ top: 90, height: 60 });
    expect(blocks.morning).toMatchObject({ top: 540, height: 60 });
    expect(blocks.night).toMatchObject({ top: 0, height: 180, clippedStart: true });
    expect(blocks.late).toMatchObject({ top: 1320, height: 120, clippedEnd: true });
    expect(layout(spans, '2026-11-02')['late']).toMatchObject({ top: 0, height: 60, clippedStart: true });
  });

  it('leaves the all-day and the multi-day events to the all-day row', () => {
    const blocks = layout([allDay('birthday', MON, MON), timed('trip', pdt(MON, '08:00'), pdt('2026-10-14', '08:00'))]);
    expect(blocks).toEqual({});
  });
});

describe('foldDense', () => {
  const five = [
    timed('a', pdt(MON, '13:00'), pdt(MON, '14:30')),
    timed('b', pdt(MON, '13:00'), pdt(MON, '14:00')),
    timed('c', pdt(MON, '13:10'), pdt(MON, '14:00')),
    timed('d', pdt(MON, '13:15'), pdt(MON, '14:15')),
    timed('e', pdt(MON, '13:20'), pdt(MON, '14:00')),
  ];

  it('shows the first columns of a dense cluster and puts the rest in one block', () => {
    const blocks = layoutDay(five, MON, TZ);
    expect(blocks.every((block) => block.columns === 5)).toBe(true);
    const week = foldDense(blocks, 2);
    expect(week.blocks.map((block) => block.item.key)).toEqual(['a']);
    expect(week.blocks[0]).toMatchObject({ columns: 2, left: 0, width: 0.5 });
    expect(week.more).toHaveLength(1);
    expect(week.more[0]!.items.map((item) => item.key)).toEqual(['b', 'c', 'd', 'e']);
    expect(week.more[0]).toMatchObject({ column: 1, columns: 2, top: 13 * 60, height: 75 });
    const day = foldDense(blocks, 6);
    expect(day.blocks).toHaveLength(5);
    expect(day.more).toEqual([]);
  });
});

describe('allDayRow', () => {
  const week = daysFrom(MON, 7);

  it('draws one-day and multi-day bars in lanes that never share a day', () => {
    const bars = allDayRow(
      [
        allDay('birthday', MON, MON),
        allDay('hw3', '2026-10-15', '2026-10-15'),
        allDay('conference', '2026-10-13', '2026-10-15'),
        timed('trip', pdt('2026-10-14', '08:00'), pdt('2026-10-16', '20:00')),
        timed('lab', pdt(MON, '09:00'), pdt(MON, '10:00')),
      ].map((span) => (span.key === 'trip' ? { ...span, startDay: '2026-10-14', endDay: '2026-10-16' } : span)),
      week,
    );
    const byKey = Object.fromEntries(bars.map((bar) => [bar.item.key, bar]));
    expect(Object.keys(byKey).sort()).toEqual(['birthday', 'conference', 'hw3', 'trip']);
    expect(byKey.birthday).toMatchObject({ start: 0, span: 1, lane: 0 });
    expect(byKey.conference).toMatchObject({ start: 1, span: 3, lane: 0 });
    expect(byKey.trip).toMatchObject({ start: 2, span: 3, lane: 1 });
    expect(byKey.hw3).toMatchObject({ start: 3, span: 1, lane: 2 });
  });

  it('cuts a bar at the edges of the range and says so', () => {
    const [bar] = allDayRow([allDay('trip', '2026-10-10', '2026-10-20')], week);
    expect(bar).toMatchObject({ start: 0, span: 7, continuesBefore: true, continuesAfter: true });
    expect(allDayRow([allDay('old', '2026-10-01', '2026-10-02')], week)).toEqual([]);
    expect(allDayRow([allDay('birthday', MON, MON)], [])).toEqual([]);
  });
});

describe('hourRange', () => {
  it('shows 07:00 to 21:00 at the least', () => {
    expect(hourRange([])).toEqual({ startHour: 7, endHour: 21 });
    expect(hourRange([{ top: 540, height: 60 }])).toEqual({ startHour: 7, endHour: 21 });
  });

  it('starts at the first event and ends at the end of the last one', () => {
    expect(hourRange([{ top: 6 * 60 + 30, height: 30 }, { top: 21 * 60 + 30, height: 60 }])).toEqual({ startHour: 6, endHour: 23 });
    expect(hourRange([{ top: 0, height: 1440 }])).toEqual({ startHour: 0, endHour: 24 });
  });
});
