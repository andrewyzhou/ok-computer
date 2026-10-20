import { describe, expect, it } from 'vitest';
import { openDb } from '../db/index.js';
import { inboxAccounts, ownerAddresses } from './accounts.js';
import { getDigest, getProposal, listSubscriptions } from './views.js';

// the ground of phase 6 t2: the columns of 026_inbox_live.sql, the views that read them and the account helpers. the
// due check has its own tests in deadlines.test.ts.

const NOW = '2026-10-19T14:00:00.000Z';

describe('026_inbox_live.sql', () => {
  it('adds the columns with defaults, so a row of phase 5 stays valid', () => {
    const db = openDb(':memory:');
    db.prepare("INSERT INTO inbox_digests (day, createdAt, shortText) VALUES ('2026-10-19', ?, 'x')").run(NOW);
    db.prepare("INSERT INTO inbox_receipts (account, messageId, readAt) VALUES ('personal', 'm1', ?)").run(NOW);
    db.prepare("INSERT INTO inbox_subscriptions (account, merchantKey, merchant, sourceMessageId, updatedAt) VALUES ('personal', 'k', 'K', 'm1', ?)").run(NOW);
    db.prepare("INSERT INTO inbox_proposals (account, kind, title, startAt, dedupeKey, createdAt) VALUES ('school', 'course', 't', ?, 'd', ?)").run(NOW, NOW);
    db.prepare("INSERT INTO inbox_senders (account, senderKey, fromAddress, firstAt, lastAt, updatedAt) VALUES ('club', 'k', 'a@b.example', ?, ?, ?)").run(NOW, NOW, NOW);
    expect(db.prepare('SELECT stats FROM inbox_digests').get()).toEqual({ stats: null });
    expect(db.prepare('SELECT parser, senderDomain, kind, statedCadence, amountInText FROM inbox_receipts').get()).toEqual({
      parser: 0,
      senderDomain: null,
      kind: null,
      statedCadence: null,
      amountInText: 0,
    });
    expect(db.prepare('SELECT cadenceSource, reasons FROM inbox_subscriptions').get()).toEqual({ cadenceSource: 'none', reasons: '[]' });
    expect(db.prepare('SELECT dueText FROM inbox_proposals').get()).toEqual({ dueText: null });
    expect(db.prepare('SELECT fromDomains FROM inbox_senders').get()).toEqual({ fromDomains: 1 });
  });

  it('refuses a value outside the checks', () => {
    const db = openDb(':memory:');
    expect(() => db.prepare("INSERT INTO inbox_receipts (account, messageId, readAt, kind) VALUES ('personal', 'm1', ?, 'gift')").run(NOW)).toThrow(/CHECK/);
    expect(() => db.prepare("INSERT INTO inbox_receipts (account, messageId, readAt, statedCadence) VALUES ('personal', 'm2', ?, 'daily')").run(NOW)).toThrow(/CHECK/);
    expect(() =>
      db.prepare("INSERT INTO inbox_subscriptions (account, merchantKey, merchant, sourceMessageId, updatedAt, cadenceSource) VALUES ('personal', 'k', 'K', 'm1', ?, 'guess')").run(NOW),
    ).toThrow(/CHECK/);
  });

  it('the views give the new fields', () => {
    const db = openDb(':memory:');
    const stats = { accounts: [{ alias: 'personal', listed: 3, read: 3, capped: false, person: 1, list: 1, automated: 1, hidden: 2, error: null }], droppedDates: 1 };
    db.prepare("INSERT INTO inbox_digests (day, createdAt, shortText, stats) VALUES ('2026-10-19', ?, 'x', ?)").run(NOW, JSON.stringify(stats));
    db.prepare("INSERT INTO inbox_digests (day, createdAt, shortText) VALUES ('2026-10-18', ?, 'y')").run(NOW);
    expect(getDigest(db, 1)?.stats).toEqual(stats);
    expect(getDigest(db, 2)?.stats).toBeNull();
    db.prepare(
      "INSERT INTO inbox_subscriptions (account, merchantKey, merchant, sourceMessageId, updatedAt, cadenceSource, reasons) VALUES ('personal', 'k', 'K', 'm1', ?, 'both', '[\"3 charges a month apart\"]')",
    ).run(NOW);
    expect(listSubscriptions(db, {}).subscriptions[0]).toMatchObject({ cadenceSource: 'both', reasons: ['3 charges a month apart'] });
    db.prepare("INSERT INTO inbox_proposals (account, kind, title, startAt, dedupeKey, createdAt, dueText) VALUES ('school', 'course', 't', ?, 'd', ?, 'due Friday, October 24')").run(NOW, NOW);
    expect(getProposal(db, 1)?.dueText).toBe('due Friday, October 24');
  });
});

describe('the account helpers', () => {
  it('cover every account of the config in its order, with the address of the sign-in first', () => {
    const db = openDb(':memory:');
    const config = { accounts: [{ alias: 'personal' }, { alias: 'school', email: 'Owner@School.example.edu' }, { alias: 'club' }] };
    db.prepare("INSERT INTO google_accounts (alias, email, updatedAt) VALUES ('personal', 'Owner.Personal@example.com', ?), ('club', NULL, ?)").run(NOW, NOW);
    expect(inboxAccounts(db, config)).toEqual([
      { alias: 'personal', email: 'owner.personal@example.com' },
      { alias: 'school', email: 'owner@school.example.edu' },
      { alias: 'club', email: null },
    ]);
    expect([...ownerAddresses(db, config)].sort()).toEqual(['owner.personal@example.com', 'owner@school.example.edu']);
  });
});
