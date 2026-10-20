import { randomUUID } from 'node:crypto';
import type { Config } from '../config/schema.js';
import type { DeskJob } from '../dashboard/desk-types.js';
import type { Db } from '../db/index.js';
import { getSetting, setSetting } from '../db/settings.js';
import type { JobResult } from '../scheduler/scheduler.js';
import { createAutomation, listAutomations, type Automation } from '../scheduler/store.js';
import type { Tool } from '../tools/registry.js';
import type { DeskContext, DeskDeps } from './context.js';
import { runFollowUps } from './followups.js';
import { createNudgeTools } from './nudge.js';
import { createDeskTools } from './tools.js';

// the desk of phase 6 t3: the delegations that the owner hands off, their follow-ups and their nudge drafts. app.ts
// makes this object always, also without google, because the desk itself needs only the database.
export interface Desk {
  // the delegation tools of the sessions, and the nudge tool that only the follow-up job calls.
  tools: Tool[];
  // a job that runs already is skipped, so a second start gives { status: 'skipped' }.
  runJob(job: DeskJob): Promise<JobResult>;
  running(job: DeskJob): boolean;
}

export function createDesk(deps: DeskDeps): Desk {
  const ctx: DeskContext = { ...deps, newId: deps.newId ?? randomUUID };
  const jobs: Record<DeskJob, () => Promise<JobResult>> = { followups: () => runFollowUps(ctx) };
  const running = new Set<DeskJob>();
  return {
    tools: [...createDeskTools(ctx), ...createNudgeTools(ctx)],
    async runJob(job) {
      // two follow-up runs at one time could save two nudges for one follow-up.
      if (running.has(job)) return { status: 'skipped', error: `the ${job} job is already running` };
      running.add(job);
      try {
        return await jobs[job]();
      } finally {
        running.delete(job);
      }
    },
    running: (job) => running.has(job),
  };
}

const FOLLOW_UP_EVERY_MS = 15 * 60_000;
const INSTALLED = 'desk_jobs_installed';

// installDeskJobs makes the follow-up automation one time, as the inbox jobs do. the owner can change its interval
// or turn it off on the automations page, and the app never puts a deleted one back.
export function installDeskJobs(db: Db, config: Pick<Config, 'timeZone'>, now: Date): boolean {
  if (getSetting(db, INSTALLED)) return false;
  if (!deskAutomation(db, 'followups')) {
    const created = createAutomation(
      db,
      {
        name: 'desk: follow-ups',
        schedule: { kind: 'every', everyMs: FOLLOW_UP_EVERY_MS },
        payload: { type: 'desk', job: 'followups' },
        slot: 'utility',
        createdBy: 'system',
      },
      now,
      config.timeZone,
    );
    if (!created.ok) throw new Error(`the desk automation is invalid: ${created.error}`);
  }
  setSetting(db, INSTALLED, true, now);
  return true;
}

export function deskAutomation(db: Db, job: DeskJob): Automation | undefined {
  return listAutomations(db).find((each) => each.payload.type === 'desk' && each.payload.job === job);
}
