import { addDays, localDay, localTime } from '../time.js';
import { cleanLine, type DetectorHit, type NewSignal } from './store.js';

// the detectors are code. they make no model call, so they work when the classifier fails, and a label of the
// classifier never hides their hits.

// a mail to check: its subject names the matter, and the text (subject and snippet) can name the day.
export interface MailItem {
  id: number;
  subject: string;
  text: string;
  arrived: Date;
}

// an event of a calendar. start is an iso time, or a date (YYYY-MM-DD) for an all-day event.
export interface CalendarItem {
  account: string;
  id: string;
  summary: string;
  start: string;
  allDay: boolean;
}

export interface Mention {
  day: string;
  phrase: string;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MONTH = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
// a date further away than this is not a deadline for the next heartbeats.
const WINDOW_DAYS = 60;
const SOON_MS = 2 * 60 * 60_000;

const pad = (n: number) => String(n).padStart(2, '0');

// the day of a month and a day without a year: this year, or next year when the day has passed.
function nearest(today: string, month: number, day: number): string | undefined {
  const year = Number(today.slice(0, 4));
  for (const y of [year, year + 1]) {
    const candidate = `${y}-${pad(month)}-${pad(day)}`;
    if (new Date(`${candidate}T00:00:00Z`).getUTCDate() !== day) return undefined;
    if (candidate >= today) return candidate;
  }
  return undefined;
}

// the days that a text names, relative to the day that it arrived in the owner's time zone. it reads iso dates,
// "Oct 17", "17 October", us dates (10/17), a weekday or the same day after a word that sets a day ("by Friday", "due
// today", "by end of day"), and "tomorrow". a past date and a date past the window are not deadlines.
export function mentionedDates(text: string, arrived: Date, timeZone: string): Mention[] {
  const today = localDay(arrived, timeZone);
  const last = addDays(today, WINDOW_DAYS);
  const found = new Map<string, Mention>();
  const add = (day: string | undefined, phrase: string) => {
    if (day && day >= today && day <= last && !found.has(day) && !Number.isNaN(Date.parse(day))) found.set(day, { day, phrase: phrase.trim() });
  };
  for (const m of text.matchAll(/\b(20\d{2})-(\d{2})-(\d{2})\b/g)) add(`${m[1]}-${m[2]}-${m[3]}`, m[0]);
  for (const m of text.matchAll(new RegExp(`\\b${MONTH}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?:,?\\s+(20\\d{2}))?`, 'gi'))) {
    const month = MONTHS.indexOf(m[1]!.slice(0, 3).toLowerCase()) + 1;
    add(m[3] ? `${m[3]}-${pad(month)}-${pad(Number(m[2]))}` : nearest(today, month, Number(m[2])), m[0]);
  }
  for (const m of text.matchAll(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+${MONTH}\\b`, 'gi'))) {
    add(nearest(today, MONTHS.indexOf(m[2]!.slice(0, 3).toLowerCase()) + 1, Number(m[1])), m[0]);
  }
  // a fraction such as 3/4 is also a match, so the month and the day must be valid and in the window.
  for (const m of text.matchAll(/\b(1[0-2]|0?[1-9])\/(3[01]|[12]\d|0?[1-9])(?:\/(20\d{2}))?\b/g)) {
    add(m[3] ? `${m[3]}-${pad(Number(m[1]))}-${pad(Number(m[2]))}` : nearest(today, Number(m[1]), Number(m[2])), m[0]);
  }
  // a weekday alone is often a proposal ("would thursday work?"), not a date to keep. it counts only after a word
  // that sets a day.
  for (const m of text.matchAll(/\b(next\s+|this\s+|by\s+|on\s+|until\s+|before\s+|due\s+)(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/gi)) {
    let ahead = (WEEKDAYS.indexOf(m[2]!.toLowerCase()) - new Date(`${today}T00:00:00Z`).getUTCDay() + 7) % 7 || 7;
    if (/next/i.test(m[1]!) && ahead < 7) ahead += 7;
    add(addDays(today, ahead), m[0]);
  }
  for (const m of text.matchAll(/\btomorrow\b/gi)) add(addDays(today, 1), m[0]);
  // a deadline on the day of the mail is the most urgent kind. "today" alone is in many newsletters, so it counts
  // only after a word that sets a day, as a weekday does.
  for (const m of text.matchAll(/\b(?:by|until|before|due)\s+(?:the\s+)?(?:today|tonight|end\s+of\s+(?:the\s+)?day|eod|cob)\b/gi)) add(today, m[0]);
  return [...found.values()].sort((a, b) => a.day.localeCompare(b.day));
}

// these words say nothing about which event a mail means.
const STOP = new Set([
  'about', 'after', 'again', 'also', 'before', 'deadline', 'from', 'have', 'here', 'just', 'meeting', 'please', 'reminder',
  'regarding', 'that', 'there', 'this', 'today', 'tonight', 'tomorrow', 'update', 'week', 'when', 'with', 'your', 'will', 'until',
  ...WEEKDAYS,
  'january', 'february', 'march', 'april', 'june', 'july', 'august', 'september', 'october', 'november', 'december',
]);

export function keywords(text: string): string[] {
  return [...new Set(text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((word) => word.length >= 4 && !STOP.has(word) && !/^\d+$/.test(word)))];
}

// an all-day event has a date only, so its day is that date. the day of a timed event is its day in the owner's zone.
const dayOf = (event: CalendarItem, timeZone: string) => (event.allDay ? event.start.slice(0, 10) : localDay(new Date(event.start), timeZone));

// date_not_on_calendar: the mail names a day, and no event of that day, in any account, shares a word with the
// subject of the mail. an empty subject never matches, so its date always counts as missing. a poll can find a mail
// days after it arrived, for example after the computer was off. a day before the day of the poll has passed, and the
// live read of the calendar does not hold its events, so it is not a deadline.
export function dateHits(mail: MailItem, events: CalendarItem[], timeZone: string, now: Date): DetectorHit[] {
  const words = keywords(mail.subject);
  const today = localDay(now, timeZone);
  return mentionedDates(mail.text, mail.arrived, timeZone).filter(({ day }) => day >= today).flatMap(({ day, phrase }) => {
    const sameDay = events.filter((event) => dayOf(event, timeZone) === day);
    if (sameDay.some((event) => keywords(event.summary).some((word) => words.includes(word)))) return [];
    return [{ name: 'date_not_on_calendar', detail: cleanLine(`mentions "${phrase}" (${day}); the primary calendars have ${sameDay.length} events that day and none about "${mail.subject}"`) }];
  });
}

// event_soon: a timed event that starts in the next two hours. the key holds the start, so a moved event can be a
// signal again.
export function soonSignals(events: CalendarItem[], now: Date, timeZone: string, runId: string): NewSignal[] {
  return events
    .filter((event) => !event.allDay && Date.parse(event.start) > now.getTime() && Date.parse(event.start) <= now.getTime() + SOON_MS)
    .map((event) => ({
      source: 'calendar',
      account: event.account,
      externalId: `soon:${event.id}@${new Date(event.start).toISOString()}`,
      kind: 'event_soon',
      summary: cleanLine(`"${event.summary}" starts at ${localTime(new Date(event.start), timeZone)}`),
      occursAt: new Date(event.start).toISOString(),
      runId,
    }));
}
