import { addDays, localDay, zonedToUtc } from '../time.js';

// the due dates of the digest. the model reads a mail and gives a due time and the words of the mail that state it.
// the code keeps a due time only when those words are in the mail and name the same day, so a deadline never holds a
// date that the mail does not state. a time is kept only when the words state one, else the deadline is all day.

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

const DUE_TEXT_LIMIT = 200;

// the words are compared without case and with each run of white space as one space.
const normal = (text: string) => text.replace(/\s+/g, ' ').trim().toLowerCase();
const WORD_CHAR = /[\p{L}\p{N}]/u;

// the text in lower case with each run of other characters as one space, and for each character of it the place in
// the text that it came from.
function bareOf(text: string): { bare: string; from: number[]; to: number[] } {
  let bare = ' ';
  const from = [0];
  const to = [0];
  let index = 0;
  for (const char of text) {
    const end = index + char.length;
    if (WORD_CHAR.test(char)) {
      for (const lower of char.toLowerCase()) {
        bare += lower;
        from.push(index);
        to.push(end);
      }
    } else if (!bare.endsWith(' ')) {
      bare += ' ';
      from.push(index);
      to.push(end);
    } else {
      // one space stands for the whole run of marks.
      to[to.length - 1] = end;
    }
    index = end;
  }
  if (!bare.endsWith(' ')) {
    bare += ' ';
    from.push(index);
    to.push(index);
  }
  return { bare, from, to };
}

// true when the text holds the words, and the words start and end on a word edge of the text. "due oct 2" is inside
// "due oct 24", but it does not end on a word edge there, so a model cannot cut a date out of a longer one.
function atWordEdges(text: string, words: string): boolean {
  if (!words) return false;
  const opensWord = WORD_CHAR.test(words[0]!);
  const closesWord = WORD_CHAR.test(words.at(-1)!);
  for (let at = text.indexOf(words); at >= 0; at = text.indexOf(words, at + 1)) {
    const before = text[at - 1];
    const after = text[at + words.length];
    if (opensWord && before !== undefined && WORD_CHAR.test(before)) continue;
    if (closesWord && after !== undefined && WORD_CHAR.test(after)) continue;
    return true;
  }
  return false;
}

// wordsOfMail gives the words of the mail that the model copied, or null when the mail does not hold them. the first
// compare is without case and with each run of white space as one space. real mail turns html into text with marks
// that a model leaves out or changes when it copies the words, as in "Today!" for "Today," or a zone in brackets, so
// the second compare reads each mark as a space on both sides: the letters and digits must be in the mail in the same
// order, and two numbers never join. the second compare gives the words as the mail writes them, so a mark that only
// the model wrote, as in "10/24" for "10 24", can never make a date.
function wordsOfMail(words: string, mail: string): string | null {
  if (atWordEdges(normal(mail), normal(words))) return words;
  const core = bareOf(words).bare;
  if (!core.trim()) return null;
  const text = bareOf(mail);
  const at = text.bare.indexOf(core);
  if (at < 0) return null;
  // the match starts and ends on the spaces around the words, so the words of the mail are between them.
  return mail.slice(text.to[at]!, text.from[at + core.length - 1]!).replace(/\s+/g, ' ').trim() || null;
}

// the digest puts the headers From, Subject and Date before the body. the Date header is the time of the mail and not
// a date that the mail states, so its line is no evidence of a deadline. the subject stays, because a subject such as
// "Homework 3 is due Oct 20" states a date.
function evidenceOf(text: string): string {
  const cut = text.indexOf('\n\n');
  if (cut < 0) return text;
  const head = text.slice(0, cut).split('\n');
  if (!head.every((line) => /^[A-Za-z-]{1,40}: ?/.test(line))) return text;
  return `${head.filter((line) => !/^date:/i.test(line)).join('\n')}${text.slice(cut)}`;
}

// checkDue is the strict check that the digest calls for each item with a due time: the words must be in the text,
// findDates must find a date in them, and that date must be the day of dueAt in the time zone of the app (or in the
// zone that the words name). a time that the words do not state is dropped, so the deadline becomes all day.
export function checkDue(input: DueInput): DueResult {
  try {
    return check(input);
  } catch {
    // a time zone that the platform does not know makes the date functions throw. such a due time cannot be checked.
    return { ok: false, why: 'bad_form' };
  }
}

function check(input: DueInput): DueResult {
  if (!input.dueAt) return { ok: false, why: 'no_date' };
  const due = parseDue(input.dueAt, input.timeZone);
  if (!due) return { ok: false, why: 'bad_form' };
  const given = typeof input.dueText === 'string' ? input.dueText.replace(/\s+/g, ' ').trim().slice(0, DUE_TEXT_LIMIT * 2) : '';
  if (!given) return { ok: false, why: 'no_words' };
  const words = wordsOfMail(given, evidenceOf(String(input.text ?? '')));
  if (!words) return { ok: false, why: 'words_not_in_mail' };
  const mentions = findDates(words, input.sentAt, input.timeZone);
  if (!mentions.length) return { ok: false, why: 'words_name_no_date' };

  const ms = Date.parse(due.at);
  // the day of dueAt: a date alone is its own day, and a time is read in the zone of the mention, else in the zone
  // of the app.
  const dueDay = (zone: string | null) => (due.allDay ? input.dueAt!.trim() : dayIn(ms, zone ?? input.timeZone));
  const matching = mentions.filter((each) => each.day === dueDay(each.zone));
  if (!matching.length) return { ok: false, why: 'other_day' };
  // a mention with the same time as dueAt is the best evidence, then a mention with any time, then the first.
  const sameTime = (each: DateMention) => each.time !== null && !due.allDay && timeIn(ms, each.zone ?? input.timeZone) === each.time;
  const mention = matching.find(sameTime) ?? matching.find((each) => each.time !== null) ?? matching[0]!;

  const sent = Date.parse(input.sentAt);
  if (Number.isFinite(sent) && mention.day < localDay(new Date(sent), input.timeZone)) return { ok: false, why: 'before_mail' };

  const dueText = words.slice(0, DUE_TEXT_LIMIT);
  // the model gave a date alone, so the deadline stays all day.
  if (due.allDay) return { ok: true, due: { ...due, dueText } };
  // the words state no time, so the time of the model is not kept: the deadline is the whole local day.
  if (mention.time === null) return { ok: true, due: { at: zonedToUtc(mention.day, '00:00', input.timeZone).toISOString(), allDay: true, dueText } };
  const at = zonedAt(mention.day, mention.time, mention.zone ?? input.timeZone);
  return { ok: true, due: { at: new Date(at).toISOString(), allDay: false, dueText } };
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

// the patterns. every quantifier has a bound and the scan is one pass of a global search, so the time stays linear in
// the size of the text, which is untrusted mail.
const MONTH = '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)(?![a-z])\\.?';
const WEEKDAY = '(?:mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:r(?:s(?:day)?)?)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)(?![a-z])\\.?';
const ORD = '(?:st|nd|rd|th)?';
const REL = '(?:this|next|coming|last)';
const ZONE = `(?:\\s{0,2}\\(?(?<zn>[pcme][sd]?t|utc|gmt|pacific|eastern|central|mountain)(?:\\s?time)?(?<zo>[+-]\\d{1,2}(?::?\\d{2})?)?\\)?(?![a-z])|\\s{0,2}(?<off>[+-]\\d{2}:?\\d{2})(?!\\d))?`;

const SCAN = new RegExp(
  [
    // 2026-10-24, with a time and an offset when it is a full iso time.
    `(?<![\\d-])(?<iy>(?:19|20)\\d{2})-(?<im>\\d{2})-(?<id>\\d{2})(?:T(?<ih>\\d{2}):(?<imin>\\d{2})(?::\\d{2}(?:\\.\\d{1,9})?)?(?<iz>z|[+-]\\d{2}:?\\d{2})?)?(?![\\d])`,
    // 10/24, 10/24/2026 and 10/24/26.
    `(?<![\\d/.:-])(?<na>\\d{1,2})/(?<nb>\\d{1,2})(?:/(?<ny>\\d{4}|\\d{2}))?(?![\\d/])`,
    // Oct 24, October 24th, 2026, and the range Oct 24-26.
    `\\b(?<mm>${MONTH})\\s{0,3}(?<md>\\d{1,2})${ORD}(?![\\d:])(?:,?\\s{1,3}(?<my>(?:19|20)\\d{2})(?![\\d:]))?(?:\\s{0,3}(?:-|\\u2013|\\u2014|to|through|thru|until)\\s{0,3}(?<mr>\\d{1,2})${ORD}(?![\\d:/]|\\s{0,2}[ap]\\.?m(?![a-z])))?`,
    // 24 October, 24th of October 2026.
    `(?<![\\d/.:])(?<dd>\\d{1,2})${ORD}\\s{0,3}(?:of\\s{1,3})?(?<dm>${MONTH})(?:,?\\s{1,3}(?<dy>(?:19|20)\\d{2})(?![\\d:]))?`,
    // Friday, this Friday, next Fri.
    `(?:(?<rel>${REL})\\s{1,3})?\\b(?<wd>${WEEKDAY})`,
    `\\b(?<word>(?:the\\s)?day\\safter\\stomorrow|today|tonight|tomorrow|tmrw)(?![a-z])`,
    `\\b(?<eod>end\\sof\\s(?:the\\s)?(?:business\\s)?day|close\\sof\\sbusiness|eod|cob)(?![a-z])`,
    // 11:59 PM PT, 5pm, 23:59, 7:03:23 PM UTC, 19:03:23, noon, midnight. the seconds are read and left out.
    `(?<![\\d:.])(?:(?<th>\\d{1,2})(?::(?<tm>\\d{2})(?::\\d{2})?)?\\s{0,2}(?<ap>[ap]\\.?m)\\.?(?![a-z])|(?<hh>\\d{1,2}):(?<hm>\\d{2})(?::\\d{2})?(?![\\d:])|\\b(?<noon>noon|midday)|\\b(?<mid>midnight))${ZONE}`,
  ].join('|'),
  'gi',
);

// the most mentions that one text gives, so a hostile mail cannot fill the memory.
const MENTION_LIMIT = 2000;
// the most days ahead that a date without a year is read as the next year.
const YEAR_WINDOW = 300;

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
// the weekdays from monday (0) to sunday (6).
const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

const ZONES: Record<string, string> = {
  pt: 'America/Los_Angeles',
  pst: 'America/Los_Angeles',
  pdt: 'America/Los_Angeles',
  pacific: 'America/Los_Angeles',
  mt: 'America/Denver',
  mst: 'America/Denver',
  mdt: 'America/Denver',
  mountain: 'America/Denver',
  ct: 'America/Chicago',
  cst: 'America/Chicago',
  cdt: 'America/Chicago',
  central: 'America/Chicago',
  et: 'America/New_York',
  est: 'America/New_York',
  edt: 'America/New_York',
  eastern: 'America/New_York',
  utc: 'UTC',
  gmt: 'UTC',
  z: 'UTC',
};

interface Token {
  kind: 'date' | 'time' | 'eod';
  index: number;
  end: number;
  day?: string;
  relative?: boolean;
  time?: string | null;
  zone?: string | null;
  // the second end of a range such as "Oct 24-26".
  rangeDay?: string;
  // true for a weekday name, which a full date right after it takes in, as in "Friday, October 24".
  weekday?: boolean;
  used?: boolean;
}

// the words before and after "n/n" that make it a fraction, a score, a page or a room, and not a date.
const NOT_DATE_BEFORE =
  /\b(?:scored?|scores|grade|graded|rating|rated|points?|pts|page|pages|pg|pp|p|room|rm|ste|suite|unit|apt|step|steps|question|q|problem|prob|exercise|ex|chapter|ch|section|sec|part|slide|item|number|ratio|odds|record|cups?)\.?\s{0,2}[:#]?\s{0,2}$|#\s{0,2}$/i;
const NOT_DATE_AFTER =
  /^\s{0,2}(?:cups?|c\.|tbsp|tsp|teaspoons?|tablespoons?|oz|ounces?|lbs?|pounds?|kg|g|grams?|ml|l|liters?|litres?|inch(?:es)?|in\.|ft|feet|miles?|mi|km|points?|pts|marks|stars?|correct|of\s{1,2}(?:the|a|an)\b)(?![a-z])/i;

const pad = (n: number) => String(n).padStart(2, '0');

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const leap = (year: number) => (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;

// the day as yyyy-mm-dd, or null when the month has no such day, as for 2/30. the check is plain arithmetic, so a
// text with thousands of dates stays fast.
function validDay(year: number, month: number, day: number): string | null {
  if (!(year >= 1900 && year <= 2099 && month >= 1 && month <= 12 && day >= 1)) return null;
  if (day > (month === 2 && leap(year) ? 29 : DAYS_IN_MONTH[month - 1]!)) return null;
  return `${year}-${pad(month)}-${pad(day)}`;
}

const daysBetween = (from: string, to: string) => Math.round((utcOf(to) - utcOf(from)) / 86_400_000);
const utcOf = (day: string) => Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)));

// a date with a year, or without one: then the year that puts it nearest on or after the day of the mail, within the
// window, else the year of the mail.
function dayOf(year: number | null, month: number, day: number, base: string | null): string | null {
  if (year !== null) return validDay(year, month, day);
  if (!base) return null;
  const sentYear = Number(base.slice(0, 4));
  for (const each of [sentYear, sentYear + 1]) {
    const candidate = validDay(each, month, day);
    if (candidate && candidate >= base && daysBetween(base, candidate) <= YEAR_WINDOW) return candidate;
  }
  return validDay(sentYear, month, day);
}

const yearOf = (text: string | undefined) => (text === undefined ? null : text.length === 2 ? 2000 + Number(text) : Number(text));
const monthOf = (text: string) => MONTHS.indexOf(text.slice(0, 3).toLowerCase()) + 1;
// the weekday of a day, from monday (0) to sunday (6).
const weekdayOf = (day: string) => (new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7;

function relativeWeekday(rel: string | undefined, target: number, base: string): string {
  const today = weekdayOf(base);
  switch (rel?.toLowerCase()) {
    case 'next':
      // the weekday of the week after the week of the mail, which starts on a monday.
      return addDays(base, 7 - today + target);
    case 'last':
      return addDays(base, -((today - target + 7) % 7 || 7));
    default:
      // "friday" in a mail of a friday is the same day.
      return addDays(base, (target - today + 7) % 7);
  }
}

function zoneOf(name: string | undefined, offset: string | undefined, plainOffset: string | undefined): string | null {
  if (plainOffset) return offsetOf(plainOffset);
  if (!name) return null;
  const base = ZONES[name.toLowerCase()];
  if (!base) return null;
  // "UTC+2" or "GMT-7" names an offset.
  if (offset && base === 'UTC') return offsetOf(offset);
  return base;
}

function offsetOf(text: string): string | null {
  const parts = /^([+-])(\d{1,2})(?::?(\d{2}))?$/.exec(text);
  if (!parts) return null;
  const hours = Number(parts[2]);
  const minutes = Number(parts[3] ?? 0);
  if (hours > 14 || minutes > 59) return null;
  return `${parts[1]}${pad(hours)}:${pad(minutes)}`;
}

function clock(hours: number, minutes: number, ampm: string | undefined): string | null {
  if (minutes > 59) return null;
  if (ampm) {
    if (hours < 1 || hours > 12) return null;
    const pm = ampm.toLowerCase().startsWith('p');
    return `${pad((hours % 12) + (pm ? 12 : 0))}:${pad(minutes)}`;
  }
  return hours > 23 ? null : `${pad(hours)}:${pad(minutes)}`;
}

// the token of one match of the scan, or null when the match is no valid date or time.
function tokenOf(match: RegExpExecArray, base: string | null, cache: Map<string, string>): Token | null {
  const g = match.groups ?? {};
  const index = match.index;
  const end = index + match[0].length;
  if (g.iy !== undefined) {
    const day = validDay(Number(g.iy), Number(g.im), Number(g.id));
    if (!day) return null;
    const time = g.ih !== undefined ? clock(Number(g.ih), Number(g.imin), undefined) : null;
    const zone = g.iz === undefined ? null : g.iz.toLowerCase() === 'z' ? 'UTC' : offsetOf(g.iz);
    return { kind: 'date', index, end, day, relative: false, time, zone: time ? zone : null };
  }
  if (g.na !== undefined) {
    // "1/2 cup", "page 3/4", "Room 4/5" and "Score: 20/12" are no dates. a slash date without a year is read only
    // when no such word stands next to it.
    if (g.ny === undefined && (NOT_DATE_BEFORE.test(match.input.slice(Math.max(0, index - 24), index)) || NOT_DATE_AFTER.test(match.input.slice(end, end + 16)))) return null;
    let month = Number(g.na);
    let day = Number(g.nb);
    // the order is month/day, as in the united states, unless the first number cannot be a month.
    if (month > 12) [month, day] = [day, month];
    const found = dayOf(yearOf(g.ny), month, day, base);
    return found ? { kind: 'date', index, end, day: found, relative: false } : null;
  }
  if (g.mm !== undefined) {
    const month = monthOf(g.mm);
    const year = yearOf(g.my);
    const found = dayOf(year, month, Number(g.md), base);
    if (!found) return null;
    const token: Token = { kind: 'date', index, end, day: found, relative: false };
    if (g.mr !== undefined) {
      const last = validDay(Number(found.slice(0, 4)), month, Number(g.mr));
      if (last && last > found) token.rangeDay = last;
    }
    return token;
  }
  if (g.dd !== undefined) {
    const found = dayOf(yearOf(g.dy), monthOf(g.dm!), Number(g.dd), base);
    return found ? { kind: 'date', index, end, day: found, relative: false } : null;
  }
  if (g.wd !== undefined) {
    // a short name such as "sat" or "sun" is also a word, so it counts only with a capital, as in "Sat".
    const short = g.wd.replace(/\.$/, '').length <= 4;
    if (short && g.wd[0] !== g.wd[0]!.toUpperCase()) return null;
    if (!base) return null;
    const key = `${(g.rel ?? '').toLowerCase()} ${g.wd.slice(0, 3).toLowerCase()}`;
    let day = cache.get(key);
    if (day === undefined) cache.set(key, (day = relativeWeekday(g.rel, WEEKDAYS.indexOf(g.wd.slice(0, 3).toLowerCase()), base)));
    return { kind: 'date', index, end, day, relative: true, weekday: true };
  }
  if (g.word !== undefined) {
    if (!base) return null;
    const word = g.word.toLowerCase();
    const days = word.endsWith('after tomorrow') ? 2 : word === 'tomorrow' || word === 'tmrw' ? 1 : 0;
    return { kind: 'date', index, end, day: addDays(base, days), relative: true };
  }
  if (g.eod !== undefined) return { kind: 'eod', index, end };
  let time: string | null;
  if (g.noon !== undefined) time = '12:00';
  // midnight of a named day is read as the end of that day, which is what a deadline "by midnight" means.
  else if (g.mid !== undefined) time = '23:59';
  else if (g.th !== undefined) time = clock(Number(g.th), Number(g.tm ?? 0), g.ap);
  else time = clock(Number(g.hh), Number(g.hm), undefined);
  if (!time) return null;
  return { kind: 'time', index, end, time, zone: zoneOf(g.zn, g.zo, g.off) };
}

// the words between a date and its time, as in "Oct 24 at 5pm" or "5pm on Friday". the gaps are short, so the test is
// cheap.
const GAP_AFTER = /^\s{0,3}(?:,\s{0,2})?(?:(?:at|by|@|before|until|due|-|\u2013)\s{1,3})?$/i;
const GAP_BEFORE = /^\s{0,3}(?:,\s{0,2})?(?:on\s{1,3})?$/i;
const GAP_EOD = /^[\s,]{0,4}(?:(?:on|at|by)\s{1,3})?$/i;
const GAP_WEEKDAY = /^,?\s{1,4}(?:the\s{1,3})?$/i;
const GAP_LIMIT = 16;
// the words between the two times of a range.
const RANGE_GAP = /^\s{0,3}(?:-|–|—|to)\s{0,3}$/i;

const gapOf = (text: string, from: number, to: number) => (to - from > GAP_LIMIT ? null : text.slice(from, to));

// findDates gives the dates that a text states, in the order of the text. a year that the text leaves out is the
// year that puts the date nearest after the time of the mail, within the next 300 days, else the year of the mail.
// a relative date counts from the local day of the mail in the time zone of the app. it never throws.
export function findDates(text: string, sentAt: string, timeZone: string): DateMention[] {
  try {
    return scan(String(text ?? ''), sentAt, timeZone);
  } catch {
    return [];
  }
}

function scan(text: string, sentAt: string, timeZone: string): DateMention[] {
  const sent = Date.parse(sentAt);
  let base: string | null = null;
  if (Number.isFinite(sent)) {
    try {
      base = localDay(new Date(sent), timeZone);
    } catch {
      base = new Date(sent).toISOString().slice(0, 10);
    }
  }

  const found: Token[] = [];
  // the relative days of the weekday names, which a hostile text repeats thousands of times.
  const cache = new Map<string, string>();
  const re = new RegExp(SCAN.source, SCAN.flags);
  let match: RegExpExecArray | null;
  while (found.length < MENTION_LIMIT * 2 && (match = re.exec(text))) {
    if (match[0].length === 0) {
      re.lastIndex += 1;
      continue;
    }
    const token = tokenOf(match, base, cache);
    if (token) found.push(token);
  }
  // a full date wins over the weekday before it, even when the two do not agree, because the date is the more exact
  // fact. the weekday then names no date of its own.
  const tokens = found.filter((token, at) => {
    const next = found[at + 1];
    if (!token.weekday || next?.kind !== 'date' || next.relative) return true;
    const gap = gapOf(text, token.end, next.index);
    if (gap === null || !GAP_WEEKDAY.test(gap)) return true;
    next.index = token.index;
    return false;
  });

  const out: DateMention[] = [];
  const push = (index: number, end: number, day: string, time: string | null, zone: string | null, relative: boolean) => {
    if (out.length < MENTION_LIMIT) out.push({ index, length: end - index, day, time, zone, relative });
  };
  tokens.forEach((token, at) => {
    if (token.kind !== 'date') return;
    let index = token.index;
    let end = token.end;
    let time = token.time ?? null;
    let zone = token.zone ?? null;
    const next = tokens[at + 1];
    const before = tokens[at - 1];
    if (time === null && !token.rangeDay) {
      const after = next?.kind === 'time' && !next.used ? gapOf(text, token.end, next.index) : null;
      const prior = before?.kind === 'time' && !before.used ? gapOf(text, before.end, token.index) : null;
      if (after !== null && GAP_AFTER.test(after)) {
        next!.used = true;
        ({ time = null, zone = null } = next!);
        end = next!.end;
      } else if (prior !== null && GAP_BEFORE.test(prior)) {
        before!.used = true;
        ({ time = null, zone = null } = before!);
        index = before!.index;
        // a range before the date, as in "8:00pm - 10:00pm on Tuesday, 10/27", starts at its first time. the zone of
        // the end counts for the start when the start names none.
        const start = tokens[at - 2];
        const range = start?.kind === 'time' && !start.used ? gapOf(text, start.end, before!.index) : null;
        if (range !== null && RANGE_GAP.test(range)) {
          start!.used = true;
          time = start!.time ?? null;
          zone = start!.zone ?? zone;
          index = start!.index;
        }
      }
    }
    // "end of day Friday" and "Friday EOD" are the day itself, and the time stays open.
    for (const near of [before, next]) {
      if (near?.kind !== 'eod' || near.used) continue;
      const gap = near === before ? gapOf(text, near.end, token.index) : gapOf(text, token.end, near.index);
      if (gap !== null && GAP_EOD.test(gap)) near.used = true;
    }
    push(index, end, token.day!, time, zone, token.relative ?? false);
    if (token.rangeDay) push(index, end, token.rangeDay, null, null, false);
  });
  // an "EOD" without a day of its own is today.
  if (base) {
    for (const token of tokens) {
      if (token.kind === 'eod' && !token.used) push(token.index, token.end, base, null, null, true);
    }
  }
  return out.sort((a, b) => a.index - b.index);
}

// the local day and time of an instant in an iana zone or a fixed offset such as "+02:00".
function shifted(ms: number, zone: string): Date | null {
  const offset = /^([+-])(\d{2}):(\d{2})$/.exec(zone);
  if (!offset) return null;
  const minutes = (Number(offset[2]) * 60 + Number(offset[3])) * (offset[1] === '-' ? -1 : 1);
  return new Date(ms + minutes * 60_000);
}

function dayIn(ms: number, zone: string): string {
  const moved = shifted(ms, zone);
  return moved ? moved.toISOString().slice(0, 10) : localDay(new Date(ms), zone);
}

function timeIn(ms: number, zone: string): string {
  const moved = shifted(ms, zone);
  if (moved) return moved.toISOString().slice(11, 16);
  return new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(ms));
}

// the instant of a local day and time in an iana zone or a fixed offset.
function zonedAt(day: string, time: string, zone: string): number {
  return /^[+-]\d{2}:\d{2}$/.test(zone) ? Date.parse(`${day}T${time}:00${zone}`) : zonedToUtc(day, time, zone).getTime();
}
