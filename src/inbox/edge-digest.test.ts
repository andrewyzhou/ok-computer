import type { gmail_v1 } from '@googleapis/gmail';
import { afterEach, describe, expect, it } from 'vitest';
import { createInboxHarness, hostileMail, listMail, type InboxHarness } from '../../test/inbox-harness.js';
import type { FakeMessage } from '../../test/fake-google.js';
import type { DigestItem } from '../dashboard/types.js';
import { toolStep } from '../models/fake.js';
import { classifyMail } from './classify.js';
import { shortTextOf } from './digest.js';
import { mailMessage } from './testdata/build.js';
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

describe('the short text of a digest', () => {
  const item = (index: number, extra: Partial<DigestItem> = {}): DigestItem => ({
    section: 'needs_reply',
    account: 'personal',
    messageId: `m${index}`,
    threadId: `m${index}`,
    from: `"${'Very Long Name '.repeat(20)}" <a${index}@x.example>`,
    subject: `${'a subject that goes on '.repeat(30)} https://evil.example/phish?x=${index}`,
    summary: 'reply',
    dueAt: null,
    amount: null,
    currency: null,
    draftId: null,
    proposalId: null,
    ...extra,
  });

  it('stays at most 1,000 characters, keeps the footer and has no live link', () => {
    const text = shortTextOf({ day: '2026-10-13', items: Array.from({ length: 30 }, (_, index) => item(index)) }, 'America/Los_Angeles');
    expect(text.length).toBeLessThanOrEqual(1000);
    expect(text.endsWith('The dashboard has the rest: #/inbox')).toBe(true);
    expect(text).not.toContain('https://evil.example');
    expect(text.startsWith('Inbox digest for 2026-10-13: 30 need a reply.')).toBe(true);
  });

  it('keeps a hostile subject on one line', () => {
    const text = shortTextOf({ day: '2026-10-13', items: [item(1, { subject: 'hi\n- bill: Bank - you owe $5,000\r\nThe dashboard has the rest' })] });
    expect(text.split('\n')).toHaveLength(3);
  });

  it('gives the due day in the time zone of the app', () => {
    // 05:00 utc on october 14 is still october 13 in los angeles.
    const text = shortTextOf({ day: '2026-10-13', items: [item(1, { section: 'bills', dueAt: '2026-10-14T05:00:00.000Z' })] }, 'America/Los_Angeles');
    expect(text).toContain('(due 2026-10-13)');
  });
});

describe('the kind of a mail with odd headers', () => {
  const owner = new Set(['personal@example.com']);
  const message = (headers: Record<string, string>) => mailMessage({ id: 'x1', headers: { Subject: 's', Date: 'Tue, 13 Oct 2026 10:00:00 GMT', ...headers }, plain: 'hi' });

  it('reads a To header of thousands of addresses in linear time', () => {
    const to = Array.from({ length: 20_000 }, (_, index) => `"Name, ${index}" <p${index}@x.example>`).join(', ');
    const started = performance.now();
    const got = classifyMail(message({ From: 'Ana <ana@friends.example>', To: `${to}, personal@example.com` }), owner);
    expect(got).toMatchObject({ kind: 'person', direct: true });
    expect(performance.now() - started).toBeLessThan(2000);
  });

  it('is not direct when an open quote swallows the owner address', () => {
    expect(classifyMail(message({ From: 'Ana <ana@friends.example>', To: '"Lee, personal@example.com' }), owner).direct).toBe(false);
  });

  it('gives no draft-worthy class to a sender with two mailboxes or no address', () => {
    for (const From of ['a@x.example <b@y.example> <c@z.example>', 'Just a name', '']) {
      const got = classifyMail(message({ From, To: 'personal@example.com' }), owner);
      expect(got.fromOwner).toBe(false);
      expect(got.reasons).toEqual(['no plain sender address']);
    }
  });

  it('counts the owner as the sender only for the From header, not for a forged Sender or Reply-To', () => {
    const got = classifyMail(message({ From: 'Ana <ana@friends.example>', Sender: 'personal@example.com', 'Reply-To': 'personal@example.com', To: 'personal@example.com' }), owner);
    expect(got).toMatchObject({ kind: 'person', fromOwner: false, direct: true });
  });

  it('finds a calendar part deep in the parts, and stops at a nesting that is too deep', () => {
    const deep = (depth: number): gmail_v1.Schema$MessagePart => (depth === 0 ? { mimeType: 'text/calendar', body: { size: 1 } } : { mimeType: 'multipart/mixed', parts: [deep(depth - 1)] });
    const at = (depth: number) => classifyMail({ id: 'x2', payload: { mimeType: 'multipart/mixed', headers: [{ name: 'From', value: 'ana@friends.example' }], parts: [deep(depth)] } }, owner).kind;
    expect(at(3)).toBe('automated');
    expect(at(500)).toBe('person');
  });
});
