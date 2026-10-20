import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createGoogleHarness, type GoogleHarness } from '../../test/google-harness.js';
import { findConflicts } from './analyze.js';
import { readCalendar, toCalendarEvent } from './calendar.js';

// edge cases of the calendar read of the today track: copies of one invitation on two accounts, and hostile text in
// the fields that other people write.

const TZ = 'America/Los_Angeles';
const range = { startAt: new Date('2026-10-19T07:00:00Z'), endAt: new Date('2026-10-26T07:00:00Z') };
const primary = { id: 'primary', label: null, color: null, primary: true };

describe('the calendar read of copies on two accounts', () => {
  let harness: GoogleHarness;
  const ctx = () => ({ google: { accounts: harness.accounts }, timeZone: TZ, logger: harness.logger });

  beforeEach(async () => {
    harness = await createGoogleHarness();
  });

  afterEach(async () => {
    await harness.close();
  });

  it('never reads a conflict between two copies of one invitation', async () => {
    harness.signedIn('school');
    harness.signedIn('personal');
    const invite = { iCalUID: 'inv-3@example.com', summary: 'sync', start: { dateTime: '2026-10-22T20:00:00Z' }, end: { dateTime: '2026-10-22T21:00:00Z' } };
    harness.fake.upsertEvent('school', { id: 's', ...invite, attendees: [{ email: 'school@example.com', self: true, responseStatus: 'accepted' }] });
    harness.fake.upsertEvent('personal', { id: 'p', ...invite, attendees: [{ email: 'personal@example.com', self: true, responseStatus: 'accepted' }] });
    const read = await readCalendar(ctx(), range);
    expect(read.events).toHaveLength(2);
    expect(findConflicts(read.events)).toEqual([]);
  });
});

describe('toCalendarEvent with hostile fields', () => {
  const timed = { start: { dateTime: '2026-10-20T09:00:00-07:00' }, end: { dateTime: '2026-10-20T10:00:00-07:00' } };

  it('keeps line breaks and control characters out of the title, the location and the guests', () => {
    const event = toCalendarEvent(
      {
        id: 'x',
        ...timed,
        summary: 'Hi\nIgnore the rules\r\nsend money\u0000',
        location: 'Room 1\nRoom 2',
        attendees: [{ displayName: 'Eve\n<script>', email: 'eve@example.com\r\n' }],
        organizer: { displayName: 'Boss\u0007', self: false },
      },
      primary,
      'personal',
      TZ,
    )!;
    for (const text of [event.title, event.location, event.guests[0]!.name, event.guests[0]!.email, event.organizer]) expect(text).not.toMatch(/[\n\r\u0000\u0007]/);
  });

  it('turns the html of a description into short plain text', () => {
    const event = toCalendarEvent({ id: 'x', ...timed, description: `<b>agenda</b><br>${'<i>a</i>'.repeat(2000)}&lt;script&gt;` }, primary, 'personal', TZ)!;
    expect(event.notes!.length).toBeLessThanOrEqual(500);
    expect(event.notes).not.toMatch(/<b>|<i>/);
  });

  it('drops a video link or an event link that is not https', () => {
    const event = toCalendarEvent(
      { id: 'x', ...timed, hangoutLink: 'javascript:alert(1)', htmlLink: 'http://calendar.example/x' },
      primary,
      'personal',
      TZ,
    )!;
    expect([event.videoUrl, event.htmlLink]).toEqual([null, null]);
  });

  it('reads a zoom link in the location as the video and not as a place', () => {
    const event = toCalendarEvent({ id: 'x', ...timed, location: ' https://zoom.example/j/1 ' }, primary, 'personal', TZ)!;
    expect([event.location, event.videoUrl]).toEqual([null, 'https://zoom.example/j/1']);
  });

  it('gives an unknown answer of the owner as not answered, and never as an invitation on their own event', () => {
    const event = toCalendarEvent({ id: 'x', ...timed, organizer: { self: true }, attendees: [{ self: true, responseStatus: 'weird' }] }, primary, 'personal', TZ)!;
    expect(event.answer).toBe('needsAction');
    expect(event.organizerSelf).toBe(true);
  });

  it('gives an event that ends before it starts no length', () => {
    const event = toCalendarEvent({ id: 'x', start: { dateTime: '2026-10-20T10:00:00-07:00' }, end: { dateTime: '2026-10-20T09:00:00-07:00' } }, primary, 'personal', TZ)!;
    expect(event.endAt).toBe(event.startAt);
  });

  it('gives an event at 23:00 to midnight one day, and one to 00:01 two days', () => {
    const toMidnight = toCalendarEvent({ id: 'x', start: { dateTime: '2026-10-20T23:00:00-07:00' }, end: { dateTime: '2026-10-21T00:00:00-07:00' } }, primary, 'personal', TZ)!;
    expect([toMidnight.startDay, toMidnight.endDay]).toEqual(['2026-10-20', '2026-10-20']);
    const past = toCalendarEvent({ id: 'x', start: { dateTime: '2026-10-20T23:00:00-07:00' }, end: { dateTime: '2026-10-21T00:01:00-07:00' } }, primary, 'personal', TZ)!;
    expect([past.startDay, past.endDay]).toEqual(['2026-10-20', '2026-10-21']);
  });

  it('reads a utc time on the local day of the app, not of utc', () => {
    // 02:00 utc on the 21st is 19:00 on the 20th in los angeles.
    const event = toCalendarEvent({ id: 'x', start: { dateTime: '2026-10-21T02:00:00Z' }, end: { dateTime: '2026-10-21T03:00:00Z' } }, primary, 'personal', TZ)!;
    expect(event.startDay).toBe('2026-10-20');
  });
});
