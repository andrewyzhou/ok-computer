import type { Result } from '../config/load.js';
import type { Config } from '../config/schema.js';
import type { BriefSchedule } from '../dashboard/brief-types.js';
import type { Db } from '../db/index.js';
import { getSetting, setSetting } from '../db/settings.js';
import { dailyCron } from '../goals/routine.js';
import { createAutomation, listAutomations, updateAutomation, type Automation } from '../scheduler/store.js';
import { BRIEF_AUTOMATION_NAME, DEFAULT_BRIEF_TIME } from './context.js';

// the automation of the brief: BRIEF_AUTOMATION_NAME at DEFAULT_BRIEF_TIME each day in the time zone of the app, with
// the payload { type: 'brief' }. the app makes it one time, and the owner moves it by chat (brief_set_time) or on the
// dashboard.

const INSTALLED = 'brief_installed';

export const BRIEF_TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

// a cron of the form 'm h * * *' runs one time each day.
const DAILY = /^(\d{1,2}) (\d{1,2}) \* \* \*$/;

function create(db: Db, time: string, now: Date, timeZone: string): Result<Automation> {
  return createAutomation(
    db,
    {
      name: BRIEF_AUTOMATION_NAME,
      schedule: { kind: 'cron', expr: dailyCron(time), tz: timeZone },
      payload: { type: 'brief' },
      slot: 'utility',
      createdBy: 'system',
    },
    now,
    timeZone,
  );
}

// installBrief makes the automation one time, as installInboxJobs does. an automation that the owner deleted does not
// come back at the next start. it gives true when it made the automation.
export function installBrief(db: Db, config: Pick<Config, 'timeZone'>, now: Date): boolean {
  if (getSetting(db, INSTALLED)) return false;
  let made = false;
  if (!briefAutomation(db)) {
    const created = create(db, DEFAULT_BRIEF_TIME, now, config.timeZone);
    if (!created.ok) throw new Error(`the brief automation "${BRIEF_AUTOMATION_NAME}" is invalid: ${created.error}`);
    made = true;
  }
  setSetting(db, INSTALLED, true, now);
  return made;
}

export function briefAutomation(db: Db): Automation | undefined {
  return listAutomations(db).find((each) => each.payload.type === 'brief');
}

// the time of a schedule that runs one time each day, as hh:mm, or null for any other schedule.
function dailyTime(automation: Automation): string | null {
  if (automation.schedule.kind !== 'cron') return null;
  const match = DAILY.exec(automation.schedule.expr.trim());
  if (!match) return null;
  const minute = Number(match[1]);
  const hour = Number(match[2]);
  if (minute > 59 || hour > 23) return null;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

// the time comes from the cron of the automation, which already holds the time zone of the app.
export function briefSchedule(db: Db, _timeZone: string, running: boolean): BriefSchedule {
  const automation = briefAutomation(db);
  if (!automation) return { automationId: null, time: null, enabled: false, nextRunAt: null, running };
  return { automationId: automation.id, time: dailyTime(automation), enabled: automation.enabled, nextRunAt: automation.nextRunAt, running };
}

// setBriefTime moves the brief to time (hh:mm, 00:00 to 23:59) each day and turns it on. it makes the automation again
// when the owner deleted it, because the owner asked for a brief at that time. the caller plans the scheduler again.
export function setBriefTime(db: Db, time: string, now: Date, timeZone: string, running = false): Result<BriefSchedule> {
  if (!BRIEF_TIME.test(time)) return { ok: false, error: 'the time must be HH:MM, from 00:00 to 23:59' };
  const current = briefAutomation(db);
  const result = current
    ? updateAutomation(db, current.id, { schedule: { kind: 'cron', expr: dailyCron(time), tz: timeZone }, enabled: true }, now, timeZone)
    : create(db, time, now, timeZone);
  if (!result.ok) return result;
  return { ok: true, value: briefSchedule(db, timeZone, running) };
}
