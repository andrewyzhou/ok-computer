import type { RunInput, RunResult } from '../agent/loop.js';
import { repairSession } from '../agent/recovery.js';
import { parseApprovalButton, type Decision, type ResolvedVia } from '../approvals/store.js';
import { parseAlwaysButton } from '../approvals/always.js';
import type { ChannelAdapter, InboundMessage } from '../channels/types.js';
import type { Db } from '../db/index.js';
import { appendEvent } from '../events/log.js';
import type { Logger } from '../observability/logger.js';
import type { Clock } from '../time.js';
import type { Card, RunState } from './commands.js';
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
  approvalCard?: (id: number) => Card;
  // "always allow" asks the owner to confirm, then adds a rule and approves.
  always?: { confirm(id: number): Card; apply(id: number, expires: Date): Promise<string> };
  // commands such as /status answer in code. undefined means that the text is not such a command.
  commands?: (text: string, state: RunState) => Card[] | undefined;
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
  // the main run that runs now. /stop and the stop button of its draft abort it.
  let current: { stop: AbortController; since: Date; tools?: string; stoppedWhile?: string } | undefined;
  // the stop keeps the tools that ran at that moment. their effect is unknown, and the owner must know that.
  const stopCurrent = () => {
    if (!current) return false;
    current.stoppedWhile ??= current.tools;
    current.stop.abort();
    return true;
  };
  // the owner messages that wait in the queue of the main session. /status shows the count.
  let queued = 0;

  return {
    async handle(message) {
      const channel = deps.channels.get(message.channel);
      if (!channel) {
        logger.error('message from a channel that is not running', { channel: message.channel });
        return;
      }
      const send = async (card: Card & { markdown?: boolean; runId?: string }) => {
        try {
          await channel.send({ chatId: message.chatId, ...card });
        } catch (err) {
          logger.error('reply failed', { channel: channel.id, err });
        }
      };
      const reply = (text: string) => send({ text });

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
        const always = parseAlwaysButton(message.button);
        if (pressed && deps.approvals) await resolve(deps.approvals, pressed.id, pressed.decision, 'button');
        else if (always && deps.always) {
          const { confirm, apply } = deps.always;
          const { expires } = always;
          if (!expires) await send(confirm(always.id));
          else await resolve(async (id) => apply(id, expires), always.id, 'approve', 'button');
        } else logger.warn('unknown button', { data: message.button });
        return;
      }
      // /stop and the commands answer at once. a message that waits in the queue would wait for the run it stops.
      if (message.text.trim() === '/stop') {
        if (!stopCurrent()) return reply('Nothing runs now.');
        return;
      }
      const state: RunState = { queued, ...(current ? { runningSince: current.since } : {}), ...(current?.tools ? { tools: current.tools } : {}) };
      const cards = deps.commands?.(message.text, state);
      if (cards) {
        for (const card of cards) await send(card);
        return;
      }
      const command = APPROVAL_COMMAND.exec(message.text.trim());
      if (command) {
        if (!deps.approvals || !deps.approvalCard) return reply('Approvals are not available.');
        const id = Number(command[2]);
        if (command[1]!.toLowerCase() === 'deny') return resolve(deps.approvals, id, 'deny', 'command');
        // the assistant can send a false card with the id of a real approval. the stored card comes back with its
        // buttons, so the owner sees the real input before the call runs.
        return send(deps.approvalCard(id));
      }

      // the user message goes into the log when its run starts. if it went in earlier, it could land between a
      // tool call and its result in a run that is still active.
      queued++;
      await queue.enqueue(MAIN_SESSION, async () => {
        queued--;
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
        const stop = new AbortController();
        const run: NonNullable<typeof current> = { stop, since: clock() };
        current = run;
        const progress = channel.progress?.(message, () => (current === run ? stopCurrent() : undefined));
        let result: RunResult | undefined;
        try {
          result = await deps.agent({
            sessionKey: MAIN_SESSION,
            trigger: 'message',
            slot: 'main',
            channel: message.channel,
            allowedTools: MAIN_TOOLS,
            events: [{ type: 'user_message', payload: { text: message.text, channel: message.channel, chatId: message.chatId } }],
            signal: deps.signal ? AbortSignal.any([deps.signal, stop.signal]) : stop.signal,
            ...(progress ? { onText: (text: string) => progress.text(text) } : {}),
            onActivity: (tools: string | undefined) => {
              run.tools = tools;
              progress?.activity(tools);
            },
          });
        } finally {
          current = undefined;
          await progress?.end(result?.status === 'completed');
        }
        // the model did not see that its reply was cut, so the session says so. the next run then does not take the
        // owner's next message as an answer to a reply that never came.
        if (stop.signal.aborted && result.status === 'aborted') {
          appendEvent(db, { sessionKey: MAIN_SESSION, runId: null, type: 'system_event', payload: { text: 'The owner stopped the previous reply before it was done.' } }, clock());
          await reply(run.stoppedWhile ? `Stopped while ${run.stoppedWhile} ran. Its effect is unknown.` : 'Stopped.');
          return;
        }
        if (result.status !== 'completed') {
          await reply(`Sorry, I could not finish that: ${result.error ?? result.status}.`);
          return;
        }
        const text = result.text.trim();
        if (!text) logger.warn('run completed without text', { runId: result.runId });
        if (text && text !== NO_REPLY) await send({ text: result.text, markdown: true, runId: result.runId });
      });
    },
  };
}
