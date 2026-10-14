import { z } from 'zod';
import type { Db } from '../db/index.js';
import { addDays, localDay, zonedToUtc } from '../time.js';
import { defineTool, type Tool } from '../tools/registry.js';
import { planCheckin } from './checkins.js';
import { addGoal, formatGoal, getGoal, goalStats, listGoals, updateGoal } from './store.js';

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'use the form YYYY-MM-DD');
const eta = z
  .string()
  .describe('The time the owner expects to finish: "HH:MM" in the owner\'s time zone on the goal\'s day, or an iso time with an offset.');

export interface GoalToolDeps {
  db: Db;
  // the tools call this after they add or change a check-in automation.
  replan: () => void;
}

type EtaResult = { ok: true; iso: string } | { ok: false; error: string };

const HALF_DAY_MS = 12 * 3_600_000;

// a past eta got no check-in, and goal_update had already ended the old one, without a word to the model. so an
// "HH:MM" for a goal of today or later that is past moves to the next day when that is at most 12 hours ahead, for
// example "01:00" said at 23:00. an "HH:MM" for a goal of an earlier day means today, because a check-in can only
// come from now on. any other past eta is an error, and the goal and its check-in stay as they were. goals_set for an
// earlier day records what happened, so it takes each eta as it is.
function parseEta(value: string, goalDay: string, timeZone: string, now: Date, record = false): EtaResult {
  if (/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) {
    if (record) return { ok: true, iso: zonedToUtc(goalDay, value, timeZone).toISOString() };
    const today = localDay(now, timeZone);
    const day = goalDay < today ? today : goalDay;
    const sameDay = zonedToUtc(day, value, timeZone);
    if (sameDay > now) return { ok: true, iso: sameDay.toISOString() };
    const nextDay = zonedToUtc(addDays(day, 1), value, timeZone);
    if (nextDay > now && nextDay.getTime() - now.getTime() <= HALF_DAY_MS) return { ok: true, iso: nextDay.toISOString() };
    return { ok: false, error: `the eta ${value} on ${day} is already past. give a later time, or an iso time with a date.` };
  }
  if (/(Z|[+-]\d{2}:\d{2})$/.test(value) && !Number.isNaN(Date.parse(value))) {
    if (!record && new Date(value) <= now) return { ok: false, error: `the eta ${value} is already past. give a later time.` };
    return { ok: true, iso: new Date(value).toISOString() };
  }
  return { ok: false, error: `the eta "${value}" is not "HH:MM" or an iso time with an offset` };
}

export function createGoalTools(deps: GoalToolDeps): Tool[] {
  const { db } = deps;

  const goalsSet = defineTool({
    name: 'goals_set',
    description:
      'Add one or more goals for a day, each with an optional ETA. A goal with an ETA gets a check-in at that time. Returns the goals of that day.',
    input: z.object({
      day: day.optional().describe("The day of the goals. The default is today in the owner's time zone."),
      goals: z.array(z.object({ title: z.string().min(1), eta: eta.optional() })).min(1).max(10),
    }),
    risk: 'write',
    async run(input, ctx) {
      const now = ctx.clock();
      const goalDay = input.day ?? localDay(now, ctx.timeZone);
      const etas: Array<string | undefined> = [];
      for (const goal of input.goals) {
        if (!goal.eta) {
          etas.push(undefined);
          continue;
        }
        const parsed = parseEta(goal.eta, goalDay, ctx.timeZone, now, goalDay < localDay(now, ctx.timeZone));
        if (!parsed.ok) return { content: parsed.error, isError: true };
        etas.push(parsed.iso);
      }
      input.goals.forEach((goal, i) => {
        const added = addGoal(db, { day: goalDay, title: goal.title, ...(etas[i] ? { eta: etas[i] } : {}) }, now);
        planCheckin(db, added, now, ctx.timeZone);
      });
      deps.replan();
      return { content: `goals for ${goalDay}:\n${listGoals(db, goalDay).map((g) => formatGoal(g, ctx.timeZone)).join('\n')}` };
    },
  });

  const goalsList = defineTool({
    name: 'goals_list',
    description: 'List the goals of one day, or of a range of days with from and to. The default is today.',
    input: z.object({ day: day.optional(), from: day.optional(), to: day.optional() }),
    risk: 'read',
    async run(input, ctx) {
      const today = localDay(ctx.clock(), ctx.timeZone);
      const from = input.from ?? input.day ?? today;
      const to = input.to ?? input.day ?? (input.from ? today : from);
      const goals = listGoals(db, from, to);
      if (!goals.length) return { content: `no goals from ${from} to ${to}` };
      return { content: goals.map((goal) => `${goal.day} ${formatGoal(goal, ctx.timeZone)}`).join('\n') };
    },
  });

  const goalUpdate = defineTool({
    name: 'goal_update',
    description:
      'Change the status, ETA, or note of a goal. Use status done when the owner finished it, and dropped when the owner gives it up. A new ETA plans a new check-in. Put the reason for a slip in the note.',
    input: z.object({
      id: z.number().int(),
      status: z.enum(['open', 'done', 'dropped']).optional(),
      eta: eta.optional(),
      note: z.string().optional(),
    }),
    risk: 'write',
    async run(input, ctx) {
      const now = ctx.clock();
      const goal = getGoal(db, input.id);
      if (!goal) return { content: `no goal has the id ${input.id}`, isError: true };
      let etaIso: string | undefined;
      if (input.eta) {
        const parsed = parseEta(input.eta, goal.day, ctx.timeZone, now);
        if (!parsed.ok) return { content: parsed.error, isError: true };
        etaIso = parsed.iso;
      }
      const updated = updateGoal(
        db,
        input.id,
        {
          ...(input.status ? { status: input.status } : {}),
          ...(etaIso ? { eta: etaIso } : {}),
          ...(input.note !== undefined ? { note: input.note } : {}),
        },
        now,
      );
      if (!updated.ok) return { content: updated.error, isError: true };
      if (input.status || etaIso) {
        planCheckin(db, updated.value, now, ctx.timeZone);
        deps.replan();
      }
      return { content: formatGoal(updated.value, ctx.timeZone) };
    },
  });

  const goalsStats = defineTool({
    name: 'goals_stats',
    description: 'Get the hit rate and streaks of goals for a range of days. The default is the last 7 days.',
    input: z.object({ from: day.optional(), to: day.optional() }),
    risk: 'read',
    async run(input, ctx) {
      const to = input.to ?? localDay(ctx.clock(), ctx.timeZone);
      const from = input.from ?? addDays(to, -6);
      return { content: JSON.stringify(goalStats(db, from, to)) };
    },
  });

  return [goalsSet, goalsList, goalUpdate, goalsStats];
}
