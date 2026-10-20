import { describe, expect, it } from 'vitest';
import type { CalendarEvent } from '../dashboard/calendar-types.js';
import { CALENDAR_WEEK, TODAY_DAY, TODAY_EVENTS, TODAY_NOW, TODAY_TZ } from '../../test/fixtures/today-data.js';
import { committed, eventsOfDay, findConflicts, findTravelGaps, unansweredInvites } from './analyze.js';

const LA = 'America/Los_Angeles';

// an event that the owner made alone, from start to end (utc iso times or times with an offset).
function ev(id: string, start: string, end: string, fields: Partial<CalendarEvent> = {}): CalendarEvent {
  const startAt = new Date(start).toISOString();
  return {
    key: `personal/primary/${id}`,
    uid: `${id}@google.com`,
    account: 'personal',
    calendarId: 'primary',
    calendarKey: 'personal/primary',
    eventId: id,
    title: id,
    startAt,
    endAt: new Date(end).toISOString(),
    allDay: false,
    startDay: startAt.slice(0, 10),
    endDay: startAt.slice(0, 10),
    location: null,
    videoUrl: null,
    status: 'confirmed',
    answer: null,
    organizerSelf: true,
    organizer: null,
    guests: [],
    showsAsFree: false,
    recurring: false,
    notes: null,
    htmlLink: null,
    ...fields,
  };
}

const keys = (events: CalendarEvent[]) => events.map((event) => event.eventId);

describe('the checks on the fixture week', () => {
  it('finds the conflicts, the travel gaps and the invitations of the fixture', () => {
    expect(findConflicts(TODAY_EVENTS)).toEqual(CALENDAR_WEEK.conflicts);
    expect(findTravelGaps(TODAY_EVENTS)).toEqual(CALENDAR_WEEK.travelGaps);
    expect(unansweredInvites(TODAY_EVENTS, new Date(TODAY_NOW)).map((event) => event.key)).toEqual(['school/primary/reading', 'personal/primary/dinner']);
    expect(unansweredInvites(TODAY_EVENTS, new Date(TODAY_NOW)).map((event) => event.key)).toEqual(CALENDAR_WEEK.invites);
  });

  it('gives the day without the declined talk and with both copies of the social', () => {
    expect(keys(eventsOfDay(TODAY_EVENTS, TODAY_DAY, TODAY_TZ))).toEqual([
      'birthday',
      'run',
      'lab',
      'lecture',
      'coffee',
      'focus',
      'advisor',
      'dentist',
      'reading',
      'social-p',
      'social-s',
    ]);
    expect(keys(eventsOfDay(TODAY_EVENTS, '2026-10-15', TODAY_TZ))).toEqual(['hw3', 'dinner']);
    expect(eventsOfDay(TODAY_EVENTS, '2026-10-14', TODAY_TZ)).toEqual([]);
  });

  it('holds only timed events that the owner accepted or organizes', () => {
    const byId = new Map(TODAY_EVENTS.map((event) => [event.eventId, event]));
    expect(committed(byId.get('run')!)).toBe(true);
    expect(committed(byId.get('lab')!)).toBe(true);
    expect(committed(byId.get('lecture')!)).toBe(false);
    expect(committed(byId.get('talk')!)).toBe(false);
    expect(committed(byId.get('focus')!)).toBe(false);
    expect(committed(byId.get('reading')!)).toBe(false);
    expect(committed(byId.get('birthday')!)).toBe(false);
    expect(committed({ ...byId.get('run')!, status: 'cancelled' })).toBe(false);
  });
});

describe('eventsOfDay', () => {
  it('gives the whole 25 hour day when the clocks go back', () => {
    // 2026-11-01 runs from 07:00 utc to 08:00 utc of the next day.
    const early = ev('early', '2026-11-01T00:30:00-07:00', '2026-11-01T01:00:00-07:00');
    const late = ev('late', '2026-11-01T23:30:00-08:00', '2026-11-02T00:00:00-08:00');
    const before = ev('before', '2026-10-31T23:00:00-07:00', '2026-11-01T00:00:00-07:00');
    const after = ev('after', '2026-11-02T00:00:00-08:00', '2026-11-02T01:00:00-08:00');
    expect(keys(eventsOfDay([after, late, before, early], '2026-11-01', LA))).toEqual(['early', 'late']);
  });

  it('gives the whole 23 hour day when the clocks go forward', () => {
    // 2026-03-08 runs from 08:00 utc to 07:00 utc of the next day.
    const first = ev('first', '2026-03-08T00:00:00-08:00', '2026-03-08T00:30:00-08:00');
    const last = ev('last', '2026-03-08T23:30:00-07:00', '2026-03-09T00:00:00-07:00');
    const next = ev('next', '2026-03-09T00:00:00-07:00', '2026-03-09T00:30:00-07:00');
    expect(keys(eventsOfDay([next, last, first], '2026-03-08', LA))).toEqual(['first', 'last']);
  });

  it('reads the day in a zone with a half hour offset', () => {
    // midnight of 2026-10-12 in kolkata is 18:30 utc of 2026-10-11.
    const inside = ev('inside', '2026-10-11T18:30:00Z', '2026-10-11T19:00:00Z');
    const outside = ev('outside', '2026-10-11T18:00:00Z', '2026-10-11T18:30:00Z');
    expect(keys(eventsOfDay([inside, outside], '2026-10-12', 'Asia/Kolkata'))).toEqual(['inside']);
    expect(keys(eventsOfDay([inside, outside], '2026-10-11', 'Asia/Kolkata'))).toEqual(['outside']);
  });

  it('shows an event that crosses midnight on both days', () => {
    const night = ev('night', '2026-10-12T23:00:00-07:00', '2026-10-13T01:00:00-07:00');
    expect(keys(eventsOfDay([night], '2026-10-12', LA))).toEqual(['night']);
    expect(keys(eventsOfDay([night], '2026-10-13', LA))).toEqual(['night']);
    expect(eventsOfDay([night], '2026-10-14', LA)).toEqual([]);
  });

  it('shows a multi-day all-day event on each of its days', () => {
    const trip = ev('trip', '2026-10-12T00:00:00-07:00', '2026-10-15T00:00:00-07:00', { allDay: true, startDay: '2026-10-12', endDay: '2026-10-14' });
    expect(['2026-10-11', '2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15'].map((day) => eventsOfDay([trip], day, LA).length)).toEqual([0, 1, 1, 1, 0]);
  });

  it('leaves out cancelled and declined events', () => {
    const gone = ev('gone', '2026-10-12T09:00:00-07:00', '2026-10-12T10:00:00-07:00', { status: 'cancelled' });
    const no = ev('no', '2026-10-12T09:00:00-07:00', '2026-10-12T10:00:00-07:00', { answer: 'declined', organizerSelf: false });
    const maybe = ev('maybe', '2026-10-12T09:00:00-07:00', '2026-10-12T10:00:00-07:00', { answer: 'tentative', organizerSelf: false });
    expect(keys(eventsOfDay([gone, no, maybe], '2026-10-12', LA))).toEqual(['maybe']);
  });

  it('sorts events with the same start by key', () => {
    const b = ev('b', '2026-10-12T09:00:00-07:00', '2026-10-12T10:00:00-07:00');
    const a = ev('a', '2026-10-12T09:00:00-07:00', '2026-10-12T09:30:00-07:00');
    const c = ev('c', '2026-10-12T08:00:00-07:00', '2026-10-12T09:30:00-07:00');
    expect(keys(eventsOfDay([b, a, c], '2026-10-12', LA))).toEqual(['c', 'a', 'b']);
  });

  it('counts an event of no length at the start of the day, and not one at its end', () => {
    const start = ev('start', '2026-10-12T00:00:00-07:00', '2026-10-12T00:00:00-07:00');
    const end = ev('end', '2026-10-13T00:00:00-07:00', '2026-10-13T00:00:00-07:00');
    expect(keys(eventsOfDay([start, end], '2026-10-12', LA))).toEqual(['start']);
  });

  it('gives nothing for no events', () => {
    expect(eventsOfDay([], '2026-10-12', LA)).toEqual([]);
    expect(findConflicts([])).toEqual([]);
    expect(findTravelGaps([])).toEqual([]);
    expect(unansweredInvites([], new Date(TODAY_NOW))).toEqual([]);
  });
});

describe('findConflicts', () => {
  // an accepted meeting with other people.
  const accepted = { answer: 'accepted' as const, organizerSelf: false, organizer: 'lee@example.com' };

  it('gives each pair of three events that overlap each other', () => {
    const a = ev('a', '2026-10-12T09:00:00Z', '2026-10-12T11:00:00Z', accepted);
    const b = ev('b', '2026-10-12T09:30:00Z', '2026-10-12T10:30:00Z', accepted);
    const c = ev('c', '2026-10-12T10:00:00Z', '2026-10-12T12:00:00Z', accepted);
    expect(findConflicts([c, b, a])).toEqual([
      { a: a.key, b: b.key, startAt: b.startAt, endAt: b.endAt },
      { a: a.key, b: c.key, startAt: c.startAt, endAt: a.endAt },
      { a: b.key, b: c.key, startAt: c.startAt, endAt: b.endAt },
    ]);
  });

  it('takes the lower key as a when two events start at the same time', () => {
    const y = ev('y', '2026-10-12T09:00:00Z', '2026-10-12T10:00:00Z', accepted);
    const x = ev('x', '2026-10-12T09:00:00Z', '2026-10-12T09:30:00Z');
    expect(findConflicts([y, x])).toEqual([{ a: x.key, b: y.key, startAt: x.startAt, endAt: x.endAt }]);
  });

  it('never counts two time blocks of the owner alone, and counts a block against a meeting', () => {
    const sleep = ev('sleep', '2026-10-12T07:00:00Z', '2026-10-12T15:00:00Z');
    const exercise = ev('exercise', '2026-10-12T14:30:00Z', '2026-10-12T15:30:00Z');
    expect(findConflicts([sleep, exercise])).toEqual([]);
    // a block that the owner made with a guest is a meeting too.
    const call = ev('call', '2026-10-12T15:00:00Z', '2026-10-12T15:30:00Z', {
      guests: [{ name: null, email: 'sam@example.com', answer: 'accepted', organizer: false, optional: false, self: false }],
    });
    const section = ev('section', '2026-10-12T15:15:00Z', '2026-10-12T16:00:00Z', accepted);
    expect(findConflicts([sleep, exercise, call, section]).map((each) => `${each.a}|${each.b}`)).toEqual([
      'personal/primary/exercise|personal/primary/call',
      'personal/primary/call|personal/primary/section',
      'personal/primary/exercise|personal/primary/section',
    ]);
  });

  it('does not count events that touch', () => {
    const a = ev('a', '2026-10-12T09:00:00Z', '2026-10-12T10:00:00Z');
    const b = ev('b', '2026-10-12T10:00:00Z', '2026-10-12T11:00:00Z');
    expect(findConflicts([a, b])).toEqual([]);
  });

  it('does not count one invitation on two accounts', () => {
    const fields = { uid: 'same', answer: 'accepted' as const, organizerSelf: false };
    const p = ev('p', '2026-10-12T09:00:00Z', '2026-10-12T10:00:00Z', fields);
    const s = { ...ev('s', '2026-10-12T09:00:00Z', '2026-10-12T10:00:00Z', fields), key: 'school/primary/s', account: 'school' };
    expect(findConflicts([p, s])).toEqual([]);
    // the same uid at another start is another instance of a series, so it counts.
    const later = { ...s, startAt: '2026-10-12T09:30:00.000Z' };
    expect(findConflicts([p, later])).toHaveLength(1);
  });

  it('does not count events that show as free, all-day events, or events the owner did not accept', () => {
    const held = ev('held', '2026-10-12T09:00:00Z', '2026-10-12T10:00:00Z');
    const free = ev('free', '2026-10-12T09:00:00Z', '2026-10-12T10:00:00Z', { showsAsFree: true });
    const allDay = ev('allday', '2026-10-12T07:00:00Z', '2026-10-13T07:00:00Z', { allDay: true });
    const asked = ev('asked', '2026-10-12T09:00:00Z', '2026-10-12T10:00:00Z', { answer: 'needsAction', organizerSelf: false });
    const maybe = ev('maybe', '2026-10-12T09:00:00Z', '2026-10-12T10:00:00Z', { answer: 'tentative', organizerSelf: false });
    expect(findConflicts([held, free, allDay, asked, maybe])).toEqual([]);
  });
});

describe('findTravelGaps', () => {
  const at = (time: string) => `2026-10-12T${time}:00Z`;

  it('counts a gap of 0 minutes and not one of exactly 15 minutes', () => {
    const a = ev('a', at('09:00'), at('10:00'), { location: 'Soda Hall' });
    const touching = ev('touching', at('10:00'), at('10:30'), { location: 'Wheeler' });
    const fifteen = ev('fifteen', at('10:45'), at('11:00'), { location: 'Evans' });
    const fourteen = ev('fourteen', at('11:14'), at('11:30'), { location: 'Dwinelle' });
    expect(findTravelGaps([a, touching, fifteen, fourteen])).toEqual([
      { from: a.key, to: touching.key, at: a.endAt, gapMinutes: 0, fromLocation: 'Soda Hall', toLocation: 'Wheeler' },
      { from: fifteen.key, to: fourteen.key, at: fifteen.endAt, gapMinutes: 14, fromLocation: 'Evans', toLocation: 'Dwinelle' },
    ]);
  });

  it('gives the minutes rounded down', () => {
    const a = ev('a', at('09:00'), at('10:00'), { location: 'Soda Hall' });
    const b = ev('b', '2026-10-12T10:07:59Z', at('11:00'), { location: 'Wheeler' });
    expect(findTravelGaps([a, b])[0]!.gapMinutes).toBe(7);
  });

  it('sees no move between places that differ only in case, spaces or a trailing dot', () => {
    const a = ev('a', at('09:00'), at('10:00'), { location: 'Soda  Hall 510.' });
    const b = ev('b', at('10:05'), at('11:00'), { location: ' soda hall 510 ' });
    const c = ev('c', at('11:05'), at('12:00'), { location: 'SODA HALL 510;' });
    expect(findTravelGaps([a, b, c])).toEqual([]);
  });

  it('needs a location on both events', () => {
    const a = ev('a', at('09:00'), at('10:00'), { location: 'Soda Hall' });
    const none = ev('none', at('10:05'), at('11:00'), { location: null });
    const blank = ev('blank', at('11:05'), at('12:00'), { location: '   ' });
    const video = ev('video', at('12:05'), at('13:00'), { videoUrl: 'https://meet.example.com/x' });
    const last = ev('last', at('13:05'), at('14:00'), { location: 'Wheeler' });
    expect(findTravelGaps([a, none, blank, video, last])).toEqual([]);
  });

  it('counts a class lecture the owner was not invited to, and skips cancelled, declined and free events', () => {
    const a = ev('a', at('09:00'), at('10:00'), { location: 'Soda Hall' });
    const lecture = ev('lecture', at('10:05'), at('11:00'), { location: 'Wheeler', organizerSelf: false });
    const cancelled = ev('cancelled', at('11:05'), at('12:00'), { location: 'Evans', status: 'cancelled' });
    const declined = ev('declined', at('11:05'), at('12:00'), { location: 'Evans', answer: 'declined', organizerSelf: false });
    const free = ev('free', at('11:05'), at('12:00'), { location: 'Evans', showsAsFree: true });
    expect(findTravelGaps([a, lecture, cancelled, declined, free]).map((gap) => gap.to)).toEqual([lecture.key]);
  });

  it('counts one invitation on two accounts once', () => {
    const a = ev('a', at('09:00'), at('10:00'), { location: 'Soda Hall' });
    const p = ev('p', at('10:05'), at('11:00'), { uid: 'same', location: 'Wheeler' });
    const s = { ...p, key: 'school/primary/s', account: 'school' };
    expect(findTravelGaps([a, p, s])).toHaveLength(1);
  });

  it('skips all-day events', () => {
    const a = ev('a', '2026-10-12T07:00:00Z', '2026-10-13T07:00:00Z', { allDay: true, location: 'Tahoe' });
    const b = ev('b', '2026-10-13T07:05:00Z', '2026-10-13T08:00:00Z', { location: 'Home' });
    expect(findTravelGaps([a, b])).toEqual([]);
  });
});

describe('unansweredInvites', () => {
  const now = new Date('2026-10-12T17:00:00Z');
  const invite = { answer: 'needsAction' as const, organizerSelf: false, organizer: 'x@example.com' };

  it('gives open invitations that are not over, sorted by start', () => {
    const later = ev('later', '2026-10-14T17:00:00Z', '2026-10-14T18:00:00Z', invite);
    const soon = ev('soon', '2026-10-12T16:00:00Z', '2026-10-12T17:30:00Z', invite);
    const over = ev('over', '2026-10-12T15:00:00Z', '2026-10-12T17:00:00Z', invite);
    const cancelled = ev('cancelled', '2026-10-13T15:00:00Z', '2026-10-13T16:00:00Z', { ...invite, status: 'cancelled' });
    const own = ev('own', '2026-10-13T15:00:00Z', '2026-10-13T16:00:00Z', { answer: 'needsAction' });
    const answered = ev('answered', '2026-10-13T15:00:00Z', '2026-10-13T16:00:00Z', { ...invite, answer: 'accepted' });
    expect(keys(unansweredInvites([later, soon, over, cancelled, own, answered], now))).toEqual(['soon', 'later']);
  });

  it('gives one invitation on two accounts once, the first by key', () => {
    const s = { ...ev('s', '2026-10-13T15:00:00Z', '2026-10-13T16:00:00Z', { ...invite, uid: 'same' }), key: 'school/primary/s', account: 'school' };
    const p = ev('p', '2026-10-13T15:00:00Z', '2026-10-13T16:00:00Z', { ...invite, uid: 'same' });
    expect(unansweredInvites([s, p], now).map((event) => event.key)).toEqual([p.key]);
  });
});
