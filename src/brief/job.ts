import type { JobResult } from '../scheduler/scheduler.js';
import { notBuilt, type BriefContext } from './context.js';

// the job of the brief automation. it runs in code in the session brief:<runId>, without a model call.

// the task of the run, its first event, so the trace and the reviewer read what the run may do.
export const BRIEF_TASK =
  'The morning brief of the owner. It reads the calendars, the latest inbox digest, the calendar proposals, the delegations and the goals of today, stores the brief, and sends the owner a short message with a link. It changes nothing.';

// the link of the telegram message: the today page of the day.
export const briefLink = (dashboardUrl: string, day: string) => `${dashboardUrl}/#/today/${day}`;

// runBriefJob builds the brief of the local day of now, stores it, sends the short text to the owner and records the
// delivery. a brief that could not be sent is still stored, and the job completes with a note.
export async function runBriefJob(ctx: BriefContext): Promise<JobResult> {
  return notBuilt('runBriefJob');
}
