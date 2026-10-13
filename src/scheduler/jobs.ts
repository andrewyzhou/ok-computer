import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { RunInput, RunResult } from '../agent/loop.js';
import type { Config } from '../config/schema.js';
import type { Db } from '../db/index.js';
import { appendEvent } from '../events/log.js';
import { checkinPrompt, writeDayResults } from '../goals/routine.js';
import { getGoal, listGoals, startCheckin } from '../goals/store.js';
import type { Logger } from '../observability/logger.js';
import type { OwnerMessenger } from '../sessions/owner.js';
import type { RunQueue } from '../sessions/queue.js';
import { MAIN_SESSION, MAIN_TOOLS, NO_REPLY } from '../sessions/router.js';
import { localDay, type Clock } from '../time.js';
import type { JobResult } from './scheduler.js';
import type { Automation } from './store.js';

export const AUTOMATION_TOOLS: readonly string[] = [
  'automations_create',
  'automations_list',
  'automations_update',
  'goal_update',
  'goals_list',
  'goals_set',
  'goals_stats',
  'memory_get',
  'memory_search',
  'memory_write',
  'message_owner',
  'now',
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

  // a run in the main session is part of the conversation, so the owner can answer it there.
  const runInMain = (automation: Automation, text: string): Promise<JobResult> =>
    queue.enqueue(MAIN_SESSION, async () => {
      const result = await deps.agent({
        sessionKey: MAIN_SESSION,
        trigger: 'automation',
        slot: automation.slot,
        channel: channel(),
        allowedTools: MAIN_TOOLS,
        events: [{ type: 'system_event', payload: { text } }],
        signal: deps.signal,
      });
      if (hasText(result)) await owner.send(result.text);
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
        events: [{ type: 'system_event', payload: { text } }],
        signal: deps.signal,
      }),
    );
    if (hasText(result)) {
      await owner.send(result.text);
      // the main session gets a copy, so the agent knows what the owner answers to.
      await appendToMain(`The automation "${automation.name}" sent this message to the owner:\n${result.text}`);
    }
    return toJob(result);
  };

  const appendToMain = (text: string) =>
    queue.enqueue(MAIN_SESSION, async () => {
      appendEvent(db, { sessionKey: MAIN_SESSION, runId: null, type: 'system_event', payload: { text } }, clock());
    });

  return async (automation) => {
    const payload = automation.payload;
    switch (payload.type) {
      case 'system_event':
        await appendToMain(`Automation "${automation.name}": ${payload.text}`);
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
    }
  };
}
