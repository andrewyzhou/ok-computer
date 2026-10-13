import type { Bot } from 'grammy';
import type { Logger } from '../observability/logger.js';
import { systemClock, type Clock } from '../time.js';
import type { ChannelAdapter, InboundMessage } from './types.js';

export const TELEGRAM = 'telegram';
export const TELEGRAM_LIMIT = 4096;

// a long reply breaks at a paragraph, else at a line, else at a word, so each part stays readable.
export function splitMessage(text: string, limit = TELEGRAM_LIMIT): string[] {
  const parts: string[] = [];
  let rest = text.trim();
  while (rest.length > limit) {
    const window = rest.slice(0, limit + 1);
    let at = [window.lastIndexOf('\n\n'), window.lastIndexOf('\n'), window.lastIndexOf(' ')].find((i) => i > 0) ?? limit;
    // a cut between the two halves of a surrogate pair breaks the character.
    if (at === limit && /[\uD800-\uDBFF]/.test(rest[limit - 1]!)) at = limit - 1;
    parts.push(rest.slice(0, at).trimEnd());
    rest = rest.slice(at).trimStart();
  }
  if (rest) parts.push(rest);
  return parts;
}

export interface TelegramOptions {
  bot: Bot;
  logger: Logger;
  clock?: Clock;
}

// the adapter sends plain text without a parse mode. model text then cannot break the telegram formatting rules.
export function createTelegramChannel(options: TelegramOptions): ChannelAdapter {
  const { bot } = options;
  const clock = options.clock ?? systemClock;
  const logger = options.logger.child({ channel: TELEGRAM });

  return {
    id: TELEGRAM,
    async start(onMessage) {
      const received = (message: Omit<InboundMessage, 'channel' | 'receivedAt'>) =>
        onMessage({ ...message, channel: TELEGRAM, receivedAt: clock().toISOString() });

      // the bot answers only in a private chat. a group chat would show the owner's data to other people.
      const isPrivate = (chat: { type: string } | undefined) => !chat || chat.type === 'private';

      bot.on('message:text', (ctx) => {
        if (!isPrivate(ctx.chat)) return logger.info('message outside a private chat ignored', { chatId: String(ctx.chat.id) });
        const reply = ctx.message.reply_to_message;
        received({
          senderId: String(ctx.from.id),
          chatId: String(ctx.chat.id),
          text: ctx.message.text,
          ...(reply ? { replyToMessageId: String(reply.message_id) } : {}),
        });
      });
      bot.on('callback_query:data', async (ctx) => {
        // telegram shows a spinner on the button until the bot answers the press.
        await ctx.answerCallbackQuery();
        if (!isPrivate(ctx.chat)) return logger.info('button outside a private chat ignored', { chatId: String(ctx.chat?.id) });
        received({
          senderId: String(ctx.from.id),
          chatId: String(ctx.chat?.id ?? ctx.from.id),
          text: '',
          button: ctx.callbackQuery.data,
        });
      });
      bot.on('message', (ctx) => logger.info('message without text ignored', { senderId: String(ctx.from.id) }));
      bot.catch((err) => logger.error('telegram update failed', { err: err.error }));

      // polling runs in the background. a network failure is logged, and the other channels keep working.
      void bot
        .start({ onStart: (info) => logger.info('telegram polling started', { username: info.username }) })
        .catch((err: unknown) => logger.error('telegram polling stopped', { err }));
    },
    async stop() {
      if (bot.isRunning()) await bot.stop();
    },
    async send(out) {
      const parts = splitMessage(out.text);
      const keyboard = out.buttons?.length
        ? { inline_keyboard: out.buttons.map((row) => row.map((button) => ({ text: button.text, callback_data: button.data }))) }
        : undefined;
      let messageId = '';
      for (const [i, part] of parts.entries()) {
        const last = i === parts.length - 1;
        const sent = await bot.api.sendMessage(out.chatId, part, last && keyboard ? { reply_markup: keyboard } : {});
        messageId = String(sent.message_id);
      }
      return { messageId };
    },
  };
}
