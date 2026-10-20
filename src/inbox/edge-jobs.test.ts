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

describe('the job runs', () => {
  it('skips a second run of a job while the first one works, and keeps the run live', async () => {
    h = await createInboxHarness({ accounts: ['personal'] });
    answerSearch(h);
    const live = new Set<string>();
    h.ctx.activeRuns = live;
    // the inbox of the harness copied ctx, so a new inbox gets the live set.
    const { createInbox } = await import('./inbox.js');
    const inbox = createInbox(h.ctx);
    h.google.fake.deliver('personal', listMail('p1'));
    const seen: number[] = [];
    h.google.fake.search = (_alias, q, messages) => {
      seen.push(live.size);
      return q === SWEEP_QUERY ? messages : [];
    };
    const [first, second] = await Promise.all([inbox.runJob('newsletters'), inbox.runJob('newsletters')]);
    expect(first.status).toBe('completed');
    expect(second).toEqual({ status: 'skipped', error: 'the newsletters job is already running' });
    expect(seen).toEqual([1]);
    expect(live.size).toBe(0);
    expect(inbox.running('newsletters')).toBe(false);
    expect((await inbox.runJob('newsletters')).status).toBe('completed');
  });

  it('fails the scan and the digest when no account could be read, and stores no empty digest', async () => {
    h = await createInboxHarness({ accounts: ['personal'] });
    answerSearch(h);
    h.google.fake.fault({ route: 'GET /gmail/v1/users/me/messages', status: 400 });
    const scan = await h.run('subscriptions');
    expect(scan.status).toBe('failed');
    expect(scan.error).toContain('personal: the receipts could not be read');
    const digest = await h.run('digest');
    expect(digest.status).toBe('failed');
    expect(h.rows('SELECT * FROM inbox_digests')).toEqual([]);
  });
});
