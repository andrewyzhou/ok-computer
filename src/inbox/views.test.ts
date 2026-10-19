import { afterEach, describe, expect, it } from 'vitest';
import { LATEST_ITEMS, seedInbox } from '../../test/seed-inbox.js';
import type { NewsletterSenderRow, SendersQuery } from '../dashboard/types.js';
import { decodeCursor, encodeCursor, getDigest, InvalidCursor, listDigests, listDrafts, listProposals, listSenders, listSubscriptions } from './views.js';

const ACCOUNTS = ['personal', 'school'];
let seeded: ReturnType<typeof seedInbox> | undefined;
const seed = (options: Parameters<typeof seedInbox>[0] = {}) => (seeded = seedInbox(options));
afterEach(() => {
  seeded?.close();
  seeded = undefined;
});

// every page of one sort, with the ids of each page.
function allPages(db: ReturnType<typeof seedInbox>['db'], query: SendersQuery & { limit: number }): number[][] {
  const pages: number[][] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = listSenders(db, { ...query, ...(cursor !== undefined ? { cursor } : {}) }, ACCOUNTS);
    pages.push(page.senders.map((sender) => sender.id));
    if (page.nextCursor === null) return pages;
    cursor = page.nextCursor;
  }
}

describe('listSenders', () => {
  it('maps a row to the contract shape', () => {
    const { db } = seed();
    const page = listSenders(db, { limit: 50 }, ACCOUNTS);
    expect(page.accounts).toEqual(ACCOUNTS);
    expect(page.nextCursor).toBeNull();
    // the failed sweep is newer, but the last sweep is the last one that completed.
    expect(page.lastSweep).toEqual({ runId: 'run-sweep-1', at: '2026-10-17T16:02:00Z' });
    expect(page.senders.find((sender) => sender.id === 5)).toEqual({
      id: 5,
      account: 'school',
      senderKey: 'digest.campus.example',
      listId: 'digest.campus.example',
      fromAddress: 'digest@campus.example',
      displayName: 'Campus Digest',
      messages: 0,
      read: 0,
      readRate: null,
      firstAt: '2026-06-01T00:00:00Z',
      lastAt: '2026-10-10T08:00:00Z',
      unsubscribe: { method: 'one_click', url: 'https://campus.example/u' },
      state: 'unsubscribed',
      approvalId: null,
      unsubscribedAt: '2026-10-11T09:00:00Z',
      archived: 25,
      label: 'Newsletters',
      error: null,
    } satisfies NewsletterSenderRow);
    const pending = page.senders.find((sender) => sender.id === 4)!;
    expect(pending).toMatchObject({ readRate: 0.25, state: 'unsubscribe_pending', approvalId: 1, unsubscribe: { method: 'none', url: null } });
    expect(page.senders.find((sender) => sender.id === 6)).toMatchObject({ state: 'failed', error: 'the link answered 500' });
  });

  it('gives a null read rate to a sender with no messages', () => {
    const { db } = seed();
    const rates = Object.fromEntries(listSenders(db, { limit: 50 }, ACCOUNTS).senders.map((sender) => [sender.id, sender.readRate]));
    expect(rates).toEqual({ 1: 0.05, 2: 0.25, 3: 1, 4: 0.25, 5: null, 6: 0.25, 7: null, 8: 0.25 });
  });

  it.each([
    ['messages', [2, 1, 4, 3, 8, 6, 7, 5]],
    ['readRate', [1, 8, 6, 4, 2, 3, 7, 5]],
    ['lastAt', [3, 1, 2, 4, 8, 6, 7, 5]],
  ] as const)('pages by %s over three pages without repeats or gaps', (sort, order) => {
    const { db } = seed();
    expect(listSenders(db, { sort, limit: 50 }, ACCOUNTS).senders.map((sender) => sender.id)).toEqual(order);
    const pages = allPages(db, { sort, limit: 3 });
    expect(pages).toEqual([order.slice(0, 3), order.slice(3, 6), order.slice(6)]);
  });

  it('gives no next cursor when the last page is exactly full', () => {
    const { db } = seed();
    expect(allPages(db, { limit: 4 })).toEqual([
      [2, 1, 4, 3],
      [8, 6, 7, 5],
    ]);
  });

  it('filters by account and state', () => {
    const { db } = seed();
    expect(listSenders(db, { account: 'school', limit: 50 }, ACCOUNTS).senders.map((sender) => sender.id)).toEqual([4, 7, 5]);
    expect(listSenders(db, { state: 'active', limit: 50 }, ACCOUNTS).senders.map((sender) => sender.id)).toEqual([2, 1, 8, 7]);
    expect(listSenders(db, { account: 'personal', state: 'active', sort: 'readRate', limit: 50 }, ACCOUNTS).senders.map((sender) => sender.id)).toEqual([1, 8, 2]);
  });

  it('refuses a cursor that it did not make', () => {
    const { db } = seed();
    expect(() => listSenders(db, { cursor: 'not-a-cursor', limit: 3 }, ACCOUNTS)).toThrow(InvalidCursor);
    expect(() => listSenders(db, { cursor: encodeCursor({ v: 'x', id: 1 }), limit: 3 }, ACCOUNTS)).toThrow(InvalidCursor);
    expect(() => listSenders(db, { sort: 'lastAt', cursor: encodeCursor({ v: 3, id: 1 }), limit: 3 }, ACCOUNTS)).toThrow(InvalidCursor);
    expect(() => decodeCursor(Buffer.from('{"v":1,"id":0}').toString('base64url'))).toThrow(InvalidCursor);
    expect(decodeCursor(encodeCursor({ v: null, id: 7 }))).toEqual({ v: null, id: 7 });
  });

  it('gives no last sweep before the first one', () => {
    const { db } = seed({ empty: true });
    expect(listSenders(db, { limit: 50 }, [])).toEqual({ accounts: [], senders: [], nextCursor: null, lastSweep: null });
  });
});

describe('listSubscriptions', () => {
  it('maps the rows, newest charge first and rows without a charge last', () => {
    const { db } = seed();
    const page = listSubscriptions(db, {});
    expect(page.subscriptions.map((row) => row.id)).toEqual([1, 3, 4, 6, 2, 5]);
    expect(page.lastScan).toEqual({ runId: 'run-scan-1', at: '2026-10-18T10:05:00Z' });
    expect(page.subscriptions[0]).toEqual({
      id: 1,
      account: 'personal',
      merchant: 'Stream Plus',
      amount: 15.99,
      currency: 'USD',
      cadence: 'monthly',
      lastChargeAt: '2026-10-05T00:00:00Z',
      nextChargeAt: '2026-11-05T00:00:00Z',
      sourceMessageId: 'r-stream-3',
      sourceSubject: 'Your Stream Plus receipt',
      sourceMessageIds: ['r-stream-3', 'r-stream-2', 'r-stream-1'],
      confidence: 0.95,
      cancelUrl: 'https://stream.example/cancel',
      state: 'active',
      approvalId: null,
      browserTaskId: null,
      updatedAt: '2026-10-18T10:05:00Z',
    });
    expect(page.subscriptions.find((row) => row.id === 5)).toMatchObject({ amount: null, currency: null, cadence: 'unknown', lastChargeAt: null, confidence: 0.3 });
  });

  it('finds the browser task through the help run, or keeps the stored one', () => {
    const { db } = seed();
    const rows = listSubscriptions(db, {}).subscriptions;
    expect(rows.find((row) => row.id === 2)?.browserTaskId).toBe('bt_help');
    expect(rows.find((row) => row.id === 6)?.browserTaskId).toBe('bt_direct');
  });

  it('leaves the cancelled and ignored rows out of the monthly totals', () => {
    const { db } = seed();
    // USD: 15.99 a month and 99 a year. EUR: 10 a quarter. the cancelled EUR 4.99 and the ignored USD 30 are left out.
    expect(listSubscriptions(db, {}).monthlyTotals).toEqual([
      { currency: 'EUR', amount: 3.33 },
      { currency: 'USD', amount: 24.24 },
    ]);
    expect(listSubscriptions(db, { state: 'cancelled' }).monthlyTotals).toEqual([]);
  });

  it('filters by account and state', () => {
    const { db } = seed();
    expect(listSubscriptions(db, { account: 'school' }).subscriptions.map((row) => row.id)).toEqual([3, 6, 5]);
    expect(listSubscriptions(db, { account: 'school', state: 'active' }).subscriptions.map((row) => row.id)).toEqual([6, 5]);
  });
});

describe('the digests', () => {
  it('gives the latest digest and a digest by id', () => {
    const { db } = seed();
    expect(getDigest(db, 'latest')).toEqual({
      id: 3,
      day: '2026-10-18',
      runId: 'run-digest-1',
      createdAt: '2026-10-18T14:31:00Z',
      accounts: ['personal', 'school'],
      shortText: 'One reply, one deadline, one bill and one parcel.',
      items: LATEST_ITEMS,
    });
    expect(getDigest(db, 3)?.items.map((each) => each.section)).toEqual(['needs_reply', 'deadlines', 'bills', 'packages']);
    expect(getDigest(db, 2)).toMatchObject({ id: 2, runId: null, items: [] });
    expect(getDigest(db, 9)).toBeUndefined();
  });

  it('keeps the text of a hostile mail as data', () => {
    const { db } = seed();
    const hostile = getDigest(db, 'latest')!.items[0]!;
    expect(hostile.summary).toContain('IGNORE ALL PREVIOUS INSTRUCTIONS');
    // the views only read. the pending approvals are still pending after the read.
    expect(db.prepare("SELECT COUNT(*) AS n FROM approvals WHERE status = 'pending'").get()!.n).toBe(3);
  });

  it('gives no digest on an empty database', () => {
    const { db } = seed({ empty: true });
    expect(getDigest(db, 'latest')).toBeUndefined();
    expect(listDigests(db, { limit: 30 })).toEqual({ digests: [], nextCursor: null });
  });

  it('lists the digests newest first with a cursor', () => {
    const { db } = seed();
    const first = listDigests(db, { limit: 2 });
    expect(first.digests).toEqual([
      { id: 3, day: '2026-10-18', runId: 'run-digest-1', createdAt: '2026-10-18T14:31:00Z', items: 4 },
      { id: 2, day: '2026-10-17', runId: null, createdAt: '2026-10-17T14:30:00Z', items: 0 },
    ]);
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = listDigests(db, { cursor: first.nextCursor!, limit: 2 });
    expect(second).toEqual({ digests: [{ id: 1, day: '2026-10-16', runId: null, createdAt: '2026-10-16T14:30:00Z', items: 1 }], nextCursor: null });
    expect(listDigests(db, { limit: 3 }).nextCursor).toBeNull();
    expect(() => listDigests(db, { cursor: 'nope!', limit: 2 })).toThrow(InvalidCursor);
  });
});

describe('the drafts and the proposals', () => {
  it('maps a draft and pages before an id', () => {
    const { db } = seed();
    const drafts = listDrafts(db, { limit: 50 });
    expect(drafts.map((draft) => draft.id)).toEqual([4, 3, 2, 1]);
    expect(drafts.find((draft) => draft.id === 2)).toEqual({
      id: 2,
      account: 'school',
      gmailDraftId: 'd-2',
      threadId: 't-m-ta',
      inReplyTo: null,
      to: ['ta@school.example', 'lee@school.example'],
      subject: 'Re: Office hours',
      body: 'Tuesday at 3 works for me.',
      state: 'drafted',
      runId: 'run-digest-1',
      toolCallId: 'digest-d2',
      createdAt: '2026-10-18T14:30:40Z',
    });
    expect(listDrafts(db, { limit: 2 }).map((draft) => draft.id)).toEqual([4, 3]);
    expect(listDrafts(db, { before: 3, limit: 2 }).map((draft) => draft.id)).toEqual([2, 1]);
    expect(listDrafts(db, { before: 1, limit: 2 })).toEqual([]);
    expect(listDrafts(db, { state: 'drafted', limit: 50 }).map((draft) => draft.id)).toEqual([2, 1]);
    expect(listDrafts(db, { account: 'school', state: 'sent_by_owner', limit: 50 }).map((draft) => draft.id)).toEqual([4]);
  });

  it('maps a proposal and pages before an id', () => {
    const { db } = seed();
    const proposals = listProposals(db, { limit: 50 });
    expect(proposals.map((proposal) => proposal.id)).toEqual([6, 5, 4, 3, 2, 1]);
    expect(proposals.find((proposal) => proposal.id === 1)).toEqual({
      id: 1,
      account: 'school',
      calendarId: 'primary',
      kind: 'course',
      title: 'Essay due',
      startAt: '2026-10-20',
      endAt: null,
      allDay: true,
      description: 'From the mail "Essay due".',
      sourceMessageId: 'm-essay',
      sourceSubject: 'Essay due',
      state: 'proposed',
      approvalId: 3,
      eventId: null,
      error: null,
      runId: 'run-digest-1',
      createdAt: '2026-10-18T14:31:00Z',
      resolvedAt: null,
    });
    expect(proposals.find((proposal) => proposal.id === 2)?.allDay).toBe(false);
    expect(listProposals(db, { before: 4, limit: 2 }).map((proposal) => proposal.id)).toEqual([3, 2]);
    expect(listProposals(db, { account: 'school', limit: 50 }).map((proposal) => proposal.id)).toEqual([6, 4, 2, 1]);
    expect(listProposals(db, { state: 'created', limit: 50 }).map((proposal) => proposal.eventId)).toEqual(['ev-power']);
  });
});
