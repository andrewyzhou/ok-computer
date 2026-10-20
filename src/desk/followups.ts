import type { JobResult } from '../scheduler/scheduler.js';
import type { DeskContext } from './context.js';

// the follow-up job of the desk. the system automation "desk: follow-ups" (installDeskJobs in desk.ts) runs it every
// 15 minutes in code. the work package "follow-ups and nudge drafts" builds it:
// - it reads listFollowUpsDue(db, now). with none due it returns { status: 'skipped' } and writes no run.
// - otherwise it writes a runs row in the session desk:followups:<runId> with a task event first, as the inbox jobs do
//   (src/inbox/run.ts), and keeps the run in activeRuns while it works.
// - for each due delegation with a thread link in a google account that works, it reads the thread (read only), marks
//   the session with the taint of that mail, and looks for a message after waitingSince that the owner did not send.
//   a reply: reply_seen in the history, status open, the next step "Read the reply from <who>", no follow-up time.
//   no reply: a nudge draft through the desk_draft_nudge tool (nudge.ts) and the caller, nudge_drafted in the history,
//   and the next follow-up NUDGE_EVERY_MS later. after MAX_NUDGES nudges the delegation becomes blocked instead.
// - a delegation without a thread, or without google, gets follow_up_due and no follow-up time, and the owner is told.
// - at the end the owner gets one short message with the changes and their desk links, and none when nothing changed.
// nothing here sends mail.
export async function runFollowUps(_ctx: DeskContext): Promise<JobResult> {
  return { status: 'skipped', error: 'the desk follow-ups are not built yet' };
}
