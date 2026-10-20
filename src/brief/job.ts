import { appendEvent } from '../events/log.js';
import { requestContext } from '../google/trace.js';
import { calendarSource, mailSource } from '../inbox/run.js';
import { redact } from '../observability/redact.js';
import type { TaintSource } from '../policy/policy.js';
import type { JobResult } from '../scheduler/scheduler.js';
import { MAIN_SESSION } from '../sessions/router.js';
import { localDay } from '../time.js';
import { errorText } from '../tools/registry.js';
import { wrapIfTainted } from '../tools/untrusted.js';
import { briefText, buildBrief } from './build.js';
import { briefSession, type BriefContext } from './context.js';
import { calendarAliases, gatherBriefInput } from './sources.js';
import { recordDelivery, saveBrief } from './store.js';

// the job of the brief automation. it runs in code in the session brief:<runId>, without a model call.

// the task of the run, its first event, so the trace and the reviewer read what the run may do.
export const BRIEF_TASK =
  'The morning brief of the owner. It reads the calendars, the latest inbox digest, the calendar proposals, the delegations and the goals of today, stores the brief, and sends the owner a short message with a link. It changes nothing.';

// the link of the telegram message: the today page of the day.
export const briefLink = (dashboardUrl: string, day: string) => `${dashboardUrl}/#/today/${day}`;

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

async function waitForDigest(ctx: BriefContext, options: BriefJobOptions): Promise<void> {
  const until = Date.now() + options.maxWaitMs;
  while (ctx.inbox?.running('digest') && !ctx.signal.aborted && Date.now() < until) {
    await sleep(Math.min(options.pollMs, Math.max(0, until - Date.now())), ctx.signal);
  }
}

// runBriefJob builds the brief of the local day of now, stores it, sends the short text to the owner and records the
// delivery. a brief that could not be sent is still stored, and the job completes with a note.
export async function runBriefJob(ctx: BriefContext, options: BriefJobOptions = DEFAULT_OPTIONS): Promise<JobResult> {
  const { db, clock } = ctx;
  const day = localDay(clock(), ctx.timeZone);
  const runId = ctx.newId();
  const sessionKey = briefSession(runId);
  // the runs row comes first, so each google request of the run is in its timeline. the app keeps the run in its live
  // runs while it works, so the sweep of stale runs leaves it alone.
  ctx.activeRuns?.add(runId);
  db.prepare("INSERT INTO runs (id, sessionKey, trigger, slot, status, startedAt) VALUES (?, ?, 'automation', 'utility', 'running', ?)").run(
    runId,
    sessionKey,
    clock().toISOString(),
  );
  const end = (status: 'completed' | 'failed', note?: string) =>
    db.prepare('UPDATE runs SET status = ?, endedAt = ?, error = ? WHERE id = ?').run(status, clock().toISOString(), note ? redact(note) : null, runId);
  const event = (text: string, taint: TaintSource[] = []) =>
    appendEvent(db, { sessionKey, runId, type: 'system_event', payload: { text, ...(taint.length ? { taint } : {}) } }, clock());

  try {
    event(BRIEF_TASK);
    await waitForDigest(ctx, options);
    const input = await requestContext.run({ runId }, () => gatherBriefInput(ctx, day));

    // the sources that the run read: the calendar of each account that it could read, and the mail of each account
    // of the digest. the brief repeats their text, so the run and its copy in the main session carry their taint.
    const skipped = new Set(input.sources.skipped.map((each) => each.account));
    const calendars = input.sources.calendar === 'off' ? [] : calendarAliases(ctx).filter((alias) => !skipped.has(alias));
    const sources = [...new Set([...calendars.map(calendarSource), ...(input.digest?.accounts ?? []).map(mailSource)])];
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

    // the main session gets a copy, so the agent knows what the owner answers to. the text repeats event titles and
    // mail subjects, so the copy is wrapped and carries the taint of the run.
    await ctx.queue.enqueue(MAIN_SESSION, async () => {
      const text = `The morning brief went to the owner:\n${wrapIfTainted(taint, shortText)}`;
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
