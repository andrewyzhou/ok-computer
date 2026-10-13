import { z } from 'zod';
import { localDay } from '../time.js';
import { defineTool, type Tool } from '../tools/registry.js';
import { appendToDailyNote, DAILY_SECTIONS } from './daily.js';

export interface MemoryToolDeps {
  memoryDir: string;
}

export function createMemoryTools(deps: MemoryToolDeps): Tool[] {
  const memoryWrite = defineTool({
    name: 'memory_write',
    description:
      "Save a durable fact, preference, decision, or event to a daily note, under one of its sections. The default is the notes section of today's note. Nightly consolidation moves lasting facts from the daily notes into MEMORY.md.",
    input: z.object({
      text: z.string().min(1),
      section: z.enum(DAILY_SECTIONS).default('notes'),
      day: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/, 'use the form YYYY-MM-DD')
        .optional()
        .describe("The day of the note. The default is today in the owner's time zone."),
    }),
    risk: 'write',
    async run(input, ctx) {
      const day = input.day ?? localDay(ctx.clock(), ctx.timeZone);
      appendToDailyNote(deps.memoryDir, day, input.section, input.text);
      return { content: `saved to daily/${day}.md under ## ${input.section}` };
    },
  });

  return [memoryWrite];
}
