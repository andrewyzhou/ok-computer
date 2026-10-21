import { z } from 'zod';
import type { Brief, BriefSource } from '../dashboard/brief-types.js';
import { formatLocal, localDay, localTime } from '../time.js';
import { defineTool, type Tool } from '../tools/registry.js';
import type { BriefContext } from './context.js';
import { briefSchedule, setBriefTime } from './install.js';
import { briefOfDay } from './store.js';

// the tools of the today track. app.ts registers them with one line, and the main session lists them
// (src/sessions/router.ts), so the owner can ask for the brief and move it by chat ("move my brief to 8").

export const BRIEF_TOOLS = ['brief_read', 'brief_set_time'] as const;

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'use the form YYYY-MM-DD');
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'use the form HH:MM, from 00:00 to 23:59');

// the source of an item as the agent reads it, so it can follow up with calendar_get_event or gmail_read_thread.
export function sourceText(source: BriefSource): string {
  switch (source.kind) {
    case 'event':
      return `event ${source.key}`;
    case 'thread':
      return `thread ${source.account}/${source.threadId}`;
    case 'digest':
      return `digest ${source.digestId}`;
    case 'draft':
      return `draft ${source.draftId}`;
    case 'proposal':
      return `proposal ${source.proposalId}`;
    case 'delegation':
      return `delegation ${source.delegationId}`;
    case 'goal':
      return `goal ${source.goalId}`;
    case 'subscription':
      return `subscription ${source.key}, alert ${source.alertId}`;
  }
}

// the stored brief as plain text: a heading line, then each section with its note and one line for each item.
export function briefAsText(brief: Brief, timeZone: string): string {
  const lines = [`Brief of ${brief.day}, built ${localTime(new Date(brief.createdAt), timeZone)}.`];
  for (const section of brief.content.sections) {
    lines.push('', section.title);
    if (section.note) lines.push(section.note);
    for (const item of section.items) lines.push(`- ${item.title}${item.detail ? `: ${item.detail}` : ''} [${sourceText(item.source)}]`);
  }
  return lines.join('\n');
}

export function createBriefTools(ctx: BriefContext): Tool[] {
  const read = defineTool({
    name: 'brief_read',
    description:
      'Read the stored morning brief of a day: the events, conflicts, tight moves between places, unanswered invitations, deadlines, the inbox digest, delegations and goals, each with its source. The default is today. It does not build a new brief.',
    input: z.object({ day: day.optional().describe("The day of the brief. The default is today in the owner's time zone.") }),
    risk: 'read',
    // the brief repeats event titles and mail subjects that other people wrote.
    untrustedOutput: 'brief',
    async run(input) {
      const of = input.day ?? localDay(ctx.clock(), ctx.timeZone);
      const brief = briefOfDay(ctx.db, of);
      if (brief) return { content: briefAsText(brief, ctx.timeZone) };
      const schedule = briefSchedule(ctx.db, ctx.timeZone, false);
      const when = !schedule.enabled ? ' the brief is turned off.' : schedule.time ? ` it is built each day at ${schedule.time}.` : '';
      return { content: `there is no brief for ${of} yet.${when}` };
    },
  });

  const setTime = defineTool({
    name: 'brief_set_time',
    description:
      'Move the morning brief to a new time each day, for example when the owner says "move my brief to 8". It turns the brief on, and makes the brief automation again if the owner deleted it.',
    input: z.object({ time: time.describe("The new time of the brief, HH:MM in the owner's time zone.") }),
    risk: 'write',
    async run(input) {
      const result = setBriefTime(ctx.db, input.time, ctx.clock(), ctx.timeZone);
      if (!result.ok) return { content: result.error, isError: true };
      ctx.replan();
      const next = result.value.nextRunAt ? ` the next one is ${formatLocal(new Date(result.value.nextRunAt), ctx.timeZone)}.` : '';
      return { content: `the brief now comes at ${input.time} each day.${next}` };
    },
  });

  return [read, setTime];
}
