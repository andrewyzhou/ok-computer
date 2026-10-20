import type { Config } from '../config/schema.js';
import type { Db } from '../db/index.js';
import { getSetting, setSetting } from '../db/settings.js';
import type { Logger } from '../observability/logger.js';
import { updateAutomation } from '../scheduler/store.js';
import { DIGEST_EXPR, inboxAutomation, OLD_DIGEST_EXPR } from './automations.js';

// the time of the digest. phase 5 installed it at 07:30, the time that phase 6 gives the morning brief, so the digest
// moves to 07:00 and the brief can read it. installInboxJobs of inbox.ts calls moveDigestBeforeBrief on each start.

export { DIGEST_EXPR, OLD_DIGEST_EXPR } from './automations.js';

// the setting that records that the check of the move ran. it is set after the first check, also when nothing moved.
export const MOVED = 'inbox_digest_moved_0700';

// moveDigestBeforeBrief moves the system digest automation from 07:30 to 07:00 one time. it changes the automation
// only when the system made it and the owner did not change its schedule (it is still OLD_DIGEST_EXPR), and it
// records in a setting that the check ran, so a later change of the owner back to 07:30 stays. it gives true when it
// moved the automation. a missing automation stays missing, because the owner deleted it.
//
// a move that fails never stops the start of the app: it logs a warning, leaves the digest at 07:30 and the setting
// unset, and the next start tries again.
export function moveDigestBeforeBrief(db: Db, config: Pick<Config, 'timeZone'>, now: Date, logger?: Pick<Logger, 'warn'>): boolean {
  if (getSetting(db, MOVED)) return false;
  const digest = inboxAutomation(db, 'digest');
  let moved = false;
  if (digest && digest.createdBy === 'system' && digest.schedule.kind === 'cron' && digest.schedule.expr === OLD_DIGEST_EXPR) {
    // the automation keeps its own time zone, and updateAutomation computes nextRunAt again from the new schedule.
    const schedule = { kind: 'cron' as const, expr: DIGEST_EXPR, ...(digest.schedule.tz === undefined ? {} : { tz: digest.schedule.tz }) };
    let updated: ReturnType<typeof updateAutomation>;
    try {
      updated = updateAutomation(db, digest.id, { schedule }, now, config.timeZone);
    } catch (err) {
      logger?.warn('the inbox digest could not move to 07:00, so it stays at 07:30 until the next start', { err });
      return false;
    }
    if (!updated.ok) {
      logger?.warn('the inbox digest could not move to 07:00, so it stays at 07:30 until the next start', { error: updated.error });
      return false;
    }
    moved = true;
  }
  setSetting(db, MOVED, true, now);
  return moved;
}
