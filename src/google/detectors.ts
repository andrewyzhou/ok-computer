import type { Db } from '../db/index.js';
import { addDays, localDay, localTime, zonedToUtc } from '../time.js';
import { addSignals, cleanLine, type NewSignal } from './signals.js';

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
// a date further away than this is not a deadline for the next heartbeats.
const HORIZON_DAYS = 60;
// mail older than this is not checked again.
const MAIL_WINDOW_MS = 3 * 24 * 60 * 60_000;
const SOON_MS = 2 * 60 * 60_000;
const QUIET = new Set(['newsletter', 'noise']);
// these words say nothing about which event a mail means.
const STOP = new Set(['about', 'after', 'before', 'from', 'have', 'here', 'just', 'please', 'reminder', 'that', 'there', 'this', 'today', 'tomorrow', 'until', 'what', 'when', 'will', 'with', 'your', 'deadline']);

const pad = (n: number) => String(n).padStart(2, '0');

// mentionedDays gives the days (YYYY-MM-DD) that a text names, from today up to the horizon. it reads iso dates,
// month names, us dates (10/20), weekday names and "tomorrow". a past date is not a deadline.
export function mentionedDays(text: string, today: string): string[] {
  const days = new Set<string>();
  const year = Number(today.slice(0, 4));
  const add = (y: number, m: number, d: number) => {
    if (m < 1 || m > 12 || d < 1 || d > 31) return;
    let day = `${y}-${pad(m)}-${pad(d)}`;
    // a date without a year that is already past means the next year.
    if (day < today && y === year) day = `${y + 1}-${pad(m)}-${pad(d)}`;
    if (day >= today && day <= addDays(today, HORIZON_DAYS) && !Number.isNaN(Date.parse(day))) days.add(day);
  };
  const lower = text.toLowerCase();
  for (const match of lower.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) add(Number(match[1]), Number(match[2]), Number(match[3]));
  for (const match of lower.matchAll(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/g)) {
    const y = match[3] ? (match[3].length === 2 ? 2000 + Number(match[3]) : Number(match[3])) : year;
    add(y, Number(match[1]), Number(match[2]));
  }
  for (const match of lower.matchAll(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b/g)) {
    add(year, MONTHS.indexOf(match[1]!) + 1, Number(match[2]));
  }
  for (const match of lower.matchAll(/\b(\d{1,2})(?:st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/g)) {
    add(year, MONTHS.indexOf(match[2]!) + 1, Number(match[1]));
  }
  if (/\btomorrow\b/.test(lower)) days.add(addDays(today, 1));
  const weekday = new Date(`${today}T12:00:00Z`).getUTCDay();
  for (const match of lower.matchAll(/\b(sun|mon|tue|wed|thu|fri|sat)[a-z]*day\b/g)) {
    const target = WEEKDAYS.indexOf(match[1]!);
    days.add(addDays(today, (target - weekday + 7) % 7));
  }
  return [...days].sort();
}

const words = (text: string) => new Set((text.toLowerCase().match(/[a-z]{4,}/g) ?? []).filter((word) => !STOP.has(word)));

// runDetectors adds the signals that code finds. it reads only the database (the signals and the copy of the
// calendar), so it makes no api call and no model call. the unique key keeps each finding to one signal.
export function runDetectors(db: Db, now: Date, timeZone: string): number {
  const found: NewSignal[] = [];
  const today = localDay(now, timeZone);

  // an event of any account that starts in the next two hours.
  const soon = db
    .prepare(
      `SELECT alias, eventId, summary, startAt FROM calendar_events
       WHERE status != 'cancelled' AND allDay = 0 AND startAt > ? AND startAt <= ?`,
    )
    .all(now.toISOString(), new Date(now.getTime() + SOON_MS).toISOString()) as Array<{ alias: string; eventId: string; summary: string; startAt: string }>;
  for (const event of soon) {
    found.push({
      source: 'detector',
      account: event.alias,
      externalId: `event_soon:${event.eventId}@${event.startAt}`,
      kind: 'event_soon',
      summary: cleanLine(`"${event.summary}" starts at ${localTime(new Date(event.startAt), timeZone)}`),
      occursAt: event.startAt,
    });
  }

  // a recent mail that names a day, where no event on that day shares a word with the mail. a quiet label skips the
  // check; an unlabeled mail is checked, so a failed classifier gives more signals, never fewer.
  const mails = db
    .prepare(
      `SELECT id, account, summary, label FROM integration_events
       WHERE source = 'gmail' AND state = 'ready' AND seenAt >= ?`,
    )
    .all(new Date(now.getTime() - MAIL_WINDOW_MS).toISOString()) as Array<{ id: number; account: string; summary: string; label: string | null }>;
  const events = db.prepare("SELECT summary, startAt, allDay FROM calendar_events WHERE status != 'cancelled' AND startAt IS NOT NULL").all() as Array<{
    summary: string;
    startAt: string;
    allDay: number;
  }>;
  // an all-day event is stored at midnight utc of its date, so its day is the date itself, not the owner's local day.
  const dayOf = (event: { startAt: string; allDay: number }) => (event.allDay ? event.startAt.slice(0, 10) : localDay(new Date(event.startAt), timeZone));
  for (const mail of mails) {
    if (mail.label && QUIET.has(mail.label)) continue;
    const mailWords = words(mail.summary);
    for (const day of mentionedDays(mail.summary, today)) {
      const covered = events.some((event) => dayOf(event) === day && [...words(event.summary)].some((word) => mailWords.has(word)));
      if (covered) continue;
      found.push({
        source: 'detector',
        account: mail.account,
        externalId: `deadline_missing:${mail.id}@${day}`,
        kind: 'deadline_missing',
        summary: cleanLine(`mail #${mail.id} names ${day}, and no calendar event that day matches it: ${mail.summary}`),
        occursAt: zonedToUtc(day, '00:00', timeZone).toISOString(),
      });
    }
  }
  return addSignals(db, found, now);
}
