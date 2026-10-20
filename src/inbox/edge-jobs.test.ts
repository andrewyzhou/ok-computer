import { afterEach, describe, expect, it } from 'vitest';
import { createInboxHarness, hostileMail, listMail, type InboxHarness } from '../../test/inbox-harness.js';
import type { FakeMessage } from '../../test/fake-google.js';
import type { DigestItem } from '../dashboard/types.js';
import { openDb, type Db } from '../db/index.js';
import { setSetting } from '../db/settings.js';
import { toolStep } from '../models/fake.js';
import type { Schedule } from '../scheduler/schedule.js';
import { createAutomation } from '../scheduler/store.js';
import { inboxAutomation, installInboxJobs } from './inbox.js';
import { DIGEST_EXPR, moveDigestBeforeBrief, OLD_DIGEST_EXPR } from './schedule.js';
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

describe('the move of the digest on start', () => {
  const NOW = new Date('2026-10-13T16:00:00Z');
  const TZ = 'America/Los_Angeles';

  function phase5Digest(db: Db, schedule: Schedule, enabled = true) {
    const created = createAutomation(db, { name: 'inbox: daily digest', schedule, payload: { type: 'inbox', job: 'digest' }, slot: 'utility', createdBy: 'system', enabled }, NOW, TZ);
    if (!created.ok) throw new Error(created.error);
    setSetting(db, 'inbox_jobs_installed', true, NOW);
  }

  it('moves a digest that the owner turned off, and it stays off', () => {
    const db = openDb(':memory:');
    phase5Digest(db, { kind: 'cron', expr: OLD_DIGEST_EXPR, tz: TZ }, false);
    expect(installInboxJobs(db, { timeZone: TZ }, NOW)).toBe(false);
    expect(inboxAutomation(db, 'digest')).toMatchObject({ schedule: { expr: DIGEST_EXPR }, enabled: false, nextRunAt: null });
  });

  it('keeps a digest whose schedule is not a cron, and a cron without a time zone keeps none', () => {
    const db = openDb(':memory:');
    phase5Digest(db, { kind: 'every', everyMs: 86_400_000 });
    expect(moveDigestBeforeBrief(db, { timeZone: TZ }, NOW)).toBe(false);
    expect(inboxAutomation(db, 'digest')!.schedule).toEqual({ kind: 'every', everyMs: 86_400_000 });

    const other = openDb(':memory:');
    phase5Digest(other, { kind: 'cron', expr: OLD_DIGEST_EXPR });
    expect(moveDigestBeforeBrief(other, { timeZone: TZ }, NOW)).toBe(true);
    // a cron without a zone runs in the zone of the app, so at 07:00 in los angeles.
    expect(inboxAutomation(other, 'digest')).toMatchObject({ schedule: { kind: 'cron', expr: DIGEST_EXPR }, nextRunAt: '2026-10-14T14:00:00.000Z' });
    expect('tz' in inboxAutomation(other, 'digest')!.schedule).toBe(false);
  });
});
