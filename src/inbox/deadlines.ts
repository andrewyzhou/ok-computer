import { zonedToUtc } from '../time.js';

// the due dates of the digest. the model reads a mail and gives a due time and the words of the mail that state it.
// the code keeps a due time only when those words are in the mail and name the same day, so a deadline never holds a
// date that the mail does not state. the work package "deadlines" builds the check. until then checkDue keeps the
// behavior of phase 5: it parses the due time of the model and does not look at the words.

const DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/i;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

// the due time from the model: a datetime with an offset becomes utc, and a date alone is midnight of that day in
// the time zone of the app, as an all-day event. a value that does not parse is no due time.
export function parseDue(value: string | null | undefined, timeZone: string): { at: string; allDay: boolean } | null {
  if (!value) return null;
  const text = value.trim();
  if (DATETIME.test(text)) {
    const ms = Date.parse(text);
    return Number.isFinite(ms) ? { at: new Date(ms).toISOString(), allDay: false } : null;
  }
  const date = DATE.exec(text);
  if (!date) return null;
  // a date such as 2026-02-31 parses to another day, so the check compares the parts.
  const day = new Date(`${text}T00:00:00Z`);
  if (!Number.isFinite(day.getTime()) || day.toISOString().slice(0, 10) !== text) return null;
  return { at: zonedToUtc(text, '00:00', timeZone).toISOString(), allDay: true };
}

// the facts that the check reads. text is the text of the mail that the model saw, and sentAt is the time of the mail,
// which a relative date such as "this friday" or "tomorrow" counts from.
export interface DueInput {
  dueAt: string | null | undefined;
  dueText: string | null | undefined;
  text: string;
  sentAt: string;
  timeZone: string;
}

// a due time that passed the check. dueText is the words of the mail, cut to one short line.
export interface DueCheck {
  at: string;
  allDay: boolean;
  dueText: string | null;
}

// the reason a due time was dropped, for the counts of the digest and for the quality check.
export type DueDrop = 'no_date' | 'bad_form' | 'no_words' | 'words_not_in_mail' | 'words_name_no_date' | 'other_day' | 'before_mail';

export type DueResult = { ok: true; due: DueCheck } | { ok: false; why: DueDrop };

// checkDue is the seam that the digest calls for each item with a due time. the work package "deadlines" replaces the
// body with the strict check: the words must be in the text, findDates must find a date in them, and that date must be
// the day of dueAt in the time zone of the app.
export function checkDue(input: DueInput): DueResult {
  if (!input.dueAt) return { ok: false, why: 'no_date' };
  const due = parseDue(input.dueAt, input.timeZone);
  if (!due) return { ok: false, why: 'bad_form' };
  return { ok: true, due: { ...due, dueText: input.dueText?.trim() ? input.dueText.trim().slice(0, 200) : null } };
}

// one date that a text states. day is yyyy-mm-dd, time is hh:mm in 24 hours or null, and zone is the time zone that
// the text names (for example "PT" or "+02:00") as an iana name or an offset, or null when it names none. index and
// length give the words in the text.
export interface DateMention {
  index: number;
  length: number;
  day: string;
  time: string | null;
  zone: string | null;
  // true for a date that the text gives relative to the mail, such as "tomorrow" or "this friday".
  relative: boolean;
}

// findDates gives the dates that a text states, in the order of the text. a year that the text leaves out is the
// year that puts the date nearest after the time of the mail, within the next 300 days, else the year of the mail.
export function findDates(_text: string, _sentAt: string, _timeZone: string): DateMention[] {
  throw new Error('not built: findDates (work package deadlines)');
}
