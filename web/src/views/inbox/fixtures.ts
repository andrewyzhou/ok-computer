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
