import type { Config } from '../config/schema.js';
import type { Db } from '../db/index.js';

// the time of the digest. phase 5 installed it at 07:30, the time that phase 6 gives the morning brief, so the digest
// moves to 07:00 and the brief can read it. the work package "schedule" builds this module and calls it from
// installInboxJobs of inbox.ts.

// the cron expression of the digest from phase 6 on.
export const DIGEST_EXPR = '0 7 * * *';
// the expression that phase 5 installed.
export const OLD_DIGEST_EXPR = '30 7 * * *';

// moveDigestBeforeBrief moves the system digest automation from 07:30 to 07:00 one time. it changes the automation
// only when the system made it and the owner did not change its schedule (it is still OLD_DIGEST_EXPR), and it
// records in a setting that the move ran, so a later change of the owner back to 07:30 stays. it gives true when it
// moved the automation.
export function moveDigestBeforeBrief(_db: Db, _config: Pick<Config, 'timeZone'>, _now: Date): boolean {
  throw new Error('not built: moveDigestBeforeBrief (work package schedule)');
}
