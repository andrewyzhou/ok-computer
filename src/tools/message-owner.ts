import { z } from 'zod';
import type { OwnerMessenger } from '../sessions/owner.js';
import { defineTool } from './registry.js';

export function createMessageOwnerTool(owner: Pick<OwnerMessenger, 'send'>) {
  return defineTool({
    name: 'message_owner',
    description: "Send a message to the owner now, in the owner's last chat. Use it in background runs.",
    input: z.object({ text: z.string().min(1) }),
    risk: 'write',
    async run({ text }, ctx) {
      return (await owner.send(text, undefined, { markdown: true, runId: ctx.runId }))
        ? { content: 'sent' }
        : { content: 'the message was not sent because no chat of the owner is available', isError: true };
    },
  });
}
