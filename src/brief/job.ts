import { appendEvent } from '../events/log.js';
import { requestContext } from '../google/trace.js';
import { inboxAutomation } from '../inbox/inbox.js';
import { calendarSource, mailSource } from '../inbox/run.js';
import { redact } from '../observability/redact.js';
import type { TaintSource } from '../policy/policy.js';
import { previousRun } from '../scheduler/schedule.js';
import type { JobResult } from '../scheduler/scheduler.js';
import { MAIN_SESSION } from '../sessions/router.js';
import { localDay } from '../time.js';
import { errorText } from '../tools/registry.js';
import { wrapIfTainted } from '../tools/untrusted.js';
import { briefText, buildBrief } from './build.js';
import { briefSession, type BriefContext } from './context.js';
import { calendarAliases, digestOfDay, gatherBriefInput } from './sources.js';
import { recordDelivery, saveBrief } from './store.js';

// the job of the brief automation. it runs in code in the session brief:<runId>, without a model call.

// the task of the run, its first event, so the trace and the reviewer read what the run may do.
export const BRIEF_TASK =
  'The morning brief of the owner. It reads the calendars, the latest inbox digest, the calendar proposals, the delegations and the goals of today, stores the brief, and sends the owner a short message with a link. It changes nothing.';

// the link of the telegram message: the today page of the day. a public address can end in a slash, and the link
// never gets two.
export const briefLink = (dashboardUrl: string, day: string) => `${dashboardUrl.replace(/\/+$/, '')}/#/today/${day}`;

// the source of the taint for the text that the brief repeats from the desk: the titles, next steps and names of the
// delegations, which often come from mail or from people outside.
export const DESK_SOURCE = 'desk';

// who started a brief run: the scheduler, or the owner on the dashboard ("make a brief now").
export type BriefTrigger = 'automation' | 'dashboard';

export const NOT_SENT = 'the message did not reach the owner';

export interface BriefJobOptions {
  // how often the job looks again whether the digest of the day still runs, and how long it waits for it at most.
  pollMs: number;
  maxWaitMs: number;
}

// the digest runs before the brief, so the brief can use it. a digest that takes longer than maxWaitMs is not waited
// for: the brief then uses the digest of the day before.
const DEFAULT_OPTIONS: BriefJobOptions = { pollMs: 5000, maxWaitMs: 600_000 };

// sleep ends early when the app stops.
const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });

// true while the digest of the day is due but has not ended yet. the scheduler fires every job of a tick at once, in
// no fixed order, so the brief can start before the digest that is planned at the same time. the digest is then due
// (its planned run of the day is at or before now, and not older than the longest wait), it has no run that started at
// or after that time, and there is no digest of the day yet. a digest that the owner turned off or moved later than
// the brief is not waited for.
export function digestPending(ctx: Pick<BriefContext, 'db' | 'clock' | 'timeZone'>, day: string, maxWaitMs: number): boolean {
  const { db } = ctx;
  const automation = inboxAutomation(db, 'digest');
  if (!automation || !automation.enabled) return false;
  const now = ctx.clock();
  const planned = previousRun(automation.schedule, now, new Date(automation.createdAt), ctx.timeZone);
  if (planned > now || now.getTime() - planned.getTime() > maxWaitMs) return false;
  // a digest made after its planned time of the day did not run at that time.
  if (planned < new Date(automation.createdAt)) return false;
  if (localDay(planned, ctx.timeZone) !== day) return false;
  if (digestOfDay(db, day)) return false;
  const ran = db.prepare('SELECT 1 FROM automation_runs WHERE automationId = ? AND startedAt >= ? LIMIT 1').get(automation.id, planned.toISOString());
  return !ran;
}

async function waitForDigest(ctx: BriefContext, day: string, options: BriefJobOptions): Promise<void> {
  if (!ctx.inbox) return;
  const inbox = ctx.inbox;
  const until = Date.now() + options.maxWaitMs;
  // the jobs of one tick start one after the other, so the brief first lets the others of its tick start.
  await sleep(0, ctx.signal);
  const waiting = () => inbox.running('digest') || digestPending(ctx, day, options.maxWaitMs);
  while (waiting() && !ctx.signal.aborted && Date.now() < until) {
    await sleep(Math.min(options.pollMs, Math.max(0, until - Date.now())), ctx.signal);
  }
}

// runBriefJob builds the brief of the local day of now, stores it, sends the short text to the owner and records the
// delivery. a brief that could not be sent is still stored, and the job completes with a note.
export async function runBriefJob(ctx: BriefContext, options: BriefJobOptions = DEFAULT_OPTIONS, trigger: BriefTrigger = 'automation'): Promise<JobResult> {
  const { db, clock } = ctx;
  const day = localDay(clock(), ctx.timeZone);
  const runId = ctx.newId();
  const sessionKey = briefSession(runId);
  // the runs row comes first, so each google request of the run is in its timeline. the app keeps the run in its live
  // runs while it works, so the sweep of stale runs leaves it alone.
  ctx.activeRuns?.add(runId);
  db.prepare("INSERT INTO runs (id, sessionKey, trigger, slot, status, startedAt) VALUES (?, ?, ?, 'utility', 'running', ?)").run(
    runId,
    sessionKey,
    trigger,
    clock().toISOString(),
  );
  const end = (status: 'completed' | 'failed', note?: string) =>
    db.prepare('UPDATE runs SET status = ?, endedAt = ?, error = ? WHERE id = ?').run(status, clock().toISOString(), note ? redact(note) : null, runId);
  const event = (text: string, taint: TaintSource[] = []) =>
    appendEvent(db, { sessionKey, runId, type: 'system_event', payload: { text, ...(taint.length ? { taint } : {}) } }, clock());

  try {
    event(BRIEF_TASK);
    await waitForDigest(ctx, day, options);
    const input = await requestContext.run({ runId }, () => gatherBriefInput(ctx, day));

    // the sources that the run read: the calendar of each account that it could read, the mail of each account of the
    // digest, and the desk when it gave delegations. the brief repeats their text, so the run and its copy in the main
    // session carry their taint.
    const skipped = new Set(input.sources.skipped.filter((each) => each.calendarId === undefined).map((each) => each.account));
    const calendars = input.sources.calendar === 'off' ? [] : calendarAliases(ctx).filter((alias) => !skipped.has(alias));
    const desk = input.delegations && input.delegations.length > 0 ? [DESK_SOURCE] : [];
    const sources = [...new Set([...calendars.map(calendarSource), ...(input.digest?.accounts ?? []).map(mailSource), ...desk])];
    const at = clock().toISOString();
    const taint: TaintSource[] = sources.map((source) => ({ source, toolName: 'brief', runId, toolCallId: `brief-${runId}`, at }));
    if (taint.length) event(`The brief read ${sources.join(', ')}.`, taint);

    const content = buildBrief(input);
    const shortText = briefText(content, briefLink(ctx.dashboardUrl, day));
    const brief = saveBrief(db, { day, runId, shortText, content }, clock());

    // the short text is plain text, so it goes without markdown.
    const sent = await ctx.owner.send(shortText, undefined, { runId });
    recordDelivery(db, brief.id, { channel: ctx.owner.chat()?.channel ?? null, ok: sent, error: sent ? null : NOT_SENT }, clock());
    event(sent ? 'Sent the brief to the owner.' : 'The brief did not reach the owner.');

    // the main session gets a copy, so the agent knows what the owner answers to, and whether it reached the owner.
    // the text repeats event titles and mail subjects, so the copy is wrapped and carries the taint of the run.
    await ctx.queue.enqueue(MAIN_SESSION, async () => {
      const lead = sent ? 'The morning brief went to the owner:' : 'The morning brief was built but did not reach the owner:';
      const text = `${lead}\n${wrapIfTainted(taint, shortText)}`;
      appendEvent(db, { sessionKey: MAIN_SESSION, runId: null, type: 'system_event', payload: { text, ...(taint.length ? { taint } : {}) } }, clock());
    });

    const note = sent ? undefined : NOT_SENT;
    end('completed', note);
    return { status: 'completed', runId, ...(note ? { error: note } : {}) };
  } catch (err) {
    const error = `the brief stopped: ${redact(errorText(err))}`;
    ctx.logger.error('brief job failed', { runId, err });
    end('failed', error);
    return { status: 'failed', runId, error };
  } finally {
    ctx.activeRuns?.delete(runId);
  }
}
