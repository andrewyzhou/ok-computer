import type { RunInput, RunResult } from '../agent/loop.js';
import { repairSession } from '../agent/recovery.js';
import { parseApprovalButton, type Decision, type ResolvedVia } from '../approvals/store.js';
import type { Button, ChannelAdapter, InboundMessage } from '../channels/types.js';
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
  'delegate',
  'goal_update',
  'goals_list',
  'goals_set',
  'goals_stats',
  'heartbeat_checklist_set',
  'memory_get',
  'memory_search',
  'memory_write',
  'now',
  'result_read',
  'skill_read',
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
  // a typed /approve gives the stored card with its buttons. only a button or the dashboard approves.
  approvalCard?: (id: number) => { text: string; buttons?: Button[][] };
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

      // the approved call can run before a later write fails, so the owner gets a reply in each case.
      const resolve = async (resolveApproval: NonNullable<RouterDeps['approvals']>, id: number, decision: Decision, via: ResolvedVia) => {
        try {
          await reply(await resolveApproval(id, decision, via));
        } catch (err) {
          logger.error('approval failed', { approvalId: id, err });
          await reply(`Something failed while I handled approval #${id}. The dashboard shows what happened.`);
        }
      };

      // only a button or an explicit command resolves an approval. free text such as "yes" goes to the model.
      if (message.button !== undefined) {
        const pressed = parseApprovalButton(message.button);
        if (pressed && deps.approvals) await resolve(deps.approvals, pressed.id, pressed.decision, 'button');
        else logger.warn('unknown button', { data: message.button });
        return;
      }
      const command = APPROVAL_COMMAND.exec(message.text.trim());
      if (command) {
        if (!deps.approvals || !deps.approvalCard) return reply('Approvals are not available.');
        const id = Number(command[2]);
        if (command[1]!.toLowerCase() === 'deny') return resolve(deps.approvals, id, 'deny', 'command');
        // the assistant can send a false card with the id of a real approval. the stored card comes back with its
        // buttons, so the owner sees the real input before the call runs.
        const card = deps.approvalCard(id);
        try {
          await channel.send({ chatId: message.chatId, text: card.text, ...(card.buttons ? { buttons: card.buttons } : {}) });
        } catch (err) {
          logger.error('reply failed', { channel: channel.id, err });
        }
        return;
      }

      // the user message goes into the log when its run starts. if it went in earlier, it could land between a
      // tool call and its result in a run that is still active.
      await queue.enqueue(MAIN_SESSION, async () => {
        if (message.text === '/new') {
          // no later run reads the calls before the reset, so a dangling call gets its result and its row now. /new
          // is the way out of a broken session, so a failed repair does not stop it.
          try {
            repairSession(db, MAIN_SESSION, clock, logger);
          } catch (err) {
            logger.error('repair before a reset failed', { err });
          }
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
