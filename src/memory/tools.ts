import { existsSync, readFileSync } from 'node:fs';
import { z } from 'zod';
import type { Db } from '../db/index.js';
import { localDay } from '../time.js';
import { defineTool, type Tool } from '../tools/registry.js';
import { appendToDailyNote, DAILY_SECTIONS } from './daily.js';
import { resolveMemoryPath, searchMemory, syncMemoryIndex } from './search.js';

const HIT_CHARS = 800;
const MAX_LINES = 500;

export interface MemoryToolDeps {
  db: Db;
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

  const memorySearch = defineTool({
    name: 'memory_search',
    description:
      'Search the daily notes, the weekly summaries, and MEMORY.md by keywords. Returns the best matching passages with their file and lines. Use memory_get to read more of a file.',
    input: z.object({ query: z.string().min(1), limit: z.number().int().min(1).max(20).default(5) }),
    risk: 'read',
    async run({ query, limit }, ctx) {
      syncMemoryIndex(deps.db, deps.memoryDir, ctx.clock());
      const hits = searchMemory(deps.db, query, limit);
      if (!hits.length) return { content: `no memory matches "${query}"` };
      const blocks = hits.map((hit) => {
        const text = hit.text.length > HIT_CHARS ? `${hit.text.slice(0, HIT_CHARS)}...` : hit.text;
        return `${hit.path} lines ${hit.startLine}-${hit.endLine} (${hit.heading}):\n${text}`;
      });
      return { content: blocks.join('\n\n') };
    },
  });

  const memoryGet = defineTool({
    name: 'memory_get',
    description: `Read a memory file, or some of its lines. The path is relative to the memory folder, for example "daily/2026-10-12.md", "weekly/2026-W42.md" or "MEMORY.md". At most ${MAX_LINES} lines come back.`,
    input: z.object({
      path: z.string().min(1),
      fromLine: z.number().int().min(1).default(1),
      lines: z.number().int().min(1).max(MAX_LINES).default(200),
    }),
    risk: 'read',
    async run({ path, fromLine, lines }) {
      const full = resolveMemoryPath(deps.memoryDir, path);
      if (!full) return { content: `the path ${path} is outside the memory folder`, isError: true };
      if (!existsSync(full)) return { content: `the memory file ${path} does not exist`, isError: true };
      const all = readFileSync(full, 'utf8').split(/\r?\n/);
      const slice = all.slice(fromLine - 1, fromLine - 1 + lines);
      return { content: `${path} lines ${fromLine}-${fromLine + slice.length - 1} of ${all.length}:\n${slice.join('\n')}` };
    },
  });

  return [memoryWrite, memorySearch, memoryGet];
}
