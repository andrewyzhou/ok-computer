import type {
  CalendarProposalView,
  DigestsPage,
  DraftView,
  InboxDigest,
  NewsletterSenderRow,
  SendersPage,
  SubscriptionRow,
  SubscriptionsPage,
} from '../../../../src/dashboard/types';

// the answers of the inbox endpoints for the tests and the screenshots. the backend of m8 is built in parallel, so the
// views are checked against these shapes from src/dashboard/types.ts.

export const PERSONAL = 'owner@example.com';
export const SCHOOL = 'owner@school.example.edu';

export const digest: InboxDigest = {
  id: 7,
  day: '2026-10-18',
  runId: 'run-1',
  createdAt: '2026-10-18T14:00:00.000Z',
  accounts: [PERSONAL, SCHOOL],
  shortText: 'Inbox, Sunday: 2 need a reply, 1 deadline, 1 bill ($84.20), 1 package.\nDrafts are ready for the replies.',
  items: [
    {
      section: 'needs_reply',
      account: SCHOOL,
      messageId: 'm-1',
      threadId: 't-1',
      from: 'Prof. Rivera',
      subject: 'Office hours moved to Thursday',
      summary: 'Asks if Thursday at 3 pm works for the project check-in.',
      dueAt: null,
      amount: null,
      currency: null,
      draftId: 41,
      proposalId: null,
    },
    {
      section: 'needs_reply',
      account: PERSONAL,
      messageId: 'm-2',
      threadId: 't-2',
      from: 'Sam Lee',
      subject: 'Dinner next week?',
      summary: 'Wants to know which night is free.',
      dueAt: null,
      amount: null,
      currency: null,
      draftId: 42,
      proposalId: null,
    },
    {
      section: 'deadlines',
      account: SCHOOL,
      messageId: 'm-3',
      threadId: 't-3',
      from: 'Course staff',
      subject: 'Homework 6 released',
      summary: 'Homework 6 is due on Friday at 11:59 pm.',
      dueAt: '2026-10-24T06:59:00.000Z',
      amount: null,
      currency: null,
      draftId: null,
      proposalId: 12,
    },
    {
      section: 'bills',
      account: PERSONAL,
      messageId: 'm-4',
      threadId: 't-4',
      from: 'City Power',
      subject: 'Your October statement',
      summary: 'The statement is ready. Autopay is off.',
      dueAt: '2026-10-28T07:00:00.000Z',
      amount: 84.2,
      currency: 'USD',
      draftId: null,
      proposalId: 13,
    },
    {
      section: 'packages',
      account: PERSONAL,
      messageId: 'm-5',
      threadId: 't-5',
      from: 'Parcel service',
      subject: 'Out for delivery',
      summary: 'A package arrives today between 2 pm and 6 pm.',
      dueAt: null,
      amount: null,
      currency: null,
      draftId: null,
      proposalId: null,
    },
  ],
  stats: null,
};

export const digests: DigestsPage = {
  digests: [
    { id: 7, day: '2026-10-18', runId: 'run-1', createdAt: '2026-10-18T14:00:00.000Z', items: 5 },
    { id: 6, day: '2026-10-17', runId: 'run-2', createdAt: '2026-10-17T14:00:00.000Z', items: 3 },
  ],
  nextCursor: 'c2',
};

export const olderDigests: DigestsPage = {
  digests: [{ id: 5, day: '2026-10-16', runId: null, createdAt: '2026-10-16T14:00:00.000Z', items: 1 }],
  nextCursor: null,
};

function sender(id: number, values: Partial<NewsletterSenderRow>): NewsletterSenderRow {
  return {
    id,
    account: PERSONAL,
    senderKey: `list-${id}.example.com`,
    listId: `list-${id}.example.com`,
    fromAddress: `news@list-${id}.example.com`,
    displayName: null,
    messages: 20,
    read: 2,
    readRate: 0.1,
    firstAt: '2026-06-01T12:00:00.000Z',
    lastAt: '2026-10-17T12:00:00.000Z',
    unsubscribe: { method: 'one_click', url: `https://list-${id}.example.com/unsubscribe` },
    state: 'active',
    approvalId: null,
    unsubscribedAt: null,
    archived: 0,
    label: null,
    error: null,
    ...values,
  };
}

export const senders: NewsletterSenderRow[] = [
  sender(1, { displayName: 'Weekly Deals', messages: 48, read: 1, readRate: 0.02 }),
  sender(2, { displayName: 'Campus Events', account: SCHOOL, messages: 31, read: 12, readRate: 0.39, unsubscribe: { method: 'none', url: null } }),
  sender(3, { displayName: 'Daily Brief', messages: 22, read: 20, readRate: 0.91, state: 'kept', unsubscribe: { method: 'https', url: 'https://brief.example.com/prefs' } }),
  sender(4, { displayName: null, listId: null, fromAddress: 'promo@shop.example.com', messages: 14, read: 0, readRate: 0, state: 'unsubscribed', unsubscribedAt: '2026-10-10T09:00:00.000Z', archived: 14, label: 'newsletters' }),
  sender(5, { displayName: 'Travel Offers', messages: 9, read: 0, readRate: 0, state: 'unsubscribe_pending', approvalId: 1, unsubscribe: { method: 'mailto', url: 'mailto:leave@travel.example.com' } }),
  sender(6, { displayName: 'Old Club', messages: 4, read: 0, readRate: 0, state: 'failed', error: 'the unsubscribe link answered 500' }),
];

export const sendersPage: SendersPage = {
  accounts: [PERSONAL, SCHOOL],
  senders: senders.slice(0, 4),
  nextCursor: 'n2',
  lastSweep: { runId: 'run-1', at: '2026-10-18T13:00:00.000Z' },
};

export const sendersPage2: SendersPage = { ...sendersPage, senders: senders.slice(4), nextCursor: null };

function subscription(id: number, values: Partial<SubscriptionRow>): SubscriptionRow {
  return {
    id,
    account: PERSONAL,
    merchant: 'Merchant',
    amount: 9.99,
    currency: 'USD',
    cadence: 'monthly',
    lastChargeAt: '2026-10-03T10:00:00.000Z',
    nextChargeAt: '2026-11-03T10:00:00.000Z',
    sourceMessageId: `r-${id}`,
    sourceSubject: 'Your receipt',
    sourceMessageIds: [`r-${id}`],
    confidence: 0.9,
    cadenceSource: 'gaps',
    reasons: [],
    cancelUrl: null,
    state: 'active',
    approvalId: null,
    browserTaskId: null,
    updatedAt: '2026-10-18T13:00:00.000Z',
    ...values,
  };
}

export const subscriptionsPage: SubscriptionsPage = {
  subscriptions: [
    subscription(1, { merchant: 'Streamly', amount: 15.49, sourceSubject: 'Your Streamly receipt', cancelUrl: 'https://streamly.example.com/account/cancel' }),
    subscription(2, { merchant: 'Cloud Notes', amount: 96, cadence: 'yearly', nextChargeAt: '2027-03-01T10:00:00.000Z', sourceSubject: 'Thanks for renewing' }),
    subscription(3, { merchant: 'Gym Plus', amount: 42, state: 'cancel_pending', approvalId: 1, browserTaskId: 'task-1', sourceSubject: 'Membership payment' }),
    subscription(4, { merchant: 'News Daily', amount: 4.5, currency: 'EUR', state: 'cancelled', sourceSubject: 'Abo bestätigt' }),
    subscription(5, { merchant: 'Free Trial', amount: null, currency: null, cadence: 'unknown', state: 'ignored', nextChargeAt: null, sourceSubject: null }),
  ],
  monthlyTotals: [
    { currency: 'USD', amount: 65.49 },
    { currency: 'EUR', amount: 4.5 },
  ],
  lastScan: { runId: 'run-1', at: '2026-10-18T12:30:00.000Z' },
};

export function draft(id: number, values: Partial<DraftView> = {}): DraftView {
  return {
    id,
    account: SCHOOL,
    gmailDraftId: `d-${id}`,
    threadId: `t-${id}`,
    inReplyTo: `<msg-${id}@school.example.edu>`,
    to: ['rivera@school.example.edu'],
    subject: `Re: Office hours ${id}`,
    body: 'Hi Professor Rivera,\n\nThursday at 3 pm works for me. I will bring the draft of the report.\n\nThanks,\nAlex',
    state: 'drafted',
    runId: 'run-1',
    toolCallId: null,
    createdAt: '2026-10-18T14:00:00.000Z',
    ...values,
  };
}

export const drafts: DraftView[] = [
  draft(42, { account: PERSONAL, to: ['sam@example.com'], subject: 'Re: Dinner next week?', body: 'Hey Sam,\n\nTuesday or Wednesday both work. Pick one!\n\nA.' }),
  draft(41, { subject: 'Re: Office hours moved to Thursday' }),
  draft(38, { to: ['ta@school.example.edu', 'staff@school.example.edu'], subject: 'Re: Regrade request', createdAt: '2026-10-15T14:00:00.000Z' }),
];

export function proposal(id: number, values: Partial<CalendarProposalView> = {}): CalendarProposalView {
  return {
    id,
    account: SCHOOL,
    calendarId: 'primary',
    kind: 'course',
    title: `Proposal ${id}`,
    startAt: '2026-10-24T04:00:00.000Z',
    endAt: '2026-10-24T06:59:00.000Z',
    allDay: false,
    description: null,
    sourceMessageId: `m-${id}`,
    sourceSubject: 'Homework 6 released',
    dueText: null,
    state: 'proposed',
    approvalId: null,
    eventId: null,
    error: null,
    runId: 'run-1',
    createdAt: '2026-10-18T14:00:00.000Z',
    resolvedAt: null,
    ...values,
  };
}

export const proposals: CalendarProposalView[] = [
  proposal(12, { title: 'Homework 6 due', approvalId: 1, description: 'Submit on the course site before 11:59 pm.' }),
  proposal(13, {
    account: PERSONAL,
    kind: 'bill',
    title: 'Pay City Power ($84.20)',
    startAt: '2026-10-28',
    endAt: null,
    allDay: true,
    sourceSubject: 'Your October statement',
  }),
];

// the five accounts of the owner, by the aliases that the api gives, for the account labels of each list and the
// coverage of the digest (phase 6 t2). school had more mail than the read limit, and hkn could not be read.
export const ACCOUNTS = ['a06', 'yurun', 'a581', 'school', 'hkn'];

export const fiveDigest: InboxDigest = {
  id: 9,
  day: '2026-10-20',
  runId: 'run-5',
  createdAt: '2026-10-20T14:00:00.000Z',
  accounts: ACCOUNTS,
  shortText: 'Inbox, Tuesday: 2 need a reply, 2 deadlines, 1 bill ($18.00), 1 package. hkn was not read.',
  items: [
    { ...digest.items[0]!, account: 'school', messageId: 'f-1', mail: 'person' },
    { ...digest.items[1]!, account: 'yurun', messageId: 'f-2', mail: 'person' },
    {
      ...digest.items[2]!,
      account: 'school',
      messageId: 'f-3',
      from: 'Course site',
      subject: 'Homework 6 released',
      summary: 'Homework 6 is due on Friday at 11:59 pm.',
      mail: 'automated',
    },
    {
      ...digest.items[2]!,
      account: 'a581',
      messageId: 'f-4',
      from: 'Club treasurer',
      subject: 'Dues for the fall term',
      summary: 'Pay the fall dues by the end of the month.',
      dueAt: '2026-10-31T07:00:00.000Z',
      proposalId: 21,
      mail: 'person',
    },
    { ...digest.items[3]!, account: 'a06', messageId: 'f-5', from: 'Phone plan', subject: 'Your bill is ready', amount: 18, mail: 'automated' },
    { ...digest.items[4]!, account: 'a06', messageId: 'f-6', mail: 'automated' },
  ],
  stats: {
    accounts: [
      { alias: 'a06', listed: 64, read: 64, capped: false, person: 3, list: 30, automated: 31, hidden: 58, error: null },
      { alias: 'yurun', listed: 12, read: 12, capped: false, person: 2, list: 6, automated: 4, hidden: 9, error: null },
      { alias: 'a581', listed: 9, read: 9, capped: false, person: 1, list: 5, automated: 3, hidden: 7, error: null },
      { alias: 'school', listed: 240, read: 100, capped: true, person: 12, list: 51, automated: 37, hidden: 80, error: null },
      { alias: 'hkn', listed: 0, read: 0, capped: false, person: 0, list: 0, automated: 0, hidden: 0, error: 'the sign-in of this account has expired' },
    ],
    droppedDates: 1,
  },
};

export const fiveDigests: DigestsPage = {
  digests: [
    { id: 9, day: '2026-10-20', runId: 'run-5', createdAt: '2026-10-20T14:00:00.000Z', items: 6 },
    { id: 8, day: '2026-10-19', runId: 'run-4', createdAt: '2026-10-19T14:00:00.000Z', items: 4 },
  ],
  nextCursor: null,
};

export const fiveSendersPage: SendersPage = {
  accounts: ACCOUNTS,
  senders: [
    sender(11, { account: 'a06', displayName: 'Weekly Deals', messages: 48, read: 1, readRate: 0.02 }),
    sender(12, { account: 'yurun', displayName: 'Weekly Deals', messages: 12, read: 3, readRate: 0.25 }),
    sender(13, { account: 'school', displayName: 'Campus Events', messages: 31, read: 12, readRate: 0.39, unsubscribe: { method: 'none', url: null } }),
    sender(14, { account: 'a581', displayName: 'Daily Brief', messages: 22, read: 20, readRate: 0.91, state: 'kept' }),
    sender(15, { account: 'hkn', displayName: 'Chapter news', messages: 8, read: 6, readRate: 0.75, unsubscribe: { method: 'mailto', url: 'mailto:leave@chapter.example.org' } }),
  ],
  nextCursor: null,
  lastSweep: { runId: 'run-5', at: '2026-10-19T13:00:00.000Z' },
};

// one row in each confidence band and with each cadence source. the two rows with confidence 0 found no charge that
// repeats, so the page hides them until the owner asks.
export const fiveSubscriptionsPage: SubscriptionsPage = {
  subscriptions: [
    subscription(21, {
      account: 'a06',
      merchant: 'Streamly',
      amount: 15.49,
      confidence: 0.9,
      cadenceSource: 'both',
      sourceMessageIds: ['r-21', 'r-21b', 'r-21c'],
      reasons: ['The receipts say the plan renews each month.', 'Three charges came about 30 days apart.'],
      sourceSubject: 'Your Streamly receipt',
    }),
    subscription(22, {
      account: 'yurun',
      merchant: 'Cloud Notes',
      amount: 96,
      cadence: 'yearly',
      confidence: 0.6,
      cadenceSource: 'stated',
      reasons: ['The receipt says the plan renews each year.', 'Only one receipt was found, so the dates cannot confirm it.'],
      sourceSubject: 'Thanks for renewing',
    }),
    subscription(23, {
      account: 'a581',
      merchant: 'Gym Plus',
      amount: 42,
      confidence: 0.3,
      cadenceSource: 'gaps',
      sourceMessageIds: ['r-23', 'r-23b'],
      reasons: ['Two charges came 31 days apart.', 'The receipts do not say that the charge repeats.'],
      sourceSubject: 'Membership payment',
    }),
    subscription(24, {
      account: 'school',
      merchant: 'Campus Store',
      amount: 23.1,
      cadence: 'unknown',
      nextChargeAt: null,
      confidence: 0,
      cadenceSource: 'none',
      reasons: ['One charge, and the receipt does not say that it repeats.'],
      sourceSubject: 'Your order',
    }),
    subscription(25, {
      account: 'hkn',
      merchant: 'Event Tickets',
      amount: 12,
      cadence: 'unknown',
      nextChargeAt: null,
      confidence: 0,
      cadenceSource: 'none',
      reasons: ['One charge for one event.'],
      sourceSubject: 'Your tickets',
    }),
  ],
  monthlyTotals: [{ currency: 'USD', amount: 31.49 }],
  lastScan: { runId: 'run-5', at: '2026-10-19T12:30:00.000Z' },
};

export const fiveDrafts: DraftView[] = [
  draft(51, { account: 'yurun', to: ['sam@example.com'], subject: 'Re: Dinner next week?' }),
  draft(52, { account: 'school', subject: 'Re: Office hours moved to Thursday' }),
  draft(53, { account: 'a581', to: ['treasurer@club.example.org'], subject: 'Re: Dues for the fall term' }),
  draft(54, { account: 'a06', to: ['support@shop.example.com'], subject: 'Re: Your return' }),
  draft(55, { account: 'hkn', to: ['officers@chapter.example.org'], subject: 'Re: Meeting notes' }),
];

export const fiveProposals: CalendarProposalView[] = [
  proposal(31, { account: 'school', title: 'Homework 6 due', dueText: 'due on Friday, October 24 at 11:59 pm' }),
  proposal(32, { account: 'a581', kind: 'other', title: 'Club dues', startAt: '2026-10-31', endAt: null, allDay: true, dueText: 'by October 31', sourceSubject: 'Dues for the fall term' }),
  proposal(33, { account: 'a06', kind: 'bill', title: 'Pay the phone bill ($18.00)', startAt: '2026-10-28', endAt: null, allDay: true, sourceSubject: 'Your bill is ready' }),
  proposal(34, { account: 'yurun', kind: 'other', title: 'Reply to Sam', sourceSubject: 'Dinner next week?' }),
  proposal(35, { account: 'hkn', kind: 'other', title: 'Chapter meeting', sourceSubject: 'Meeting notes' }),
];

// the answer of /api/google when the integration is set up and an account is signed in. the inbox pages show their
// first step instead of an empty list without it, so each test of a page that has data gives this answer.
export const googleReady = {
  'GET /api/google': () => ({ configured: true, accounts: ACCOUNTS.map((alias) => ({ alias, status: 'ok' })) }),
};
