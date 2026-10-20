import { randomUUID } from 'node:crypto';
import type { JobResult } from '../scheduler/scheduler.js';
import type { Tool } from '../tools/registry.js';
import { readCalendar, type CalendarRead } from './calendar.js';
import type { BriefContext, BriefDeps } from './context.js';
import { runBriefJob, type BriefTrigger } from './job.js';
import { createBriefTools } from './tools.js';

// the today track of phase 6 (t1): the morning brief, and the calendar that the today and calendar pages read. app.ts
// makes one of these for every app, with or without a google block.
export interface Today {
  tools: Tool[];
  // the events of every shown calendar of every account between two times.
  calendar(range: { startAt: Date; endAt: Date }): Promise<CalendarRead>;
  // the job of the brief automation. a brief that builds already is skipped, so a second start gives skipped. trigger
  // is automation from the scheduler and dashboard when the owner starts it there.
  runBrief(trigger?: BriefTrigger): Promise<JobResult>;
  running(): boolean;
}

export function createToday(deps: BriefDeps): Today {
  const ctx: BriefContext = { ...deps, newId: deps.newId ?? randomUUID };
  let running = false;
  return {
    tools: createBriefTools(ctx),
    calendar: (range) => readCalendar(ctx, range),
    async runBrief(trigger = 'automation') {
      // two briefs at once would send the owner two messages.
      if (running) return { status: 'skipped', error: 'the brief is already being built' };
      running = true;
      try {
        return await runBriefJob(ctx, undefined, trigger);
      } finally {
        running = false;
      }
    },
    running: () => running,
  };
}
