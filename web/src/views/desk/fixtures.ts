import type { Delegation, DelegationDetail, DelegationEvent, DeskBoard, DelegationStatus } from '../../../../src/dashboard/desk-types';

// the answers of the desk api for the web tests, until the routes are built and after. they follow the rows of
// test/seed-desk.ts at the time FIXTURE_NOW, so a test that stubs a route and a test on the seeded server see the
// same delegations. the board tests stub GET /api/desk with board(), and the details tests stub
// GET /api/desk/delegations/:id with detail(id).

export const FIXTURE_NOW = new Date('2026-10-13T01:00:00.000Z');

const H = 3_600_000;
const D = 24 * H;
const iso = (ms: number) => new Date(FIXTURE_NOW.getTime() + ms).toISOString();

export const LONG_TITLE =
  'Collect every receipt of the October trip from mail and the photos, and put them into one expense report for the school';

export function delegation(id: number, overrides: Partial<Delegation> = {}): Delegation {
  return {
    id,
    title: `Delegation ${id}`,
    details: null,
    status: 'open',
    nextStep: null,
    waitingOn: null,
    waitingSince: null,
    dueAt: null,
    nextFollowUpAt: null,
    lastCheckedAt: null,
    nudgeCount: 0,
    links: [],
    createdBy: 'agent',
    sessionKey: 'main',
    runId: 'run-1',
    createdAt: iso(-1 * D),
    updatedAt: iso(-1 * D),
    closedAt: null,
    ...overrides,
  };
}

export const delegations: Delegation[] = [
  delegation(1, {
    title: 'Book the Denver flights',
    details: 'Two seats, out on Oct 24 and back on Oct 27. Aisle seats when they cost the same.',
    nextStep: 'Compare the morning flights on Oct 24',
    dueAt: iso(3 * D),
    links: [{ kind: 'run', ref: 'run-1', account: null, label: 'The chat where you asked', href: 'runs/run-1' }],
    createdAt: iso(-2 * D),
    updatedAt: iso(-2 * D),
  }),
  delegation(2, {
    title: 'Get the lease renewal from Dana',
    status: 'waiting',
    nextStep: "Wait for Dana's reply with the new lease",
    waitingOn: { name: 'Dana Park', email: 'dana@landlord.example' },
    waitingSince: iso(-4 * D),
    dueAt: iso(5 * D),
    nextFollowUpAt: iso(1 * D),
    lastCheckedAt: iso(-1 * D),
    nudgeCount: 1,
    links: [{ kind: 'thread', ref: 't-lease', account: 'personal', label: 'Lease renewal', href: null }],
    createdAt: iso(-4 * D),
    updatedAt: iso(-2 * H),
  }),
  delegation(3, {
    title: 'Reschedule the dentist',
    status: 'waiting',
    nextStep: 'Pick a time next week from the slots they send',
    waitingOn: { name: null, email: 'front@dentist.example' },
    waitingSince: iso(-3 * D),
    dueAt: iso(-1 * D),
    nextFollowUpAt: iso(-1 * H),
    links: [{ kind: 'thread', ref: 't-dentist', account: 'school', label: null, href: null }],
    createdAt: iso(-3 * D),
    updatedAt: iso(-3 * D),
  }),
  delegation(4, {
    title: 'Renew the passport',
    details: 'The passport ends in March.',
    status: 'blocked',
    nextStep: 'Sign the form and choose a photo',
    dueAt: iso(20 * D),
    links: [{ kind: 'doc', ref: 'doc-1', account: null, label: 'Passport checklist', href: 'docs/doc-1' }],
    createdBy: 'owner',
    sessionKey: null,
    runId: null,
    createdAt: iso(-6 * D),
    updatedAt: iso(-1 * D),
  }),
  delegation(5, { title: 'Send the thank-you note to Prof. Lee', status: 'done', createdAt: iso(-7 * D), updatedAt: iso(-2 * D), closedAt: iso(-2 * D) }),
  delegation(6, { title: 'Find a cheaper phone plan', status: 'dropped', createdBy: 'owner', sessionKey: null, runId: null, createdAt: iso(-10 * D), updatedAt: iso(-5 * D), closedAt: iso(-5 * D) }),
  delegation(7, {
    title: LONG_TITLE,
    links: [{ kind: 'event', ref: 'ev-1', account: 'school', label: 'Trip review', href: null }],
    createdBy: 'owner',
    sessionKey: null,
    runId: null,
  }),
  delegation(8, {
    title: 'Ask Dana about the parking spot',
    status: 'waiting',
    waitingOn: { name: 'Dana', email: null },
    waitingSince: iso(-3 * H),
    nextFollowUpAt: iso(2 * D),
    createdAt: iso(-3 * H),
    updatedAt: iso(-3 * H),
  }),
];

const ORDER: DelegationStatus[] = ['open', 'waiting', 'blocked', 'done', 'dropped'];

// the board of the given delegations, in the order of the server: active columns by dueAt (none last), then by id,
// and closed columns by closedAt, the newest first.
export function board(rows: Delegation[] = delegations): DeskBoard {
  const byDue = (a: Delegation, b: Delegation) => (a.dueAt ?? '￿').localeCompare(b.dueAt ?? '￿') || a.id - b.id;
  const byClosed = (a: Delegation, b: Delegation) => (b.closedAt ?? '').localeCompare(a.closedAt ?? '') || b.id - a.id;
  const columns = ORDER.map((status) => {
    const of = rows.filter((row) => row.status === status).sort(status === 'done' || status === 'dropped' ? byClosed : byDue);
    return { status, delegations: of, total: of.length };
  });
  return {
    columns,
    people: [
      { key: 'dana', name: 'Dana', email: null, active: 1 },
      { key: 'dana@landlord.example', name: 'Dana Park', email: 'dana@landlord.example', active: 1 },
      { key: 'front@dentist.example', name: null, email: 'front@dentist.example', active: 1 },
    ],
    dueToday: 1,
  };
}

export const emptyBoard: DeskBoard = { columns: ORDER.map((status) => ({ status, delegations: [], total: 0 })), people: [], dueToday: 0 };

const event = (id: number, delegationId: number, overrides: Partial<DelegationEvent>): DelegationEvent => ({
  id,
  delegationId,
  kind: 'note',
  actor: 'agent',
  text: null,
  data: {},
  runId: null,
  toolCallId: null,
  createdAt: iso(-1 * D),
  ...overrides,
});

const HISTORY: Record<number, DelegationEvent[]> = {
  2: [
    event(3, 2, { kind: 'created', runId: 'run-1', data: { title: 'Get the lease renewal from Dana', status: 'waiting' }, createdAt: iso(-4 * D) }),
    event(4, 2, { kind: 'link_added', runId: 'run-1', data: { kind: 'thread', ref: 't-lease', account: 'personal', label: 'Lease renewal' }, createdAt: iso(-4 * D) }),
    event(5, 2, { kind: 'follow_up_checked', actor: 'system', data: { threadId: 't-lease', account: 'personal' } }),
    event(6, 2, {
      kind: 'nudge_drafted',
      actor: 'system',
      text: 'Saved a nudge to Dana in Gmail Drafts. It is not sent.',
      data: { nudgeId: 1, gmailDraftId: 'd-nudge-1', account: 'personal', threadId: 't-lease' },
    }),
    event(7, 2, { kind: 'note', actor: 'owner', text: 'Dana said on the phone that the lease comes this week.', createdAt: iso(-2 * H) }),
  ],
};

// the detail of a delegation of the fixture. delegation 2 has the full history and a nudge, and the others have a
// created row only.
export function detail(id: number): DelegationDetail {
  const found = delegations.find((each) => each.id === id) ?? delegation(id);
  return {
    ...found,
    history: HISTORY[id] ?? [event(id * 100, id, { kind: 'created', data: { title: found.title, status: found.status }, createdAt: found.createdAt })],
    nudges:
      id === 2
        ? [
            {
              id: 1,
              delegationId: 2,
              account: 'personal',
              threadId: 't-lease',
              sourceMessageId: 'm-lease-2',
              gmailDraftId: 'd-nudge-1',
              toAddress: 'dana@landlord.example',
              subject: 'Re: Lease renewal',
              body: 'Hi Dana, I wanted to check in on the lease renewal. Could you send the new lease when it is ready? Thank you.',
              followUpAt: iso(-1 * D),
              runId: null,
              createdAt: iso(-1 * D),
            },
          ]
        : [],
  };
}
