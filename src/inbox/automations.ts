import type { InboxJob } from '../dashboard/types.js';
import type { Db } from '../db/index.js';
import { listAutomations, type Automation } from '../scheduler/store.js';

// the automations of the inbox jobs and the time of the digest. inbox.ts installs them and schedule.ts moves the
// digest, and both read this module, which imports no other module of the inbox.

// the cron expression of the digest from phase 6 on: 07:00, before the morning brief at 07:30.
export const DIGEST_EXPR = '0 7 * * *';
// the expression that phase 5 installed.
export const OLD_DIGEST_EXPR = '30 7 * * *';

// the automation of a job, for POST /api/inbox/run.
export function inboxAutomation(db: Db, job: InboxJob): Automation | undefined {
  return listAutomations(db).find((each) => each.payload.type === 'inbox' && each.payload.job === job);
}
