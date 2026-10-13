import { z } from 'zod';
import { SLOTS } from '../config/schema.js';
import type { Db } from '../db/index.js';
import type { TaintSource } from '../policy/policy.js';
import { sessionTaint } from '../policy/store.js';
import { formatLocal } from '../time.js';
import { defineTool, type Tool } from '../tools/registry.js';
import { describeSchedule, scheduleSchema } from './schedule.js';
import {
  createAutomation,
  deleteAutomation,
  getAutomation,
  listAutomations,
  updateAutomation,
  type Automation,
} from './store.js';

const schedule = scheduleSchema.describe(
  'When to run. "at" runs one time at an iso time with an offset. "every" repeats after everyMs milliseconds. "cron" uses a 5-field cron expression in tz, which is the owner\'s time zone by default.',
);

// the agent can create only these payloads. the system payloads (heartbeat, check-ins, results) come from code.
const agentPayload = z
  .discriminatedUnion('type', [
    z.object({ type: z.literal('agent'), prompt: z.string().min(1) }),
    z.object({ type: z.literal('system_event'), text: z.string().min(1) }),
  ])
  .describe(
    '"agent" starts a run with this prompt; its final text goes to the owner unless it is NO_REPLY. "system_event" only adds a note to the main session without a model call.',
  );

const sessionMode = z
  .enum(['isolated', 'main'])
  .describe('"isolated" runs in a fresh session. "main" runs in the conversation with the owner.');

export function formatAutomation(automation: Automation, timeZone: string): string {
  const next = automation.nextRunAt ? `next ${formatLocal(new Date(automation.nextRunAt), timeZone)}` : 'no next run';
  const state = automation.enabled ? next : 'disabled';
  const failures = automation.consecutiveFailures ? `, ${automation.consecutiveFailures} failures in a row` : '';
  const what = automation.payload.type === 'agent' ? `prompt: ${automation.payload.prompt}` : automation.payload.type === 'system_event' ? `text: ${automation.payload.text}` : automation.payload.type;
  return `${automation.id} "${automation.name}": ${describeSchedule(automation.schedule, timeZone)}, ${state}, ${automation.sessionMode} session, by ${automation.createdBy}${failures}. ${what}`;
}

// a one-shot automation that already ran is history, not a plan, so the list leaves it out.
const finished = (automation: Automation) =>
  automation.schedule.kind === 'at' && !automation.enabled && automation.lastRunAt !== null;

// one entry for each source, as in the taint of a session.
function unionTaint(a: TaintSource[], b: TaintSource[]): TaintSource[] {
  const sources = new Set(a.map((each) => each.source));
  return [...a, ...b.filter((each) => !sources.has(each.source))];
}

export function createAutomationTools(deps: { db: Db; replan: () => void }): Tool[] {
  const { db } = deps;
  // the code makes the heartbeat, the polls and the routines. they watch the owner's accounts and goals, so a pause, a
  // new schedule or a delete always asks the owner. else text that a session read could stop them without a word.
  const codeMade = (id: string) => {
    const type = getAutomation(db, id)?.payload.type;
    return type !== undefined && type !== 'agent' && type !== 'system_event';
  };

  const list = defineTool({
    name: 'automations_list',
    description: 'List the automations with their ids, schedules, next run times, and states.',
    input: z.object({}),
    risk: 'read',
    async run(_input, ctx) {
      const automations = listAutomations(db).filter((automation) => !finished(automation));
      if (!automations.length) return { content: 'there are no automations' };
      const content = automations.map((automation) => formatAutomation(automation, ctx.timeZone)).join('\n');
      // the name and the prompt of a tainted automation repeat untrusted text, so the list is untrusted too. else a
      // session after /new reads that text and stays clean.
      const sources = [...new Set(automations.flatMap((automation) => automation.taint.map((each) => each.source)))];
      return { content, ...(sources.length ? { untrustedSource: sources.join(', ') } : {}) };
    },
  });

  const create = defineTool({
    name: 'automations_create',
    description:
      'Create an automation that runs at exact times. Use it for reminders and routines that the owner describes, for example "every weekday at 8am ask me about my plan".',
    input: z.object({
      name: z.string().min(1),
      schedule,
      payload: agentPayload,
      sessionMode: sessionMode.default('isolated'),
      slot: z.enum(SLOTS).default('main').describe('The model slot for agent runs.'),
    }),
    risk: 'write',
    async run(input, ctx) {
      // the prompt can repeat untrusted text that the session read. its runs keep that taint.
      const created = createAutomation(db, { ...input, createdBy: 'agent', taint: sessionTaint(db, ctx.sessionKey) }, ctx.clock(), ctx.timeZone);
      if (!created.ok) return { content: created.error, isError: true };
      deps.replan();
      return { content: `created ${formatAutomation(created.value, ctx.timeZone)}` };
    },
  });

  const update = defineTool({
    name: 'automations_update',
    description: 'Change an automation by id: its name, schedule, payload, session mode, slot, or enabled state.',
    input: z.object({
      id: z.string(),
      name: z.string().min(1).optional(),
      schedule: schedule.optional(),
      payload: agentPayload.optional(),
      sessionMode: sessionMode.optional(),
      slot: z.enum(SLOTS).optional(),
      enabled: z.boolean().optional(),
    }),
    risk: 'write',
    riskFor: (input) => (codeMade(input.id) && (input.enabled !== undefined || input.schedule !== undefined) ? 'external' : 'write'),
    async run({ id, ...patch }, ctx) {
      const current = getAutomation(db, id);
      if (!current) return { content: `no automation has the id ${id}`, isError: true };
      const own = current.payload.type === 'agent' || current.payload.type === 'system_event';
      if (patch.payload && !own) {
        return { content: `the payload of a ${current.payload.type} automation cannot change`, isError: true };
      }
      // the routine reminders stop through their condition. a new prompt must not remove the condition.
      const payload: Automation['payload'] | undefined =
        patch.payload?.type === 'agent' && current.payload.type === 'agent' && current.payload.condition
          ? { ...patch.payload, condition: current.payload.condition }
          : patch.payload;
      // the name and the payload are text that each run reads. the old taint stays while any old text stays, and a
      // session that writes text adds its own taint. so a rename or a save of the same text cannot remove a taint. a
      // change of the schedule or the state writes no text, so a pause from a tainted session does not taint it.
      const replaced =
        patch.name !== undefined &&
        patch.name !== current.name &&
        payload !== undefined &&
        JSON.stringify(payload) !== JSON.stringify(current.payload);
      const writes = patch.name !== undefined || payload !== undefined;
      const taint = unionTaint(replaced ? [] : current.taint, writes ? sessionTaint(db, ctx.sessionKey) : []);
      const updated = updateAutomation(
        db,
        id,
        { ...patch, ...(payload && { payload }), taint },
        ctx.clock(),
        ctx.timeZone,
      );
      if (!updated.ok) return { content: updated.error, isError: true };
      deps.replan();
      return { content: `updated ${formatAutomation(updated.value, ctx.timeZone)}` };
    },
  });

  const remove = defineTool({
    name: 'automations_delete',
    description: 'Delete an automation by id. To pause an automation, use automations_update with enabled false.',
    input: z.object({ id: z.string() }),
    risk: 'write',
    riskFor: (input) => (codeMade(input.id) ? 'external' : 'write'),
    async run({ id }) {
      if (!deleteAutomation(db, id)) return { content: `no automation has the id ${id}`, isError: true };
      deps.replan();
      return { content: `deleted ${id}` };
    },
  });

  return [list, create, update, remove];
}
