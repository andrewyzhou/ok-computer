import { describe, expect, it } from 'vitest';
import { openDb, type Db } from '../db/index.js';
import { getSetting, setSetting } from '../db/settings.js';
import { createAutomation, deleteAutomation, updateAutomation } from '../scheduler/store.js';
import { inboxAutomation, installInboxJobs } from './inbox.js';
import { DIGEST_EXPR, MOVED, moveDigestBeforeBrief, OLD_DIGEST_EXPR } from './schedule.js';

// the digest moves from 07:30 to 07:00, before the morning brief, one time and only when the owner did not change it.

// 09:00 in los angeles, so the next 07:00 is the next morning.
const NOW = new Date('2026-10-13T16:00:00Z');
const LATER = new Date('2026-10-15T16:00:00Z');
const TZ = 'America/Los_Angeles';
const config = { timeZone: TZ };

// the state that phase 5 left: the three automations, with the digest at 07:30, and no record of the move.
function phase5(db: Db, createdBy: 'system' | 'owner' = 'system', expr = OLD_DIGEST_EXPR): string {
  const created = createAutomation(
    db,
    { name: 'inbox: daily digest', schedule: { kind: 'cron', expr, tz: TZ }, payload: { type: 'inbox', job: 'digest' }, slot: 'utility', createdBy },
    NOW,
    TZ,
  );
  if (!created.ok) throw new Error(created.error);
  setSetting(db, 'inbox_jobs_installed', true, NOW);
  return created.value.id;
}

describe('moveDigestBeforeBrief', () => {
  it('moves the digest of a phase 5 install to 07:00 one time and records it', () => {
    const db = openDb(':memory:');
    phase5(db);
    expect(inboxAutomation(db, 'digest')!.nextRunAt).toBe('2026-10-14T14:30:00.000Z');
    expect(moveDigestBeforeBrief(db, config, NOW)).toBe(true);
    const digest = inboxAutomation(db, 'digest')!;
    expect(digest.schedule).toEqual({ kind: 'cron', expr: DIGEST_EXPR, tz: TZ });
    // nextRunAt follows the new time: 07:00 in los angeles is 14:00 utc in october.
    expect(digest.nextRunAt).toBe('2026-10-14T14:00:00.000Z');
    expect(getSetting(db, MOVED)).toBe(true);
    expect(moveDigestBeforeBrief(db, config, LATER)).toBe(false);
    expect(inboxAutomation(db, 'digest')!.updatedAt).toBe(NOW.toISOString());
  });

  it('keeps a time that the owner chose, and records that the check ran', () => {
    const db = openDb(':memory:');
    phase5(db, 'system', '0 8 * * *');
    expect(moveDigestBeforeBrief(db, config, NOW)).toBe(false);
    expect(inboxAutomation(db, 'digest')!.schedule).toEqual({ kind: 'cron', expr: '0 8 * * *', tz: TZ });
    expect(getSetting(db, MOVED)).toBe(true);
  });

  it('keeps a digest automation that the owner made, also at 07:30', () => {
    const db = openDb(':memory:');
    phase5(db, 'owner');
    expect(moveDigestBeforeBrief(db, config, NOW)).toBe(false);
    expect(inboxAutomation(db, 'digest')!.schedule).toMatchObject({ expr: OLD_DIGEST_EXPR });
  });

  it('keeps the time zone of the automation', () => {
    const db = openDb(':memory:');
    const id = phase5(db);
    updateAutomation(db, id, { schedule: { kind: 'cron', expr: OLD_DIGEST_EXPR, tz: 'Europe/Berlin' } }, NOW, TZ);
    expect(moveDigestBeforeBrief(db, config, NOW)).toBe(true);
    // 07:00 in berlin is 05:00 utc in october (summer time ends on october 25).
    expect(inboxAutomation(db, 'digest')).toMatchObject({ schedule: { kind: 'cron', expr: DIGEST_EXPR, tz: 'Europe/Berlin' }, nextRunAt: '2026-10-14T05:00:00.000Z' });
  });

  it('never makes a digest that the owner deleted', () => {
    const db = openDb(':memory:');
    deleteAutomation(db, phase5(db));
    expect(moveDigestBeforeBrief(db, config, NOW)).toBe(false);
    expect(inboxAutomation(db, 'digest')).toBeUndefined();
    expect(installInboxJobs(db, config, LATER)).toBe(false);
    expect(inboxAutomation(db, 'digest')).toBeUndefined();
    expect(getSetting(db, MOVED)).toBe(true);
  });
});

describe('installInboxJobs and the move', () => {
  it('moves a phase 5 digest on start, and keeps 07:30 when the owner sets it again', () => {
    const db = openDb(':memory:');
    const id = phase5(db);
    // the jobs were installed in phase 5, so the start installs nothing, but it still moves the digest.
    expect(installInboxJobs(db, config, NOW)).toBe(false);
    expect(inboxAutomation(db, 'digest')!.schedule).toMatchObject({ expr: DIGEST_EXPR });
    // the owner moves the digest back to 07:30 on the automations page, and the next start keeps it.
    updateAutomation(db, id, { schedule: { kind: 'cron', expr: OLD_DIGEST_EXPR, tz: TZ } }, NOW, TZ);
    expect(installInboxJobs(db, config, LATER)).toBe(false);
    expect(inboxAutomation(db, 'digest')).toMatchObject({ schedule: { expr: OLD_DIGEST_EXPR }, nextRunAt: '2026-10-14T14:30:00.000Z' });
  });

  it('gives a new install the digest at 07:00 at once', () => {
    const db = openDb(':memory:');
    expect(installInboxJobs(db, config, NOW)).toBe(true);
    expect(inboxAutomation(db, 'digest')).toMatchObject({ schedule: { kind: 'cron', expr: DIGEST_EXPR, tz: TZ }, createdBy: 'system', nextRunAt: '2026-10-14T14:00:00.000Z' });
    expect(getSetting(db, MOVED)).toBe(true);
    expect(installInboxJobs(db, config, LATER)).toBe(false);
    expect(inboxAutomation(db, 'digest')!.schedule).toMatchObject({ expr: DIGEST_EXPR });
  });
});
