import type { RunInput, RunResult } from '../agent/loop.js';
import { parseApprovalButton, type Decision, type ResolvedVia } from '../approvals/store.js';
import type { ChannelAdapter, InboundMessage } from '../channels/types.js';
import type { Db } from '../db/index.js';
import { appendEvent } from '../events/log.js';
import type { Logger } from '../observability/logger.js';
import type { Clock } from '../time.js';
import type { RunQueue } from './queue.js';

// all owner messages from all channels share one continuous conversation.
export const MAIN_SESSION = 'main';
export const MAIN_TOOLS: readonly string[] = [
  'automations_create',
  'automations_delete',
  'automations_list',
  'automations_update',
  'goal_update',
  'goals_list',
  'goals_set',
  'goals_stats',
  'heartbeat_checklist_set',
  'memory_write',
  'now',
];
export const NO_REPLY = 'NO_REPLY';

export interface RouterDeps {
  db: Db;
  logger: Logger;
  clock: Clock;
  queue: RunQueue;
  channels: Map<string, ChannelAdapter>;
  agent: (input: RunInput) => Promise<RunResult>;
  isOwner: (message: InboundMessage) => boolean;
  // the router saves the chat of each owner message, so proactive messages go to the chat that the owner used last.
  rememberOwnerChat?: (chat: { channel: string; chatId: string }) => void;
  // resolve gives the text of the reply to the owner.
  approvals?: (id: number, decision: Decision, via: ResolvedVia) => Promise<string>;
  // the router calls this on /new before the reset event goes into the log.
  onReset?: () => void;
  signal?: AbortSignal;
}

const APPROVAL_COMMAND = /^\/(approve|deny)\s+#?(\d+)$/i;

export interface Router {
  handle(message: InboundMessage): Promise<void>;
}

export function createRouter(deps: RouterDeps): Router {
  const { db, logger, clock, queue } = deps;

  return {
    async handle(message) {
      const channel = deps.channels.get(message.channel);
      if (!channel) {
        logger.error('message from a channel that is not running', { channel: message.channel });
        return;
      }
      const reply = async (text: string) => {
        try {
          await channel.send({ chatId: message.chatId, text });
        } catch (err) {
          logger.error('reply failed', { channel: channel.id, err });
        }
      };

      // the text of an unknown sender never reaches the model or the event log.
      if (!deps.isOwner(message)) {
        logger.warn('message from an unknown sender', { channel: message.channel, senderId: message.senderId });
        await reply('Sorry, I only talk with my owner.');
        return;
      }
      deps.rememberOwnerChat?.({ channel: message.channel, chatId: message.chatId });

      // only a button or an explicit command resolves an approval. free text such as "yes" goes to the model.
      if (message.button !== undefined) {
        const pressed = parseApprovalButton(message.button);
        if (pressed && deps.approvals) await reply(await deps.approvals(pressed.id, pressed.decision, 'button'));
        else logger.warn('unknown button', { data: message.button });
        return;
      }
      const command = APPROVAL_COMMAND.exec(message.text.trim());
      if (command) {
        if (!deps.approvals) return reply('Approvals are not available.');
        const decision = command[1]!.toLowerCase() === 'approve' ? 'approve' : 'deny';
        await reply(await deps.approvals(Number(command[2]), decision, 'command'));
        return;
      }

      // the user message goes into the log when its run starts. if it went in earlier, it could land between a
      // tool call and its result in a run that is still active.
      await queue.enqueue(MAIN_SESSION, async () => {
        if (message.text === '/new') {
          deps.onReset?.();
          appendEvent(db, { sessionKey: MAIN_SESSION, runId: null, type: 'session_reset', payload: {} }, clock());
          await reply('Started a new session.');
          return;
        }
        const result = await deps.agent({
          sessionKey: MAIN_SESSION,
          trigger: 'message',
          slot: 'main',
          channel: message.channel,
          allowedTools: MAIN_TOOLS,
          events: [{ type: 'user_message', payload: { text: message.text, channel: message.channel, chatId: message.chatId } }],
          signal: deps.signal,
        });
        if (result.status !== 'completed') {
          await reply(`Sorry, I could not finish that: ${result.error ?? result.status}.`);
          return;
        }
        const text = result.text.trim();
        if (!text) logger.warn('run completed without text', { runId: result.runId });
        if (text && text !== NO_REPLY) await reply(result.text);
      });
    },
  };
}
