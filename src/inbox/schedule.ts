import type { Config } from '../config/schema.js';
import type { Db } from '../db/index.js';
import { getSetting, setSetting } from '../db/settings.js';
import { updateAutomation } from '../scheduler/store.js';
import { inboxAutomation } from './inbox.js';

// the time of the digest. phase 5 installed it at 07:30, the time that phase 6 gives the morning brief, so the digest
// moves to 07:00 and the brief can read it. installInboxJobs of inbox.ts calls moveDigestBeforeBrief on each start.
// inbox.ts imports this module too, so it reads the constants below only inside its functions.

// the cron expression of the digest from phase 6 on.
export const DIGEST_EXPR = '0 7 * * *';
// the expression that phase 5 installed.
export const OLD_DIGEST_EXPR = '30 7 * * *';

// the setting that records that the check of the move ran. it is set after the first check, also when nothing moved.
export const MOVED = 'inbox_digest_moved_0700';

// moveDigestBeforeBrief moves the system digest automation from 07:30 to 07:00 one time. it changes the automation
// only when the system made it and the owner did not change its schedule (it is still OLD_DIGEST_EXPR), and it
// records in a setting that the check ran, so a later change of the owner back to 07:30 stays. it gives true when it
// moved the automation. a missing automation stays missing, because the owner deleted it.
export function moveDigestBeforeBrief(db: Db, config: Pick<Config, 'timeZone'>, now: Date): boolean {
  if (getSetting(db, MOVED)) return false;
  const digest = inboxAutomation(db, 'digest');
  let moved = false;
  if (digest && digest.createdBy === 'system' && digest.schedule.kind === 'cron' && digest.schedule.expr === OLD_DIGEST_EXPR) {
    // the automation keeps its own time zone, and updateAutomation computes nextRunAt again from the new schedule.
    const schedule = { kind: 'cron' as const, expr: DIGEST_EXPR, ...(digest.schedule.tz === undefined ? {} : { tz: digest.schedule.tz }) };
    const updated = updateAutomation(db, digest.id, { schedule }, now, config.timeZone);
    if (!updated.ok) throw new Error(`the inbox digest could not move to 07:00: ${updated.error}`);
    moved = true;
  }
  setSetting(db, MOVED, true, now);
  return moved;
}
