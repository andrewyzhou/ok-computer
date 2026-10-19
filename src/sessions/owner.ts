import { CLI_CHAT_ID } from '../channels/cli.js';
import { WEB, WEB_CHAT_ID } from '../channels/web.js';
import type { Button, ChannelAdapter, OutboundMessage } from '../channels/types.js';
import type { Db } from '../db/index.js';
import { getSetting, setSetting } from '../db/settings.js';
import type { Logger } from '../observability/logger.js';
import type { Clock } from '../time.js';

const OWNER_CHAT = 'owner_chat';

export interface OwnerChat {
  channel: string;
  chatId: string;
}

export interface OwnerMessenger {
  remember(chat: OwnerChat): void;
  chat(): OwnerChat | undefined;
  // send gives false when no chat of the owner is known or the channel fails.
  send(text: string, buttons?: Button[][], extra?: Pick<OutboundMessage, 'markdown' | 'details' | 'runId'>): Promise<boolean>;
}

// proactive messages go to the chat that the owner used last. the preferred chat, for example the owner's private
// telegram chat, comes before the cli, because the cli is often not in front of the owner. the web chat is never the
// target: it shows only while a tab of the dashboard is open, so approvals and alerts must reach telegram. the owner
// chat ignores a web message, and a saved web chat from an older setting is skipped. when only the web channel runs,
// no chat is known. each proactive message also goes to the web chat as a copy, as a reply with no turn, so an open
// tab shows an approval card with its buttons. the copy never changes the result of send.
export function createOwnerMessenger(deps: {
  db: Db;
  channels: Map<string, ChannelAdapter>;
  logger: Logger;
  clock: Clock;
  preferred?: OwnerChat;
}): OwnerMessenger {
  const { db, channels, logger, preferred } = deps;
  const chat = (): OwnerChat | undefined => {
    const saved = getSetting<OwnerChat>(db, OWNER_CHAT);
    const running = (candidate: OwnerChat | undefined) => candidate !== undefined && candidate.channel !== WEB && channels.has(candidate.channel);
    if (running(saved) && saved!.channel !== 'cli') return saved;
    if (running(preferred)) return preferred;
    if (running(saved)) return saved;
    return channels.has('cli') ? { channel: 'cli', chatId: CLI_CHAT_ID } : undefined;
  };
  return {
    remember(next) {
      if (next.channel === WEB) return;
      const saved = getSetting<OwnerChat>(db, OWNER_CHAT);
      if (saved?.channel !== next.channel || saved.chatId !== next.chatId) setSetting(db, OWNER_CHAT, next, deps.clock());
    },
    chat,
    async send(text, buttons, extra) {
      const out = { text, ...(buttons ? { buttons } : {}), ...extra };
      const target = chat();
      let sent = false;
      if (!target) logger.error('no chat of the owner is known, so a message was not sent', { text });
      else {
        try {
          await channels.get(target.channel)!.send({ chatId: target.chatId, ...out });
          sent = true;
        } catch (err) {
          logger.error('message to the owner failed', { channel: target.channel, err });
        }
      }
      const web = channels.get(WEB);
      if (web) {
        try {
          await web.send({ chatId: WEB_CHAT_ID, ...out });
        } catch (err) {
          logger.warn('the copy of a message to the web chat failed', { err });
        }
      }
      return sent;
    },
  };
}
