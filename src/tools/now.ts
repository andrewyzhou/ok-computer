import { z } from 'zod';
import { formatLocal } from '../time.js';
import { defineTool } from './registry.js';

export const nowTool = defineTool({
  name: 'now',
  description: "Get the current date and time in the owner's time zone.",
  input: z.object({}),
  risk: 'read',
  async run(_input, ctx) {
    const now = ctx.clock();
    return { content: `${formatLocal(now, ctx.timeZone)} (${now.toISOString()})` };
  },
});
