import type { calendar_v3 } from '@googleapis/calendar';
import { cleanLine } from '../signals/store.js';
import type { GoogleApis } from './accounts.js';

// the calendar reads that calendar_list_events and the calendar page of the today track share, so both show the same
// events from the same calendars.

// the text of an event description. a calendar app writes it in html, and the sender of an invitation writes it, so
// each step takes linear time and the text stays untrusted.
export function plainText(html: string): string {
  return html
    .replace(/<br\s*\/?>|<\/p>|<\/li>/gi, ' ')
    .replace(/<[^<>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

// the video link of an event: a meet link, or the video entry point of another conference tool.
// a zoom invitation often puts its link in the location, so a location that is a link counts as the video link.
export const isLink = (text: string | null | undefined) => /^https?:\/\/\S+$/i.test((text ?? '').trim());
export const videoOf = (event: calendar_v3.Schema$Event) =>
  event.hangoutLink ??
  event.conferenceData?.entryPoints?.find((point) => point.entryPointType === 'video')?.uri ??
  (isLink(event.location) ? event.location!.trim() : undefined);

// a calendar of an account that the owner shows in google calendar. id is 'primary' for the primary calendar, and
// label is null for it. color is the background color that google gives the calendar, or null. owned is true for a
// calendar other than the primary one that the account owns (access role owner), such as a calendar the owner made for
// his own time blocks. it is left out for the primary calendar and for calendars of other people.
export interface ShownCalendar {
  id: string;
  label: string | null;
  color: string | null;
  primary: boolean;
  owned?: boolean;
}

// the shown calendars of an account, and the ids of every calendar that the account owns (the primary one under its
// real id, the address of the account, and each other calendar with the access role owner). google names the
// organizer of an event that the owner made on one of his own calendars by the id of that calendar.
export interface ShownCalendars {
  calendars: ShownCalendar[];
  ownedIds: Set<string>;
}

// the calendars of an account that the owner shows in google calendar, with the ids that it owns. the primary one comes
// first. a list that fails gives the primary calendar alone, so a read still works.
export async function readShownCalendars(apis: GoogleApis): Promise<ShownCalendars> {
  try {
    const { data } = await apis.calendar.calendarList.list({ minAccessRole: 'reader', maxResults: 250 });
    const items = data.items ?? [];
    const primary = items.find((each) => each.primary);
    const others = items
      .filter((each) => !each.primary && each.selected && !each.hidden && each.id)
      .map(
        (each): ShownCalendar => ({
          id: each.id!,
          label: cleanLine(each.summaryOverride ?? each.summary ?? each.id!, 60),
          color: each.backgroundColor ?? null,
          primary: false,
          ...(each.accessRole === 'owner' ? { owned: true } : {}),
        }),
      );
    const ownedIds = new Set(items.filter((each) => each.id && (each.primary || each.accessRole === 'owner')).map((each) => each.id!.toLowerCase()));
    return { calendars: [{ id: 'primary', label: null, color: primary?.backgroundColor ?? null, primary: true }, ...others], ownedIds };
  } catch {
    return { calendars: [{ id: 'primary', label: null, color: null, primary: true }], ownedIds: new Set() };
  }
}

// the calendars of an account that the owner shows in google calendar. the primary one comes first.
export async function shownCalendars(apis: GoogleApis): Promise<ShownCalendar[]> {
  return (await readShownCalendars(apis)).calendars;
}

// one page of events.list holds at most this many events, and a calendar gives at most MAX_PAGES pages. a calendar
// with more events in the range gives the first ones and a note.
export const EVENTS_PAGE_SIZE = 250;
export const MAX_PAGES = 4;

// a note about one calendar of an account: it could not be read, or only its first events are there. reason is one
// sentence for the owner.
export interface CalendarNote {
  calendar: ShownCalendar;
  reason: string;
}

// the name of a calendar in a note: its label, or "the primary calendar".
const calendarName = (calendar: ShownCalendar) => (calendar.primary ? 'the primary calendar' : `the calendar ${calendar.label ?? calendar.id}`);

// the events of every shown calendar of one account between two times. each calendar is read page by page, up to
// MAX_PAGES pages. an invitation from a shared calendar is also on the primary one, so the first copy, from the
// primary calendar, stays. two copies are the same event when they have the same uid and start at the same instant,
// because google writes each start in the zone of its calendar. used holds the calendars that gave at least one event.
// a calendar that fails gives a note, and the other calendars of the account are still read.
export async function listShownEvents(
  apis: GoogleApis,
  from: string,
  to: string,
): Promise<{
  calendars: ShownCalendar[];
  ownedIds: Set<string>;
  events: Array<{ event: calendar_v3.Schema$Event; calendar: ShownCalendar }>;
  used: ShownCalendar[];
  notes: CalendarNote[];
}> {
  const { calendars, ownedIds } = await readShownCalendars(apis);
  const notes: CalendarNote[] = [];
  const lists = await Promise.all(
    calendars.map(async (calendar) => {
      const found: Array<{ event: calendar_v3.Schema$Event; calendar: ShownCalendar }> = [];
      let pageToken: string | undefined;
      try {
        for (let page = 0; page < MAX_PAGES; page++) {
          const { data } = await apis.calendar.events.list({
            calendarId: calendar.id,
            timeMin: from,
            timeMax: to,
            singleEvents: true,
            orderBy: 'startTime',
            maxResults: EVENTS_PAGE_SIZE,
            ...(pageToken ? { pageToken } : {}),
          });
          for (const event of data.items ?? []) found.push({ event, calendar });
          pageToken = data.nextPageToken ?? undefined;
          if (!pageToken) break;
        }
        if (pageToken) notes.push({ calendar, reason: `Only the first ${found.length} events of ${calendarName(calendar)} are shown.` });
      } catch (err) {
        // the primary calendar is the account itself, so its error goes to the caller, which skips the account.
        if (calendar.primary) throw err;
        notes.push({ calendar, reason: `${capitalize(calendarName(calendar))} could not be read.` });
      }
      return found;
    }),
  );
  const seen = new Set<string>();
  const used = new Set<ShownCalendar>();
  const events = lists.flat().filter(({ event }) => {
    const key = `${event.iCalUID ?? event.id}@${instantOf(event.start)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  for (const { calendar } of events) used.add(calendar);
  return { calendars, ownedIds, events, used: [...used], notes };
}

// the start of an event as a number of milliseconds for a time, or the date of an all-day event.
function instantOf(start: calendar_v3.Schema$EventDateTime | undefined): string {
  if (start?.dateTime) {
    const at = Date.parse(start.dateTime);
    return Number.isNaN(at) ? start.dateTime : String(at);
  }
  return start?.date ?? '';
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
