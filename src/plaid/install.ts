import type { PlaidStatus } from '../dashboard/plaid-types.js';
import type { Db } from '../db/index.js';
import { listAutomations, type Automation } from '../scheduler/store.js';
import type { PlaidConfig } from './config.js';

// the automation of the daily sync: PLAID_AUTOMATION_NAME at plaid.syncAt each day in the time zone of the app, with
// the payload { type: 'plaid', job: 'sync' } and the slot utility. the app makes it one time, as installBrief does, so
// an automation that the owner deleted does not come back at the next start. the job skips when no bank is linked.

// gives true when it made the automation. the scaffold leaves it uninstalled until the sync is built, so the app runs
// as before; the sync package builds it with the setting plaid_sync_installed.
export function installPlaidSync(db: Db, config: { timeZone: string; plaid: PlaidConfig }, now: Date): boolean {
  void db;
  void config;
  void now;
  return false;
}

export function plaidAutomation(db: Db): Automation | undefined {
  return listAutomations(db).find((each) => each.payload.type === 'plaid');
}

// a cron of the form 'm h * * *' runs one time each day.
const DAILY = /^(\d{1,2}) (\d{1,2}) \* \* \*$/;

// the time comes from the cron of the automation, as briefSchedule of src/brief/install.ts reads it.
export function plaidSchedule(db: Db): PlaidStatus['schedule'] {
  const automation = plaidAutomation(db);
  if (!automation) return { automationId: null, time: null, enabled: false, nextRunAt: null };
  const match = automation.schedule.kind === 'cron' ? DAILY.exec(automation.schedule.expr.trim()) : null;
  const minute = Number(match?.[1]);
  const hour = Number(match?.[2]);
  const time = match && minute <= 59 && hour <= 23 ? `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}` : null;
  return { automationId: automation.id, time, enabled: automation.enabled, nextRunAt: automation.nextRunAt };
}
