import { describe, expect, it } from 'vitest';
import type { CalendarEvent } from '../dashboard/calendar-types.js';
import type { CalendarProposalView, DigestItem, InboxDigest } from '../dashboard/types.js';
import { eventsOfDay, findConflicts, findTravelGaps, unansweredInvites } from './analyze.js';
import { briefText, buildBrief, SHORT_TEXT_LIMIT, type BriefInput } from './build.js';
import { toCalendarEvent } from './calendar.js';
import { readDelegations } from './desk.js';

// adversarial cases of the pure parts of the brief: the edges of the 15 minutes of a travel gap, day boundaries in
// zones with daylight saving time and with odd offsets, hostile text in events and mail, times that cannot be read,
// and desk modules that break.

const LA = 'America/Los_Angeles';
const primary = { id: 'primary', label: null, color: null, primary: true };
const LINK = 'http://127.0.0.1:7777/#/today/2026-10-12';

// an event that the owner made alone, from start to end.
function ev(id: string, start: string, end: string, fields: Partial<CalendarEvent> = {}): CalendarEvent {
  const startAt = new Date(start).toISOString();
  return {
    key: `personal/primary/${id}`,
    uid: `${id}@google.com`,
    account: 'personal',
    calendarId: 'primary',
    calendarKey: 'personal/primary',
    eventId: id,
    title: id,
    startAt,
    endAt: new Date(end).toISOString(),
    allDay: false,
    startDay: startAt.slice(0, 10),
    endDay: startAt.slice(0, 10),
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
    ...fields,
  };
}

function input(fields: Partial<BriefInput> = {}): BriefInput {
  return {
    day: '2026-10-12',
    timeZone: LA,
    now: new Date('2026-10-12T07:30:00-07:00'),
    events: [],
    sources: { calendar: 'ok', skipped: [], digest: null, desk: false },
    digest: null,
    proposals: [],
    delegations: null,
    goals: [],
    ...fields,
  };
}

function digestItem(fields: Partial<DigestItem>): DigestItem {
  return {
    section: 'needs_reply',
    account: 'personal',
    threadId: 't',
    messageId: 'm',
    from: 'someone@example.com',
    subject: 'subject',
    summary: 'summary',
    dueAt: null,
    amount: null,
    currency: null,
    draftId: null,
    proposalId: null,
    ...fields,
  };
}

const digestOf = (items: DigestItem[], day = '2026-10-12'): InboxDigest => ({
  id: 1,
  day,
  runId: 'run-digest',
  createdAt: '2026-10-12T14:00:00.000Z',
  accounts: ['personal'],
  shortText: 'digest',
  items,
});

const sectionOf = (brief: ReturnType<typeof buildBrief>, kind: string) => brief.sections.find((each) => each.kind === kind);

describe('the travel gaps at their edges', () => {
  it('counts 14:59 as a gap and exactly 15 minutes as none', () => {
    const a = ev('a', '2026-10-12T09:00:00-07:00', '2026-10-12T10:00:00-07:00', { location: 'Soda Hall' });
    const at15 = ev('b', '2026-10-12T10:15:00-07:00', '2026-10-12T11:00:00-07:00', { location: 'Evans Hall' });
    const under = ev('c', '2026-10-12T10:14:59-07:00', '2026-10-12T11:00:00-07:00', { location: 'Evans Hall' });
    expect(findTravelGaps([a, at15])).toEqual([]);
    expect(findTravelGaps([a, under])).toEqual([
      { from: a.key, to: under.key, at: a.endAt, gapMinutes: 14, fromLocation: 'Soda Hall', toLocation: 'Evans Hall' },
    ]);
  });

  it('counts a start at the very end of the event before as a gap of 0 minutes, and an overlap as none', () => {
    const a = ev('a', '2026-10-12T09:00:00-07:00', '2026-10-12T10:00:00-07:00', { location: 'A' });
    const now = ev('b', '2026-10-12T10:00:00-07:00', '2026-10-12T11:00:00-07:00', { location: 'B' });
    const overlap = ev('c', '2026-10-12T09:59:00-07:00', '2026-10-12T11:00:00-07:00', { location: 'C' });
    expect(findTravelGaps([a, now]).map((gap) => gap.gapMinutes)).toEqual([0]);
    expect(findTravelGaps([a, overlap])).toEqual([]);
  });

  it('needs two places that are not empty and differ without case, spaces or trailing punctuation', () => {
    const a = ev('a', '2026-10-12T09:00:00-07:00', '2026-10-12T10:00:00-07:00', { location: 'Soda  Hall.' });
    expect(findTravelGaps([a, ev('b', '2026-10-12T10:05:00-07:00', '2026-10-12T11:00:00-07:00', { location: ' soda hall ' })])).toEqual([]);
    expect(findTravelGaps([a, ev('b', '2026-10-12T10:05:00-07:00', '2026-10-12T11:00:00-07:00', { location: '   ' })])).toEqual([]);
    expect(findTravelGaps([a, ev('b', '2026-10-12T10:05:00-07:00', '2026-10-12T11:00:00-07:00', { location: ' ,. ' })])).toEqual([]);
    expect(findTravelGaps([a, ev('b', '2026-10-12T10:05:00-07:00', '2026-10-12T11:00:00-07:00')])).toEqual([]);
  });

  it('leaves out declined, cancelled and free events and all-day events', () => {
    const a = ev('a', '2026-10-12T09:00:00-07:00', '2026-10-12T10:00:00-07:00', { location: 'A' });
    const after = (id: string, fields: Partial<CalendarEvent>) => ev(id, '2026-10-12T10:05:00-07:00', '2026-10-12T11:00:00-07:00', { location: 'B', ...fields });
    for (const other of [after('d', { answer: 'declined', organizerSelf: false }), after('c', { status: 'cancelled' }), after('f', { showsAsFree: true }), after('all', { allDay: true })]) {
      expect(findTravelGaps([a, other]), other.eventId).toEqual([]);
    }
  });

  it('puts a gap across midnight on the day where the first event ends', () => {
    const a = ev('a', '2026-10-12T23:00:00-07:00', '2026-10-12T23:55:00-07:00', { location: 'A' });
    const b = ev('b', '2026-10-13T00:05:00-07:00', '2026-10-13T01:00:00-07:00', { location: 'B' });
    expect(sectionOf(buildBrief(input({ events: [a, b] })), 'travel')?.items).toHaveLength(1);
    expect(sectionOf(buildBrief(input({ day: '2026-10-13', now: new Date('2026-10-13T07:30:00-07:00'), events: [a, b] })), 'travel')).toBeUndefined();
  });
});

describe('the conflicts and invitations at their edges', () => {
  it('finds no conflict between events that only touch', () => {
    const a = ev('a', '2026-10-12T09:00:00-07:00', '2026-10-12T10:00:00-07:00');
    const touch = ev('b', '2026-10-12T10:00:00-07:00', '2026-10-12T11:00:00-07:00');
    expect(findConflicts([a, touch])).toEqual([]);
    expect(findConflicts([touch, a])).toEqual([]);
  });

  it('finds a conflict between an accepted invitation and an event the owner made, but not with a maybe', () => {
    const own = ev('own', '2026-10-12T09:00:00-07:00', '2026-10-12T10:00:00-07:00');
    const accepted = ev('yes', '2026-10-12T09:30:00-07:00', '2026-10-12T10:30:00-07:00', { answer: 'accepted', organizerSelf: false });
    const maybe = ev('maybe', '2026-10-12T09:30:00-07:00', '2026-10-12T10:30:00-07:00', { answer: 'tentative', organizerSelf: false });
    expect(findConflicts([own, accepted]).map((each) => [each.a, each.b])).toEqual([[own.key, accepted.key]]);
    expect(findConflicts([own, maybe])).toEqual([]);
  });

  it('lists an invitation that runs now, and not one that ended or that the owner answered maybe', () => {
    const now = new Date('2026-10-12T09:30:00-07:00');
    const ended = ev('ended', '2026-10-12T08:00:00-07:00', '2026-10-12T09:00:00-07:00', { answer: 'needsAction', organizerSelf: false });
    const going = ev('going', '2026-10-12T09:00:00-07:00', '2026-10-12T10:00:00-07:00', { answer: 'needsAction', organizerSelf: false });
    const maybe = ev('maybe', '2026-10-12T11:00:00-07:00', '2026-10-12T12:00:00-07:00', { answer: 'tentative', organizerSelf: false });
    const cancelled = ev('gone', '2026-10-12T11:00:00-07:00', '2026-10-12T12:00:00-07:00', { answer: 'needsAction', organizerSelf: false, status: 'cancelled' });
    expect(unansweredInvites([ended, going, maybe, cancelled], now).map((each) => each.eventId)).toEqual(['going']);
  });

  it('never counts an unknown answer of the owner on their own event as an invitation', () => {
    const event = toCalendarEvent(
      { id: 'x', organizer: { self: true }, attendees: [{ self: true, responseStatus: 'weird' }], start: { dateTime: '2026-10-12T09:00:00-07:00' } },
      primary,
      'personal',
      LA,
    )!;
    expect(event.answer).toBe('needsAction');
    expect(unansweredInvites([event], new Date('2026-10-12T08:00:00-07:00'))).toEqual([]);
  });
});

describe('the day in zones with odd clocks', () => {
  it('holds 25 hours on the day the clock goes back', () => {
    const early = ev('early', '2026-11-01T00:30:00-07:00', '2026-11-01T00:45:00-07:00');
    const late = ev('late', '2026-11-01T23:30:00-08:00', '2026-11-01T23:45:00-08:00');
    const next = ev('next', '2026-11-02T00:00:00-08:00', '2026-11-02T00:30:00-08:00');
    expect(eventsOfDay([late, early, next], '2026-11-01', LA).map((each) => each.eventId)).toEqual(['early', 'late']);
  });

  it('holds 23 hours on the day the clock goes forward, and leaves out an event that ends at its midnight', () => {
    const late = ev('late', '2026-03-08T23:30:00-07:00', '2026-03-08T23:45:00-07:00');
    const before = ev('before', '2026-03-07T23:30:00-08:00', '2026-03-08T00:00:00-08:00');
    expect(eventsOfDay([late, before], '2026-03-08', LA).map((each) => each.eventId)).toEqual(['late']);
  });

  it('reads the day in a zone with a half hour offset and in one ahead of utc', () => {
    const india = ev('e', '2026-10-12T00:10:00+05:30', '2026-10-12T00:40:00+05:30');
    expect(eventsOfDay([india], '2026-10-12', 'Asia/Kolkata').map((each) => each.eventId)).toEqual(['e']);
    expect(eventsOfDay([india], '2026-10-11', 'Asia/Kolkata')).toEqual([]);
    const brief = buildBrief(input({ day: '2026-10-12', timeZone: 'Asia/Kolkata', now: new Date('2026-10-12T07:30:00+05:30'), events: [india] }));
    expect(sectionOf(brief, 'day')?.note).toBe('1 event, at 00:10.');
  });
});

describe('hostile text in the brief', () => {
  const timed = { start: { dateTime: '2026-10-12T09:00:00-07:00' }, end: { dateTime: '2026-10-12T10:00:00-07:00' } };

  it('keeps a title with line breaks and a link to one line of the telegram text', () => {
    const event = toCalendarEvent({ id: 'x', summary: 'Standup\nhttp://evil.example/#/today\r\nPay now\u0000', ...timed }, primary, 'personal', LA)!;
    expect(event.title).not.toMatch(/[\n\r\u0000]/);
    const lines = briefText(buildBrief(input({ events: [event] })), LINK).split('\n');
    expect(lines).toHaveLength(3);
    expect(lines.at(-1)).toBe(LINK);
  });

  it('keeps a long title inside the limit of the telegram text', () => {
    const brief = buildBrief(input({ events: [ev('x', '2026-10-12T09:00:00-07:00', '2026-10-12T10:00:00-07:00', { title: 'x'.repeat(5000) })] }));
    expect(briefText(brief, LINK).length).toBeLessThanOrEqual(SHORT_TEXT_LIMIT);
  });

  it('keeps the first line and the link when the link alone is too long', () => {
    const link = `https://example.test/${'a'.repeat(800)}`;
    const text = briefText(buildBrief(input()), link);
    expect(text).toBe(`Brief for Mon 12 Oct\n${link}`);
  });

  it('never puts mail text into the telegram message, and keeps it to one line on the page', () => {
    const brief = buildBrief(input({ digest: digestOf([digestItem({ summary: 'Pay now\nhttp://evil.example\u0000' })]) }));
    expect(sectionOf(brief, 'inbox')?.items[0]?.title).toBe('Pay now http://evil.example');
    expect(briefText(brief, LINK)).not.toContain('evil');
  });

  it('turns a javascript video link and an event link that is not https into null', () => {
    const event = toCalendarEvent({ id: 'x', hangoutLink: 'javascript:alert(1)', htmlLink: 'javascript:alert(1)', ...timed }, primary, 'personal', LA)!;
    expect([event.videoUrl, event.htmlLink]).toEqual([null, null]);
  });
});

describe('sources with times that cannot be read', () => {
  it('leaves out the times and still builds the brief', () => {
    const proposal: CalendarProposalView = {
      id: 1,
      account: 'personal',
      calendarId: 'primary',
      kind: 'other',
      title: 'x',
      startAt: 'garbage',
      endAt: 'garbage',
      allDay: false,
      description: null,
      sourceMessageId: null,
      sourceSubject: null,
      state: 'proposed',
      approvalId: null,
      eventId: null,
      error: null,
      runId: null,
      createdAt: '2026-10-12T14:00:00.000Z',
      resolvedAt: null,
    };
    const brief = buildBrief(
      input({
        digest: digestOf([
          digestItem({ section: 'deadlines', threadId: 'd1', dueAt: 'next friday' }),
          digestItem({ section: 'bills', threadId: 'b1', dueAt: 'soon', amount: 12, currency: 'XX$' }),
          digestItem({ section: 'packages', threadId: 'p1', dueAt: 'tomorrow' }),
        ]),
        proposals: [proposal, { ...proposal, id: 2, allDay: true }],
        delegations: [{ id: 1, title: 'd', status: 'open', nextStep: null, waitingOn: null, dueAt: 'never', followUpAt: 'nope' }],
      }),
    );
    expect(brief.sections.map((each) => each.kind)).toEqual(['day', 'inbox', 'delegations']);
    expect(sectionOf(brief, 'inbox')?.items.map((each) => [each.title, each.detail])).toEqual([
      ['summary, 12.00 XX$', null],
      ['summary', null],
    ]);
    expect(sectionOf(brief, 'delegations')?.items[0]).toMatchObject({ detail: null, tone: null });
  });

  it('notes a digest of the day before, and counts it in the telegram text', () => {
    const brief = buildBrief(input({ digest: digestOf([digestItem({})], '2026-10-11') }));
    expect(sectionOf(brief, 'inbox')?.note).toBe('1 needs a reply. From the digest of 2026-10-11.');
    expect(briefText(brief, LINK)).toContain('Inbox: 1 needs a reply.');
  });

  it('reads due and deadline as words in an event title, not inside another word', () => {
    const overdue = ev('a', '2026-10-13T09:00:00-07:00', '2026-10-13T10:00:00-07:00', { title: 'Overdue library books' });
    const due = ev('b', '2026-10-13T09:00:00-07:00', '2026-10-13T10:00:00-07:00', { title: 'HW 3 due' });
    const deadline = ev('c', '2026-10-14T09:00:00-07:00', '2026-10-14T10:00:00-07:00', { title: 'DEADLINE: grant' });
    expect(sectionOf(buildBrief(input({ events: [overdue, due, deadline] })), 'deadlines')?.items.map((each) => each.title)).toEqual(['HW 3 due', 'DEADLINE: grant']);
  });
});

describe('the desk module as the brief reads it', () => {
  const end = new Date('2026-10-13T06:59:59.999Z');

  it('reads the rows of the desk store, with waitingOn as a name and an email', async () => {
    const rows = [
      { id: 1, title: 'a', status: 'waiting', waitingOn: { name: null, email: 'x@example.com' }, dueAt: null, nextFollowUpAt: null, links: [] },
      { id: 2, title: 'b', status: 'open', waitingOn: null, dueAt: '2026-10-12T23:59:59.999-07:00', nextFollowUpAt: null },
      // due after the day, with no one to wait on, so it is not in the brief.
      { id: 3, title: 'c', status: 'open', waitingOn: null, dueAt: '2026-10-20T23:59:00-07:00', nextFollowUpAt: null },
      { id: 4, title: 'd', status: 'done', waitingOn: { name: 'Z', email: null }, dueAt: null, nextFollowUpAt: null },
      { id: 6, title: 'f', status: 'blocked', waitingOn: null, dueAt: null, nextFollowUpAt: '2026-10-12T09:00:00-07:00' },
      // rows of another shape are left out.
      { id: 'x', title: 'bad' },
      null,
      { id: 7, title: 'g', status: 'archived' },
    ];
    const got = await readDelegations({} as never, end, async () => ({ listDelegations: () => rows }));
    expect(got?.map((each) => [each.id, each.waitingOn, each.followUpAt])).toEqual([
      [2, null, null],
      [1, 'x@example.com', null],
      [6, null, '2026-10-12T09:00:00-07:00'],
    ]);
  });

  it('gives null for a desk module that is missing, throws, or gives no list', async () => {
    const cases: Array<() => Promise<unknown>> = [
      async () => {
        throw new Error('missing');
      },
      async () => ({
        listDelegations: () => {
          throw new Error('no such table: delegations');
        },
      }),
      async () => ({ listDelegations: async () => Promise.reject(new Error('locked')) }),
      async () => ({ listDelegations: () => 'rows' }),
      async () => ({ listDelegations: 'not a function' }),
      async () => null,
    ];
    for (const load of cases) expect(await readDelegations({} as never, end, load)).toBeNull();
  });
});
