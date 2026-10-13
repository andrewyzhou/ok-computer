import { randomInt } from 'node:crypto';
import { GrammyError, type Bot } from 'grammy';
import type { InlineKeyboardMarkup } from 'grammy/types';
import type { Logger } from '../observability/logger.js';
import { headOf, tailOf } from '../text.js';
import { systemClock, type Clock } from '../time.js';
import { buttonSigner } from './telegram-buttons.js';
import { escapeHtml, htmlToPlain, markdownToHtmlParts } from './telegram-html.js';
import { neutralizeMarkdown, splitMarkdown } from './telegram-safe.js';
import type { Button, ChannelAdapter, InboundMessage } from './types.js';

export const TELEGRAM = 'telegram';
export const TELEGRAM_LIMIT = 4096;
// a rich message holds up to 32768 characters. the length in utf-16 units is never below the count of characters. the
// margin keeps a part under the limit if telegram counts in a different way.
export const RICH_LIMIT = 30_000;

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
// the end of a reply waits this long for a draft in flight, so the draft does not show after the reply.
const DRAFT_WAIT_MS = 2000;
// after this many failed drafts in a row, a reply shows no more drafts. typing goes on.
const DRAFT_FAILURES = 3;
// the updates that the bot reads. telegram keeps the list of the last call, so the bot always names it.
export const ALLOWED_UPDATES = ['message', 'callback_query', 'stopped_message_generation'] as const;
// the room for the note that says how many characters of the details were cut.
const CUT_NOTE_ROOM = 80;

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
// tags. a card with a long text goes out as plain parts. long details keep their start and their end, because a
// field at the end, for example a recipient, matters as much as a field at the start.
export function cardHtml(text: string, details: string): string | undefined {
  const room = TELEGRAM_LIMIT - text.length - 1;
  if (room < 300) return undefined;
  let shown = details;
  if (details.length > room) {
    const keep = room - CUT_NOTE_ROOM;
    const head = headOf(details, Math.floor(keep * 0.7));
    const tail = tailOf(details, keep - head.length);
    shown = `${head}\n[... ${details.length - head.length - tail.length} characters cut, the dashboard shows the full input ...]\n${tail}`;
  }
  return `${escapeHtml(text)}\n<blockquote expandable>${escapeHtml(shown)}</blockquote>`;
}

// a draft shows plain text, because a part of the markdown can be incomplete. a long draft shows its end.
const draftText = (text: string) => (text.length <= TELEGRAM_LIMIT ? text : `…${tailOf(text, TELEGRAM_LIMIT - 1)}`);

export interface TelegramOptions {
  bot: Bot;
  // the owner's user id, which is also the id of the owner's private chat. only that chat gets the commands menu.
  ownerId: string;
  logger: Logger;
  clock?: Clock;
}

// model replies go out as rich markdown. other text, for example an approval card, never goes through a markdown
// parser, so text that the model wrote into a tool input cannot change how the card looks.
export function createTelegramChannel(options: TelegramOptions): ChannelAdapter {
  const { bot } = options;
  const clock = options.clock ?? systemClock;
  const logger = options.logger.child({ channel: TELEGRAM });
  const buttons = buttonSigner(bot.token);
  // the stop button of a draft sends an update with the draft id. the map finds the run of that draft.
  const stops = new Map<number, { chatId: number; stop: () => void }>();

  // telegram refuses a format with a 400. the caller then sends a simpler format. other errors can come after the
  // message reached the chat, so they go up, and the message is not sent twice.
  // delivery collects the formats of each message and the reasons for each fallback, for one log line per send.
  type Delivery = { formats: string[]; refused: string[] };
  const refusedAsUndefined = async <T>(delivery: Delivery, send: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await send();
    } catch (err) {
      if (!(err instanceof GrammyError) || err.error_code !== 400) throw err;
      delivery.refused.push(err.description);
      return undefined;
    }
  };

  const sendParts = async (
    chatId: string,
    parts: Array<{ html?: string; plain: string }>,
    keyboard: InlineKeyboardMarkup | undefined,
    delivery: Delivery,
  ) => {
    let messageId = '';
    for (const [i, part] of parts.entries()) {
      const markup = i === parts.length - 1 && keyboard ? { reply_markup: keyboard } : {};
      const html = part.html;
      let sent =
        html !== undefined
          ? await refusedAsUndefined(delivery, () => bot.api.sendMessage(chatId, html, { parse_mode: 'HTML', ...markup }))
          : undefined;
      if (sent) delivery.formats.push('html');
      else {
        sent = await bot.api.sendMessage(chatId, part.plain, markup);
        delivery.formats.push('plain');
      }
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
        const data = buttons.check(ctx.callbackQuery.data);
        // telegram shows a spinner on the button until the bot answers the press.
        if (data === undefined) {
          logger.warn('a button without a valid mark was pressed, so it was ignored', { data: ctx.callbackQuery.data });
          await ctx.answerCallbackQuery({ text: 'That button is not from one of my cards. Send /approvals to see the real ones.', show_alert: true });
          return;
        }
        await ctx.answerCallbackQuery();
        if (!isPrivate(ctx.chat)) return logger.info('button outside a private chat ignored', { chatId: String(ctx.chat?.id) });
        received({
          senderId: String(ctx.from.id),
          chatId: String(ctx.chat?.id ?? ctx.from.id),
          text: '',
          button: data,
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
      bot.api
        .setMyCommands(COMMANDS, { scope: { type: 'chat', chat_id: Number(options.ownerId) } })
        .catch((err: unknown) => logger.warn('telegram commands menu not set', { err }));
      // polling runs in the background. a network failure is logged, and the other channels keep working.
      void bot
        .start({
          allowed_updates: ALLOWED_UPDATES,
          onStart: (info) => logger.info('telegram polling started', { username: info.username }),
        })
        .catch((err: unknown) => logger.error('telegram polling stopped', { err }));
    },
    async stop() {
      if (bot.isRunning()) await bot.stop();
    },
    async send(out) {
      const keyboard = out.buttons?.length
        ? { inline_keyboard: out.buttons.map((row) => row.map((button: Button) => ({ text: button.text, callback_data: buttons.sign(button.data) }))) }
        : undefined;
      const delivery: Delivery = { formats: [], refused: [] };
      let neutralized: string[] = [];
      let messageId = '';
      try {
        if (out.details !== undefined) {
          const html = cardHtml(out.text, out.details);
          const plain = `${out.text}\n\n${out.details}`;
          ({ messageId } = await sendParts(out.chatId, html ? [{ html, plain }] : plainParts(plain), keyboard, delivery));
        } else if (!out.markdown) {
          ({ messageId } = await sendParts(out.chatId, plainParts(out.text), keyboard, delivery));
        } else {
          const safe = neutralizeMarkdown(out.text);
          neutralized = safe.neutralized;
          // a possible injection. the run id leads to the tool results that the model read before it wrote this.
          if (neutralized.length) logger.warn('markup in a model reply was neutralized', { runId: out.runId, neutralized });
          const parts = splitMarkdown(safe.text, RICH_LIMIT);
          // each part falls back on its own, so a part that went out is never sent again.
          for (const [i, part] of parts.entries()) {
            const markup = i === parts.length - 1 ? keyboard : undefined;
            const sent = await refusedAsUndefined(delivery, () =>
              bot.api.sendRichMessage(out.chatId, { markdown: part }, markup ? { reply_markup: markup } : {}),
            );
            if (sent) {
              delivery.formats.push('rich');
              messageId = String(sent.message_id);
              continue;
            }
            const html = markdownToHtmlParts(part);
            const fallback = html.length ? html.map((each) => ({ html: each, plain: htmlToPlain(each) })) : plainParts(part);
            ({ messageId } = await sendParts(out.chatId, fallback, markup, delivery));
          }
        }
        return { messageId };
      } finally {
        logger.info('telegram send', { runId: out.runId, formats: delivery.formats, fallback: delivery.refused, neutralized });
      }
    },
    progress(message, stop) {
      const chatId = Number(message.chatId);
      // a random id, so a stop update for a draft of an older process does not stop a new run.
      const draftId = randomInt(1, 2 ** 31);
      stops.set(draftId, { chatId, stop });
      // progress is a convenience. a failed call is logged and never stops the run.
      const quiet = (what: string, call: () => Promise<unknown>) =>
        call().catch((err: unknown) => logger.warn(`telegram ${what} failed`, { err }));
      const react = (emoji?: typeof WORKING | typeof DONE) =>
        message.messageId === undefined
          ? Promise.resolve()
          : quiet('reaction', () => bot.api.setMessageReaction(chatId, Number(message.messageId), emoji ? [{ type: 'emoji', emoji }] : []));

      let latest = '';
      let tools: string | undefined;
      let shown: string | undefined;
      let shownAt = 0;
      let ticks = 0;
      let failures = 0;
      let inFlight: Promise<void> | undefined;
      const composed = () => (tools ? `${latest}\n\n⏳ ${tools}`.trimStart() : latest);
      // an empty draft shows the "Thinking…" placeholder. one draft at a time, so drafts never arrive out of order.
      const draft = () => {
        if (inFlight || failures >= DRAFT_FAILURES) return;
        shown = composed();
        shownAt = clock().getTime();
        inFlight = bot.api
          .sendMessageDraft(chatId, draftId, draftText(shown), { can_stop: true })
          .then(
            () => {
              failures = 0;
            },
            (err: unknown) => {
              failures++;
              logger.warn('telegram draft failed', { err, failures });
            },
          )
          .finally(() => {
            inFlight = undefined;
          });
      };
      void react(WORKING);
      draft();
      const timer = setInterval(() => {
        ticks++;
        if (composed() !== shown || clock().getTime() - shownAt >= DRAFT_KEEP_MS) draft();
        if (ticks % TYPING_TICKS === 0) void quiet('typing', () => bot.api.sendChatAction(chatId, 'typing'));
      }, TICK_MS);

      return {
        text(full) {
          latest = full;
        },
        activity(names) {
          tools = names;
        },
        // no draft goes out after the end, so a stale draft never shows after the reply. a slow draft does not hold
        // the reply for long.
        async end(ok) {
          clearInterval(timer);
          stops.delete(draftId);
          let wait: NodeJS.Timeout | undefined;
          await Promise.race([inFlight, new Promise<void>((resolve) => (wait = setTimeout(resolve, DRAFT_WAIT_MS)))]);
          clearTimeout(wait);
          await react(ok ? DONE : undefined);
        },
      };
    },
  };
}
