import { describe, expect, it } from 'vitest';
import { buttonUpdate, createFakeTelegram, textUpdate, until } from '../../test/fake-telegram.js';
import { silentLogger } from '../observability/logger.js';
import { htmlToPlain } from './telegram-html.js';
import { cardHtml, createTelegramChannel, RICH_LIMIT, splitMessage, TELEGRAM_LIMIT } from './telegram.js';
import type { InboundMessage } from './types.js';

const clock = () => new Date('2026-10-13T03:15:00Z');

describe('splitMessage', () => {
  it('keeps a short message as one part', () => {
    expect(splitMessage('hello')).toEqual(['hello']);
  });

  it('splits at paragraphs first, then at lines, then at words, then anywhere', () => {
    const paragraph = 'p'.repeat(3000);
    expect(splitMessage(`${paragraph}\n\n${paragraph}`)).toEqual([paragraph, paragraph]);
    expect(splitMessage(`${'a'.repeat(4000)}\n${'b'.repeat(200)}`)).toEqual(['a'.repeat(4000), 'b'.repeat(200)]);
    expect(splitMessage(`${'w'.repeat(4090)} next words`)).toEqual([`${'w'.repeat(4090)} next`, 'words']);
    const parts = splitMessage('x'.repeat(10_000));
    expect(parts.map((p) => p.length)).toEqual([4096, 4096, 1808]);
  });

  it('never cuts a character that uses two code units', () => {
    const parts = splitMessage(`${'x'.repeat(TELEGRAM_LIMIT - 1)}😀${'y'.repeat(10)}`);
    expect(parts[0]!.length).toBe(TELEGRAM_LIMIT - 1);
    expect(parts[1]!.startsWith('😀')).toBe(true);
    expect(parts.join('')).toBe(`${'x'.repeat(TELEGRAM_LIMIT - 1)}😀${'y'.repeat(10)}`);
  });
});

describe('telegram channel', () => {
  it('sends plain text in parts and puts the buttons on the last part', async () => {
    const fake = createFakeTelegram();
    const channel = createTelegramChannel({ bot: fake.bot, logger: silentLogger, clock });
    const result = await channel.send({
      chatId: '777',
      text: `${'a'.repeat(3000)}\n\n${'b'.repeat(3000)}`,
      buttons: [[{ text: 'Approve', data: 'approval:1:approve' }, { text: 'Deny', data: 'approval:1:deny' }]],
    });
    const sent = fake.sent();
    expect(sent).toHaveLength(2);
    expect(sent[0]).toMatchObject({ chat_id: '777', text: 'a'.repeat(3000) });
    expect(sent[0]).not.toHaveProperty('reply_markup');
    expect(sent.some((p) => 'parse_mode' in p)).toBe(false);
    expect(sent[1]).toMatchObject({
      text: 'b'.repeat(3000),
      reply_markup: {
        inline_keyboard: [
          [
            { text: 'Approve', callback_data: 'approval:1:approve' },
            { text: 'Deny', callback_data: 'approval:1:deny' },
          ],
        ],
      },
    });
    expect(result).toEqual({ messageId: '101' });
  });

  it('turns polled messages and button presses into inbound messages and stops polling', async () => {
    const fake = createFakeTelegram();
    const channel = createTelegramChannel({ bot: fake.bot, logger: silentLogger, clock });
    const inbound: InboundMessage[] = [];
    await channel.start((message) => inbound.push(message));

    fake.push(textUpdate(777, 'hello'));
    await until(() => inbound.length === 1);
    expect(inbound[0]).toEqual({
      channel: 'telegram',
      senderId: '777',
      chatId: '777',
      text: 'hello',
      messageId: '1',
      receivedAt: '2026-10-13T03:15:00.000Z',
    });

    fake.push({ message: { message_id: 3, date: 0, chat: { id: -100, type: 'group', title: 'g' }, from: { id: 777, is_bot: false, first_name: 'a' }, text: 'hi all' } } as never);
    fake.push({ message: { message_id: 2, date: 0, chat: { id: 777, type: 'private', first_name: 'a' }, from: { id: 777, is_bot: false, first_name: 'a' }, sticker: {} } } as never);
    fake.push(buttonUpdate(777, 'approval:3:deny'));
    await until(() => inbound.length === 2);
    expect(inbound[1]).toMatchObject({ senderId: '777', chatId: '777', text: '', button: 'approval:3:deny' });
    expect(fake.calls.some((c) => c.method === 'answerCallbackQuery' && c.payload.callback_query_id === 'cb-approval:3:deny')).toBe(true);

    await channel.stop();
    expect(fake.bot.isRunning()).toBe(false);
  });
});

describe('telegram formats', () => {
  const methods = (fake: ReturnType<typeof createFakeTelegram>) => fake.calls.filter((c) => c.method !== 'getUpdates').map((c) => c.method);
  const buttons = [[{ text: 'OK', data: 'x' }]];

  it('sends a markdown reply as one rich message with its buttons', async () => {
    const fake = createFakeTelegram();
    const channel = createTelegramChannel({ bot: fake.bot, logger: silentLogger, clock });
    await channel.send({ chatId: '777', text: '# Hi\n\n- **one**\n- two', markdown: true, buttons });
    expect(fake.calls).toEqual([
      {
        method: 'sendRichMessage',
        payload: {
          chat_id: '777',
          rich_message: { markdown: '# Hi\n\n- **one**\n- two' },
          reply_markup: { inline_keyboard: [[{ text: 'OK', callback_data: 'x' }]] },
        },
      },
    ]);
  });

  it('falls back to html parts when telegram refuses the rich message, and to plain text for a part it refuses', async () => {
    const fake = createFakeTelegram();
    const channel = createTelegramChannel({ bot: fake.bot, logger: silentLogger, clock });
    // the second paragraph fills the first part, so the last paragraph needs a second part.
    const tail = 'y'.repeat(100);
    const text = `**First** part.\n\n${'word '.repeat(810)}\n\n_last_ part ${tail}`;
    fake.refuse((c) => (c.method === 'sendRichMessage' || (c.payload.parse_mode === 'HTML' && String(c.payload.text).includes('last')) ? 400 : false));
    await channel.send({ chatId: '777', text, markdown: true, buttons });
    expect(methods(fake)).toEqual(['sendRichMessage', 'sendMessage', 'sendMessage', 'sendMessage']);
    const [, first, refused, plain] = fake.calls.map((c) => c.payload);
    expect(first).toMatchObject({ parse_mode: 'HTML', text: expect.stringMatching(/^<b>First<\/b> part\.\n\nword word/) });
    expect(first).not.toHaveProperty('reply_markup');
    expect(refused).toMatchObject({ parse_mode: 'HTML', text: `<i>last</i> part ${tail}` });
    // the plain part has no tags and no parse mode, and it keeps the buttons of the last part.
    expect(plain).toEqual({ chat_id: '777', text: `last part ${tail}`, reply_markup: { inline_keyboard: [[{ text: 'OK', callback_data: 'x' }]] } });
  });

  it('sends a reply over the rich limit as html parts, and does not send again after an error that is not a refusal', async () => {
    const fake = createFakeTelegram();
    const channel = createTelegramChannel({ bot: fake.bot, logger: silentLogger, clock });
    await channel.send({ chatId: '777', text: 'x'.repeat(RICH_LIMIT + 1), markdown: true });
    expect(new Set(methods(fake))).toEqual(new Set(['sendMessage']));

    const broken = createFakeTelegram();
    const other = createTelegramChannel({ bot: broken.bot, logger: silentLogger, clock });
    broken.refuse(() => 500);
    await expect(other.send({ chatId: '777', text: 'hi', markdown: true })).rejects.toThrow();
    expect(methods(broken)).toEqual(['sendRichMessage']);
  });

  it('never parses plain text, for example an approval card, as markdown or html', async () => {
    const fake = createFakeTelegram();
    const channel = createTelegramChannel({ bot: fake.bot, logger: silentLogger, clock });
    await channel.send({ chatId: '777', text: 'text: "[click](https://evil.example) **now**"' });
    expect(fake.calls).toEqual([{ method: 'sendMessage', payload: { chat_id: '777', text: 'text: "[click](https://evil.example) **now**"' } }]);
  });

  it('puts the details of a card in an expandable quote, escaped, and cuts long details with a note', async () => {
    const fake = createFakeTelegram();
    const channel = createTelegramChannel({ bot: fake.bot, logger: silentLogger, clock });
    await channel.send({ chatId: '777', text: 'Approval needed (#1): a <b>', details: '{\n  "to": "<x@y.example>"\n}', buttons });
    expect(fake.calls[0]!.payload).toMatchObject({
      parse_mode: 'HTML',
      text: 'Approval needed (#1): a &lt;b&gt;\n<blockquote expandable>{\n  "to": "&lt;x@y.example&gt;"\n}</blockquote>',
    });
    const html = cardHtml('Approval needed', 'z'.repeat(10_000))!;
    expect(htmlToPlain(html).length).toBeLessThanOrEqual(TELEGRAM_LIMIT);
    expect(html).toContain('[... cut, the dashboard shows the full input]</blockquote>');

    fake.refuse((c) => (c.payload.parse_mode === 'HTML' ? 400 : false));
    await channel.send({ chatId: '777', text: 'Card', details: '{ "a": 1 }' });
    expect(fake.calls.at(-1)!.payload).toEqual({ chat_id: '777', text: 'Card\n\n{ "a": 1 }' });
  });
});
