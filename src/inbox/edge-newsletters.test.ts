import { afterEach, describe, expect, it } from 'vitest';
import { createInboxHarness, hostileMail, listMail, type InboxHarness } from '../../test/inbox-harness.js';
import type { FakeMessage } from '../../test/fake-google.js';
import type { DigestItem } from '../dashboard/types.js';
import { toolStep } from '../models/fake.js';
import { shortTextOf } from './digest.js';
import { proposeEvent } from './proposals.js';
import { markRead, mailSource, startRun } from './run.js';
import { ARCHIVE_TOOL, keepSender, requestArchive, requestUnsubscribe, SWEEP_QUERY } from './newsletters.js';
import { cadenceOf, merchantKeyOf, RECEIPT_QUERY, requestCancel } from './subscriptions.js';
import { decodeCursor, encodeCursor, InvalidCursor, listSenders } from './views.js';

// edge cases of the inbox jobs: races, rows that change while an approval waits, odd input and hostile mail. the cases
// are split by area, so the work package of each area owns its file.

let h: InboxHarness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

// the fake does not parse gmail search syntax, so this answers the sweep and the archive queries.
function answerSearch(harness: InboxHarness) {
  harness.google.fake.search = (_alias, q, messages) => {
    if (q === SWEEP_QUERY) return messages;
    if (q === RECEIPT_QUERY) return messages;
    if (!q.startsWith('in:inbox')) return [];
    return messages.filter((each) => (each.labelIds ?? ['INBOX']).includes('INBOX'));
  };
}

describe('the sender actions under a race', () => {
  it('asks the owner one time when two archives of one sender come at once', async () => {
    h = await createInboxHarness({ accounts: ['personal'] });
    answerSearch(h);
    h.google.fake.deliver('personal', listMail('p1', { date: '2026-08-01T00:00:00Z' }));
    await h.run('newsletters');
    const results = await Promise.all([requestArchive(h.ctx, 1, { olderThanDays: 30 }), requestArchive(h.ctx, 1, { olderThanDays: 30 })]);
    expect(results.filter((each) => each.ok)).toHaveLength(1);
    expect(h.rows('SELECT COUNT(*) AS n FROM approvals WHERE toolName = ?', ARCHIVE_TOOL)).toEqual([{ n: 1 }]);
  });

  it('keeps a kept sender kept, and a second keep is still done', async () => {
    h = await createInboxHarness({ accounts: ['personal'] });
    answerSearch(h);
    h.google.fake.deliver('personal', listMail('p1'));
    await h.run('newsletters');
    expect(keepSender(h.ctx, 1)).toMatchObject({ ok: true });
    expect(keepSender(h.ctx, 1)).toMatchObject({ ok: true, response: { status: 'done' } });
    expect(h.rows('SELECT state FROM inbox_senders')).toEqual([{ state: 'kept' }]);
  });
});

describe('a hostile list id', () => {
  it('cannot widen the archive to the mail of another sender', async () => {
    h = await createInboxHarness({ accounts: ['personal'] });
    // the fake answers every archive query with all of the inbox, as a search that the list id widened would.
    answerSearch(h);
    h.google.fake.deliver('personal', listMail('e1', { from: 'Evil <x@evil.example>', listId: '<a.example OR from:bank.example>', date: '2026-08-01T00:00:00Z' }));
    const bank: FakeMessage = {
      id: 'b1',
      labelIds: ['INBOX'],
      internalDate: String(Date.parse('2026-08-01T00:00:00Z')),
      snippet: 'statement',
      body: 'Your statement is ready.',
      headers: { From: 'Bank <alerts@bank.example>', Subject: 'Statement', 'List-Id': '<alerts.bank.example>', 'List-Unsubscribe': '<https://bank.example/u>' },
    };
    h.google.fake.deliver('personal', bank);
    await h.run('newsletters');
    const id = Number(h.rows("SELECT id FROM inbox_senders WHERE fromAddress = 'x@evil.example'")[0]!.id);
    const result = await requestArchive(h.ctx, id, { olderThanDays: 30 });
    expect(result).toMatchObject({ ok: true, response: { status: 'pending_approval' } });
    if (!result.ok) return;
    await h.approve(result.response.approvalId!);
    const box = h.google.fake.mailbox('personal');
    expect(box.messages.get('e1')!.labelIds).not.toContain('INBOX');
    expect(box.messages.get('b1')!.labelIds).toContain('INBOX');
  });
});

describe('the hostile mail in the sweep', () => {
  it('asks for no approval and sends nothing when the sweep reads it', async () => {
    h = await createInboxHarness({ accounts: ['personal'] });
    answerSearch(h);
    h.google.fake.deliver('personal', hostileMail('h1'));
    h.google.fake.deliver('personal', listMail('p1'));
    await h.run('newsletters');
    await h.ctx.queue.drain();
    expect(h.rows('SELECT * FROM approvals')).toEqual([]);
    expect(h.oneClicks).toEqual([]);
    expect(h.agentRuns).toEqual([]);
    expect(h.google.fake.sent).toEqual([]);
    expect(h.rows('SELECT * FROM tool_calls')).toEqual([]);
    // the session of the run is tainted with the mail, so a later call in it is a call of a tainted session.
    const run = h.rows("SELECT sessionKey FROM runs WHERE sessionKey LIKE 'inbox:newsletters:%'")[0]!;
    const events = h.rows("SELECT payload FROM events WHERE sessionKey = ? AND type = 'system_event'", String(run.sessionKey));
    expect(JSON.stringify(events)).toContain('gmail:personal');
  });
});

describe('the sender cursor', () => {
  it('round trips and refuses a cursor that it did not make', () => {
    expect(decodeCursor(encodeCursor({ v: 0.25, id: 3 }))).toEqual({ v: 0.25, id: 3 });
    expect(decodeCursor(encodeCursor({ v: null, id: 1 }))).toEqual({ v: null, id: 1 });
    for (const bad of [
      Buffer.from('{"v":1,"id":0}').toString('base64url'),
      Buffer.from('{"v":1,"id":1.5}').toString('base64url'),
      Buffer.from('{"v":{},"id":1}').toString('base64url'),
      Buffer.from('[1,2]').toString('base64url'),
      Buffer.from('null').toString('base64url'),
      Buffer.from(`{"v":1,"id":${2 ** 60}}`).toString('base64url'),
    ]) {
      expect(() => decodeCursor(bad), bad).toThrow(InvalidCursor);
    }
  });

  it('refuses a cursor of another sort', async () => {
    h = await createInboxHarness({ accounts: ['personal'] });
    const lastAt = encodeCursor({ v: '2026-10-10T00:00:00.000Z', id: 5 });
    expect(() => listSenders(h!.ctx.db, { sort: 'messages', cursor: lastAt, limit: 10 }, ['personal'])).toThrow(InvalidCursor);
    const count = encodeCursor({ v: 4, id: 5 });
    expect(() => listSenders(h!.ctx.db, { sort: 'lastAt', cursor: count, limit: 10 }, ['personal'])).toThrow(InvalidCursor);
  });

  it('pages each sort one row at a time without a gap or a repeat', async () => {
    h = await createInboxHarness({ accounts: ['personal'] });
    const insert = h.ctx.db.prepare(
      "INSERT INTO inbox_senders (account, senderKey, fromAddress, messages, read, firstAt, lastAt, updatedAt) VALUES ('personal', ?, ?, ?, ?, ?, ?, ?)",
    );
    // ties in each sort value, and two senders with no messages.
    const rows: Array<[number, number, string]> = [
      [4, 1, '2026-10-01T00:00:00.000Z'],
      [4, 1, '2026-10-01T00:00:00.000Z'],
      [0, 0, '2026-10-02T00:00:00.000Z'],
      [3, 3, '2026-10-03T00:00:00.000Z'],
      [0, 0, '2026-10-01T00:00:00.000Z'],
      [10, 1, '2026-10-05T00:00:00.000Z'],
      [3, 1, '2026-10-05T00:00:00.000Z'],
    ];
    rows.forEach(([messages, read, at], index) => insert.run(`s${index}`, `s${index}@x.example`, messages, read, at, at, at));
    for (const sort of ['messages', 'readRate', 'lastAt'] as const) {
      const whole = listSenders(h.ctx.db, { sort, limit: 100 }, ['personal']).senders.map((each) => each.id);
      const seen: number[] = [];
      let cursor: string | undefined;
      for (let pages = 0; pages < 20; pages++) {
        const page = listSenders(h.ctx.db, { sort, limit: 1, ...(cursor ? { cursor } : {}) }, ['personal']);
        seen.push(...page.senders.map((each) => each.id));
        if (!page.nextCursor) break;
        cursor = page.nextCursor;
      }
      expect(seen, sort).toEqual(whole);
      expect(new Set(seen).size).toBe(rows.length);
    }
  });
});

describe('the unsubscribe of a sender that the owner cannot reach', () => {
  it('refuses a cancel of an unknown subscription and an unsubscribe of an unknown sender', async () => {
    h = await createInboxHarness({ accounts: ['personal'] });
    expect(await requestCancel(h.ctx, 1)).toEqual({ ok: false, status: 404, error: 'subscription not found' });
    expect(await requestUnsubscribe(h.ctx, 1)).toEqual({ ok: false, status: 404, error: 'sender not found' });
    expect(merchantKeyOf('Stream Co.')).toBe('streamco');
  });
});

describe('a hostile sender key', () => {
  it('cannot join the group of another sender with a "#" in its headers', async () => {
    h = await createInboxHarness({ accounts: ['personal'] });
    answerSearch(h);
    const shared = '<a1b2c3.list-id.mailplatform.example>';
    h.google.fake.deliver('personal', listMail('d1', { from: 'Daily <news@dailybrief.example>', listId: shared, date: '2026-08-01T00:00:00Z' }));
    h.google.fake.deliver('personal', listMail('t1', { from: 'Jazz via Tickets <noreply@tickets.example>', listId: '', date: '2026-08-01T00:00:00Z' }));
    // a list id that is the key of the first sender, from a domain that ends like it.
    h.google.fake.deliver(
      'personal',
      listMail('e1', { from: 'Evil <x@a.example#dailybrief.example>', listId: '<a1b2c3.list-id.mailplatform.example#dailybrief.example>', date: '2026-08-01T00:00:00Z' }),
    );
    // an address that is the key of the second sender.
    h.google.fake.deliver('personal', listMail('e2', { from: 'Evil <noreply@tickets.example#jazz>', listId: '', date: '2026-08-01T00:00:00Z' }));
    await h.run('newsletters');
    const rows = h.rows('SELECT senderKey, fromAddress, messages FROM inbox_senders ORDER BY senderKey');
    expect(rows).toHaveLength(4);
    expect(rows.every((each) => each.messages === 1)).toBe(true);
    const daily = rows.find((each) => each.fromAddress === 'news@dailybrief.example')!;
    expect(daily.senderKey).toBe('a1b2c3.list-id.mailplatform.example#dailybrief.example');
    const id = Number(h.rows('SELECT id FROM inbox_senders WHERE senderKey = ?', String(daily.senderKey))[0]!.id);
    const result = await requestArchive(h.ctx, id, { olderThanDays: 30 });
    if (!result.ok) throw new Error(result.error);
    await h.approve(result.response.approvalId!);
    const box = h.google.fake.mailbox('personal');
    expect(box.messages.get('d1')!.labelIds).not.toContain('INBOX');
    for (const other of ['t1', 'e1', 'e2']) expect(box.messages.get(other)!.labelIds, other).toContain('INBOX');
  });

  it('keeps a list id longer than 200 characters at 200, and finds the same row in the next sweep', async () => {
    h = await createInboxHarness({ accounts: ['personal'] });
    answerSearch(h);
    const long = `<${'a'.repeat(300)}.platform.example>`;
    h.google.fake.deliver('personal', listMail('l1', { from: 'One <one@first.example>', listId: long }));
    h.google.fake.deliver('personal', listMail('l2', { from: 'Two <two@second.example>', listId: long }));
    await h.run('newsletters');
    await h.run('newsletters');
    const rows = h.rows('SELECT senderKey, listId, messages FROM inbox_senders');
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(String(row.senderKey).length).toBeLessThanOrEqual(200);
      expect(row).toMatchObject({ listId: 'a'.repeat(200), messages: 1 });
    }
  });
});
