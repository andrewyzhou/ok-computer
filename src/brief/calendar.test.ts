import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createGoogleHarness, type GoogleHarness } from '../../test/google-harness.js';
import type { CalendarEvent } from '../dashboard/calendar-types.js';
import { CALENDAR_PALETTE, calendarColor, readCalendar, toCalendarEvent } from './calendar.js';

const TZ = 'America/Los_Angeles';
const primary = { id: 'primary', label: null, color: null, primary: true };
const range = { startAt: new Date('2026-10-19T07:00:00Z'), endAt: new Date('2026-10-26T07:00:00Z') };

// the fields that most events share, so each test names only what it changes.
const base = (over: Partial<CalendarEvent>): CalendarEvent => ({
  key: 'personal/primary/e1',
  uid: null,
  account: 'personal',
  calendarId: 'primary',
  calendarKey: 'personal/primary',
  eventId: 'e1',
  title: '(no title)',
  startAt: '',
  endAt: '',
  allDay: false,
  startDay: '',
  endDay: '',
  location: null,
  videoUrl: null,
  status: 'confirmed',
  answer: null,
  organizerSelf: true,
  organizer: null,
  guests: [],
  showsAsFree: false,
  recurring: false,
  notes: null,
  htmlLink: null,
  ...over,
});

describe('calendarColor', () => {
  it('keeps a google hex color in lower case', () => {
    expect(calendarColor('#9FE1E7', 'personal/primary')).toBe('#9fe1e7');
  });

  it('picks a stable palette color for a missing or odd color', () => {
    const picked = calendarColor(null, 'school/cs189-class');
    expect(CALENDAR_PALETTE).toContain(picked);
    expect(calendarColor('red', 'school/cs189-class')).toBe(picked);
    expect(calendarColor('#fff', 'school/cs189-class')).toBe(picked);
    // the palette spreads keys, so many keys use more than one color.
    const colors = new Set(Array.from({ length: 40 }, (_, i) => calendarColor(null, `a/${i}`)));
    expect(colors.size).toBeGreaterThan(3);
  });
});

describe('toCalendarEvent', () => {
  it('leaves out an event without an id or a start', () => {
    expect(toCalendarEvent({ start: { dateTime: '2026-10-20T16:00:00Z' } }, primary, 'personal', TZ)).toBeUndefined();
    expect(toCalendarEvent({ id: 'e1', start: {} }, primary, 'personal', TZ)).toBeUndefined();
    expect(toCalendarEvent({ id: 'e1' }, primary, 'personal', TZ)).toBeUndefined();
  });

  it('reads an all-day event over 3 days', () => {
    const event = toCalendarEvent({ id: 'e1', summary: '  retreat  ', start: { date: '2026-10-20' }, end: { date: '2026-10-23' } }, primary, 'personal', TZ);
    expect(event).toEqual(
      base({ title: 'retreat', allDay: true, startDay: '2026-10-20', endDay: '2026-10-22', startAt: '2026-10-20T07:00:00.000Z', endAt: '2026-10-23T07:00:00.000Z' }),
    );
  });

  it('reads an all-day event across the dst change', () => {
    const event = toCalendarEvent({ id: 'e1', start: { date: '2026-10-31' }, end: { date: '2026-11-02' } }, primary, 'personal', TZ)!;
    expect([event.startDay, event.endDay]).toEqual(['2026-10-31', '2026-11-01']);
    // midnight is at 7:00 utc before the change and at 8:00 utc after it.
    expect([event.startAt, event.endAt]).toEqual(['2026-10-31T07:00:00.000Z', '2026-11-02T08:00:00.000Z']);
  });

  it('gives an all-day event without a later end one day', () => {
    const event = toCalendarEvent({ id: 'e1', start: { date: '2026-10-20' }, end: { date: '2026-10-20' } }, primary, 'personal', TZ)!;
    expect([event.startDay, event.endDay, event.endAt]).toEqual(['2026-10-20', '2026-10-20', '2026-10-21T07:00:00.000Z']);
  });

  it('reads a timed event with no end as a point in time', () => {
    const event = toCalendarEvent({ id: 'e1', start: { dateTime: '2026-10-20T09:00:00-07:00' } }, primary, 'personal', TZ)!;
    expect([event.startAt, event.endAt, event.startDay, event.endDay]).toEqual(['2026-10-20T16:00:00.000Z', '2026-10-20T16:00:00.000Z', '2026-10-20', '2026-10-20']);
    const before = toCalendarEvent({ id: 'e1', start: { dateTime: '2026-10-20T16:00:00Z' }, end: { dateTime: '2026-10-20T15:00:00Z' } }, primary, 'personal', TZ)!;
    expect(before.endAt).toBe('2026-10-20T16:00:00.000Z');
  });

  it('ends an event that ends at midnight on the day before', () => {
    const event = toCalendarEvent({ id: 'e1', start: { dateTime: '2026-10-20T22:00:00-07:00' }, end: { dateTime: '2026-10-21T00:00:00-07:00' } }, primary, 'personal', TZ)!;
    expect([event.startDay, event.endDay]).toEqual(['2026-10-20', '2026-10-20']);
    const late = toCalendarEvent({ id: 'e1', start: { dateTime: '2026-10-20T22:00:00-07:00' }, end: { dateTime: '2026-10-21T01:00:00-07:00' } }, primary, 'personal', TZ)!;
    expect(late.endDay).toBe('2026-10-21');
  });

  it('moves a zoom link in the location to the video link', () => {
    const event = toCalendarEvent(
      { id: 'e1', start: { dateTime: '2026-10-20T16:00:00Z' }, end: { dateTime: '2026-10-20T17:00:00Z' }, location: ' https://zoom.example/j/123 ' },
      primary,
      'personal',
      TZ,
    )!;
    expect([event.location, event.videoUrl]).toEqual([null, 'https://zoom.example/j/123']);
  });

  it('drops a video link that is not http', () => {
    const event = toCalendarEvent({ id: 'e1', start: { dateTime: '2026-10-20T16:00:00Z' }, hangoutLink: 'javascript:alert(1)', htmlLink: 'http://calendar.example/e1' }, primary, 'personal', TZ)!;
    expect([event.videoUrl, event.htmlLink]).toEqual([null, null]);
  });

  it('reads an html description as plain text of at most 500 characters', () => {
    const event = toCalendarEvent(
      { id: 'e1', start: { dateTime: '2026-10-20T16:00:00Z' }, description: '<p>Agenda:</p><ul><li>budget &amp; plan</li><li>next   steps</li></ul><br>' },
      primary,
      'personal',
      TZ,
    )!;
    expect(event.notes).toBe('Agenda: budget & plan next steps');
    const long = toCalendarEvent({ id: 'e1', start: { dateTime: '2026-10-20T16:00:00Z' }, description: 'x'.repeat(900) }, primary, 'personal', TZ)!;
    expect(long.notes).toHaveLength(500);
    expect(toCalendarEvent({ id: 'e1', start: { dateTime: '2026-10-20T16:00:00Z' }, description: '<br>' }, primary, 'personal', TZ)!.notes).toBeNull();
  });

  it('reads the guests, the answer and the organizer of an invitation', () => {
    const event = toCalendarEvent(
      {
        id: 'e1',
        iCalUID: 'uid-1@example.com',
        summary: 'review',
        status: 'tentative',
        start: { dateTime: '2026-10-20T16:00:00Z' },
        end: { dateTime: '2026-10-20T17:00:00Z' },
        organizer: { email: 'boss@example.com', displayName: 'The Boss' },
        attendees: [
          { email: 'boss@example.com', organizer: true, responseStatus: 'accepted' },
          { email: 'personal@example.com', self: true },
          { email: 'room-1@resource.example', resource: true, responseStatus: 'accepted' },
          { email: 'pat@example.com', displayName: 'Pat', optional: true, responseStatus: 'declined' },
        ],
        location: 'Soda 380',
        transparency: 'transparent',
        recurringEventId: 'r1',
        htmlLink: 'https://calendar.example/e1',
      },
      primary,
      'personal',
      TZ,
    );
    expect(event).toEqual(
      base({
        uid: 'uid-1@example.com',
        title: 'review',
        status: 'tentative',
        startAt: '2026-10-20T16:00:00.000Z',
        endAt: '2026-10-20T17:00:00.000Z',
        startDay: '2026-10-20',
        endDay: '2026-10-20',
        location: 'Soda 380',
        answer: 'needsAction',
        organizerSelf: false,
        organizer: 'The Boss',
        guests: [
          { name: null, email: 'boss@example.com', answer: 'accepted', organizer: true, optional: false, self: false },
          { name: null, email: 'personal@example.com', answer: 'needsAction', organizer: false, optional: false, self: true },
          { name: 'Pat', email: 'pat@example.com', answer: 'declined', organizer: false, optional: true, self: false },
        ],
        showsAsFree: true,
        recurring: true,
        htmlLink: 'https://calendar.example/e1',
      }),
    );
  });

  it('counts an event with guests and no organizer as not organized by the owner', () => {
    const event = toCalendarEvent({ id: 'e1', start: { dateTime: '2026-10-20T16:00:00Z' }, attendees: [{ email: 'a@example.com' }] }, primary, 'personal', TZ)!;
    expect([event.organizerSelf, event.answer]).toEqual([false, null]);
  });
});

describe('readCalendar', () => {
  let harness: GoogleHarness;
  const ctx = () => ({ google: { accounts: harness.accounts }, timeZone: TZ, logger: harness.logger });

  beforeEach(async () => {
    harness = await createGoogleHarness();
  });

  afterEach(async () => {
    await harness.close();
  });

  const seed = () => {
    harness.fake.upsertEvent('personal', { id: 'p1', summary: 'dentist', start: { dateTime: '2026-10-20T17:00:00Z' }, end: { dateTime: '2026-10-20T18:00:00Z' }, organizer: { email: 'personal@example.com', self: true } });
    harness.fake.upsertEvent('personal', { id: 'p2', summary: 'trip', start: { date: '2026-10-21' }, end: { date: '2026-10-24' } });
    harness.fake.upsertEvent('school', { id: 's1', summary: 'office hours', start: { dateTime: '2026-10-20T17:00:00Z' }, end: { dateTime: '2026-10-20T18:00:00Z' } });
    harness.fake.addCalendar('school', {
      id: 'cs189-class',
      summary: 'CS 189 lectures',
      events: [{ id: 'c1', summary: 'lecture', start: { dateTime: '2026-10-20T16:00:00Z' }, end: { dateTime: '2026-10-20T17:00:00Z' }, location: 'Wheeler 150' }],
    });
  };

  it('says configured false without a google block', async () => {
    expect(await readCalendar({ timeZone: TZ, logger: harness.logger }, range)).toEqual({ configured: false, calendars: [], events: [], skipped: [] });
  });

  it('reads every shown calendar of every account, sorted by start and key', async () => {
    harness.signedIn('personal');
    harness.signedIn('school');
    seed();
    const read = await readCalendar(ctx(), range);
    expect(read.configured).toBe(true);
    expect(read.skipped).toEqual([]);
    expect(read.calendars).toEqual([
      { key: 'personal/primary', account: 'personal', calendarId: 'primary', label: 'personal', color: calendarColor(null, 'personal/primary'), primary: true },
      { key: 'school/primary', account: 'school', calendarId: 'primary', label: 'school', color: calendarColor(null, 'school/primary'), primary: true },
      { key: 'school/cs189-class', account: 'school', calendarId: 'cs189-class', label: 'CS 189 lectures', color: calendarColor(null, 'school/cs189-class'), primary: false },
    ]);
    expect(read.events.map((each) => each.key)).toEqual(['school/cs189-class/c1', 'personal/primary/p1', 'school/primary/s1', 'personal/primary/p2']);
    expect(read.events[0]).toEqual(
      base({
        key: 'school/cs189-class/c1',
        account: 'school',
        calendarId: 'cs189-class',
        calendarKey: 'school/cs189-class',
        eventId: 'c1',
        title: 'lecture',
        startAt: '2026-10-20T16:00:00.000Z',
        endAt: '2026-10-20T17:00:00.000Z',
        startDay: '2026-10-20',
        endDay: '2026-10-20',
        location: 'Wheeler 150',
        // the class calendar belongs to someone else, so its event is not one that the owner made.
        organizerSelf: false,
      }),
    );
    expect(read.events[3]).toMatchObject({ allDay: true, startDay: '2026-10-21', endDay: '2026-10-23', startAt: '2026-10-21T07:00:00.000Z', endAt: '2026-10-24T07:00:00.000Z' });
  });

  it('skips a signed-out account and still reads the other', async () => {
    harness.signedIn('school');
    seed();
    const read = await readCalendar(ctx(), range);
    expect(read.skipped).toEqual([
      { account: 'personal', reason: 'personal is not signed in: the personal google account is not signed in yet. The owner connects it on the dashboard.' },
    ]);
    expect(read.calendars.map((each) => each.key)).toEqual(['school/primary', 'school/cs189-class']);
    expect(read.events.map((each) => each.key)).toEqual(['school/cs189-class/c1', 'school/primary/s1']);
  });

  it('skips an account whose primary calendar fails with 500 and still reads the other', async () => {
    harness.signedIn('personal');
    harness.signedIn('school');
    seed();
    // the first read of a primary calendar fails, whichever account it is.
    harness.fake.fault({ route: 'GET /calendar/v3/calendars/primary/events', status: 500, echoAuth: true, times: 1 });
    const read = await readCalendar(ctx(), range);
    expect(read.skipped).toHaveLength(1);
    const failed = read.skipped[0]!;
    expect(failed.calendarId).toBeUndefined();
    expect(failed.reason).toMatch(new RegExp(`^${failed.account} could not be read: `));
    expect(failed.reason.length).toBeLessThanOrEqual(200);
    // the fault echoes the authorization header, and no token may reach the reason.
    expect(failed.reason).not.toMatch(/ya29|fake-access/);
    expect(failed.reason).toContain('[redacted]');
    const other = failed.account === 'school' ? 'personal' : 'school';
    expect(read.calendars.every((each) => each.account === other)).toBe(true);
    expect(read.events.length).toBeGreaterThan(0);
    expect(read.events.every((each) => each.account === other)).toBe(true);
  });

  it('notes one shared calendar that fails and still reads the rest of its account', async () => {
    harness.signedIn('personal');
    harness.signedIn('school');
    seed();
    harness.fake.fault({ route: 'GET /calendar/v3/calendars/cs189-class/events', status: 500, echoAuth: true });
    const read = await readCalendar(ctx(), range);
    expect(read.skipped).toEqual([{ account: 'school', calendarId: 'cs189-class', reason: 'school: The calendar CS 189 lectures could not be read.' }]);
    expect(read.calendars.map((each) => each.key)).toEqual(['personal/primary', 'school/primary', 'school/cs189-class']);
    expect(read.events.map((each) => each.key)).toEqual(['personal/primary/p1', 'school/primary/s1', 'personal/primary/p2']);
  });

  it('gives no events and skips every alias when every account fails', async () => {
    harness.signedIn('personal');
    harness.signedIn('school');
    seed();
    harness.fake.fault({ route: 'GET /calendar/v3/calendars/primary/events', status: 500 });
    const read = await readCalendar(ctx(), range);
    expect(read).toMatchObject({ configured: true, calendars: [], events: [] });
    expect(read.skipped.map((each) => each.account)).toEqual(['personal', 'school']);
    for (const each of read.skipped) expect(each.reason).toMatch(new RegExp(`^${each.account} could not be read: .*500`));
  });

  it('keeps one copy of an invitation on the shared and the primary calendar of one account', async () => {
    harness.signedIn('personal');
    harness.signedIn('school');
    const invite = { iCalUID: 'inv-1@example.com', summary: 'section', start: { dateTime: '2026-10-22T20:00:00Z' }, end: { dateTime: '2026-10-22T21:00:00Z' } };
    harness.fake.upsertEvent('school', { id: 'inv-primary', ...invite, attendees: [{ email: 'school@example.com', self: true, responseStatus: 'needsAction' }] });
    harness.fake.addCalendar('school', { id: 'cs189-class', summary: 'CS 189 lectures', events: [{ id: 'inv-shared', ...invite }] });
    // the personal account got the same invitation, and the analysis, not the read, joins copies across accounts.
    harness.fake.upsertEvent('personal', { id: 'inv-personal', ...invite });
    const read = await readCalendar(ctx(), range);
    expect(read.events.map((each) => each.key)).toEqual(['personal/primary/inv-personal', 'school/primary/inv-primary']);
    expect(read.events[1]).toMatchObject({ uid: 'inv-1@example.com', answer: 'needsAction', calendarKey: 'school/primary' });
  });

  it('leaves out an event without an id from a calendar', async () => {
    harness.signedIn('school');
    harness.fake.addCalendar('school', {
      id: 'cs189-class',
      summary: 'CS 189 lectures',
      events: [{ id: '', summary: 'broken', start: { dateTime: '2026-10-20T16:00:00Z' }, end: { dateTime: '2026-10-20T17:00:00Z' } }],
    });
    const read = await readCalendar(ctx(), range);
    expect(read.events).toEqual([]);
  });
});
