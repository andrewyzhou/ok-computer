import { GrammyError, type Bot } from 'grammy';
import type { InlineKeyboardMarkup } from 'grammy/types';
import type { Logger } from '../observability/logger.js';
import { headOf, tailOf } from '../text.js';
import { systemClock, type Clock } from '../time.js';
import { escapeHtml, htmlToPlain, markdownToHtmlParts } from './telegram-html.js';
import type { Button, ChannelAdapter, InboundMessage } from './types.js';

export const TELEGRAM = 'telegram';
export const TELEGRAM_LIMIT = 4096;
// a rich message holds up to 32768 characters. the length in utf-16 units is never below the count of characters.
export const RICH_LIMIT = 32_768;

export const COMMANDS = [
  { command: 'new', description: 'Start a fresh conversation' },
  { command: 'status', description: 'What runs now, and what waits for you' },
  { command: 'goals', description: "Today's goals" },
  { command: 'approvals', description: 'Pending approvals with their buttons' },
  { command: 'dashboard', description: 'Link to the dashboard' },
  { command: 'stop', description: 'Stop the reply in progress' },
];

// a bot can react only with emoji from a fixed list. a check mark is not on the list.
const WORKING = '👀';
const DONE = '👌';
const TICK_MS = 1000;
const TYPING_TICKS = 4;
// telegram removes a draft after 30 seconds, so a draft that did not change is sent again before that.
const DRAFT_KEEP_MS = 20_000;
const CUT_NOTE = '\n[... cut, the dashboard shows the full input]';

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

// the card shows its text, and the details in a quote that the owner opens. the limit counts the text without the
// tags. a card with a long text goes out as plain parts.
export function cardHtml(text: string, details: string): string | undefined {
  const room = TELEGRAM_LIMIT - text.length - 1;
  if (room < 300) return undefined;
  const shown = details.length <= room ? details : headOf(details, room - CUT_NOTE.length) + CUT_NOTE;
  return `${escapeHtml(text)}\n<blockquote expandable>${escapeHtml(shown)}</blockquote>`;
}

// a draft shows plain text, because a part of the markdown can be incomplete. a long draft shows its end.
const draftText = (text: string) => (text.length <= TELEGRAM_LIMIT ? text : `…${tailOf(text, TELEGRAM_LIMIT - 1)}`);

export interface TelegramOptions {
  bot: Bot;
  logger: Logger;
  clock?: Clock;
}

// model replies go out as rich markdown. other text, for example an approval card, never goes through a markdown
// parser, so text that the model wrote into a tool input cannot change how the card looks.
export function createTelegramChannel(options: TelegramOptions): ChannelAdapter {
  const { bot } = options;
  const clock = options.clock ?? systemClock;
  const logger = options.logger.child({ channel: TELEGRAM });
  // the stop button of a draft sends an update with the draft id. the map finds the run of that draft.
  const stops = new Map<number, { chatId: number; stop: () => void }>();
  let nextDraftId = 1;

  // telegram refuses a format with a 400. the caller then sends a simpler format. other errors can come after the
  // message reached the chat, so they go up, and the message is not sent twice.
  const refusedAsUndefined = async <T>(method: string, send: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await send();
    } catch (err) {
      if (!(err instanceof GrammyError) || err.error_code !== 400) throw err;
      logger.warn('telegram refused a format, so a simpler format follows', { method, description: err.description });
      return undefined;
    }
  };

  const sendParts = async (chatId: string, parts: Array<{ html?: string; plain: string }>, keyboard?: InlineKeyboardMarkup) => {
    let messageId = '';
    for (const [i, part] of parts.entries()) {
      const markup = i === parts.length - 1 && keyboard ? { reply_markup: keyboard } : {};
      const html = part.html;
      const sent =
        (html !== undefined
          ? await refusedAsUndefined('sendMessage', () => bot.api.sendMessage(chatId, html, { parse_mode: 'HTML', ...markup }))
          : undefined) ?? (await bot.api.sendMessage(chatId, part.plain, markup));
      messageId = String(sent.message_id);
    }
    return { messageId };
  };
  const plainParts = (text: string) => splitMessage(text).map((plain) => ({ plain }));

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
          messageId: String(ctx.message.message_id),
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
      // a draft goes only to the owner's chat, so a stop from the chat of the draft comes from the owner.
      bot.on('stopped_message_generation', (ctx) => {
        const stopped = ctx.update.stopped_message_generation;
        const entry = stops.get(stopped.draft_id);
        if (!entry || entry.chatId !== stopped.chat.id) return logger.info('stop for an unknown draft ignored', { draftId: stopped.draft_id });
        logger.info('the owner stopped a reply', { draftId: stopped.draft_id });
        entry.stop();
      });
      bot.on('message', (ctx) => logger.info('message without text ignored', { senderId: String(ctx.from.id) }));
      bot.catch((err) => logger.error('telegram update failed', { err: err.error }));

      // the menu is a convenience. a failure is logged, and the bot works without it.
      bot.api.setMyCommands(COMMANDS).catch((err: unknown) => logger.warn('telegram commands menu not set', { err }));
      // polling runs in the background. a network failure is logged, and the other channels keep working.
      void bot
        .start({ onStart: (info) => logger.info('telegram polling started', { username: info.username }) })
        .catch((err: unknown) => logger.error('telegram polling stopped', { err }));
    },
    async stop() {
      if (bot.isRunning()) await bot.stop();
    },
    async send(out) {
      const keyboard = out.buttons?.length
        ? { inline_keyboard: out.buttons.map((row) => row.map((button: Button) => ({ text: button.text, callback_data: button.data }))) }
        : undefined;
      if (out.details !== undefined) {
        const html = cardHtml(out.text, out.details);
        return sendParts(out.chatId, html ? [{ html, plain: `${out.text}\n\n${out.details}` }] : plainParts(`${out.text}\n\n${out.details}`), keyboard);
      }
      if (!out.markdown) return sendParts(out.chatId, plainParts(out.text), keyboard);
      if (out.text.length <= RICH_LIMIT) {
        const sent = await refusedAsUndefined('sendRichMessage', () =>
          bot.api.sendRichMessage(out.chatId, { markdown: out.text }, keyboard ? { reply_markup: keyboard } : {}),
        );
        if (sent) return { messageId: String(sent.message_id) };
      }
      const html = markdownToHtmlParts(out.text);
      return sendParts(out.chatId, html.length ? html.map((part) => ({ html: part, plain: htmlToPlain(part) })) : plainParts(out.text), keyboard);
    },
    progress(message, stop) {
      const chatId = Number(message.chatId);
      const draftId = nextDraftId++;
      stops.set(draftId, { chatId, stop });
      // progress is a convenience. a failed call is logged and never stops the run.
      const quiet = (what: string, call: () => Promise<unknown>) =>
        call().catch((err: unknown) => logger.warn(`telegram ${what} failed`, { err }));
      const react = (emoji?: typeof WORKING | typeof DONE) =>
        message.messageId === undefined
          ? Promise.resolve()
          : quiet('reaction', () => bot.api.setMessageReaction(chatId, Number(message.messageId), emoji ? [{ type: 'emoji', emoji }] : []));

      let latest = '';
      let shown: string | undefined;
      let shownAt = 0;
      let ticks = 0;
      let inFlight: Promise<unknown> = Promise.resolve();
      // an empty draft shows the "Thinking…" placeholder.
      const draft = () => {
        shown = latest;
        shownAt = clock().getTime();
        inFlight = quiet('draft', () => bot.api.sendMessageDraft(chatId, draftId, draftText(latest), { can_stop: true }));
      };
      void react(WORKING);
      draft();
      const timer = setInterval(() => {
        ticks++;
        if (latest !== shown || clock().getTime() - shownAt >= DRAFT_KEEP_MS) draft();
        if (ticks % TYPING_TICKS === 0) void quiet('typing', () => bot.api.sendChatAction(chatId, 'typing'));
      }, TICK_MS);

      return {
        text(full) {
          latest = full;
        },
        // no draft goes out after the end, so a stale draft never shows after the reply.
        async end(ok) {
          clearInterval(timer);
          stops.delete(draftId);
          await inFlight;
          await react(ok ? DONE : undefined);
        },
      };
    },
  };
}
