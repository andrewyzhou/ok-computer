import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { RunInput, RunResult } from '../agent/loop.js';
import { durationMs, type Config } from '../config/schema.js';
import type { Db } from '../db/index.js';
import { getSetting, setSetting } from '../db/settings.js';
import { appendEvent, succeededCalls } from '../events/log.js';
import type { Logger } from '../observability/logger.js';
import type { TaintSource } from '../policy/policy.js';
import { sessionTaint } from '../policy/store.js';
import type { OwnerMessenger } from '../sessions/owner.js';
import type { Digest } from '../signals/digest.js';
import type { RunQueue } from '../sessions/queue.js';
import { MAIN_SESSION } from '../sessions/router.js';
import { localTime, type Clock } from '../time.js';
import { defineTool, type Tool } from '../tools/registry.js';
import { wrapIfTainted } from '../tools/untrusted.js';
import type { JobResult } from './scheduler.js';
import { createAutomation, listAutomations, updateAutomation, type Automation } from './store.js';

export const HEARTBEAT_TOOLS: readonly string[] = ['goals_list', 'heartbeat_respond', 'now'];
export const HEARTBEAT_PREFIX = 'heartbeat:';
const CHECKLIST = 'heartbeat_checklist';
const CHECKLIST_TAINT = 'heartbeat_checklist_taint';
const SYNCED_EVERY = 'heartbeat_synced_every_ms';
// the last heartbeat runs whose message to the owner failed. the list keeps as many runs as the recent notifications.
const UNSENT_RUNS = 'heartbeat_unsent_runs';
const RECENT_LIMIT = 5;

export const HEARTBEAT_INSTRUCTIONS = `This is a heartbeat run. The owner does not see this session. Check the items of the heartbeat checklist against the context that you have. Then call heartbeat_respond one time. Use notify true with a short message only when something needs the owner's attention now. Use notify false in all other cases. Do not repeat a recent notification. After heartbeat_respond, reply NO_REPLY.`;

export function getChecklist(db: Db): string {
  return getSetting<string>(db, CHECKLIST) ?? '';
}

// the checklist can repeat untrusted text that the writing session read. each heartbeat run starts with that taint.
// the owner's own checklist from the dashboard has no taint.
export function setChecklist(db: Db, text: string, now: Date, taint: TaintSource[] = []): void {
  setSetting(db, CHECKLIST, text.trim(), now);
  setSetting(db, CHECKLIST_TAINT, taint, now);
}

export function checklistTaint(db: Db): TaintSource[] {
  return getSetting<TaintSource[]>(db, CHECKLIST_TAINT) ?? [];
}

export function inActiveHours(now: Date, timeZone: string, hours: { start: string; end: string }): boolean {
  const time = localTime(now, timeZone);
  // active hours can also cross midnight, for example 22:00 to 02:00.
  return hours.start <= hours.end ? time >= hours.start && time < hours.end : time >= hours.start || time < hours.end;
}

// the heartbeat automation follows the config at each start. a config value of "0" turns it off.
// the app keeps the last synced config value. a pause by the owner then stays until the config changes.
export function syncHeartbeat(db: Db, config: Pick<Config, 'heartbeat' | 'timeZone'>, now: Date): void {
  const everyMs = durationMs(config.heartbeat.every);
  const existing = listAutomations(db).find((automation) => automation.payload.type === 'heartbeat');
  const synced =
    getSetting<number>(db, SYNCED_EVERY) ?? (existing?.schedule.kind === 'every' ? existing.schedule.everyMs : undefined);
  setSetting(db, SYNCED_EVERY, everyMs, now);
  if (!everyMs) {
    if (existing?.enabled) updateAutomation(db, existing.id, { enabled: false }, now, config.timeZone);
    return;
  }
  const schedule = { kind: 'every' as const, everyMs };
  if (!existing) {
    createAutomation(
      db,
      { name: 'heartbeat', schedule, payload: { type: 'heartbeat' }, slot: 'heartbeat', createdBy: 'system' },
      now,
      config.timeZone,
    );
  } else if (synced !== everyMs) {
    updateAutomation(db, existing.id, { schedule, enabled: true }, now, config.timeZone);
  }
}

interface Respond {
  notify: boolean;
  text?: string;
}

// a message that did not reach the owner is not a recent notification. the next heartbeat would see it as sent, and
// it could then keep back the signal that the failed message was about.
export function recentNotifications(db: Db): Array<{ text: string; runId: string }> {
  return db
    .prepare(
      `SELECT input, runId FROM tool_calls WHERE name = 'heartbeat_respond' AND isError = 0
         AND json_extract(input, '$.notify') = 1 AND runId NOT IN (SELECT value FROM json_each(?))
         ORDER BY id DESC LIMIT ${RECENT_LIMIT}`,
    )
    .all(JSON.stringify(getSetting<string[]>(db, UNSENT_RUNS) ?? []))
    .map((row) => ({ text: (JSON.parse(String(row.input)) as Respond).text ?? '', runId: String(row.runId) }));
}

// the taint that a heartbeat run read itself: its checklist and its digest. a run from before readTaint has only
// its whole taint.
function readTaint(db: Db, runId: string): TaintSource[] {
  const row = db
    .prepare(
      `SELECT COALESCE(json_extract(payload, '$.readTaint'), json_extract(payload, '$.taint')) AS taint FROM events
       WHERE sessionKey = ? AND type = 'system_event' ORDER BY seq LIMIT 1`,
    )
    .get(`${HEARTBEAT_PREFIX}${runId}`);
  return row?.taint ? (JSON.parse(String(row.taint)) as TaintSource[]) : [];
}

// a refusal, the step limit and a request that the provider rejected (for example its content filter) can come from
// the text of the input. a refusal counts also when the next model of the chain then failed. a transient error or a
// crash comes from the model or the app.
function inputCanCause(db: Db, result: RunResult): boolean {
  if (result.stoppedAtLimit || result.rejected) return true;
  return !!db.prepare("SELECT 1 FROM model_calls WHERE runId = ? AND stopReason = 'refusal' LIMIT 1").get(result.runId);
}

export function createHeartbeatTools(deps: { db: Db }): Tool[] {
  const respond = defineTool({
    name: 'heartbeat_respond',
    description:
      'Give the result of a heartbeat check. Only notify true sends text to the owner. The optional checklist replaces the heartbeat checklist.',
    input: z.object({ notify: z.boolean(), text: z.string().optional(), checklist: z.string().optional() }),
    risk: 'write',
    async run(input, ctx) {
      if (input.notify && !input.text?.trim()) return { content: 'notify true needs a text', isError: true };
      if (input.checklist === undefined) return { content: 'recorded' };
      // a heartbeat run that read outside text (a mail in the digest, or a checklist that a tainted session wrote)
      // must not change the checklist. the owner does not see this session, and a new checklist drives every later
      // heartbeat. the answer itself still counts, so a notification is not lost. the main session can change the
      // checklist with heartbeat_checklist_set, where the owner sees it.
      const taint = sessionTaint(deps.db, ctx.sessionKey);
      if (taint.length) return { content: 'recorded, but the checklist did not change, because this run read outside text' };
      setChecklist(deps.db, input.checklist, ctx.clock());
      return { content: 'recorded' };
    },
  });

  const checklistSet = defineTool({
    name: 'heartbeat_checklist_set',
    description:
      'Replace the heartbeat checklist: the things that the heartbeat checks every interval during active hours. An empty checklist stops the heartbeat checks.',
    input: z.object({ checklist: z.string() }),
    risk: 'write',
    async run({ checklist }, ctx) {
      setChecklist(deps.db, checklist, ctx.clock(), sessionTaint(deps.db, ctx.sessionKey));
      return { content: checklist.trim() ? `the checklist is now:\n${checklist.trim()}` : 'the checklist is empty' };
    },
  });

  return [respond, checklistSet];
}

export interface HeartbeatDeps {
  db: Db;
  clock: Clock;
  logger: Logger;
  config: Pick<Config, 'heartbeat' | 'timeZone'>;
  queue: RunQueue;
  owner: OwnerMessenger;
  agent: (input: RunInput) => Promise<RunResult>;
  signal: AbortSignal;
  newId?: () => string;
  // the signals of the integrations: a bounded digest of the unhandled ones, and the mark after a completed run.
  signals?: {
    digest(now: Date): Digest | undefined;
    finish(digest: Digest, runId: string | null, notified: boolean, now: Date): void;
    // a failed run that showed signals counts against each of them.
    failed(digest: Digest): void;
  };
}

export function createHeartbeat(deps: HeartbeatDeps): (automation: Automation) => Promise<JobResult> {
  const { db, clock, config, queue, owner } = deps;
  const newId = deps.newId ?? randomUUID;

  return async (automation) => {
    // the checks below need no model call, so a skipped heartbeat costs nothing.
    if (!inActiveHours(clock(), config.timeZone, config.heartbeat.activeHours)) {
      return { status: 'skipped', error: 'outside active hours' };
    }
    const checklist = getChecklist(db);
    if (queue.busy(MAIN_SESSION)) return { status: 'skipped', error: 'the main session has a run in progress' };
    // new signals are a reason to run without a checklist.
    const digest = deps.signals?.digest(clock());
    if (!checklist && !digest?.shown.length) {
      // newsletters and noise need no model call. they are closed now, so they do not wait for ever.
      if (digest) deps.signals!.finish(digest, null, false, clock());
      return { status: 'skipped', error: 'the checklist is empty' };
    }

    const recent = recentNotifications(db);
    // a recent notification can repeat a mail that its heartbeat read. it keeps the taint of that run, so the mail
    // cannot change the checklist one heartbeat later through it. only the taint that the run read itself counts, not
    // the taint of the recent notifications that it read. else each notification gives the taint to the next ones, and
    // one mail taints every later heartbeat and the main session for ever.
    const recentTaint = recent.flatMap((each) => readTaint(db, each.runId));
    const text = [
      'Heartbeat check.',
      '',
      'Checklist:',
      checklist || '- none',
      ...(digest?.shown.length
        ? [
            '',
            "New signals from the owner's accounts: the ones with a detector hit first, then the newest. Tell the owner about a signal only when it needs attention soon, for example a deadline that is not on the calendar. Each signal is shown one time.",
            digest.text,
          ]
        : []),
      '',
      'Recent notifications to the owner:',
      recent.length ? wrapIfTainted(recentTaint, recent.map((each) => `- ${each.text}`).join('\n')) : '- none',
    ].join('\n');
    // the digest and the recent notifications can quote outside text, so the run starts with their taint. the
    // heartbeat has no external tools.
    const read = [...checklistTaint(db), ...(digest?.taint ?? [])];
    const inherited = [...read, ...recentTaint];
    const runId = newId();
    const sessionKey = `${HEARTBEAT_PREFIX}${runId}`;
    const result = await queue.enqueue(sessionKey, () =>
      deps.agent({
        runId,
        sessionKey,
        trigger: 'heartbeat',
        slot: automation.slot,
        channel: owner.chat()?.channel ?? 'cli',
        allowedTools: HEARTBEAT_TOOLS,
        events: [{ type: 'system_event', payload: { text, ...(inherited.length ? { taint: inherited, readTaint: read } : {}) } }],
        signal: deps.signal,
      }),
    );
    // a failed run leaves the signals unhandled, so the next heartbeat shows them again. a failure that the input can
    // cause counts against the shown signals, so a signal whose text makes every run fail loses that text, and the
    // scheduler does not turn the heartbeat off. an outage of the model or an aborted run (a stop of the app) does not
    // count, because the text would else be lost for a failure that the text did not cause.
    if (result.status !== 'completed') {
      if (result.status === 'failed' && digest?.shown.length && inputCanCause(db, result)) deps.signals!.failed(digest);
      return { status: 'failed', runId, error: result.error ?? result.status };
    }

    // the answer comes from the event log, because one failed trace write must not drop the owner's notification.
    const answer = succeededCalls(db, sessionKey, runId, 'heartbeat_respond').at(-1) as Respond | undefined;
    // a run that ended without heartbeat_respond (a plain answer, or a reply cut at max_tokens) did not decide about
    // the signals. the text of a mail can cause this at every run, so it counts against them like a refusal.
    if (!answer && digest?.shown.length) deps.signals!.failed(digest);
    const message = answer?.notify ? answer.text : undefined;
    const notified = !!message && (await owner.send(message, undefined, { markdown: true, runId }));
    if (message && !notified) {
      const unsent = [runId, ...(getSetting<string[]>(db, UNSENT_RUNS) ?? [])].slice(0, RECENT_LIMIT);
      setSetting(db, UNSENT_RUNS, unsent, clock());
    }
    // the mark comes after the send. a crash between the two shows the signals again, and the recent notifications
    // tell the next heartbeat not to repeat itself. a lost deadline is worse than a repeated one. a run that gave no
    // heartbeat_respond did not decide about the signals, and a message that did not reach the owner did not tell
    // about them, so in both cases they stay open for the next heartbeat. the digest closes them as stale after some
    // days, so a model that never answers or a channel that stays down cannot hold them for ever. the filtered signals
    // need no decision.
    if (digest) deps.signals!.finish(answer && !!message === notified ? digest : { ...digest, shown: [] }, runId, notified, clock());
    if (message && !notified) return { status: 'completed', runId, error: 'the message to the owner failed, so the signals stay open' };
    if (message && notified) {
      // the notification can repeat untrusted content that the heartbeat read, so it carries that taint, and its text
      // is wrapped.
      const taint = sessionTaint(db, sessionKey);
      const text = `The heartbeat sent this message to the owner:\n${wrapIfTainted(taint, message)}`;
      await queue.enqueue(MAIN_SESSION, async () => {
        appendEvent(
          db,
          {
            sessionKey: MAIN_SESSION,
            runId: null,
            type: 'system_event',
            payload: { text, ...(taint.length ? { taint } : {}) },
          },
          clock(),
        );
      });
    }
    return { status: 'completed', runId };
  };
}
