import { randomUUID } from 'node:crypto';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { RunInput, RunResult } from '../agent/loop.js';
import type { Config } from '../config/schema.js';
import type { Db } from '../db/index.js';
import { getSetting, setSetting } from '../db/settings.js';
import { succeededCalls } from '../events/log.js';
import { dailyCron } from '../goals/routine.js';
import { goalStats, listGoals, type Goal, type GoalStats } from '../goals/store.js';
import type { JobResult } from '../scheduler/scheduler.js';
import { createAutomation, type Automation } from '../scheduler/store.js';
import type { RunQueue } from '../sessions/queue.js';
import { addDays, localDay, localTime, type Clock } from '../time.js';
import { defineTool, type Tool } from '../tools/registry.js';
import { dailyNotePath } from './daily.js';

export const MEMORY_LIMIT = 8000;
export const CONSOLIDATION_PREFIX = 'consolidate:';
export const CONSOLIDATION_TOOLS: readonly string[] = ['consolidation_save'];
const INSTALLED = 'consolidation_installed';

export const CONSOLIDATION_INSTRUCTIONS = `This is the nightly memory consolidation. The owner does not see this session. Read the input, then call consolidation_save one time. Write the weekly trends as short markdown bullets: the hit rate and how it changes, common reasons for slipped goals, and the best and worst times of day. Take every number from the statistics, which come from the database; do not count goals from the notes. Give memory only when MEMORY.md must change. Then it is the full new text of MEMORY.md: lasting facts and preferences about the owner, at most ${MEMORY_LIMIT} characters. Keep the facts that are still true, add the new lasting facts from the daily note, and remove facts that the note shows are wrong. After consolidation_save succeeds, reply NO_REPLY.`;

// iso weeks start on monday. week 1 is the week with the first thursday of the year.
export function isoWeek(day: string): string {
  const date = new Date(`${day}T00:00:00Z`);
  const weekday = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - weekday);
  const yearStart = Date.UTC(date.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((date.getTime() - yearStart) / 86_400_000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

const PARTS_OF_DAY = [
  { name: 'morning', from: '05:00' },
  { name: 'afternoon', from: '12:00' },
  { name: 'evening', from: '17:00' },
  { name: 'night', from: '22:00' },
] as const;

function partOfDay(iso: string, timeZone: string): string {
  const time = localTime(new Date(iso), timeZone);
  const part = [...PARTS_OF_DAY].reverse().find((p) => time >= p.from);
  return part?.name ?? 'night';
}

function countByPart(goals: Goal[], time: (goal: Goal) => string | null, timeZone: string): string {
  const counts = new Map<string, number>(PARTS_OF_DAY.map((p) => [p.name, 0]));
  for (const goal of goals) {
    const iso = time(goal);
    if (!iso) continue;
    const part = partOfDay(iso, timeZone);
    counts.set(part, counts.get(part)! + 1);
  }
  return [...counts].map(([name, n]) => `${name} ${n}`).join(', ');
}

function describeStats(label: string, stats: GoalStats): string {
  const rate = stats.hitRate === null ? 'no goals' : `hit rate ${Math.round(stats.hitRate * 100)}%`;
  return (
    `- ${label} (${stats.from} to ${stats.to}): ${stats.goals} goals on ${stats.daysWithGoals} days, ${rate}, ` +
    `${stats.done} done (${stats.doneOnTime} on time), ${stats.dropped} dropped, ${stats.open} open. ` +
    `Streak of days with goals: ${stats.setStreak}. Streak of days with all goals done: ${stats.allDoneStreak}.`
  );
}

// the statistics come from the database only. the model gets them as facts and does not count from the notes.
export function consolidationStats(db: Db, day: string, timeZone: string): string {
  const month = listGoals(db, addDays(day, -29), day);
  const slipped = month.filter((goal) => goal.status !== 'done' || (goal.firstEta !== null && goal.completedAt! > goal.firstEta));
  return [
    describeStats('last 7 days', goalStats(db, addDays(day, -6), day)),
    describeStats('last 30 days', goalStats(db, addDays(day, -29), day)),
    `- done goals by the time they were done (last 30 days): ${countByPart(
      month.filter((goal) => goal.status === 'done'),
      (goal) => goal.completedAt,
      timeZone,
    )}.`,
    `- slipped or late goals by their first eta (last 30 days): ${countByPart(slipped, (goal) => goal.firstEta, timeZone)}.`,
  ].join('\n');
}

// the routine is installed one time only, so the owner can change or delete it.
export function installConsolidation(db: Db, config: Pick<Config, 'timeZone' | 'memory'>, now: Date): boolean {
  if (getSetting(db, INSTALLED)) return false;
  const created = createAutomation(
    db,
    {
      name: 'memory: nightly consolidation',
      schedule: { kind: 'cron', expr: dailyCron(config.memory.consolidateAt), tz: config.timeZone },
      payload: { type: 'consolidation' },
      slot: 'consolidation',
      createdBy: 'system',
    },
    now,
    config.timeZone,
  );
  if (!created.ok) throw new Error(`the consolidation automation is invalid: ${created.error}`);
  setSetting(db, INSTALLED, true, now);
  return true;
}

const readOr = (path: string, fallback: string) => (existsSync(path) ? readFileSync(path, 'utf8').trim() : fallback);

export interface ConsolidationToolDeps {
  db: Db;
  memoryDir: string;
}

export function createConsolidationTools(deps: ConsolidationToolDeps): Tool[] {
  const { db, memoryDir } = deps;
  const save = defineTool({
    name: 'consolidation_save',
    description: `Save the result of the nightly consolidation. weeklyTrends replaces the trends of the weekly file. memory, when given, replaces MEMORY.md and must have at most ${MEMORY_LIMIT} characters. logNote is one short sentence for the consolidation log.`,
    input: z.object({ weeklyTrends: z.string().min(1), memory: z.string().min(1).optional(), logNote: z.string().min(1) }),
    risk: 'write',
    async run(input, ctx) {
      if (!ctx.sessionKey.startsWith(CONSOLIDATION_PREFIX)) {
        return { content: 'consolidation_save works only in a consolidation run', isError: true };
      }
      const runDay = ctx.sessionKey.slice(CONSOLIDATION_PREFIX.length);
      const day = addDays(runDay, -1);
      const week = isoWeek(day);
      const now = ctx.clock();

      mkdirSync(join(memoryDir, 'weekly'), { recursive: true });
      const stats = consolidationStats(db, day, ctx.timeZone);
      writeFileSync(
        join(memoryDir, 'weekly', `${week}.md`),
        `# week ${week}\n\n## stats\n\nFrom the database, up to ${day}.\n\n${stats}\n\n## trends\n\n${input.weeklyTrends.trim()}\n`,
      );

      const memoryPath = join(memoryDir, 'MEMORY.md');
      const before = readOr(memoryPath, '');
      let memoryResult = 'MEMORY.md did not change';
      let retry = '';
      if (input.memory !== undefined && input.memory.trim() !== before) {
        const next = input.memory.trim();
        if (next.length > MEMORY_LIMIT) {
          memoryResult = `MEMORY.md did not change, because the new text has ${next.length} characters and the limit is ${MEMORY_LIMIT}`;
          retry = ' Shorten the memory text and call consolidation_save again.';
        } else {
          // the first backup of a day is the version from before that day's changes, so it is never replaced.
          const backup = join(memoryDir, 'history', `MEMORY.md.bak-${runDay}`);
          mkdirSync(join(memoryDir, 'history'), { recursive: true });
          if (existsSync(memoryPath) && !existsSync(backup)) copyFileSync(memoryPath, backup);
          writeFileSync(memoryPath, `${next}\n`);
          memoryResult = `MEMORY.md changed from ${before.length} to ${next.length} characters`;
        }
      }

      const entry = `- ${runDay} ${localTime(now, ctx.timeZone)}: consolidated ${day} into weekly/${week}.md. ${memoryResult}. ${input.logNote.trim()}`;
      appendFileSync(join(memoryDir, 'consolidation-log.md'), `${entry}\n`);
      return { content: `weekly/${week}.md is saved. ${memoryResult}.${retry}`, ...(retry ? { isError: true } : {}) };
    },
  });
  return [save];
}

export interface ConsolidationDeps {
  db: Db;
  clock: Clock;
  config: Pick<Config, 'timeZone'>;
  memoryDir: string;
  queue: RunQueue;
  agent: (input: RunInput) => Promise<RunResult>;
  signal: AbortSignal;
  newId?: () => string;
}

export function createConsolidation(deps: ConsolidationDeps): (automation: Automation) => Promise<JobResult> {
  const { db, clock, config, memoryDir } = deps;
  const tz = config.timeZone;
  return async (automation) => {
    // a late run still consolidates the day before the planned run.
    const runDay = localDay(new Date(automation.nextRunAt ?? clock()), tz);
    const day = addDays(runDay, -1);
    const week = isoWeek(day);
    const memory = readOr(join(memoryDir, 'MEMORY.md'), '');
    const text = [
      `Nightly memory consolidation for ${day}.`,
      '',
      'Statistics from the database:',
      consolidationStats(db, day, tz),
      '',
      `The daily note daily/${day}.md:`,
      readOr(dailyNotePath(memoryDir, day), '(there is no daily note for this day)'),
      '',
      `The current weekly file weekly/${week}.md:`,
      readOr(join(memoryDir, 'weekly', `${week}.md`), '(the weekly file does not exist yet)'),
      '',
      `The current MEMORY.md (${memory.length} of ${MEMORY_LIMIT} characters):`,
      memory || '(MEMORY.md is empty)',
    ].join('\n');

    const runId = (deps.newId ?? randomUUID)();
    const sessionKey = `${CONSOLIDATION_PREFIX}${runDay}`;
    const result = await deps.queue.enqueue(sessionKey, () =>
      deps.agent({
        runId,
        sessionKey,
        trigger: 'consolidation',
        slot: automation.slot,
        channel: 'none',
        allowedTools: CONSOLIDATION_TOOLS,
        events: [{ type: 'system_event', payload: { text } }],
        signal: deps.signal,
      }),
    );
    if (result.status !== 'completed') return { status: 'failed', runId, error: result.error ?? result.status };
    // the event log and not the trace tells whether the save worked. a lost trace row must not start a second run.
    const saved = succeededCalls(db, sessionKey, runId, 'consolidation_save').length > 0;
    return saved ? { status: 'completed', runId } : { status: 'failed', runId, error: 'the model did not save the consolidation' };
  };
}
