import type { Brief, BriefContent, BriefSchedule, BriefsPage } from '../../src/dashboard/brief-types.js';
import type { CalendarEvent, CalendarInfo, CalendarPage, CalendarProposalBlock } from '../../src/dashboard/calendar-types.js';

// the shared data of the today track (phase 6 t1): one week of calendar events and the briefs that go with them. the
// route tests, the seeded dashboard (test/seed-today.ts), the screenshots and the web tests all read it, so a test may
// depend on each id, time and count that the comments name. this file imports types only, so the web tests can import
// it too.
//
// the week starts on monday 2026-10-12 in America/Los_Angeles (pdt, utc-7), the day of test/seed.ts. the accounts are
// personal and school. the calendars are personal/primary, school/primary and the shared class calendar
// school/cs189@group.calendar.google.com.
//
// the events of monday 2026-10-12 (local time):
//   run      07:00-07:45 personal  Memorial Glade      the owner's own event
//   lab      09:00-10:00 school    Soda Hall 510       accepted
//   lecture  10:05-11:30 school/cs189 Wheeler 150      not invited (a class calendar). travel gap of 5 minutes after lab
//   coffee   11:00-11:45 personal  Free Speech Cafe    accepted. overlaps the lecture, but the lecture is not the
//                                                      owner's, so it is no conflict
//   talk     12:00-13:00 school    Banatao Auditorium  declined, so it is not on the day
//   focus    13:00-14:00 personal  none                the owner's own, shows as free
//   advisor  14:00-14:30 school    video only          accepted
//   dentist  14:15-15:00 personal  2650 Telegraph Ave  the owner's own. conflict with advisor from 14:15 to 14:30
//   reading  16:00-17:00 school    Moffitt 101         not answered (invite 1)
//   social   18:00-19:00 personal and school, one invitation (uid club-social) on both accounts, accepted on both. the
//                                                      two copies are no conflict
//   birthday all day     personal                      the owner's own
// later in the week:
//   office hours tue 10-13 15:00-16:00 school accepted
//   homework     thu 10-15 all day school/cs189 "Homework 3 due" (a deadline)
//   dinner       thu 10-15 19:00-21:00 personal not answered (invite 2)
// proposal 7: "Problem set 4 due", school, all day on wed 10-14, waiting for approval 11.

export const TODAY_DAY = '2026-10-12';
export const TODAY_TZ = 'America/Los_Angeles';
// 07:30 local, the time of the brief.
export const TODAY_NOW = '2026-10-12T14:30:00.000Z';

const at = (day: string, time: string) => new Date(`${day}T${time}:00-07:00`).toISOString();
const CLASS = 'cs189@group.calendar.google.com';

export const TODAY_CALENDARS: CalendarInfo[] = [
  { key: 'personal/primary', account: 'personal', calendarId: 'primary', label: 'personal', color: '#3b6fd8', primary: true },
  { key: 'school/primary', account: 'school', calendarId: 'primary', label: 'school', color: '#c2410c', primary: true },
  { key: `school/${CLASS}`, account: 'school', calendarId: CLASS, label: 'CS 189', color: '#15803d', primary: false },
];

// an event with the defaults of an event that the owner made alone on a primary calendar.
function event(account: string, calendarId: string, eventId: string, fields: Partial<CalendarEvent> & Pick<CalendarEvent, 'title' | 'startAt' | 'endAt'>): CalendarEvent {
  const startDay = fields.startDay ?? new Date(Date.parse(fields.startAt) - 7 * 3_600_000).toISOString().slice(0, 10);
  return {
    key: `${account}/${calendarId}/${eventId}`,
    uid: `${eventId}@google.com`,
    account,
    calendarId,
    calendarKey: `${account}/${calendarId}`,
    eventId,
    allDay: false,
    startDay,
    endDay: startDay,
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
    htmlLink: `https://www.google.com/calendar/event?eid=${eventId}`,
    ...fields,
  };
}

const guest = (email: string, answer: string, extra: { organizer?: boolean; self?: boolean } = {}) => ({
  name: null,
  email,
  answer,
  organizer: extra.organizer ?? false,
  optional: false,
  self: extra.self ?? false,
});

const invited = (organizer: string, answer: string) => ({
  organizerSelf: false,
  organizer,
  answer: answer as CalendarEvent['answer'],
  guests: [guest(organizer, 'accepted', { organizer: true }), guest('owner@school.example.edu', answer, { self: true })],
});

const D = TODAY_DAY;

export const TODAY_EVENTS: CalendarEvent[] = [
  event('personal', 'primary', 'birthday', { title: "Mom's birthday", startAt: at(D, '00:00'), endAt: at('2026-10-13', '00:00'), allDay: true }),
  event('personal', 'primary', 'run', { title: 'Run with Sam', startAt: at(D, '07:00'), endAt: at(D, '07:45'), location: 'Memorial Glade' }),
  event('school', 'primary', 'lab', { title: 'Lab meeting', startAt: at(D, '09:00'), endAt: at(D, '10:00'), location: 'Soda Hall 510', ...invited('prof@school.example.edu', 'accepted') }),
  event('school', CLASS, 'lecture', {
    title: 'CS 189 lecture',
    startAt: at(D, '10:05'),
    endAt: at(D, '11:30'),
    location: 'Wheeler 150',
    organizerSelf: false,
    organizer: 'cs189-staff@school.example.edu',
    recurring: true,
    notes: 'Lecture 12: kernels.',
  }),
  event('personal', 'primary', 'coffee', { title: 'Coffee with Priya', startAt: at(D, '11:00'), endAt: at(D, '11:45'), location: 'Free Speech Cafe', ...invited('priya@example.com', 'accepted') }),
  event('school', 'primary', 'talk', { title: 'Faculty talk', startAt: at(D, '12:00'), endAt: at(D, '13:00'), location: 'Banatao Auditorium', ...invited('events@school.example.edu', 'declined') }),
  event('personal', 'primary', 'focus', { title: 'Focus block', startAt: at(D, '13:00'), endAt: at(D, '14:00'), showsAsFree: true }),
  event('school', 'primary', 'advisor', {
    title: 'Advisor 1:1',
    startAt: at(D, '14:00'),
    endAt: at(D, '14:30'),
    videoUrl: 'https://meet.google.com/abc-defg-hij',
    ...invited('advisor@school.example.edu', 'accepted'),
  }),
  event('personal', 'primary', 'dentist', { title: 'Dentist', startAt: at(D, '14:15'), endAt: at(D, '15:00'), location: '2650 Telegraph Ave' }),
  event('school', 'primary', 'reading', {
    title: 'Reading group',
    startAt: at(D, '16:00'),
    endAt: at(D, '17:00'),
    location: 'Moffitt 101',
    notes: 'We read chapter 4.',
    ...invited('lee@school.example.edu', 'needsAction'),
  }),
  event('personal', 'primary', 'social-p', { uid: 'club-social', title: 'Club social', startAt: at(D, '18:00'), endAt: at(D, '19:00'), location: 'MLK Student Union', ...invited('club@example.org', 'accepted') }),
  event('school', 'primary', 'social-s', { uid: 'club-social', title: 'Club social', startAt: at(D, '18:00'), endAt: at(D, '19:00'), location: 'MLK Student Union', ...invited('club@example.org', 'accepted') }),
  event('school', 'primary', 'office', { title: 'Office hours', startAt: at('2026-10-13', '15:00'), endAt: at('2026-10-13', '16:00'), location: 'Soda Hall 347', ...invited('ta@school.example.edu', 'accepted') }),
  event('school', CLASS, 'hw3', {
    title: 'Homework 3 due',
    startAt: at('2026-10-15', '00:00'),
    endAt: at('2026-10-16', '00:00'),
    allDay: true,
    organizerSelf: false,
    organizer: 'cs189-staff@school.example.edu',
  }),
  event('personal', 'primary', 'dinner', { title: 'Team dinner', startAt: at('2026-10-15', '19:00'), endAt: at('2026-10-15', '21:00'), location: 'Gather, 2200 Oxford St', ...invited('jo@example.com', 'needsAction') }),
].sort((a, b) => a.startAt.localeCompare(b.startAt) || a.key.localeCompare(b.key));

export const TODAY_PROPOSALS: CalendarProposalBlock[] = [
  { proposalId: 7, account: 'school', title: 'Problem set 4 due', kind: 'course', startAt: '2026-10-14', endAt: null, allDay: true, approvalId: 11 },
];

const WEEK = ['2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16', '2026-10-17', '2026-10-18'];

// GET /api/calendar?from=2026-10-12 on the seeded week.
export const CALENDAR_WEEK: CalendarPage = {
  configured: true,
  timeZone: TODAY_TZ,
  from: WEEK[0]!,
  to: WEEK[6]!,
  days: WEEK,
  startAt: at(WEEK[0]!, '00:00'),
  endAt: at('2026-10-19', '00:00'),
  calendars: TODAY_CALENDARS,
  events: TODAY_EVENTS,
  proposals: TODAY_PROPOSALS,
  conflicts: [{ a: 'school/primary/advisor', b: 'personal/primary/dentist', startAt: at(D, '14:15'), endAt: at(D, '14:30') }],
  travelGaps: [{ from: 'school/primary/lab', to: `school/${CLASS}/lecture`, at: at(D, '10:00'), gapMinutes: 5, fromLocation: 'Soda Hall 510', toLocation: 'Wheeler 150' }],
  invites: ['school/primary/reading', 'personal/primary/dinner'],
  skipped: [],
};

// the same week with no events: the empty state.
export const CALENDAR_EMPTY: CalendarPage = { ...CALENDAR_WEEK, events: [], proposals: [], conflicts: [], travelGaps: [], invites: [] };

// no google block: the first-run state.
export const CALENDAR_OFF: CalendarPage = { ...CALENDAR_EMPTY, configured: false, calendars: [] };

// every account failed: the error state.
export const CALENDAR_FAILED: CalendarPage = {
  ...CALENDAR_EMPTY,
  calendars: [],
  skipped: [
    { account: 'personal', reason: 'personal needs a new sign-in on the Google page.' },
    { account: 'school', reason: 'Google did not answer for school.' },
  ],
};

const eventItem = (key: string, title: string, detail: string | null, tone: 'info' | 'warning' | 'critical' | null = null) => {
  const found = TODAY_EVENTS.find((each) => each.key === key)!;
  return { id: `event:${key}`, title, detail, at: found.allDay ? found.startDay : found.startAt, account: found.account, tone, source: { kind: 'event' as const, key, day: found.startDay } };
};

export const BRIEF_CONTENT: BriefContent = {
  day: TODAY_DAY,
  timeZone: TODAY_TZ,
  generatedAt: TODAY_NOW,
  sources: { calendar: 'ok', skipped: [], digest: { id: 1, day: TODAY_DAY }, desk: true },
  sections: [
    {
      kind: 'day',
      title: 'Today',
      note: '10 events, the first at 07:00.',
      items: [
        eventItem('personal/primary/birthday', "Mom's birthday", 'All day'),
        eventItem('personal/primary/run', 'Run with Sam', '07:00 to 07:45 · Memorial Glade'),
        eventItem('school/primary/lab', 'Lab meeting', '09:00 to 10:00 · Soda Hall 510'),
        eventItem(`school/${CLASS}/lecture`, 'CS 189 lecture', '10:05 to 11:30 · Wheeler 150'),
        eventItem('personal/primary/coffee', 'Coffee with Priya', '11:00 to 11:45 · Free Speech Cafe'),
        eventItem('personal/primary/focus', 'Focus block', '13:00 to 14:00 · shows as free'),
        eventItem('school/primary/advisor', 'Advisor 1:1', '14:00 to 14:30 · video'),
        eventItem('personal/primary/dentist', 'Dentist', '14:15 to 15:00 · 2650 Telegraph Ave'),
        eventItem('school/primary/reading', 'Reading group', '16:00 to 17:00 · Moffitt 101 · not answered', 'warning'),
        eventItem('personal/primary/social-p', 'Club social', '18:00 to 19:00 · MLK Student Union'),
      ],
    },
    {
      kind: 'conflicts',
      title: 'Conflicts',
      note: null,
      items: [eventItem('school/primary/advisor', 'Advisor 1:1 overlaps Dentist', '14:15 to 14:30', 'critical')],
    },
    {
      kind: 'travel',
      title: 'Tight moves',
      note: null,
      items: [eventItem(`school/${CLASS}/lecture`, 'Soda Hall 510 to Wheeler 150', '5 minutes between Lab meeting and CS 189 lecture', 'warning')],
    },
    {
      kind: 'invites',
      title: 'Invitations to answer',
      note: null,
      items: [
        eventItem('school/primary/reading', 'Reading group', 'Today 16:00 · from lee@school.example.edu', 'warning'),
        eventItem('personal/primary/dinner', 'Team dinner', 'Thu 19:00 · from jo@example.com', 'warning'),
      ],
    },
    {
      kind: 'deadlines',
      title: 'Deadlines this week',
      note: null,
      items: [
        { id: 'thread:school:t-essay', title: 'Essay draft for HIST 7B', detail: 'Due Tue 23:59 · from the inbox', at: at('2026-10-13', '23:59'), account: 'school', tone: 'warning', source: { kind: 'thread', account: 'school', threadId: 't-essay', digestId: 1 } },
        { id: 'proposal:7', title: 'Problem set 4 due', detail: 'Wed · proposed, waiting for your approval', at: '2026-10-14', account: 'school', tone: null, source: { kind: 'proposal', proposalId: 7 } },
        eventItem(`school/${CLASS}/hw3`, 'Homework 3 due', 'Thu · CS 189'),
      ],
    },
    {
      kind: 'inbox',
      title: 'Inbox',
      note: '2 need a reply, 1 bill, 1 package.',
      items: [
        { id: 'thread:personal:t-landlord', title: 'Reply to Dana about the lease', detail: 'A draft is in Gmail Drafts', at: null, account: 'personal', tone: 'warning', source: { kind: 'thread', account: 'personal', threadId: 't-landlord', digestId: 1 } },
        { id: 'thread:school:t-ta', title: 'Answer the TA about section swap', detail: null, at: null, account: 'school', tone: 'warning', source: { kind: 'thread', account: 'school', threadId: 't-ta', digestId: 1 } },
        { id: 'thread:personal:t-power', title: 'Electric bill, $64.20', detail: 'Due Fri', at: at('2026-10-16', '23:59'), account: 'personal', tone: null, source: { kind: 'thread', account: 'personal', threadId: 't-power', digestId: 1 } },
        { id: 'thread:personal:t-box', title: 'Package from the bookstore', detail: 'Arrives today', at: null, account: 'personal', tone: null, source: { kind: 'thread', account: 'personal', threadId: 't-box', digestId: 1 } },
      ],
    },
    {
      kind: 'delegations',
      title: 'Delegations',
      note: null,
      items: [
        { id: 'delegation:3', title: 'Book flights for the conference', detail: 'Waiting on the travel office · due Wed', at: at('2026-10-14', '17:00'), account: null, tone: null, source: { kind: 'delegation', delegationId: 3 } },
        { id: 'delegation:4', title: 'Get the refund from the airline', detail: 'Follow up today', at: at(D, '12:00'), account: null, tone: 'warning', source: { kind: 'delegation', delegationId: 4 } },
      ],
    },
    {
      kind: 'goals',
      title: 'Goals',
      note: null,
      items: [
        { id: 'goal:1', title: 'finish essay', detail: 'by 21:00', at: at(D, '21:00'), account: null, tone: null, source: { kind: 'goal', goalId: 1 } },
        { id: 'goal:2', title: 'gym', detail: null, at: null, account: null, tone: null, source: { kind: 'goal', goalId: 2 } },
      ],
    },
  ],
};

export const BRIEF_FULL: Brief = {
  id: 2,
  day: TODAY_DAY,
  runId: 'run-brief-2',
  createdAt: TODAY_NOW,
  shortText: [
    'Brief for Mon 12 Oct',
    '10 events, first at 07:00 Run with Sam.',
    '1 conflict, 1 tight move, 2 invitations to answer.',
    '3 deadlines this week. Inbox: 2 need a reply, 1 bill, 1 package.',
    '2 delegations, 2 goals.',
    'http://127.0.0.1:7777/#/today/2026-10-12',
  ].join('\n'),
  content: BRIEF_CONTENT,
  delivery: { channel: 'telegram', ok: true, error: null, at: TODAY_NOW },
};

// the brief of the day before: a quiet day, with no google block and no desk, and a message that did not reach the
// owner.
export const BRIEF_QUIET: Brief = {
  id: 1,
  day: '2026-10-11',
  runId: 'run-brief-1',
  createdAt: '2026-10-11T14:30:00.000Z',
  shortText: 'Brief for Sun 11 Oct\nNo events today.\nhttp://127.0.0.1:7777/#/today/2026-10-11',
  content: {
    day: '2026-10-11',
    timeZone: TODAY_TZ,
    generatedAt: '2026-10-11T14:30:00.000Z',
    sources: { calendar: 'off', skipped: [], digest: null, desk: false },
    sections: [{ kind: 'day', title: 'Today', note: 'Google is not set up, so the brief has no calendar.', items: [] }],
  },
  delivery: { channel: null, ok: false, error: 'no chat of the owner is known', at: '2026-10-11T14:30:01.000Z' },
};

export const BRIEFS_PAGE: BriefsPage = {
  briefs: [
    { id: 2, day: TODAY_DAY, createdAt: TODAY_NOW, items: 25, sent: true },
    { id: 1, day: '2026-10-11', createdAt: BRIEF_QUIET.createdAt, items: 0, sent: false },
  ],
  nextCursor: null,
};

export const BRIEF_SCHEDULE: BriefSchedule = { automationId: 'auto-brief', time: '07:30', enabled: true, nextRunAt: '2026-10-13T14:30:00.000Z', running: false };
