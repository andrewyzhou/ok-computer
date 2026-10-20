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

// each pair of committed events that overlap. two events overlap when one starts before the other ends; an event that
// starts when the other ends does not. two copies of one invitation on two accounts (the same uid and start) are not a
// conflict. a is the event that starts first (then the lower key), and the list is sorted by startAt.
export function findConflicts(events: CalendarEvent[]): CalendarConflict[] {
  const held = events.filter(committed).sort(byStart);
  const conflicts: CalendarConflict[] = [];
  for (let i = 0; i < held.length; i++) {
    const a = held[i]!;
    for (let j = i + 1; j < held.length; j++) {
      const b = held[j]!;
      // the list is sorted by start, so no later event can overlap a.
      if (startOf(b) >= endOf(a)) break;
      if (startOf(a) >= endOf(b)) continue;
      if (a.uid !== null && a.uid === b.uid && startOf(a) === startOf(b)) continue;
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
    .replace(/[.,;:\s]+$/, '');
}

// each pair of timed events, not cancelled, not declined and not shown as free, where the second starts 0 to 14
// minutes after the first ends and both have a location that is not empty and the two locations differ. locations
// compare without case, without repeated spaces and without trailing punctuation.
export function findTravelGaps(events: CalendarEvent[]): TravelGap[] {
  const placed = dedupeCopies(
    events.filter((event) => !event.allDay && visible(event) && !event.showsAsFree && event.location !== null && normalizeLocation(event.location) !== '').sort(byStart),
  );
  const gaps: TravelGap[] = [];
  for (const a of placed) {
    for (const b of placed) {
      if (a === b) continue;
      const gap = startOf(b) - endOf(a);
      if (gap < 0 || gap >= TRAVEL_GAP_MINUTES * MINUTE) continue;
      if (normalizeLocation(a.location!) === normalizeLocation(b.location!)) continue;
      gaps.push({ from: a.key, to: b.key, at: a.endAt, gapMinutes: Math.floor(gap / MINUTE), fromLocation: a.location!.trim(), toLocation: b.location!.trim() });
    }
  }
  return gaps.sort((x, y) => Date.parse(x.at) - Date.parse(y.at) || compare(x.from, y.from) || compare(x.to, y.to));
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
