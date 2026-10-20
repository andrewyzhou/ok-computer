import type { calendar_v3 } from '@googleapis/calendar';
import type { CalendarEvent, CalendarInfo, CalendarSkipped } from '../dashboard/calendar-types.js';
import type { ShownCalendar } from '../google/calendar-events.js';
import { notBuilt, type BriefContext } from './context.js';

// the calendar of the today track: the events of every calendar that the owner shows, on every account, read with the
// same code as calendar_list_events (src/google/calendar-events.ts). the calendar page and the brief both read it.

// what one read gives. configured is false without a google block. skipped names each account that could not be read
// (signed out, or an error), with one sentence for the owner.
export interface CalendarRead {
  configured: boolean;
  calendars: CalendarInfo[];
  events: CalendarEvent[];
  skipped: CalendarSkipped[];
}

// the colors of a calendar that google gives no color. each one reads on the warm light and dark themes.
export const CALENDAR_PALETTE: readonly string[] = ['#3b6fd8', '#c2410c', '#15803d', '#9333ea', '#b45309', '#0e7490', '#be185d', '#4d7c0f'];

// the color of a calendar: the color that google gives it, when it is a css hex color, or a color of the palette that
// a hash of the key picks, so one calendar keeps its color across loads.
export function calendarColor(googleColor: string | null, key: string): string {
  return notBuilt('calendarColor');
}

// one google event as the page reads it, or undefined for an event without an id or a start. see CalendarEvent for
// the rules of each field. timeZone is the zone of the app, for the days of an all-day event.
export function toCalendarEvent(event: calendar_v3.Schema$Event, calendar: ShownCalendar, account: string, timeZone: string): CalendarEvent | undefined {
  return notBuilt('toCalendarEvent');
}

// readCalendar reads the events between two times from every shown calendar of every account that can take a call.
// one account that fails does not hide the others.
export async function readCalendar(ctx: Pick<BriefContext, 'google' | 'timeZone' | 'logger'>, range: { startAt: Date; endAt: Date }): Promise<CalendarRead> {
  return notBuilt('readCalendar');
}
