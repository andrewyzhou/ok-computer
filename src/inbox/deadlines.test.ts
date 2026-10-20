import { describe, expect, it } from 'vitest';
import { header } from '../google/mime.js';
import { localDay } from '../time.js';
import { checkDue, findDates, parseDue, statesDue, type DueInput } from './deadlines.js';
import { receivedAt } from './gmail.js';
import { mailText } from './mailtext.js';
import { CORPUS, corpusMessages, TIME_ZONE } from './testdata/corpus.js';
import { CORPUS_ANSWERS, CORPUS_INVENTED, DUE_CASES, SENT_MONDAY } from './testdata/deadlines-corpus.js';

const TZ = 'America/Los_Angeles';

// the day, time, zone and words of each mention, which is what the tables compare.
const read = (text: string, sentAt = SENT_MONDAY, timeZone = TZ) =>
  findDates(text, sentAt, timeZone).map((each) => ({ day: each.day, time: each.time, zone: each.zone, relative: each.relative, words: text.slice(each.index, each.index + each.length) }));
const days = (text: string, sentAt = SENT_MONDAY, timeZone = TZ) => findDates(text, sentAt, timeZone).map((each) => each.day);

describe('findDates', () => {
  it.each([
    ['Oct 24', '2026-10-24'],
    ['October 24', '2026-10-24'],
    ['Oct. 24th', '2026-10-24'],
    ['24 October', '2026-10-24'],
    ['24th of October', '2026-10-24'],
    ['October 24, 2026', '2026-10-24'],
    ['October 24 2027', '2027-10-24'],
    ['10/24', '2026-10-24'],
    ['10/24/2026', '2026-10-24'],
    ['10/24/26', '2026-10-24'],
    ['24/10', '2026-10-24'],
    ['24/10/2026', '2026-10-24'],
    ['2026-10-24', '2026-10-24'],
    ['Sept 3', '2026-09-03'],
    ['Feb 3', '2027-02-03'],
    ['december 1st', '2026-12-01'],
  ])('reads %s as %s', (text, day) => {
    expect(read(text)).toEqual([{ day, time: null, zone: null, relative: false, words: text }]);
  });

  it('reads the dates inside a sentence, in the order of the text', () => {
    expect(days('We are doing dinner on Friday, October 30. Can you let me know by Oct 27 if you can make it?')).toEqual(['2026-10-30', '2026-10-27']);
    expect(read('due Friday, October 24 at 11:59 PM PT on the site')).toEqual([
      { day: '2026-10-24', time: '23:59', zone: 'America/Los_Angeles', relative: false, words: 'Friday, October 24 at 11:59 PM PT' },
    ]);
  });

  it('reads the relative words from the local day of the mail', () => {
    expect(read('today')).toEqual([{ day: '2026-10-19', time: null, zone: null, relative: true, words: 'today' }]);
    expect(days('tonight')).toEqual(['2026-10-19']);
    expect(days('tomorrow')).toEqual(['2026-10-20']);
    expect(days('the day after tomorrow')).toEqual(['2026-10-21']);
    expect(read('end of day Friday')).toEqual([{ day: '2026-10-23', time: null, zone: null, relative: true, words: 'Friday' }]);
    expect(days('Friday EOD')).toEqual(['2026-10-23']);
    expect(read('by EOD')).toEqual([{ day: '2026-10-19', time: null, zone: null, relative: true, words: 'EOD' }]);
    expect(days('by end of day')).toEqual(['2026-10-19']);
    expect(days('EOD tomorrow')).toEqual(['2026-10-20']);
    // 23:30 in los angeles is the next day in utc. the mail counts from its local day.
    expect(days('tomorrow', '2026-10-20T06:30:00.000Z')).toEqual(['2026-10-20']);
    expect(days('tomorrow', '2026-10-20T06:30:00.000Z', 'UTC')).toEqual(['2026-10-21']);
  });

  // the days of the week of 2026-10-19 (a monday) to 2026-10-25 (a sunday), at noon in los angeles.
  const week = ['2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23', '2026-10-24', '2026-10-25'];
  const noon = (day: string) => `${day}T19:00:00.000Z`;
  it.each([
    // sent, friday, this friday, next friday, monday, next monday, last friday
    ['2026-10-19', '2026-10-23', '2026-10-23', '2026-10-30', '2026-10-19', '2026-10-26', '2026-10-16'],
    ['2026-10-20', '2026-10-23', '2026-10-23', '2026-10-30', '2026-10-26', '2026-10-26', '2026-10-16'],
    ['2026-10-21', '2026-10-23', '2026-10-23', '2026-10-30', '2026-10-26', '2026-10-26', '2026-10-16'],
    ['2026-10-22', '2026-10-23', '2026-10-23', '2026-10-30', '2026-10-26', '2026-10-26', '2026-10-16'],
    ['2026-10-23', '2026-10-23', '2026-10-23', '2026-10-30', '2026-10-26', '2026-10-26', '2026-10-16'],
    ['2026-10-24', '2026-10-30', '2026-10-30', '2026-10-30', '2026-10-26', '2026-10-26', '2026-10-23'],
    ['2026-10-25', '2026-10-30', '2026-10-30', '2026-10-30', '2026-10-26', '2026-10-26', '2026-10-23'],
  ])('reads the weekdays of a mail of %s', (sent, friday, thisFriday, nextFriday, monday, nextMonday, lastFriday) => {
    const at = noon(sent);
    expect(days('Friday', at)).toEqual([friday]);
    expect(days('Fri', at)).toEqual([friday]);
    expect(days('this Friday', at)).toEqual([thisFriday]);
    expect(days('next Friday', at)).toEqual([nextFriday]);
    expect(days('monday', at)).toEqual([monday]);
    expect(days('next Monday', at)).toEqual([nextMonday]);
    expect(days('last Friday', at)).toEqual([lastFriday]);
    expect(read('Friday', at)[0]!.relative).toBe(true);
    expect(week).toContain(sent);
  });

  it('reads short weekday names only with a capital, so words such as sat and sun stay words', () => {
    expect(days('I sat in the sun and wed my friend')).toEqual([]);
    expect(days('Sat or Sun')).toEqual(['2026-10-24', '2026-10-25']);
  });

  it('gives a full date over the weekday before it, also when the two disagree', () => {
    // 2026-10-24 is a saturday, but the date is the more exact fact.
    expect(read('Friday, October 24')).toEqual([{ day: '2026-10-24', time: null, zone: null, relative: false, words: 'Friday, October 24' }]);
    expect(days('next Friday, Oct 30')).toEqual(['2026-10-30']);
    expect(days('Fri 10/30')).toEqual(['2026-10-30']);
  });

  it('gives each end of a range', () => {
    expect(days('Oct 24-26')).toEqual(['2026-10-24', '2026-10-26']);
    expect(days('Oct 24 – 26')).toEqual(['2026-10-24', '2026-10-26']);
    expect(days('Oct 24 to Oct 26')).toEqual(['2026-10-24', '2026-10-26']);
    expect(days('Oct 24 through 26')).toEqual(['2026-10-24', '2026-10-26']);
    expect(days('10/24 - 10/26')).toEqual(['2026-10-24', '2026-10-26']);
    expect(days('Oct 30 - Nov 2')).toEqual(['2026-10-30', '2026-11-02']);
    // a time after a dash is no end of a range.
    expect(read('Oct 24 - 5pm')).toEqual([{ day: '2026-10-24', time: '17:00', zone: null, relative: false, words: 'Oct 24 - 5pm' }]);
  });

  it.each([
    ['Oct 24 at 11:59 PM', '23:59', null],
    ['Oct 24 11:59pm', '23:59', null],
    ['Oct 24, 23:59', '23:59', null],
    ['Oct 24 at 5pm', '17:00', null],
    ['Oct 24 at 5 p.m.', '17:00', null],
    ['Oct 24 at 9am', '09:00', null],
    ['Oct 24 at 12am', '00:00', null],
    ['Oct 24 at 12pm', '12:00', null],
    ['Oct 24 at noon', '12:00', null],
    ['Oct 24 at midnight', '23:59', null],
    ['Oct 24 at 5pm PT', '17:00', 'America/Los_Angeles'],
    ['Oct 24 at 5pm PST', '17:00', 'America/Los_Angeles'],
    ['Oct 24 at 5pm PDT', '17:00', 'America/Los_Angeles'],
    ['Oct 24 at 5pm (PDT)', '17:00', 'America/Los_Angeles'],
    ['Oct 24 at 5pm ET', '17:00', 'America/New_York'],
    ['Oct 24 at 5pm EST', '17:00', 'America/New_York'],
    ['Oct 24 at 5pm EDT', '17:00', 'America/New_York'],
    ['Oct 24 at 5pm CT', '17:00', 'America/Chicago'],
    ['Oct 24 at 5pm MT', '17:00', 'America/Denver'],
    ['Oct 24 at 5pm UTC', '17:00', 'UTC'],
    ['Oct 24 at 5pm GMT', '17:00', 'UTC'],
    ['Oct 24 at 17:00 UTC+2', '17:00', '+02:00'],
    ['Oct 24 at 17:00 GMT-7', '17:00', '-07:00'],
    ['Oct 24 at 17:00 +0530', '17:00', '+05:30'],
    ['Oct 24 at 5pm Eastern Time', '17:00', 'America/New_York'],
    ['2026-10-24T23:59:00-07:00', '23:59', '-07:00'],
    ['2026-10-24T23:59:00Z', '23:59', 'UTC'],
    ['2026-10-24T23:59', '23:59', null],
  ])('reads the time of %s', (text, time, zone) => {
    expect(findDates(text, SENT_MONDAY, TZ)).toEqual([{ index: 0, length: text.length, day: '2026-10-24', time, zone, relative: false }]);
  });

  it('reads a time before its day', () => {
    expect(read('5pm tomorrow')).toEqual([{ day: '2026-10-20', time: '17:00', zone: null, relative: true, words: '5pm tomorrow' }]);
    expect(read('11:59 PM PT on Friday')).toEqual([{ day: '2026-10-23', time: '23:59', zone: 'America/Los_Angeles', relative: true, words: '11:59 PM PT on Friday' }]);
    expect(read('midnight Friday')).toEqual([{ day: '2026-10-23', time: '23:59', zone: null, relative: true, words: 'midnight Friday' }]);
    expect(read('tonight at 8pm')[0]).toMatchObject({ day: '2026-10-19', time: '20:00' });
  });

  it('gives no date for a time alone, a bad time or a bad day', () => {
    expect(days('at 11:59 PM')).toEqual([]);
    expect(read('Oct 24 at 25:00')).toEqual([{ day: '2026-10-24', time: null, zone: null, relative: false, words: 'Oct 24' }]);
    expect(read('Oct 24 at 13pm')[0]!.time).toBeNull();
    expect(days('2/30')).toEqual([]);
    expect(days('February 30')).toEqual([]);
    expect(days('13/13')).toEqual([]);
    expect(days('2026-13-01')).toEqual([]);
    expect(days('Feb 29, 2027')).toEqual([]);
    expect(days('Feb 29, 2028')).toEqual(['2028-02-29']);
  });

  it('gives no date for text that names none', () => {
    expect(days('The midterm is coming up soon. We will post the room and the time later.')).toEqual([]);
    expect(days('Your order #113-55 is 12345 items, version 1.2.3, at 99.5%.')).toEqual([]);
    expect(days('maybe in march, the octopus')).toEqual([]);
  });

  it('takes the year that puts a date nearest after the mail', () => {
    // a mail of 2026-12-28 that names january means the next january.
    expect(days('Jan 3', '2026-12-28T18:00:00.000Z')).toEqual(['2027-01-03']);
    expect(days('1/3', '2026-12-28T18:00:00.000Z')).toEqual(['2027-01-03']);
    expect(days('Dec 30', '2026-12-28T18:00:00.000Z')).toEqual(['2026-12-30']);
    // a date that just passed is more than 300 days ahead next year, so it keeps the year of the mail.
    expect(days('Dec 20', '2026-12-28T18:00:00.000Z')).toEqual(['2026-12-20']);
    expect(days('Oct 1')).toEqual(['2026-10-01']);
    // the day of the mail is not after it, but it is the nearest, so it stays in the year of the mail.
    expect(days('Oct 19')).toEqual(['2026-10-19']);
    // 300 days after 2026-10-19 is 2027-08-15.
    expect(days('Aug 15')).toEqual(['2027-08-15']);
    expect(days('Aug 16')).toEqual(['2026-08-16']);
    // february 29 counts only in a leap year within the window, else it names no day.
    expect(days('Feb 29', '2027-03-01T18:00:00.000Z')).toEqual([]);
    expect(days('Feb 29', '2027-06-01T18:00:00.000Z')).toEqual(['2028-02-29']);
  });

  it('never throws, and gives only absolute dates without a valid time of the mail', () => {
    for (const [text, sentAt, zone] of [
      ['Oct 24 and tomorrow', 'not a time', TZ],
      ['Oct 24, 2026 and tomorrow', '', TZ],
      ['Oct 24 and tomorrow', SENT_MONDAY, 'Not/AZone'],
      [null, SENT_MONDAY, TZ],
      [undefined, SENT_MONDAY, TZ],
      ['\u0000\ud800 Oct ￿ 24 ‮', SENT_MONDAY, TZ],
    ] as Array<[string, string, string]>) {
      expect(() => findDates(text, sentAt, zone)).not.toThrow();
    }
    expect(days('Oct 24, 2026 and Oct 25 and tomorrow', 'not a time')).toEqual(['2026-10-24']);
    // a time zone that the platform does not know reads the mail in utc.
    expect(days('tomorrow', SENT_MONDAY, 'Not/AZone')).toEqual(['2026-10-20']);
  });

  it('reads hostile text of 100 kB in linear time', () => {
    const cases = [
      'Oct 24 '.repeat(15_000),
      'Friday, October 24 at 11:59 PM PT; '.repeat(3_000),
      '1/'.repeat(50_000),
      '1'.repeat(100_000),
      ' '.repeat(100_000),
      'next '.repeat(20_000),
      'Oct '.repeat(25_000),
      '12:'.repeat(33_000),
      '2026-10-'.repeat(12_500),
      'end of '.repeat(15_000),
      'a'.repeat(100_000),
    ];
    for (const text of cases) {
      expect(text.length).toBeGreaterThanOrEqual(99_000);
      const started = performance.now();
      const found = findDates(text, SENT_MONDAY, TZ);
      expect(performance.now() - started).toBeLessThan(1000);
      expect(found.length).toBeLessThanOrEqual(2000);
    }
  });

  it('reads a mail with 1,000 dates, all of them in order', () => {
    const text = Array.from({ length: 1000 }, (_, at) => `item ${at} is due ${(at % 12) + 1}/${(at % 28) + 1}`).join('. ');
    const found = findDates(text, SENT_MONDAY, TZ);
    expect(found).toHaveLength(1000);
    expect(found.map((each) => each.index)).toEqual([...found.map((each) => each.index)].sort((a, b) => a - b));
  });
});

const due = (extra: Partial<DueInput>): DueInput => ({ dueAt: '2026-10-24', dueText: 'due Oct 24', text: 'The essay is due Oct 24.', sentAt: SENT_MONDAY, timeZone: TZ, ...extra });

describe('checkDue', () => {
  it('gives each reason of a drop', () => {
    expect(checkDue(due({ dueAt: null }))).toEqual({ ok: false, why: 'no_date' });
    expect(checkDue(due({ dueAt: undefined }))).toEqual({ ok: false, why: 'no_date' });
    expect(checkDue(due({ dueAt: '' }))).toEqual({ ok: false, why: 'no_date' });
    expect(checkDue(due({ dueAt: 'friday' }))).toEqual({ ok: false, why: 'bad_form' });
    expect(checkDue(due({ dueAt: '2026-10-24T17:00:00' }))).toEqual({ ok: false, why: 'bad_form' });
    expect(checkDue(due({ dueText: null }))).toEqual({ ok: false, why: 'no_words' });
    expect(checkDue(due({ dueText: undefined }))).toEqual({ ok: false, why: 'no_words' });
    expect(checkDue(due({ dueText: ' \n ' }))).toEqual({ ok: false, why: 'no_words' });
    expect(checkDue(due({ dueText: 'due Oct 25' }))).toEqual({ ok: false, why: 'words_not_in_mail' });
    expect(checkDue(due({ dueText: 'The essay is' }))).toEqual({ ok: false, why: 'words_name_no_date' });
    expect(checkDue(due({ dueAt: '2026-10-25' }))).toEqual({ ok: false, why: 'other_day' });
    expect(checkDue(due({ dueAt: '2026-10-01', dueText: 'due Oct 1', text: 'It was due Oct 1.' }))).toEqual({ ok: false, why: 'before_mail' });
    // an unknown time zone cannot be checked.
    expect(checkDue(due({ timeZone: 'Not/AZone' }))).toEqual({ ok: false, why: 'bad_form' });
  });

  it('keeps a due date of the words, all day when the model gave a date alone', () => {
    expect(checkDue(due({}))).toEqual({ ok: true, due: { ...parseDue('2026-10-24', TZ)!, dueText: 'due Oct 24' } });
    expect(checkDue(due({ dueText: '  due   Oct\n24 ' }))).toEqual({ ok: true, due: { at: '2026-10-24T07:00:00.000Z', allDay: true, dueText: 'due Oct 24' } });
  });

  it('keeps a date stated on the day of the mail', () => {
    expect(checkDue(due({ dueAt: '2026-10-19', dueText: 'today', text: 'Please reply today.' }))).toMatchObject({ ok: true, due: { at: '2026-10-19T07:00:00.000Z', allDay: true } });
  });

  it('makes a timed due date all day when the words state no time', () => {
    expect(checkDue(due({ dueAt: '2026-10-24T17:00:00-07:00' }))).toEqual({ ok: true, due: { at: '2026-10-24T07:00:00.000Z', allDay: true, dueText: 'due Oct 24' } });
    // the day of a timed due date counts in the time zone of the app: 01:00 utc on the 25th is the 24th in los angeles.
    expect(checkDue(due({ dueAt: '2026-10-25T01:00:00Z' }))).toMatchObject({ ok: true, due: { at: '2026-10-24T07:00:00.000Z', allDay: true } });
    expect(checkDue(due({ dueAt: '2026-10-25T08:00:00Z' }))).toEqual({ ok: false, why: 'other_day' });
  });

  it('keeps the time that the words state, in their zone', () => {
    const text = 'Homework 6 is due Friday, October 24 at 11:59 PM PT on the course site.';
    const dueText = 'Friday, October 24 at 11:59 PM PT';
    expect(checkDue(due({ text, dueText, dueAt: '2026-10-24T23:59:00-07:00' }))).toEqual({ ok: true, due: { at: '2026-10-25T06:59:00.000Z', allDay: false, dueText } });
    // the model gave the same instant in utc.
    expect(checkDue(due({ text, dueText, dueAt: '2026-10-25T06:59:00Z' }))).toMatchObject({ ok: true, due: { at: '2026-10-25T06:59:00.000Z', allDay: false } });
    // an app in new york reads the day in the zone of the words, so the deadline keeps its pacific time.
    expect(checkDue(due({ text, dueText, dueAt: '2026-10-25T06:59:00Z', timeZone: 'America/New_York' }))).toMatchObject({ ok: true, due: { at: '2026-10-25T06:59:00.000Z', allDay: false } });
    const eastern = 'The form closes Oct 24 at 5pm ET.';
    expect(checkDue(due({ text: eastern, dueText: 'Oct 24 at 5pm ET', dueAt: '2026-10-24T14:00:00-07:00' }))).toMatchObject({ ok: true, due: { at: '2026-10-24T21:00:00.000Z', allDay: false } });
    const offset = 'Submit by 2026-10-24T18:00:00+02:00.';
    expect(checkDue(due({ text: offset, dueText: '2026-10-24T18:00:00+02:00', dueAt: '2026-10-24T18:00:00+02:00' }))).toMatchObject({ ok: true, due: { at: '2026-10-24T16:00:00.000Z', allDay: false } });
  });

  it('keeps a time without a zone in the time zone of the app', () => {
    expect(checkDue(due({ text: 'The essay is due Oct 24 at 5pm.', dueText: 'due Oct 24 at 5pm', dueAt: '2026-10-24T17:00:00-07:00' }))).toMatchObject({ ok: true, due: { at: '2026-10-25T00:00:00.000Z', allDay: false } });
  });

  it('cuts the words to 200 characters', () => {
    const long = `due Oct 24 ${'and more words '.repeat(30)}`.trim();
    const result = checkDue(due({ text: `The essay is ${long}.`, dueText: long }));
    expect(result.ok).toBe(true);
    expect(result.ok && result.due.dueText).toBe(long.slice(0, 200));
  });

  it('never throws on odd input', () => {
    const odd = [
      due({ text: null as unknown as string }),
      due({ sentAt: 'never' }),
      due({ dueText: 42 as unknown as string }),
      due({ dueAt: '9999-99-99' }),
      due({ dueAt: '2026-10-24T25:61:00Z' }),
      due({ text: 'x'.repeat(200_000), dueText: 'Oct 24 '.repeat(100) }),
    ];
    for (const input of odd) expect(() => checkDue(input)).not.toThrow();
    // without a time of the mail, a date without a year and a relative date name no day, and a full date still counts.
    expect(checkDue(due({ sentAt: 'never' }))).toEqual({ ok: false, why: 'words_name_no_date' });
    expect(checkDue(due({ sentAt: 'never', text: 'due Oct 24, 2026', dueText: 'due Oct 24, 2026' }))).toMatchObject({ ok: true });
    expect(checkDue(due({ sentAt: 'never', dueText: 'tomorrow', text: 'do it tomorrow', dueAt: '2026-10-20' }))).toEqual({ ok: false, why: 'words_name_no_date' });
  });

  it.each(DUE_CASES.map((each) => [each.name, each] as const))('%s', (_name, each) => {
    const result = checkDue({ dueAt: each.dueAt, dueText: each.dueText, text: each.text, sentAt: each.sentAt ?? SENT_MONDAY, timeZone: each.timeZone ?? TZ });
    if ('why' in each.expect) expect(result).toEqual({ ok: false, why: each.expect.why });
    else expect(result).toMatchObject({ ok: true, due: each.expect });
  });
});

describe('checkDue on the corpus', () => {
  const messages = corpusMessages();
  // the text that the digest gives the model: the subject line and the text of the mail.
  const textOf = (id: string) => {
    const found = [...messages.values()].find((each) => each.mail.spec.id === id)!;
    return { mail: found.mail, sentAt: receivedAt(found.message), text: `Subject: ${header(found.message, 'Subject')}\n\n${mailText(found.message).text}` };
  };

  it('keeps the stated due date of each corpus mail that has one', () => {
    const withDue = CORPUS.filter((mail) => typeof mail.expect.due === 'string');
    expect(withDue.map((mail) => mail.spec.id).sort()).toEqual(Object.keys(CORPUS_ANSWERS).sort());
    for (const [id, answer] of Object.entries(CORPUS_ANSWERS)) {
      const { mail, sentAt, text } = textOf(id);
      const result = checkDue({ dueAt: answer.dueAt, dueText: answer.dueText, text, sentAt, timeZone: TIME_ZONE });
      expect(result, id).toEqual({ ok: true, due: { at: answer.at, allDay: answer.allDay, dueText: answer.dueText } });
      expect(result.ok && localDay(new Date(result.due.at), TIME_ZONE)).toBe(mail.expect.due);
    }
  });

  it('downgrades an invented time on a corpus date without one', () => {
    const { sentAt, text } = textOf('c-rsvp');
    expect(checkDue({ dueAt: '2026-10-27T17:00:00-07:00', dueText: 'by Oct 27', text, sentAt, timeZone: TIME_ZONE })).toEqual({ ok: true, due: { at: '2026-10-27T07:00:00.000Z', allDay: true, dueText: 'by Oct 27' } });
    // the dinner date is in the mail too, but the words of the reply date do not name it.
    expect(checkDue({ dueAt: '2026-10-30', dueText: 'by Oct 27', text, sentAt, timeZone: TIME_ZONE })).toEqual({ ok: false, why: 'other_day' });
  });

  it('drops an invented date on each corpus mail that states none', () => {
    for (const [id, answer] of Object.entries(CORPUS_INVENTED)) {
      const { mail, sentAt, text } = textOf(id);
      expect(mail.expect.due).toBeNull();
      expect(checkDue({ dueAt: answer.dueAt, dueText: answer.dueText, text, sentAt, timeZone: TIME_ZONE }), id).toEqual({ ok: false, why: answer.why });
      // words that the mail does not hold are no evidence either.
      expect(checkDue({ dueAt: answer.dueAt, dueText: 'due Oct 26', text, sentAt, timeZone: TIME_ZONE })).toEqual({ ok: false, why: 'words_not_in_mail' });
    }
  });

  it('accepts a date that only the subject states', () => {
    const { text, sentAt } = textOf('c-course-due');
    expect(checkDue({ dueAt: '2026-10-24', dueText: 'Homework 6 released', text, sentAt, timeZone: TIME_ZONE })).toEqual({ ok: false, why: 'words_name_no_date' });
    const subject = `Subject: Quiz 2 is due 10/22\n\n${text}`;
    expect(checkDue({ dueAt: '2026-10-22', dueText: 'due 10/22', text: subject, sentAt, timeZone: TIME_ZONE })).toMatchObject({ ok: true, due: { allDay: true } });
  });
});

describe('statesDue', () => {
  it('finds a due word in the words, near them in the mail, or a limit right before them', () => {
    expect(statesDue('Subject: x\n\nanything', 'due Fri 10/16')).toBe(true);
    expect(statesDue('Subject: x\n\nHomework 6 is due on\nFri 10/16 at 11:59 pm.', 'Fri 10/16 at 11:59 pm')).toBe(true);
    expect(statesDue('Subject: x\n\nSign up for the trip by Fri 10/16.', 'Fri 10/16')).toBe(true);
    expect(statesDue('Subject: x\n\nThe form closes Fri 10/16.', 'Fri 10/16')).toBe(true);
  });

  it('is false for the date of an event and for no words', () => {
    expect(statesDue('Subject: [CAL CLIMBING] PRACTICES\n\nPractices are on Wed 10/14 at the gym.', 'Wed 10/14')).toBe(false);
    expect(statesDue('Subject: Game reminder\n\nYour game is on Wed 10/14 at 9:00 pm. Come early, arrive before the start.', 'Wed 10/14 at 9:00 pm')).toBe(false);
    // "standby" holds "by" inside a word, which is no limit.
    expect(statesDue('Subject: x\n\nWe are on standby Wed 10/14.', 'Wed 10/14')).toBe(false);
    expect(statesDue('Subject: x\n\nanything', null)).toBe(false);
  });
});
