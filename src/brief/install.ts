import type { Result } from '../config/load.js';
import type { Config } from '../config/schema.js';
import type { BriefSchedule } from '../dashboard/brief-types.js';
import type { Db } from '../db/index.js';
import type { Automation } from '../scheduler/store.js';
import { notBuilt } from './context.js';

// the automation of the brief: BRIEF_AUTOMATION_NAME at DEFAULT_BRIEF_TIME each day in the time zone of the app, with
// the payload { type: 'brief' }. the app makes it one time, and the owner moves it by chat (brief_set_time) or on the
// dashboard.

// installBrief makes the automation one time, as installInboxJobs does. an automation that the owner deleted does not
// come back at the next start. it gives true when it made the automation.
export function installBrief(db: Db, config: Pick<Config, 'timeZone'>, now: Date): boolean {
  // the scaffold installs nothing, so the app starts as before until the brief job is built.
  return false;
}

export function briefAutomation(db: Db): Automation | undefined {
  return notBuilt('briefAutomation');
}

export function briefSchedule(db: Db, timeZone: string, running: boolean): BriefSchedule {
  return notBuilt('briefSchedule');
}

// setBriefTime moves the brief to time (hh:mm, 00:00 to 23:59) each day and turns it on. it makes the automation again
// when the owner deleted it, because the owner asked for a brief at that time.
export function setBriefTime(db: Db, time: string, now: Date, timeZone: string): Result<BriefSchedule> {
  return notBuilt('setBriefTime');
}
