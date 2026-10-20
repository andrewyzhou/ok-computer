import { z } from 'zod';
import { defineTool, type Tool } from '../tools/registry.js';
import { notBuilt, type BriefContext } from './context.js';

// the tools of the today track. app.ts registers them with one line, and the main session lists them
// (src/sessions/router.ts), so the owner can ask for the brief and move it by chat ("move my brief to 8").

export const BRIEF_TOOLS = ['brief_read', 'brief_set_time'] as const;

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'use the form YYYY-MM-DD');
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'use the form HH:MM, from 00:00 to 23:59');

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
      return notBuilt('brief_read');
    },
  });

  const setTime = defineTool({
    name: 'brief_set_time',
    description:
      'Move the morning brief to a new time each day, for example when the owner says "move my brief to 8". It turns the brief on, and makes the brief automation again if the owner deleted it.',
    input: z.object({ time: time.describe("The new time of the brief, HH:MM in the owner's time zone.") }),
    risk: 'write',
    async run(input) {
      return notBuilt('brief_set_time');
    },
  });

  return [read, setTime];
}
