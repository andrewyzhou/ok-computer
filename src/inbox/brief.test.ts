import { describe, expect, it } from 'vitest';
import type { DigestStats } from '../dashboard/inbox-types.js';
import type { DigestItem } from '../dashboard/types.js';
import { openDb, type Db } from '../db/index.js';
import { inboxForBrief } from './brief.js';

// the inbox part of the morning brief, read from the digests that the 07:00 job wrote.

const ALIASES = ['personal', 'work', 'side', 'school', 'club'];

const item = (section: DigestItem['section'], account: string, id: string, extra: Partial<DigestItem> = {}): DigestItem => ({
  section,
  account,
  messageId: id,
  threadId: `t-${id}`,
  from: 'Someone <someone@example.com>',
  subject: id,
  summary: `the mail ${id}`,
  dueAt: null,
  amount: null,
  currency: null,
  draftId: null,
  proposalId: null,
  ...extra,
});

const account = (alias: string, hidden: number, error: string | null = null) => ({
  alias,
  listed: hidden + 2,
  read: error ? 0 : hidden + 2,
  capped: false,
  person: 1,
  list: 1,
  automated: hidden,
  hidden,
  error,
});

function addDigest(db: Db, day: string, items: DigestItem[], options: { accounts?: string[]; stats?: DigestStats | null; createdAt?: string } = {}): number {
  const row = db
    .prepare('INSERT INTO inbox_digests (day, runId, createdAt, accounts, shortText, items, notified, stats) VALUES (?, NULL, ?, ?, ?, ?, 1, ?)')
    .run(
      day,
      options.createdAt ?? `${day}T14:00:00.000Z`,
      JSON.stringify(options.accounts ?? ALIASES),
      'text',
      JSON.stringify(items),
      options.stats === undefined || options.stats === null ? null : JSON.stringify(options.stats),
    );
  return Number(row.lastInsertRowid);
}

describe('inboxForBrief', () => {
  it('gives the newest digest of the day, sorted into the sections in the stored order', () => {
    const db = openDb(':memory:');
    addDigest(db, '2026-10-19', [item('bills', 'personal', 'old-bill')]);
    addDigest(db, '2026-10-20', [item('packages', 'personal', 'first-run')], { createdAt: '2026-10-20T14:00:00.000Z' });
    const stats: DigestStats = { accounts: ALIASES.map((alias, index) => account(alias, index)), droppedDates: 1 };
    const id = addDigest(
      db,
      '2026-10-20',
      [
        item('needs_reply', 'school', 'r1', { draftId: 4 }),
        item('needs_reply', 'work', 'r2'),
        item('deadlines', 'school', 'd1', { dueAt: '2026-10-24', proposalId: 7 }),
        item('bills', 'side', 'b1', { amount: 64.2, currency: 'USD', dueAt: '2026-10-25T00:00:00Z' }),
        item('packages', 'club', 'p1'),
        item('packages', 'personal', 'p2'),
      ],
      { stats, createdAt: '2026-10-20T14:01:00.000Z' },
    );
    const brief = inboxForBrief(db, '2026-10-20')!;
    expect(brief).toMatchObject({ digestId: id, day: '2026-10-20', createdAt: '2026-10-20T14:01:00.000Z', stale: false, accounts: ALIASES, unread: [], hidden: 10 });
    expect(brief.needsReply.map((each) => each.messageId)).toEqual(['r1', 'r2']);
    expect(brief.deadlines.map((each) => each.messageId)).toEqual(['d1']);
    expect(brief.packages.map((each) => [each.account, each.messageId])).toEqual([
      ['club', 'p1'],
      ['personal', 'p2'],
    ]);
    expect(brief.bills[0]).toEqual({
      account: 'side',
      messageId: 'b1',
      threadId: 't-b1',
      from: 'Someone <someone@example.com>',
      subject: 'b1',
      summary: 'the mail b1',
      dueAt: '2026-10-25T00:00:00Z',
      amount: 64.2,
      currency: 'USD',
      draftId: null,
      proposalId: null,
      link: `#/inbox/digests/${id}`,
    });
  });

  it('links each item to its draft, its proposal or its digest', () => {
    const db = openDb(':memory:');
    const id = addDigest(db, '2026-10-20', [
      item('needs_reply', 'personal', 'with-draft', { draftId: 3 }),
      item('needs_reply', 'personal', 'without-draft'),
      item('deadlines', 'school', 'with-proposal', { proposalId: 9 }),
      item('bills', 'side', 'bill-with-proposal', { proposalId: 10 }),
      item('deadlines', 'school', 'deadline-alone'),
      // a draft wins over a proposal.
      item('needs_reply', 'club', 'both', { draftId: 5, proposalId: 11 }),
    ]);
    const brief = inboxForBrief(db, '2026-10-20')!;
    const links = Object.fromEntries([...brief.needsReply, ...brief.deadlines, ...brief.bills].map((each) => [each.messageId, each.link]));
    expect(links).toEqual({
      'with-draft': '#/inbox/drafts?id=3',
      'without-draft': `#/inbox/digests/${id}`,
      'with-proposal': '#/inbox/proposals?id=9',
      'bill-with-proposal': '#/inbox/proposals?id=10',
      'deadline-alone': `#/inbox/digests/${id}`,
      both: '#/inbox/drafts?id=5',
    });
  });

  it('gives the newest older digest as stale when the day has none, and never a later one', () => {
    const db = openDb(':memory:');
    addDigest(db, '2026-10-17', [item('bills', 'personal', 'oldest')]);
    const older = addDigest(db, '2026-10-18', [item('bills', 'personal', 'older')]);
    addDigest(db, '2026-10-21', [item('bills', 'personal', 'later')]);
    const brief = inboxForBrief(db, '2026-10-20')!;
    expect(brief).toMatchObject({ digestId: older, day: '2026-10-18', stale: true });
    expect(brief.bills.map((each) => each.messageId)).toEqual(['older']);
  });

  it('gives null without a digest', () => {
    const db = openDb(':memory:');
    expect(inboxForBrief(db, '2026-10-20')).toBeNull();
    expect(inboxForBrief(db, '2026-10-20', ALIASES)).toBeNull();
    addDigest(db, '2026-10-21', []);
    expect(inboxForBrief(db, '2026-10-20')).toBeNull();
  });

  it('counts the hidden mail and lists the accounts that the digest could not read from its counts', () => {
    const db = openDb(':memory:');
    const stats: DigestStats = {
      accounts: [account('personal', 3), account('work', 0, 'the work google account needs the owner to sign in again on the dashboard.'), account('side', 4), account('school', 2), account('club', 0, 'the mail could not be read')],
      droppedDates: 0,
    };
    addDigest(db, '2026-10-20', [], { accounts: ['personal', 'side', 'school'], stats });
    expect(inboxForBrief(db, '2026-10-20')).toMatchObject({ hidden: 9, unread: ['work', 'club'], accounts: ['personal', 'side', 'school'] });
    // an account that the config has and the counts do not name was not read either.
    expect(inboxForBrief(db, '2026-10-20', [...ALIASES, 'new'])!.unread).toEqual(['work', 'club', 'new']);
  });

  it('reads a digest of phase 5 without counts', () => {
    const db = openDb(':memory:');
    // the items of phase 5 have no mail kind, and a very old item may lack the ids of its draft and its proposal.
    const old = { ...item('needs_reply', 'personal', 'r1') } as Partial<DigestItem>;
    delete old.draftId;
    delete old.proposalId;
    const id = addDigest(db, '2026-10-20', [old as DigestItem, item('bills', 'school', 'b1', { proposalId: 2 })], { accounts: ['personal', 'school'], stats: null });
    const brief = inboxForBrief(db, '2026-10-20')!;
    expect(brief).toMatchObject({ stale: false, hidden: 0, unread: [] });
    expect(brief.needsReply[0]).toMatchObject({ draftId: null, proposalId: null, link: `#/inbox/digests/${id}` });
    expect(brief.bills[0]!.link).toBe('#/inbox/proposals?id=2');
    // with the configured aliases, the accounts that the digest did not read are unread.
    expect(inboxForBrief(db, '2026-10-20', ALIASES)!.unread).toEqual(['work', 'side', 'club']);
  });

  it('only reads', () => {
    const db = openDb(':memory:');
    addDigest(db, '2026-10-20', [item('bills', 'personal', 'b1')]);
    const before = db.prepare('SELECT * FROM inbox_digests').all();
    const changes = db.prepare('SELECT total_changes() AS n').get();
    inboxForBrief(db, '2026-10-20', ALIASES);
    inboxForBrief(db, '2026-10-21', ALIASES);
    expect(db.prepare('SELECT total_changes() AS n').get()).toEqual(changes);
    expect(db.prepare('SELECT * FROM inbox_digests').all()).toEqual(before);
  });
});
