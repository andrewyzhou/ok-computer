import type { CalendarConflict, CalendarEvent, TravelGap } from '../dashboard/calendar-types.js';
import { addDays, zonedToUtc } from '../time.js';

// the pure checks of a day of calendar events. the brief and the calendar page both use them, so the two never
// disagree. nothing here reads the database or google.

// two events closer than this, at different places, are a travel gap.
export const TRAVEL_GAP_MINUTES = 15;

const MINUTE = 60_000;

const startOf = (event: CalendarEvent) => Date.parse(event.startAt);
const endOf = (event: CalendarEvent) => Date.parse(event.endAt);

// events sort by start, then by key, so the order is the same on each run.
export function byStart(a: CalendarEvent, b: CalendarEvent): number {
  return startOf(a) - startOf(b) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
}

// two copies of one invitation on two accounts have the same uid and the same start. an event without a uid is its own
// copy.
export function copyKey(event: CalendarEvent): string {
  return event.uid === null ? `key:${event.key}` : `uid:${event.uid}@${startOf(event)}`;
}

// the first event of each invitation, in the order of the list.
export function dedupeCopies(events: CalendarEvent[]): CalendarEvent[] {
  const seen = new Set<string>();
  return events.filter((event) => {
    const key = copyKey(event);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// an event that is gone, or that the owner said no to, is on no day and in no check.
const visible = (event: CalendarEvent) => event.status !== 'cancelled' && event.answer !== 'declined';

// true for a timed event that the owner holds: not cancelled, not shown as free, and accepted by the owner or
// organized by the owner (organizerSelf, which is also true for an event that the owner made alone).
export function committed(event: CalendarEvent): boolean {
  return !event.allDay && event.status !== 'cancelled' && !event.showsAsFree && (event.answer === 'accepted' || event.organizerSelf);
}

// the events that touch the local day in timeZone, not cancelled and not declined by the owner, sorted by startAt and
// then by key. an all-day event touches each day from startDay to endDay.
export function eventsOfDay(events: CalendarEvent[], day: string, timeZone: string): CalendarEvent[] {
  const dayStart = zonedToUtc(day, '00:00', timeZone).getTime();
  const dayEnd = zonedToUtc(addDays(day, 1), '00:00', timeZone).getTime();
  return events
    .filter((event) => {
      if (!visible(event)) return false;
      if (event.allDay) return event.startDay <= day && day <= event.endDay;
      const start = startOf(event);
      const end = endOf(event);
      // an event of no length touches the day that holds its start.
      if (end <= start) return start >= dayStart && start < dayEnd;
      return start < dayEnd && end > dayStart;
    })
    .sort(byStart);
}

// true for an event with other people: a guest who is not the owner, or an organizer who is not the owner. the owner
// blocks out his own time (sleep, meals, a long work block) with events that have no guests, and two such blocks
// that overlap are a plan, not a double booking.
export function meeting(event: CalendarEvent): boolean {
  return event.guests.some((guest) => !guest.self) || !event.organizerSelf;
}

// each pair of committed events that overlap, where at least one of the two is a meeting with other people. two
// events overlap when one starts before the other ends; an event that starts when the other ends does not, and an
// event of no length is a point in time that overlaps nothing. copies of one invitation on two accounts (the same
// uid and start) count as one event, so they make one conflict with a third event and none with each other. a is the
// event that starts first (then the lower key), and the list is sorted by startAt.
export function findConflicts(events: CalendarEvent[]): CalendarConflict[] {
  const held = dedupeCopies(events.filter((event) => committed(event) && endOf(event) > startOf(event)).sort(byStart));
  const conflicts: CalendarConflict[] = [];
  for (let i = 0; i < held.length; i++) {
    const a = held[i]!;
    for (let j = i + 1; j < held.length; j++) {
      const b = held[j]!;
      // the list is sorted by start, so no later event can overlap a.
      if (startOf(b) >= endOf(a)) break;
      if (startOf(a) >= endOf(b)) continue;
      if (!meeting(a) && !meeting(b)) continue;
      conflicts.push({ a: a.key, b: b.key, startAt: b.startAt, endAt: endOf(a) <= endOf(b) ? a.endAt : b.endAt });
    }
  }
  return conflicts.sort((x, y) => Date.parse(x.startAt) - Date.parse(y.startAt) || compare(x.a, y.a) || compare(x.b, y.b));
}

// locations compare without case, without repeated spaces and without trailing punctuation.
export function normalizeLocation(location: string): string {
  return location
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[.,;:\s…]+$/, '');
}

// a location that names no place: question marks, tbd and the like, a word for a call, or text without a letter or a
// digit.
const PLACEHOLDER = /^(\?+|tbd|tba|n\/a|none|online|virtual|zoom|remote)$/i;

export function realPlace(location: string | null): boolean {
  if (location === null) return false;
  const place = normalizeLocation(location);
  return place !== '' && !PLACEHOLDER.test(place) && /[\p{L}\p{N}]/u.test(place);
}

// words that start many places, so a shared first word of this kind says nothing.
const COMMON_FIRST_WORDS = new Set(['the', 'a', 'an', 'room', 'rm', 'building', 'bldg', 'floor', 'suite', 'office']);

const segmentsOf = (place: string) =>
  place
    .split(',')
    .map((each) => each.trim().replace(/[.…]+$/, ''))
    .filter((each) => each !== '');

const initialsOf = (text: string) =>
  text
    .split(/[\s-]+/)
    .filter((word) => /^\p{L}/u.test(word))
    .map((word) => word[0])
    .join('');

// true when two locations name the same place, as people write one place in more than one way. the places are the
// same when the normalized texts are equal or one holds the other ('cory hall' and 'cory hall, berkeley'), when they
// share a street address ('the gateway, 2300 hearst ave' and '2300 hearst ave, berkeley, ca'), when the first parts
// start with the same word that is not a common one ('cory 540ab' and 'cory hall'), or when one first part is the
// initials of the other ('vlsb' and 'valley life sciences building').
export function samePlace(a: string, b: string): boolean {
  const x = normalizeLocation(a);
  const y = normalizeLocation(b);
  if (x === y || x.includes(y) || y.includes(x)) return true;
  const xs = segmentsOf(x);
  const ys = segmentsOf(y);
  const street = (segment: string) => /^\d+\s+\p{L}/u.test(segment);
  if (xs.some((segment) => street(segment) && ys.includes(segment))) return true;
  const [xFirst = '', yFirst = ''] = [xs[0], ys[0]];
  const xWord = xFirst.split(' ')[0] ?? '';
  const yWord = yFirst.split(' ')[0] ?? '';
  if (xWord.length >= 3 && xWord === yWord && !COMMON_FIRST_WORDS.has(xWord) && !/^\d/.test(xWord)) return true;
  const compact = (text: string) => text.replace(/\s+/g, '');
  const initials = (short: string, long: string) => compact(short).length >= 3 && !short.includes(' ') && initialsOf(long) === compact(short);
  return initials(xFirst, yFirst) || initials(yFirst, xFirst);
}

// true for an event that the owner goes to: one the owner made or was invited to, or one without a guest list, such
// as a lecture on a class calendar that the owner shows. a meeting on a shared calendar of someone else that does not
// invite the owner is that person's move, not the owner's.
const ownersMove = (event: CalendarEvent) => event.organizerSelf || event.answer !== null || event.guests.length === 0;

// the travel gaps: for each timed event at a place, the events at a place that come right after it (the first start
// at or after its end), when they start 0 to 14 minutes after it ends at another place (see samePlace). the events are
// not cancelled, not declined, not shown as free, are the owner's move (see ownersMove), and have a location that
// names a place (see realPlace). copies of one invitation count once, and each later event has at most one
// gap: the one from the event that ends last before it.
export function findTravelGaps(events: CalendarEvent[]): TravelGap[] {
  const placed = dedupeCopies(
    events
      .filter((event) => !event.allDay && visible(event) && !event.showsAsFree && ownersMove(event) && realPlace(event.location))
      .sort(byStart),
  );
  const best = new Map<string, TravelGap>();
  for (const a of placed) {
    const after = placed.filter((b) => b !== a && startOf(b) >= endOf(a));
    if (after.length === 0) continue;
    const next = Math.min(...after.map(startOf));
    for (const b of after) {
      if (startOf(b) !== next) continue;
      const gap = startOf(b) - endOf(a);
      if (gap >= TRAVEL_GAP_MINUTES * MINUTE) continue;
      if (samePlace(a.location!, b.location!)) continue;
      const found = { from: a.key, to: b.key, at: a.endAt, gapMinutes: Math.floor(gap / MINUTE), fromLocation: a.location!.trim(), toLocation: b.location!.trim() };
      const kept = best.get(b.key);
      if (!kept || Date.parse(found.at) > Date.parse(kept.at)) best.set(b.key, found);
    }
  }
  return [...best.values()].sort((x, y) => Date.parse(x.at) - Date.parse(y.at) || compare(x.from, y.from) || compare(x.to, y.to));
}

// the events that the owner was invited to and did not answer (answer needsAction), not cancelled, not organized by
// the owner, and not ended before now. sorted by startAt.
export function unansweredInvites(events: CalendarEvent[], now: Date): CalendarEvent[] {
  const open = events.filter((event) => event.answer === 'needsAction' && !event.organizerSelf && event.status !== 'cancelled' && endOf(event) > now.getTime());
  return dedupeCopies(open.sort(byStart));
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
