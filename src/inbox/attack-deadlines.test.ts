import { describe, expect, it } from 'vitest';
import { checkDue, findDates, parseDue, type DueInput } from './deadlines.js';

// tests that try to break the due date check: dates at the edge of a year, a month and a change of the clock, words
// that a model copied badly, hostile text and time zones that the platform does not know. a due date must never
// hold a day that the mail does not state.

const TZ = 'America/Los_Angeles';

const due = (input: Partial<DueInput> & Pick<DueInput, 'text'>) =>
  checkDue({ dueAt: null, dueText: null, sentAt: '2026-10-20T16:00:00Z', timeZone: TZ, ...input });

describe('the due check across the edges of the calendar', () => {
  it('reads a date without a year in a mail of late december as the next year', () => {
    const got = due({ text: 'Subject: rent\n\nThe rent is due Jan 3.', dueAt: '2027-01-03', dueText: 'due Jan 3', sentAt: '2026-12-28T18:00:00Z' });
    expect(got).toEqual({ ok: true, due: { at: '2027-01-03T08:00:00.000Z', allDay: true, dueText: 'due Jan 3' } });
  });

  it('drops a due date that puts a date without a year in the year of the mail when that day has passed', () => {
    const got = due({ text: 'Subject: rent\n\nThe rent is due Jan 3.', dueAt: '2026-01-03', dueText: 'due Jan 3', sentAt: '2026-12-28T18:00:00Z' });
    expect(got.ok).toBe(false);
  });

  it('finds no date in february 29 of a year that is not a leap year, and finds it in a leap year', () => {
    expect(findDates('Due Feb 29, 2027', '2026-10-20T16:00:00Z', TZ)).toEqual([]);
    expect(findDates('Due Feb 29, 2028', '2026-10-20T16:00:00Z', TZ).map((each) => each.day)).toEqual(['2028-02-29']);
    expect(parseDue('2027-02-29', TZ)).toBeNull();
  });

  it('keeps a time in the hour that the clock repeats when it falls back', () => {
    const got = due({ text: 'Subject: x\n\nThe form closes Nov 1 at 1:30am.', dueAt: '2026-11-01T01:30:00-07:00', dueText: 'Nov 1 at 1:30am' });
    expect(got).toMatchObject({ ok: true, due: { allDay: false } });
    if (got.ok) expect(got.due.at.slice(0, 10)).toBe('2026-11-01');
  });

  it('reads 11:59 pm pacific on a day as that day, also when utc is already the next day', () => {
    const got = due({ text: 'Subject: hw\n\nHomework 4 is due Oct 24 at 11:59 PM PT.', dueAt: '2026-10-25T06:59:00Z', dueText: 'due Oct 24 at 11:59 PM PT' });
    expect(got).toEqual({ ok: true, due: { at: '2026-10-25T06:59:00.000Z', allDay: false, dueText: 'due Oct 24 at 11:59 PM PT' } });
  });

  it('drops a due time whose local day is not the day of the words', () => {
    // 2026-10-24T01:00Z is still october 23 in los angeles.
    const got = due({ text: 'Subject: hw\n\nDue Oct 24.', dueAt: '2026-10-24T01:00:00Z', dueText: 'Due Oct 24' });
    expect(got).toEqual({ ok: false, why: 'other_day' });
  });

  it('reads a relative day from the local day of the mail, not from its utc day', () => {
    // 2026-10-21T05:00Z is the evening of october 20 in los angeles, so tomorrow is october 21.
    const got = due({ text: 'Subject: x\n\nPlease send it tomorrow.', dueAt: '2026-10-21', dueText: 'tomorrow', sentAt: '2026-10-21T05:00:00Z' });
    expect(got).toMatchObject({ ok: true, due: { at: '2026-10-21T07:00:00.000Z', allDay: true } });
    const wrong = due({ text: 'Subject: x\n\nPlease send it tomorrow.', dueAt: '2026-10-22', dueText: 'tomorrow', sentAt: '2026-10-21T05:00:00Z' });
    expect(wrong).toEqual({ ok: false, why: 'other_day' });
  });
});

describe('the due check against bad input', () => {
  it('drops a due date of a time zone that the platform does not know, and does not throw', () => {
    const got = due({ text: 'Subject: x\n\nDue Oct 24.', dueAt: '2026-10-24', dueText: 'Due Oct 24', timeZone: 'Mars/Olympus_Mons' });
    expect(got.ok).toBe(false);
    expect(findDates('Due Oct 24 tomorrow', '2026-10-20T16:00:00Z', 'Mars/Olympus_Mons')).toBeInstanceOf(Array);
  });

  it('drops a due date when the time of the mail does not parse, for a relative day', () => {
    const got = due({ text: 'Subject: x\n\nDue tomorrow.', dueAt: '2026-10-21', dueText: 'Due tomorrow', sentAt: 'not a date' });
    expect(got.ok).toBe(false);
  });

  it('drops a due date in a form that is not iso, also when the words state a date', () => {
    for (const dueAt of ['Oct 24', '10/24/2026', '2026-10-24 17:00', '2026-10-24T17:00', '2026-13-01', '2026-10-24T25:00:00Z', '']) {
      const got = due({ text: 'Subject: x\n\nDue Oct 24.', dueAt, dueText: 'Due Oct 24' });
      expect(got.ok, dueAt).toBe(false);
    }
  });

  it('drops words that hold no letter or digit', () => {
    expect(due({ text: 'Subject: x\n\nDue Oct 24.', dueAt: '2026-10-24', dueText: ' ... ' })).toMatchObject({ ok: false });
    expect(due({ text: 'Subject: x\n\nDue Oct 24.', dueAt: '2026-10-24', dueText: '' })).toEqual({ ok: false, why: 'no_words' });
  });

  it('matches words across the line breaks of a mail with windows line endings', () => {
    const got = due({ text: 'Subject: x\r\n\r\nThe essay is due\r\nOct 24.', dueAt: '2026-10-24', dueText: 'due Oct 24' });
    expect(got).toMatchObject({ ok: true, due: { allDay: true } });
  });

  it('never reads the date of the Date header as evidence', () => {
    const text = 'From: a <a@x.example>\nSubject: hello\nDate: 2026-10-20T16:00:00.000Z\nKind: person\n\nHow are you?';
    expect(due({ text, dueAt: '2026-10-20', dueText: '2026-10-20' })).toEqual({ ok: false, why: 'words_not_in_mail' });
  });

  it('keeps the time of the model only when the words state one', () => {
    const got = due({ text: 'Subject: x\n\nThe form closes Oct 24.', dueAt: '2026-10-24T17:00:00-07:00', dueText: 'closes Oct 24' });
    expect(got).toEqual({ ok: true, due: { at: '2026-10-24T07:00:00.000Z', allDay: true, dueText: 'closes Oct 24' } });
  });
});

describe('the due check against hostile text', () => {
  it('reads a mail of many thousands of dates and weekday names in linear time', () => {
    const text = 'Due Friday, Oct 24 at 5pm PT. '.repeat(20_000) + 'Mon Tue Wed '.repeat(20_000);
    const started = performance.now();
    const found = findDates(text, '2026-10-20T16:00:00Z', TZ);
    expect(performance.now() - started).toBeLessThan(3000);
    expect(found.length).toBeLessThanOrEqual(2000);
  });

  it('reads long runs of digits, slashes and colons without a blow-up', () => {
    const text = `${'1/'.repeat(50_000)} ${'12:'.repeat(50_000)} ${'2026-'.repeat(30_000)}`;
    const started = performance.now();
    findDates(text, '2026-10-20T16:00:00Z', TZ);
    expect(performance.now() - started).toBeLessThan(3000);
  });

  it('does not find a date in words that only look like one', () => {
    expect(findDates('Version 10.24 is out, call 555-1024, ticket 2026-1024', '2026-10-20T16:00:00Z', TZ).map((each) => each.day)).not.toContain('2026-10-24');
    expect(findDates('13/14 and 0/5 and 2/30', '2026-10-20T16:00:00Z', TZ)).toEqual([]);
  });

  it('drops words that the mail holds only with the digits joined differently', () => {
    // the model wrote "10/24" for the text "10 24", which states no date.
    const got = due({ text: 'Subject: x\n\nRoom 10 24 people.', dueAt: '2026-10-24', dueText: '10/24' });
    expect(got.ok).toBe(false);
  });
});
