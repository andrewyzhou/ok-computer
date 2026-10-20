import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { RunInput, RunResult } from '../agent/loop.js';
import type { Config } from '../config/schema.js';
import type { Db } from '../db/index.js';
import { DOC_TOOLS } from '../docs/names.js';
import { appendEvent } from '../events/log.js';
import { checkinPrompt, writeDayResults } from '../goals/routine.js';
import { getGoal, listGoals, startCheckin } from '../goals/store.js';
import type { DeskJob } from '../dashboard/desk-types.js';
import type { InboxJob } from '../dashboard/types.js';
import { DESK_AUTO_TOOLS } from '../desk/names.js';
import type { Logger } from '../observability/logger.js';
import type { TaintSource } from '../policy/policy.js';
import { sessionTaint } from '../policy/store.js';
import type { OwnerMessenger } from '../sessions/owner.js';
import type { RunQueue } from '../sessions/queue.js';
import { MAIN_SESSION, MAIN_TOOLS, NO_REPLY } from '../sessions/router.js';
import { localDay, type Clock } from '../time.js';
import { wrapIfTainted } from '../tools/untrusted.js';
import type { JobResult } from './scheduler.js';
import type { Automation } from './store.js';

export const AUTOMATION_TOOLS: readonly string[] = [
  'automations_create',
  'automations_list',
  'automations_update',
  'delegate',
  'goal_update',
  'goals_list',
  'goals_set',
  'goals_stats',
  'memory_get',
  'memory_search',
  'memory_write',
  'message_owner',
  'now',
  'result_read',
  'skill_read',
  ...DESK_AUTO_TOOLS,
  ...DOC_TOOLS,
];

export interface JobDeps {
  db: Db;
  clock: Clock;
  logger: Logger;
  config: Pick<Config, 'timeZone' | 'paths'>;
  queue: RunQueue;
  owner: OwnerMessenger;
  agent: (input: RunInput) => Promise<RunResult>;
  heartbeat: (automation: Automation) => Promise<JobResult>;
  consolidation: (automation: Automation) => Promise<JobResult>;
  // the poll of each integration, by its id. a poll reads new items in code, without a model call. only the process
  // that connects the integrations has polls.
  polls?: ReadonlyMap<string, () => Promise<JobResult>>;
  // the poll in code of each source that is not an integration entry, for example google, by its source name.
  sourcePolls?: Record<string, () => Promise<JobResult>>;
  workshop: (automation: Automation) => Promise<JobResult>;
  // the inbox jobs of phase 5 m8. only an app with a google block has them.
  inboxJobs?: (job: InboxJob) => Promise<JobResult>;
  // the desk jobs of phase 6 t3.
  deskJobs?: (job: DeskJob) => Promise<JobResult>;
  signal: AbortSignal;
  newId?: () => string;
}

export function createJobRunner(deps: JobDeps): (automation: Automation) => Promise<JobResult> {
  const { db, clock, config, queue, owner } = deps;
  const newId = deps.newId ?? randomUUID;
  const channel = () => owner.chat()?.channel ?? 'cli';
  const toJob = (result: RunResult): JobResult =>
    result.status === 'completed'
      ? { status: 'completed', runId: result.runId }
      : { status: 'failed', runId: result.runId, error: result.error ?? result.status };
  const hasText = (result: RunResult) => result.status === 'completed' && result.text.trim() !== '' && result.text.trim() !== NO_REPLY;

  // the first event carries the taint of the automation, so the run starts as tainted as the session that wrote it.
  const start = (text: string, taint: TaintSource[]) => [{ type: 'system_event' as const, payload: { text, ...(taint.length ? { taint } : {}) } }];

  // a run in the main session is part of the conversation, so the owner can answer it there.
  const runInMain = (automation: Automation, text: string): Promise<JobResult> =>
    queue.enqueue(MAIN_SESSION, async () => {
      const result = await deps.agent({
        sessionKey: MAIN_SESSION,
        trigger: 'automation',
        slot: automation.slot,
        channel: channel(),
        allowedTools: MAIN_TOOLS,
        events: start(text, automation.taint),
        signal: deps.signal,
      });
      if (hasText(result)) await owner.send(result.text, undefined, { markdown: true, runId: result.runId });
      return toJob(result);
    });

  const runIsolated = async (automation: Automation, text: string): Promise<JobResult> => {
    const runId = newId();
    const sessionKey = `auto:${automation.id}:${runId}`;
    const result = await queue.enqueue(sessionKey, () =>
      deps.agent({
        runId,
        sessionKey,
        trigger: 'automation',
        slot: automation.slot,
        channel: channel(),
        allowedTools: AUTOMATION_TOOLS,
        events: start(text, automation.taint),
        signal: deps.signal,
      }),
    );
    if (hasText(result)) {
      await owner.send(result.text, undefined, { markdown: true, runId });
      // the main session gets a copy, so the agent knows what the owner answers to. the text can repeat untrusted
      // content that the run read, so the copy carries the taint of the run's session, and its text is wrapped. the
      // name of a tainted automation is untrusted text too, so the id stands for it.
      const taint = sessionTaint(db, sessionKey);
      const name = automation.taint.length ? automation.id : `"${automation.name}"`;
      await appendToMain(`The automation ${name} sent this message to the owner:\n${wrapIfTainted(taint, result.text)}`, taint);
    }
    return toJob(result);
  };

  const appendToMain = (text: string, taint: TaintSource[] = []) =>
    queue.enqueue(MAIN_SESSION, async () => {
      const payload = { text, ...(taint.length ? { taint } : {}) };
      appendEvent(db, { sessionKey: MAIN_SESSION, runId: null, type: 'system_event', payload }, clock());
    });

  return async (automation) => {
    const payload = automation.payload;
    switch (payload.type) {
      case 'system_event':
        await appendToMain(
          automation.taint.length
            ? `Automation ${automation.id}:\n${wrapIfTainted(automation.taint, `"${automation.name}": ${payload.text}`)}`
            : `Automation "${automation.name}": ${payload.text}`,
          automation.taint,
        );
        return { status: 'completed' };
      case 'agent': {
        if (payload.condition === 'no_goals_today' && listGoals(db, localDay(clock(), config.timeZone)).length) {
          return { status: 'skipped', error: 'goals for today exist' };
        }
        const text = `The automation "${automation.name}" (${automation.id}) is running. Its instructions:\n${payload.prompt}`;
        return automation.sessionMode === 'main' ? runInMain(automation, text) : runIsolated(automation, text);
      }
      case 'goal_checkin': {
        const goal = getGoal(db, payload.goalId);
        if (goal?.status !== 'open') return { status: 'skipped', error: 'the goal is not open' };
        startCheckin(db, goal.id, clock());
        return runInMain(automation, checkinPrompt(goal, config.timeZone));
      }
      case 'goals_results': {
        // a late run after midnight still writes the results of the planned day.
        const day = localDay(new Date(automation.nextRunAt ?? clock()), config.timeZone);
        writeDayResults(db, join(config.paths.data, 'memory'), day, clock(), config.timeZone);
        return { status: 'completed' };
      }
      case 'heartbeat':
        return deps.heartbeat(automation);
      case 'consolidation':
        return deps.consolidation(automation);
      case 'integration_poll': {
        const poll = deps.polls?.get(payload.integration);
        return poll ? poll() : { status: 'skipped', error: deps.polls ? `${payload.integration} has no poll` : 'the chat process does not poll' };
      }
      case 'poll': {
        // the config can remove a source while its automation stays.
        const poll = deps.sourcePolls?.[payload.source];
        return poll ? poll() : { status: 'skipped', error: `no integration polls ${payload.source}` };
      }
      case 'workshop':
        return deps.workshop(automation);
      case 'inbox':
        // the config can remove the google block while the automation stays.
        return deps.inboxJobs ? deps.inboxJobs(payload.job) : { status: 'skipped', error: 'the inbox jobs need the google integration' };
      case 'desk':
        return deps.deskJobs ? deps.deskJobs(payload.job) : { status: 'skipped', error: 'the desk is not set up in this process' };
    }
  };
}
