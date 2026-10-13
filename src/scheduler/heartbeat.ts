import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { RunInput, RunResult } from '../agent/loop.js';
import { durationMs, type Config } from '../config/schema.js';
import type { Db } from '../db/index.js';
import { getSetting, setSetting } from '../db/settings.js';
import { appendEvent } from '../events/log.js';
import type { Logger } from '../observability/logger.js';
import type { OwnerMessenger } from '../sessions/owner.js';
import type { RunQueue } from '../sessions/queue.js';
import { MAIN_SESSION } from '../sessions/router.js';
import { localTime, type Clock } from '../time.js';
import { defineTool, type Tool } from '../tools/registry.js';
import type { JobResult } from './scheduler.js';
import { createAutomation, listAutomations, updateAutomation, type Automation } from './store.js';

export const HEARTBEAT_TOOLS: readonly string[] = ['goals_list', 'heartbeat_respond', 'now'];
export const HEARTBEAT_PREFIX = 'heartbeat:';
const CHECKLIST = 'heartbeat_checklist';
const RECENT_LIMIT = 5;

export const HEARTBEAT_INSTRUCTIONS = `This is a heartbeat run. The owner does not see this session. Check the items of the heartbeat checklist against the context that you have. Then call heartbeat_respond one time. Use notify true with a short message only when something needs the owner's attention now. Use notify false in all other cases. Do not repeat a recent notification. After heartbeat_respond, reply NO_REPLY.`;

export function getChecklist(db: Db): string {
  return getSetting<string>(db, CHECKLIST) ?? '';
}

export function setChecklist(db: Db, text: string, now: Date): void {
  setSetting(db, CHECKLIST, text.trim(), now);
}

export function inActiveHours(now: Date, timeZone: string, hours: { start: string; end: string }): boolean {
  const time = localTime(now, timeZone);
  // active hours can also cross midnight, for example 22:00 to 02:00.
  return hours.start <= hours.end ? time >= hours.start && time < hours.end : time >= hours.start || time < hours.end;
}

// the heartbeat automation follows the config at each start. a config value of "0" turns it off.
export function syncHeartbeat(db: Db, config: Pick<Config, 'heartbeat' | 'timeZone'>, now: Date): void {
  const everyMs = durationMs(config.heartbeat.every);
  const existing = listAutomations(db).find((automation) => automation.payload.type === 'heartbeat');
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
  } else if (existing.schedule.kind !== 'every' || existing.schedule.everyMs !== everyMs) {
    updateAutomation(db, existing.id, { schedule, enabled: true }, now, config.timeZone);
  }
}

interface Respond {
  notify: boolean;
  text?: string;
}

function responses(db: Db, sql: string, ...params: string[]): Respond[] {
  return db
    .prepare(sql)
    .all(...params)
    .map((row) => JSON.parse(String(row.input)) as Respond);
}

export function recentNotifications(db: Db): string[] {
  return responses(
    db,
    `SELECT input FROM tool_calls WHERE name = 'heartbeat_respond' AND isError = 0
       AND json_extract(input, '$.notify') = 1 ORDER BY id DESC LIMIT ${RECENT_LIMIT}`,
  ).map((respond) => respond.text ?? '');
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
      if (input.checklist !== undefined) setChecklist(deps.db, input.checklist, ctx.clock());
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
      setChecklist(deps.db, checklist, ctx.clock());
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
    if (!checklist) return { status: 'skipped', error: 'the checklist is empty' };
    if (queue.busy(MAIN_SESSION)) return { status: 'skipped', error: 'the main session has a run in progress' };

    const recent = recentNotifications(db);
    const text = [
      'Heartbeat check.',
      '',
      'Checklist:',
      checklist,
      '',
      'Recent notifications to the owner:',
      ...(recent.length ? recent.map((line) => `- ${line}`) : ['- none']),
    ].join('\n');
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
        events: [{ type: 'system_event', payload: { text } }],
        signal: deps.signal,
      }),
    );
    if (result.status !== 'completed') return { status: 'failed', runId, error: result.error ?? result.status };

    const answer = responses(
      db,
      "SELECT input FROM tool_calls WHERE runId = ? AND name = 'heartbeat_respond' AND isError = 0 ORDER BY id DESC LIMIT 1",
      runId,
    )[0];
    if (answer?.notify && answer.text) {
      await owner.send(answer.text);
      await queue.enqueue(MAIN_SESSION, async () => {
        appendEvent(
          db,
          {
            sessionKey: MAIN_SESSION,
            runId: null,
            type: 'system_event',
            payload: { text: `The heartbeat sent this message to the owner:\n${answer.text}` },
          },
          clock(),
        );
      });
    }
    return { status: 'completed', runId };
  };
}
