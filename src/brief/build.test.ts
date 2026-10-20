import { describe, expect, it } from 'vitest';
import type { BriefContent, BriefDelegation, BriefSection } from '../dashboard/brief-types.js';
import type { CalendarEvent } from '../dashboard/calendar-types.js';
import type { CalendarProposalView, DigestItem, GoalRow, InboxDigest } from '../dashboard/types.js';
import { BRIEF_FULL, BRIEF_QUIET, TODAY_DAY, TODAY_EVENTS, TODAY_NOW, TODAY_TZ } from '../../test/fixtures/today-data.js';
import { briefInboxOf } from '../inbox/brief.js';
import { briefText, buildBrief, SHORT_TEXT_LIMIT, type BriefInput } from './build.js';

const at = (day: string, time: string) => new Date(`${day}T${time}:00-07:00`).toISOString();
const LINK = 'http://127.0.0.1:7777/#/today/2026-10-12';

function digestItem(fields: Partial<DigestItem> & Pick<DigestItem, 'section' | 'account' | 'threadId' | 'summary'>): DigestItem {
  return {
    messageId: `m-${fields.threadId}`,
    from: 'someone@example.com',
    subject: `subject of ${fields.threadId}`,
    dueAt: null,
    amount: null,
    currency: null,
    draftId: null,
    proposalId: null,
    ...fields,
  };
}

const DIGEST: InboxDigest = {
  id: 1,
  day: TODAY_DAY,
  runId: 'run-digest-1',
  createdAt: '2026-10-12T14:00:00.000Z',
  accounts: ['personal', 'school'],
  shortText: 'digest',
  stats: null,
  items: [
    digestItem({ section: 'needs_reply', account: 'personal', threadId: 't-landlord', summary: 'Reply to Dana about the lease', draftId: 5 }),
    digestItem({ section: 'needs_reply', account: 'school', threadId: 't-ta', summary: 'Answer the TA about section swap' }),
    digestItem({ section: 'deadlines', account: 'school', threadId: 't-essay', summary: 'Essay draft for HIST 7B', dueAt: at('2026-10-13', '23:59') }),
    digestItem({ section: 'bills', account: 'personal', threadId: 't-power', summary: 'Electric bill', amount: 64.2, currency: 'USD', dueAt: at('2026-10-16', '23:59') }),
    digestItem({ section: 'packages', account: 'personal', threadId: 't-box', summary: 'Package from the bookstore', dueAt: at(TODAY_DAY, '00:00') }),
  ],
};

// the digest in the shape that the brief reads, as inboxForBrief gives it.
const inboxOf = (digest: InboxDigest) => briefInboxOf(digest, { stale: false });

function proposal(fields: Partial<CalendarProposalView> & Pick<CalendarProposalView, 'id' | 'title' | 'startAt'>): CalendarProposalView {
  return {
    account: 'school',
    calendarId: 'primary',
    kind: 'course',
    endAt: null,
    allDay: true,
    description: null,
    sourceMessageId: null,
    sourceSubject: null,
    state: 'proposed',
    approvalId: 11,
    eventId: null,
    error: null,
    runId: null,
    createdAt: '2026-10-11T14:00:00.000Z',
    resolvedAt: null,
    dueText: null,
    ...fields,
  };
}

const DELEGATIONS: BriefDelegation[] = [
  { id: 3, title: 'Book flights for the conference', status: 'waiting', nextStep: null, waitingOn: 'the travel office', dueAt: at('2026-10-14', '17:00'), followUpAt: null },
  { id: 4, title: 'Get the refund from the airline', status: 'open', nextStep: null, waitingOn: null, dueAt: null, followUpAt: at(TODAY_DAY, '12:00') },
];

function goal(id: number, title: string, status: string, eta: string | null): GoalRow {
  return { id, day: TODAY_DAY, title, eta, status, completedAt: status === 'done' ? at(TODAY_DAY, '07:00') : null, note: null };
}

function input(fields: Partial<BriefInput> = {}): BriefInput {
  return {
    day: TODAY_DAY,
    timeZone: TODAY_TZ,
    now: new Date(TODAY_NOW),
    events: TODAY_EVENTS,
    sources: { calendar: 'ok', skipped: [], digest: { id: 1, day: TODAY_DAY }, desk: true },
    inbox: inboxOf(DIGEST),
    proposals: [proposal({ id: 7, title: 'Problem set 4 due', startAt: '2026-10-14' })],
    delegations: DELEGATIONS,
    goals: [goal(2, 'gym', 'open', null), goal(1, 'finish essay', 'open', at(TODAY_DAY, '21:00')), goal(3, 'laundry', 'dropped', null)],
    ...fields,
  };
}

const sectionOf = (content: BriefContent, kind: BriefSection['kind']) => content.sections.find((each) => each.kind === kind);
const ids = (content: BriefContent, kind: BriefSection['kind']) => sectionOf(content, kind)?.items.map((item) => item.id);

describe('buildBrief', () => {
  it('gives every section in order on the fixture day', () => {
    const content = buildBrief(input());
    expect(content.day).toBe(TODAY_DAY);
    expect(content.timeZone).toBe(TODAY_TZ);
    expect(content.generatedAt).toBe(TODAY_NOW);
    expect(content.sources).toEqual(input().sources);
    expect(content.sections.map((each) => [each.kind, each.title])).toEqual(BRIEF_FULL.content.sections.map((each) => [each.kind, each.title]));
    for (const kind of ['day', 'conflicts', 'travel', 'invites', 'deadlines', 'inbox', 'delegations', 'goals'] as const) {
      expect(ids(content, kind), kind).toEqual(sectionOf(BRIEF_FULL.content, kind)!.items.map((item) => item.id));
    }
  });

  it('gives the brief of the shared fixture, item by item', () => {
    // the web tests, the route tests and the screenshots show BRIEF_FULL, so it must be what the builder makes.
    const content = buildBrief(input());
    for (const section of BRIEF_FULL.content.sections) expect(sectionOf(content, section.kind), section.kind).toEqual(section);
    expect(content).toEqual(BRIEF_FULL.content);
    expect(briefText(content, LINK)).toBe(BRIEF_FULL.shortText);
  });

  it('describes the events of the day', () => {
    const day = sectionOf(buildBrief(input()), 'day')!;
    // the brief is built at 07:30, so the note names the lab meeting, and calls it the next event, because the run
    // started at 07:00.
    expect(day.note).toBe('10 events, the next at 09:00.');
    const byId = new Map(day.items.map((item) => [item.id, item]));
    expect(byId.get('event:personal/primary/birthday')).toMatchObject({ detail: 'All day', at: TODAY_DAY, tone: null });
    expect(byId.get('event:personal/primary/run')).toMatchObject({
      title: 'Run with Sam',
      detail: '07:00 to 07:45 · Memorial Glade',
      at: at(TODAY_DAY, '07:00'),
      account: 'personal',
      source: { kind: 'event', key: 'personal/primary/run', day: TODAY_DAY },
    });
    expect(byId.get('event:school/primary/advisor')!.detail).toBe('14:00 to 14:30 · video');
    expect(byId.get('event:personal/primary/focus')!.detail).toBe('13:00 to 14:00 · shows as free');
    expect(byId.get('event:school/primary/reading')).toMatchObject({ detail: '16:00 to 17:00 · Moffitt 101 · not answered', tone: 'warning' });
    // the club social is one invitation on two accounts, so the day shows it once.
    expect(byId.has('event:school/primary/social-s')).toBe(false);
  });

  it('marks conflicts, travel and invitations', () => {
    const content = buildBrief(input());
    expect(sectionOf(content, 'conflicts')!.items).toEqual([
      {
        id: 'conflict:school/primary/advisor|personal/primary/dentist',
        title: 'Advisor 1:1 overlaps Dentist',
        detail: '14:15 to 14:30',
        at: at(TODAY_DAY, '14:00'),
        account: 'school',
        tone: 'critical',
        source: { kind: 'event', key: 'school/primary/advisor', day: TODAY_DAY },
      },
    ]);
    expect(sectionOf(content, 'travel')!.items).toMatchObject([
      { title: 'Soda Hall 510 to Wheeler 150', detail: '5 minutes between Lab meeting and CS 189 lecture', tone: 'warning', source: { kind: 'event', key: 'school/cs189@group.calendar.google.com/lecture' } },
    ]);
    expect(sectionOf(content, 'invites')!.items).toMatchObject([
      { title: 'Reading group', detail: 'Today 16:00 · from lee@school.example.edu', tone: 'warning' },
      { title: 'Team dinner', detail: 'Thu 19:00 · from jo@example.com', tone: 'warning', source: { kind: 'event', key: 'personal/primary/dinner', day: '2026-10-15' } },
    ]);
  });

  it('gives the deadlines of the week from mail, the calendar and proposals', () => {
    const items = sectionOf(buildBrief(input()), 'deadlines')!.items;
    expect(items).toMatchObject([
      { id: 'thread:school:t-essay', detail: 'Due Tomorrow 23:59 · from the inbox', tone: null, source: { kind: 'thread', account: 'school', threadId: 't-essay', digestId: 1 } },
      { id: 'proposal:7', at: '2026-10-14', detail: 'Wed · proposed, waiting for your approval', tone: null, source: { kind: 'proposal', proposalId: 7 } },
      { id: 'event:school/cs189@group.calendar.google.com/hw3', at: '2026-10-15', detail: 'Thu', tone: null },
    ]);
  });

  it('opens the draft or the proposal of a digest item, else the digest', () => {
    const digest: InboxDigest = {
      ...DIGEST,
      items: [
        digestItem({ section: 'needs_reply', account: 'personal', threadId: 't-draft', summary: 'Reply with a draft', draftId: 5, proposalId: 8 }),
        digestItem({ section: 'needs_reply', account: 'school', threadId: 't-plain', summary: 'Reply without a draft' }),
        digestItem({ section: 'deadlines', account: 'school', threadId: 't-proposed', summary: 'Form due', dueAt: at('2026-10-14', '17:00'), proposalId: 8 }),
      ],
    };
    const content = buildBrief(input({ inbox: inboxOf(digest), proposals: [], events: [] }));
    const sources = new Map(content.sections.flatMap((section) => section.items).map((item) => [item.id, item.source]));
    expect(sources.get('thread:personal:t-draft')).toEqual({ kind: 'draft', draftId: 5 });
    expect(sources.get('thread:school:t-plain')).toEqual({ kind: 'thread', account: 'school', threadId: 't-plain', digestId: 1 });
    // the proposal of this deadline is not in the list (it was decided), so the deadline stays and opens the proposal.
    expect(sources.get('thread:school:t-proposed')).toEqual({ kind: 'proposal', proposalId: 8 });
  });

  it('shows a deadline of the digest and its proposal as one item', () => {
    const digest: InboxDigest = {
      ...DIGEST,
      items: [digestItem({ section: 'deadlines', account: 'school', threadId: 't-mt3', summary: 'CS 61A Midterm 3', dueAt: at('2026-10-14', '20:00'), proposalId: 8 })],
    };
    const proposals = [proposal({ id: 8, title: 'CS 61A Midterm 3', startAt: at('2026-10-14', '20:00'), endAt: at('2026-10-14', '22:00'), allDay: false })];
    const content = buildBrief(input({ inbox: inboxOf(digest), proposals, events: [] }));
    expect(sectionOf(content, 'deadlines')!.items).toEqual([
      {
        id: 'proposal:8',
        title: 'CS 61A Midterm 3',
        detail: 'Wed 20:00 · from the inbox, proposed, waiting for your approval',
        at: at('2026-10-14', '20:00'),
        account: 'school',
        tone: null,
        source: { kind: 'proposal', proposalId: 8 },
      },
    ]);
    expect(briefText(content, LINK)).toContain('1 deadline this week.');
  });

  it('leaves out a proposal made of a mail that confirms a thing the owner did', () => {
    const proposals = [
      proposal({ id: 2, title: 'CS 61A MT3 proctoring preferences form due', startAt: TODAY_DAY, sourceSubject: 'Thanks for filling out CS 61A MT3 proctoring preferences' }),
      proposal({ id: 7, title: 'Problem set 4 due', startAt: '2026-10-14', sourceSubject: 'Problem set 4 is out' }),
    ];
    const items = sectionOf(buildBrief(input({ inbox: null, proposals, events: [] })), 'deadlines')!.items;
    expect(items.map((item) => item.id)).toEqual(['proposal:7']);
  });

  it('names a day of the next week and a day before the brief by its date', () => {
    const digest: InboxDigest = {
      ...DIGEST,
      items: [
        digestItem({ section: 'deadlines', account: 'school', threadId: 't-today', summary: 'Due today', dueAt: at(TODAY_DAY, '20:00') }),
        digestItem({ section: 'deadlines', account: 'school', threadId: 't-tomorrow', summary: 'Due tomorrow', dueAt: at('2026-10-13', '07:15') }),
        digestItem({ section: 'deadlines', account: 'school', threadId: 't-sun', summary: 'Due sunday', dueAt: '2026-10-18' }),
        // the same weekday a week later is in the window of the brief, and must not read as today.
        digestItem({ section: 'deadlines', account: 'school', threadId: 't-week', summary: 'Due next monday', dueAt: at('2026-10-19', '20:00') }),
      ],
    };
    const items = sectionOf(buildBrief(input({ inbox: inboxOf(digest), proposals: [], events: [] })), 'deadlines')!.items;
    expect(items.map((item) => item.detail)).toEqual([
      'Due Today 20:00 · from the inbox',
      'Due Tomorrow 07:15 · from the inbox',
      'Due Sun · from the inbox',
      'Due Mon, Oct 19 20:00 · from the inbox',
    ]);
  });

  it('marks an overdue deadline critical and one of the day as a warning', () => {
    const digest: InboxDigest = {
      ...DIGEST,
      items: [
        digestItem({ section: 'deadlines', account: 'school', threadId: 't-late', summary: 'Form due this morning', dueAt: at(TODAY_DAY, '06:00') }),
        digestItem({ section: 'deadlines', account: 'school', threadId: 't-tonight', summary: 'Quiz tonight', dueAt: at(TODAY_DAY, '22:00') }),
        digestItem({ section: 'deadlines', account: 'school', threadId: 't-date', summary: 'Waiver', dueAt: TODAY_DAY }),
        digestItem({ section: 'deadlines', account: 'school', threadId: 't-old', summary: 'Last week', dueAt: at('2026-10-05', '12:00') }),
        digestItem({ section: 'deadlines', account: 'school', threadId: 't-far', summary: 'Next month', dueAt: at('2026-10-20', '12:00') }),
      ],
    };
    const items = sectionOf(buildBrief(input({ inbox: inboxOf(digest), proposals: [], events: [] })), 'deadlines')!.items;
    expect(items.map((item) => [item.id, item.tone, item.at])).toEqual([
      ['thread:school:t-date', 'warning', TODAY_DAY],
      ['thread:school:t-late', 'critical', at(TODAY_DAY, '06:00')],
      ['thread:school:t-tonight', 'warning', at(TODAY_DAY, '22:00')],
    ]);
  });

  it('builds the inbox without repeating a deadline', () => {
    const digest: InboxDigest = {
      ...DIGEST,
      items: [...DIGEST.items, digestItem({ section: 'needs_reply', account: 'school', threadId: 't-essay', summary: 'Reply about the essay' })],
    };
    const inbox = sectionOf(buildBrief(input({ inbox: inboxOf(digest) })), 'inbox')!;
    expect(inbox.note).toBe('2 need a reply, 1 bill, 1 package.');
    expect(inbox.items.map((item) => [item.id, item.title, item.detail, item.tone])).toEqual([
      ['thread:personal:t-landlord', 'Reply to Dana about the lease', 'A draft is in Gmail Drafts', 'warning'],
      ['thread:school:t-ta', 'Answer the TA about section swap', null, 'warning'],
      ['thread:personal:t-power', 'Electric bill, $64.20', 'Due Fri 23:59', null],
      ['thread:personal:t-box', 'Package from the bookstore', 'Arrives today', null],
    ]);
  });

  it('says when the digest is of the day before, and says so when there is no digest', () => {
    const old = buildBrief(input({ inbox: inboxOf({ ...DIGEST, day: '2026-10-11' }) }));
    expect(sectionOf(old, 'inbox')!.note).toBe('2 need a reply, 1 bill, 1 package. From the digest of 2026-10-11.');
    // with google set up, the owner can tell "nothing needs you" from "the inbox was not read".
    expect(sectionOf(buildBrief(input({ inbox: null })), 'inbox')).toEqual({ kind: 'inbox', title: 'Inbox', items: [], note: 'No inbox digest yet today.' });
    // without google there is no inbox to read, so the section is left out.
    expect(sectionOf(buildBrief(input({ inbox: null, sources: { calendar: 'off', skipped: [], digest: null, desk: false } })), 'inbox')).toBeUndefined();
  });

  it('leaves the delegations out for null and for an empty list', () => {
    expect(sectionOf(buildBrief(input({ delegations: null })), 'delegations')).toBeUndefined();
    expect(sectionOf(buildBrief(input({ delegations: [] })), 'delegations')).toBeUndefined();
  });

  it('marks delegations that are late or due today', () => {
    const delegations: BriefDelegation[] = [
      ...DELEGATIONS,
      { id: 5, title: 'Late one', status: 'blocked', nextStep: null, waitingOn: 'Sam', dueAt: at('2026-10-11', '17:00'), followUpAt: null },
      { id: 6, title: 'Due today', status: 'open', nextStep: null, waitingOn: null, dueAt: at(TODAY_DAY, '17:00'), followUpAt: at(TODAY_DAY, '09:00') },
    ];
    const items = sectionOf(buildBrief(input({ delegations })), 'delegations')!.items;
    expect(items.map((item) => [item.id, item.detail, item.tone])).toEqual([
      ['delegation:3', 'Waiting on the travel office · due Wed', null],
      ['delegation:4', 'Follow up today', 'warning'],
      ['delegation:5', 'Waiting on Sam · due Sun, Oct 11', 'critical'],
      ['delegation:6', 'Due today · Follow up today', 'warning'],
    ]);
    expect(items[0]!.source).toEqual({ kind: 'delegation', delegationId: 3 });
  });

  it('lists goals by id, with done goals and without dropped ones', () => {
    const goals = [goal(2, 'gym', 'done', null), goal(1, 'finish essay', 'open', at(TODAY_DAY, '21:00')), goal(3, 'laundry', 'dropped', null)];
    const items = sectionOf(buildBrief(input({ goals })), 'goals')!.items;
    expect(items.map((item) => [item.id, item.detail, item.source])).toEqual([
      ['goal:1', 'by 21:00', { kind: 'goal', goalId: 1 }],
      ['goal:2', 'done', { kind: 'goal', goalId: 2 }],
    ]);
  });

  it('gives only the day section and the note of the missing digest on an empty day', () => {
    const content = buildBrief(input({ events: [], inbox: null, proposals: [], delegations: null, goals: [] }));
    expect(content.sections).toEqual([
      { kind: 'day', title: 'Schedule', items: [], note: 'No events today.' },
      { kind: 'inbox', title: 'Inbox', items: [], note: 'No inbox digest yet today.' },
    ]);
  });

  it('explains a calendar that is off, failed or partial', () => {
    const off = buildBrief(input({ events: [], sources: { calendar: 'off', skipped: [], digest: null, desk: false } }));
    expect(sectionOf(off, 'day')!.note).toBe('Google is not set up, so the brief has no calendar.');
    const failed = buildBrief(input({ events: [], sources: { calendar: 'failed', skipped: [{ account: 'personal', reason: 'x' }], digest: null, desk: true } }));
    expect(sectionOf(failed, 'day')!.note).toBe('The calendars could not be read.');
    const partial = buildBrief(input({ sources: { calendar: 'partial', skipped: [{ account: 'school', reason: 'x' }], digest: null, desk: true } }));
    expect(sectionOf(partial, 'day')!.note).toBe('10 events, the next at 09:00. The calendar of school could not be read.');
    // one calendar of an account that was read in part gives its own reason.
    const cut = buildBrief(
      input({ sources: { calendar: 'partial', skipped: [{ account: 'school', calendarId: 'c', reason: 'school: Only the first 1000 events of the calendar c are shown.' }], digest: null, desk: true } }),
    );
    expect(sectionOf(cut, 'day')!.note).toBe('10 events, the next at 09:00. school: Only the first 1000 events of the calendar c are shown.');
  });

  it('shows one invitation on two accounts once in each section', () => {
    const base = TODAY_EVENTS.find((event) => event.eventId === 'reading')!;
    const copy: CalendarEvent = { ...base, key: 'personal/primary/reading-copy', account: 'personal', calendarKey: 'personal/primary', eventId: 'reading-copy' };
    const content = buildBrief(input({ events: [...TODAY_EVENTS, copy] }));
    expect(ids(content, 'day')!.filter((id) => id.includes('reading'))).toHaveLength(1);
    expect(ids(content, 'invites')!.filter((id) => id.includes('reading'))).toHaveLength(1);
    expect(ids(content, 'conflicts')).toEqual(['conflict:school/primary/advisor|personal/primary/dentist']);
  });

  it('reads the day in another time zone', () => {
    const tz = 'Asia/Kolkata';
    const events = [
      { ...TODAY_EVENTS.find((event) => event.eventId === 'run')!, startAt: '2026-10-12T03:30:00.000Z', endAt: '2026-10-12T04:00:00.000Z', startDay: TODAY_DAY, endDay: TODAY_DAY },
    ];
    const content = buildBrief(input({ timeZone: tz, events, now: new Date('2026-10-12T02:00:00Z') }));
    expect(sectionOf(content, 'day')!.items[0]!.detail).toBe('09:00 to 09:30 · Memorial Glade');
    expect(sectionOf(content, 'day')!.note).toBe('1 event, at 09:00.');
  });
});

describe('briefText', () => {
  it('gives the short text of the fixture day with the link last', () => {
    const text = briefText(buildBrief(input()), LINK);
    const lines = text.split('\n');
    expect(lines[0]).toBe('Brief for Mon 12 Oct');
    expect(lines.at(-1)).toBe(LINK);
    expect(lines.slice(1, -1)).toEqual([
      '10 events, next at 09:00 Lab meeting.',
      '1 conflict, 1 tight move, 2 invitations to answer.',
      '3 deadlines this week. Inbox: 2 need a reply, 1 bill, 1 package.',
      '2 delegations, 2 goals.',
    ]);
    expect(text).not.toMatch(/[*_`[\]]/);
  });

  it('gives the quiet day', () => {
    const content = buildBrief(input({ day: '2026-10-11', events: [], inbox: null, proposals: [], delegations: null, goals: [], sources: BRIEF_QUIET.content.sources }));
    expect(briefText(content, 'http://127.0.0.1:7777/#/today/2026-10-11')).toBe(BRIEF_QUIET.shortText);
  });

  it('cuts a long first title and keeps the text under the limit', () => {
    const long = 'x'.repeat(900);
    const events = TODAY_EVENTS.map((event) => (event.eventId === 'lab' ? { ...event, title: long } : event));
    const text = briefText(buildBrief(input({ events })), LINK);
    expect(text.length).toBeLessThanOrEqual(SHORT_TEXT_LIMIT);
    expect(text.split('\n')[1]).toBe(`10 events, next at 09:00 ${'x'.repeat(60)}.`);
    expect(text).not.toContain('Dentist');
  });

  it('drops middle lines and never the first line or the link when the text is too long', () => {
    const link = `http://127.0.0.1:7777/#/today/2026-10-12?${'q'.repeat(560)}`;
    const text = briefText(buildBrief(input()), link);
    const lines = text.split('\n');
    expect(text.length).toBeLessThanOrEqual(SHORT_TEXT_LIMIT);
    expect(lines[0]).toBe('Brief for Mon 12 Oct');
    expect(lines.at(-1)).toBe(link);
    expect(lines.length).toBeLessThan(6);
    expect(lines[1]).toBe('10 events, next at 09:00 Lab meeting.');
  });
});
