import { describe, expect, it } from 'vitest';
import { buttonUpdate, createFakeTelegram, textUpdate, until } from '../../test/fake-telegram.js';
import { silentLogger } from '../observability/logger.js';
import { createTelegramChannel, splitMessage, TELEGRAM_LIMIT } from './telegram.js';
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
      receivedAt: '2026-10-13T03:15:00.000Z',
    });

    fake.push({ message: { message_id: 2, date: 0, chat: { id: 777, type: 'private', first_name: 'a' }, from: { id: 777, is_bot: false, first_name: 'a' }, sticker: {} } } as never);
    fake.push(buttonUpdate(777, 'approval:3:deny'));
    await until(() => inbound.length === 2);
    expect(inbound[1]).toMatchObject({ senderId: '777', chatId: '777', text: '', button: 'approval:3:deny' });
    expect(fake.calls.some((c) => c.method === 'answerCallbackQuery' && c.payload.callback_query_id === 'cb-approval:3:deny')).toBe(true);

    await channel.stop();
    expect(fake.bot.isRunning()).toBe(false);
  });
});
