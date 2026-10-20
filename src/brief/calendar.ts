import type { calendar_v3 } from '@googleapis/calendar';
import type { CalendarAnswer, CalendarEvent, CalendarGuest, CalendarInfo, CalendarSkipped } from '../dashboard/calendar-types.js';
import { isLink, listShownEvents, plainText, videoOf, type ShownCalendar } from '../google/calendar-events.js';
import { toGoogleError } from '../google/errors.js';
import { cleanLine } from '../signals/store.js';
import { addDays, localDay, zonedToUtc } from '../time.js';
import type { BriefContext } from './context.js';

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
  if (googleColor && /^#[0-9a-f]{6}$/i.test(googleColor)) return googleColor.toLowerCase();
  return CALENDAR_PALETTE[fnv1a(key) % CALENDAR_PALETTE.length]!;
}

// the 32-bit fnv-1a hash of a text. it is stable across runs and machines, which the palette needs.
function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

const ANSWERS = new Set(['needsAction', 'accepted', 'tentative', 'declined']);

// the owner's own answer. an attendee with self true is the owner, and an answer that google does not document counts
// as no answer yet.
function answerOf(event: calendar_v3.Schema$Event): CalendarAnswer {
  const own = (event.attendees ?? []).find((each) => each.self === true);
  if (!own) return null;
  const answer = own.responseStatus ?? 'needsAction';
  return ANSWERS.has(answer) ? (answer as CalendarAnswer) : 'needsAction';
}

// a link that the page may open. only http and https links pass, so a javascript: link never reaches an anchor.
const webLink = (text: string | null | undefined): string | null => (text && /^https?:\/\/\S+$/i.test(text.trim()) ? text.trim() : null);

// one google event as the page reads it, or undefined for an event without an id or a start. see CalendarEvent for
// the rules of each field. timeZone is the zone of the app, for the days of an all-day event.
export function toCalendarEvent(event: calendar_v3.Schema$Event, calendar: ShownCalendar, account: string, timeZone: string): CalendarEvent | undefined {
  if (!event.id || !(event.start?.dateTime || event.start?.date)) return undefined;
  const allDay = !event.start.dateTime;
  let startAt: string;
  let endAt: string;
  let startDay: string;
  let endDay: string;
  if (allDay) {
    // google gives the day after the last day as the end of an all-day event, so the last day is one day before it.
    startDay = event.start.date!;
    const end = event.end?.date;
    endDay = end && end > startDay ? addDays(end, -1) : startDay;
    startAt = zonedToUtc(startDay, '00:00', timeZone).toISOString();
    endAt = zonedToUtc(addDays(endDay, 1), '00:00', timeZone).toISOString();
  } else {
    const start = new Date(event.start.dateTime!);
    if (Number.isNaN(start.getTime())) return undefined;
    const given = event.end?.dateTime ? new Date(event.end.dateTime) : undefined;
    const end = given && !Number.isNaN(given.getTime()) && given >= start ? given : start;
    startAt = start.toISOString();
    endAt = end.toISOString();
    startDay = localDay(start, timeZone);
    // an event that ends at midnight ends on the day before, so the end day uses the last millisecond of the event.
    const last = localDay(new Date(Math.max(start.getTime(), end.getTime() - 1)), timeZone);
    endDay = last < startDay ? startDay : last;
  }
  const attendees = event.attendees ?? [];
  const guests: CalendarGuest[] = attendees
    .filter((each) => !each.resource)
    .map((each) => ({
      name: each.displayName ? cleanLine(each.displayName, 120) || null : null,
      email: each.email ? cleanLine(each.email, 200) || null : null,
      answer: each.responseStatus ?? 'needsAction',
      organizer: each.organizer === true,
      optional: each.optional === true,
      self: each.self === true,
    }));
  const place = event.location?.trim() ?? '';
  const notes = event.description ? plainText(event.description).replace(/\s+/g, ' ').trim().slice(0, 500) : '';
  const organizer = event.organizer?.displayName ?? event.organizer?.email;
  return {
    key: `${account}/${calendar.id}/${event.id}`,
    uid: event.iCalUID ?? null,
    account,
    calendarId: calendar.id,
    calendarKey: `${account}/${calendar.id}`,
    eventId: event.id,
    title: cleanLine(event.summary?.trim() || '(no title)', 300),
    startAt,
    endAt,
    allDay,
    startDay,
    endDay,
    location: place && !isLink(place) ? cleanLine(place, 300) : null,
    videoUrl: webLink(videoOf(event)),
    status: event.status === 'cancelled' || event.status === 'tentative' ? event.status : 'confirmed',
    answer: answerOf(event),
    organizerSelf: event.organizer ? event.organizer.self === true : attendees.length === 0,
    organizer: organizer ? cleanLine(organizer, 200) || null : null,
    guests,
    showsAsFree: event.transparency === 'transparent',
    recurring: Boolean(event.recurringEventId),
    notes: notes || null,
    htmlLink: event.htmlLink?.startsWith('https://') ? event.htmlLink : null,
  };
}

// readCalendar reads the events between two times from every shown calendar of every account that can take a call.
// one account that fails does not hide the others.
export async function readCalendar(ctx: Pick<BriefContext, 'google' | 'timeZone' | 'logger'>, range: { startAt: Date; endAt: Date }): Promise<CalendarRead> {
  if (!ctx.google) return { configured: false, calendars: [], events: [], skipped: [] };
  const { accounts } = ctx.google;
  const from = range.startAt.toISOString();
  const to = range.endAt.toISOString();
  // each account reads at the same time, and a failure stays with its account.
  const reads = await Promise.all(
    accounts.aliases.map(async (alias) => {
      const why = accounts.unavailable(alias);
      if (why) return { alias, skipped: { account: alias, reason: `${alias} is not signed in: ${why}` } };
      try {
        return { alias, read: await accounts.run(alias, (apis) => listShownEvents(apis, from, to)) };
      } catch (err) {
        // toGoogleError keeps only the status and a short redacted message, so no token reaches the owner or the log.
        const error = toGoogleError(err);
        ctx.logger.warn('the calendar of a google account could not be read', { alias, err: error });
        return { alias, skipped: { account: alias, reason: cleanLine(`${alias} could not be read: ${error.message}`, 200) } };
      }
    }),
  );
  const calendars: CalendarInfo[] = [];
  const events: CalendarEvent[] = [];
  const skipped: CalendarSkipped[] = [];
  for (const each of reads) {
    if (each.skipped) {
      skipped.push(each.skipped);
      continue;
    }
    for (const calendar of each.read!.calendars) {
      const key = `${each.alias}/${calendar.id}`;
      calendars.push({ key, account: each.alias, calendarId: calendar.id, label: calendar.primary ? each.alias : (calendar.label ?? calendar.id), color: calendarColor(calendar.color, key), primary: calendar.primary });
    }
    for (const { event, calendar } of each.read!.events) {
      const shown = toCalendarEvent(event, calendar, each.alias, ctx.timeZone);
      if (shown) events.push(shown);
    }
  }
  events.sort((a, b) => (a.startAt === b.startAt ? (a.key < b.key ? -1 : a.key > b.key ? 1 : 0) : a.startAt < b.startAt ? -1 : 1));
  return { configured: true, calendars, events, skipped };
}
