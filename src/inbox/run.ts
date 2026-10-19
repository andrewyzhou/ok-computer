import type { Slot } from '../config/schema.js';
import type { InboxJob } from '../dashboard/types.js';
import type { Db } from '../db/index.js';
import { appendEvent } from '../events/log.js';
import { redact } from '../observability/redact.js';
import type { TaintSource } from '../policy/policy.js';
import type { JobResult } from '../scheduler/scheduler.js';
import { errorText } from '../tools/registry.js';
import { requestContext } from '../google/trace.js';
import type { InboxContext, JobRun } from './context.js';

export const INBOX_PREFIX = 'inbox:';

// a job run has the session inbox:<job>:<runId>, and a dashboard action has inbox:action:<runId>.
export const sessionOf = (job: JobRun['job'], runId: string) => `${INBOX_PREFIX}${job}:${runId}`;

// the source name of the mail of one account, the same name that the google read tools use.
export const mailSource = (account: string) => `gmail:${account}`;
export const calendarSource = (account: string) => `calendar:${account}`;

// startRun writes the runs row before any request leaves, so each google request and each model call of the run is in
// its timeline.
export function startRun(ctx: InboxContext, job: JobRun['job'], slot: Slot): JobRun {
  const runId = ctx.newId();
  const sessionKey = sessionOf(job, runId);
  ctx.db
    .prepare("INSERT INTO runs (id, sessionKey, trigger, slot, status, startedAt) VALUES (?, ?, 'automation', ?, 'running', ?)")
    .run(runId, sessionKey, slot, ctx.clock().toISOString());
  return { job, runId, sessionKey };
}

export function endRun(ctx: InboxContext, run: JobRun, status: 'completed' | 'failed', note?: string): void {
  ctx.db.prepare('UPDATE runs SET status = ?, endedAt = ?, error = ? WHERE id = ?').run(status, ctx.clock().toISOString(), note ? redact(note) : null, run.runId);
}

// runJob gives the job its run and ends the run with the result. the google requests of the work carry the run id, so
// the run page shows them. an error of the work fails the job, and its text goes to the run and to the log.
export async function runJob(ctx: InboxContext, job: InboxJob, slot: Slot, work: (run: JobRun) => Promise<{ note?: string }>): Promise<JobResult> {
  const run = startRun(ctx, job, slot);
  try {
    const { note } = await requestContext.run({ runId: run.runId }, () => work(run));
    endRun(ctx, run, 'completed', note);
    return { status: 'completed', runId: run.runId, ...(note ? { error: note } : {}) };
  } catch (err) {
    ctx.logger.error('inbox job failed', { job, runId: run.runId, err });
    const text = `the ${job} job stopped: ${redact(errorText(err))}`;
    endRun(ctx, run, 'failed', text);
    return { status: 'failed', runId: run.runId, error: text };
  }
}

// markRead adds the taint of the mail that the run read to its session. each tool call of the run that comes after it
// is then a call of a tainted session: the policy and the approval card say so, as they do for the main session.
export function markRead(ctx: InboxContext, run: JobRun, sources: string[], toolName: string): void {
  const at = ctx.clock().toISOString();
  const taint: TaintSource[] = [...new Set(sources)].map((source) => ({ source, toolName, runId: run.runId, toolCallId: `${run.job}-${run.runId}`, at }));
  if (!taint.length) return;
  appendEvent(
    ctx.db,
    { sessionKey: run.sessionKey, runId: run.runId, type: 'system_event', payload: { text: `The ${run.job} job read ${taint.map((each) => each.source).join(', ')}.`, taint } },
    ctx.clock(),
  );
}

// the last run of a job that completed, for the "last sweep" and "last scan" lines of the dashboard.
export function lastJobRun(db: Db, job: InboxJob): { runId: string | null; at: string } | null {
  const row = db
    .prepare("SELECT id, COALESCE(endedAt, startedAt) AS at FROM runs WHERE sessionKey LIKE ? AND status = 'completed' ORDER BY startedAt DESC LIMIT 1")
    .get(`${INBOX_PREFIX}${job}:%`);
  return row ? { runId: String(row.id), at: String(row.at) } : null;
}
