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
// label is null for it. color is the background color that google gives the calendar, or null.
export interface ShownCalendar {
  id: string;
  label: string | null;
  color: string | null;
  primary: boolean;
}

// the calendars of an account that the owner shows in google calendar. the primary one comes first. a list that
// fails gives the primary calendar alone, so a read still works.
export async function shownCalendars(apis: GoogleApis): Promise<ShownCalendar[]> {
  try {
    const { data } = await apis.calendar.calendarList.list({ minAccessRole: 'reader', maxResults: 250 });
    const items = data.items ?? [];
    const primary = items.find((each) => each.primary);
    const others = items
      .filter((each) => !each.primary && each.selected && !each.hidden && each.id)
      .map((each) => ({ id: each.id!, label: cleanLine(each.summaryOverride ?? each.summary ?? each.id!, 60), color: each.backgroundColor ?? null, primary: false }));
    return [{ id: 'primary', label: null, color: primary?.backgroundColor ?? null, primary: true }, ...others];
  } catch {
    return [{ id: 'primary', label: null, color: null, primary: true }];
  }
}

// the events of every shown calendar of one account between two times, one page of at most 100 events for each
// calendar. an invitation from a shared calendar is also on the primary one, so the first copy, from the primary
// calendar, stays. used holds the calendars that gave at least one event.
export async function listShownEvents(
  apis: GoogleApis,
  from: string,
  to: string,
): Promise<{ calendars: ShownCalendar[]; events: Array<{ event: calendar_v3.Schema$Event; calendar: ShownCalendar }>; used: ShownCalendar[] }> {
  const calendars = await shownCalendars(apis);
  const lists = await Promise.all(
    calendars.map(async (calendar) => {
      const { data } = await apis.calendar.events.list({ calendarId: calendar.id, timeMin: from, timeMax: to, singleEvents: true, orderBy: 'startTime', maxResults: 100 });
      return (data.items ?? []).map((event) => ({ event, calendar }));
    }),
  );
  const seen = new Set<string>();
  const used = new Set<ShownCalendar>();
  const events = lists.flat().filter(({ event, calendar }) => {
    const key = `${event.iCalUID ?? event.id}@${event.start?.dateTime ?? event.start?.date}`;
    if (seen.has(key)) return false;
    seen.add(key);
    used.add(calendar);
    return true;
  });
  return { calendars, events, used: [...used] };
}
