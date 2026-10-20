import type { CalendarConflict, CalendarEvent, TravelGap } from '../dashboard/calendar-types.js';
import { notBuilt } from './context.js';

// the pure checks of a day of calendar events. the brief and the calendar page both use them, so the two never
// disagree. nothing here reads the database or google.

// two events closer than this, at different places, are a travel gap.
export const TRAVEL_GAP_MINUTES = 15;

// true for a timed event that the owner holds: not cancelled, not shown as free, and accepted by the owner or
// organized by the owner (organizerSelf, which is also true for an event that the owner made alone).
export function committed(event: CalendarEvent): boolean {
  return notBuilt('committed');
}

// the events that touch the local day in timeZone, not cancelled and not declined by the owner, sorted by startAt and
// then by key. an all-day event touches each day from startDay to endDay.
export function eventsOfDay(events: CalendarEvent[], day: string, timeZone: string): CalendarEvent[] {
  return notBuilt('eventsOfDay');
}

// each pair of committed events that overlap. two events overlap when one starts before the other ends; an event that
// starts when the other ends does not. two copies of one invitation on two accounts (the same uid and start) are not a
// conflict. a is the event that starts first (then the lower key), and the list is sorted by startAt.
export function findConflicts(events: CalendarEvent[]): CalendarConflict[] {
  return notBuilt('findConflicts');
}

// each pair of timed events, not cancelled, not declined and not shown as free, where the second starts 0 to 14
// minutes after the first ends and both have a location that is not empty and the two locations differ. locations
// compare without case, without repeated spaces and without trailing punctuation.
export function findTravelGaps(events: CalendarEvent[]): TravelGap[] {
  return notBuilt('findTravelGaps');
}

// the events that the owner was invited to and did not answer (answer needsAction), not cancelled, not organized by
// the owner, and not ended before now. sorted by startAt.
export function unansweredInvites(events: CalendarEvent[], now: Date): CalendarEvent[] {
  return notBuilt('unansweredInvites');
}
