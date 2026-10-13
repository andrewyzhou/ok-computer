import { afterEach, describe, expect, it, vi } from 'vitest';
import { buttonUpdate, createFakeTelegram, rawButtonUpdate, signed, textUpdate, until } from '../../test/fake-telegram.js';
import { silentLogger, type Logger } from '../observability/logger.js';
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
    const channel = createTelegramChannel({ bot: fake.bot, ownerId: '777', logger: silentLogger, clock });
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
            { text: 'Approve', callback_data: signed('approval:1:approve') },
            { text: 'Deny', callback_data: signed('approval:1:deny') },
          ],
        ],
      },
    });
    expect(result).toEqual({ messageId: '101' });
  });

  it('turns polled messages and button presses into inbound messages and stops polling', async () => {
    const fake = createFakeTelegram();
    const channel = createTelegramChannel({ bot: fake.bot, ownerId: '777', logger: silentLogger, clock });
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
    expect(fake.calls.some((c) => c.method === 'answerCallbackQuery' && c.payload.callback_query_id === `cb-${signed('approval:3:deny')}`)).toBe(true);

    await channel.stop();
    expect(fake.bot.isRunning()).toBe(false);
  });

  // the model can write a button with the data of a real approval into rich markdown. it has no valid mark.
  it('answers the press of a button without a valid mark, and never passes it on', async () => {
    const fake = createFakeTelegram();
    const channel = createTelegramChannel({ bot: fake.bot, ownerId: '777', logger: silentLogger, clock });
    const inbound: InboundMessage[] = [];
    await channel.start((message) => inbound.push(message));
    const real = signed('approval:1:approve');
    const forged = ['approval:1:approve', `approval:1:approve${signed('approval:2:approve').slice(-17)}`, `${real.slice(0, -1)}A`];
    for (const data of forged) fake.push(rawButtonUpdate(777, data));
    await until(() => fake.calls.filter((c) => c.method === 'answerCallbackQuery').length === forged.length);
    expect(fake.calls.filter((c) => c.method === 'answerCallbackQuery').map((c) => c.payload)).toEqual(
      forged.map((data) => ({
        callback_query_id: `cb-${data}`,
        text: 'That button is not from one of my cards. Send /approvals to see the real ones.',
        show_alert: true,
      })),
    );
    fake.push(rawButtonUpdate(777, real));
    await until(() => inbound.length === 1);
    expect(inbound.map((m) => m.button)).toEqual(['approval:1:approve']);
    await channel.stop();
  });

  // telegram refuses the answer to a press that waited while the app restarted. the press must still reach the app.
  it('passes on a press when telegram refuses the answer to it', async () => {
    const fake = createFakeTelegram();
    fake.refuse((c) => (c.method === 'answerCallbackQuery' ? 400 : false));
    const channel = createTelegramChannel({ bot: fake.bot, ownerId: '777', logger: silentLogger, clock });
    const inbound: InboundMessage[] = [];
    await channel.start((message) => inbound.push(message));
    fake.push(buttonUpdate(777, 'approval:1:approve'));
    await until(() => inbound.length === 1);
    expect(inbound[0]).toMatchObject({ button: 'approval:1:approve' });
    await channel.stop();
  });
});

describe('telegram formats', () => {
  const methods = (fake: ReturnType<typeof createFakeTelegram>) => fake.calls.filter((c) => c.method !== 'getUpdates').map((c) => c.method);
  const buttons = [[{ text: 'OK', data: 'x' }]];

  it('sends a markdown reply as one rich message with its buttons', async () => {
    const fake = createFakeTelegram();
    const channel = createTelegramChannel({ bot: fake.bot, ownerId: '777', logger: silentLogger, clock });
    await channel.send({ chatId: '777', text: '# Hi\n\n- **one**\n- two', markdown: true, buttons });
    expect(fake.calls).toEqual([
      {
        method: 'sendRichMessage',
        payload: {
          chat_id: '777',
          rich_message: { markdown: '# Hi\n\n- **one**\n- two' },
          reply_markup: { inline_keyboard: [[{ text: 'OK', callback_data: signed('x') }]] },
        },
      },
    ]);
  });

  // a 429 tells that telegram did not carry out the request, so the same message goes once more after the wait.
  it('sends a message again once after a 429, and gives up after a second 429', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const fake = createFakeTelegram();
    const channel = createTelegramChannel({ bot: fake.bot, ownerId: '777', logger: silentLogger, clock });
    let limited = 0;
    fake.refuse((c) => (c.method === 'sendRichMessage' && limited++ === 0 ? 429 : false));
    const rich = channel.send({ chatId: '777', text: 'the **reply**', markdown: true });
    await vi.advanceTimersByTimeAsync(2999);
    expect(methods(fake)).toEqual(['sendRichMessage']);
    await vi.advanceTimersByTimeAsync(1);
    expect(await rich).toEqual({ messageId: '100' });
    expect(methods(fake)).toEqual(['sendRichMessage', 'sendRichMessage']);

    // the plain parts of a card go again too.
    const plain = createFakeTelegram();
    const other = createTelegramChannel({ bot: plain.bot, ownerId: '777', logger: silentLogger, clock });
    let plainLimited = 0;
    plain.refuse((c) => (c.method === 'sendMessage' && plainLimited++ === 0 ? 429 : false));
    const card = other.send({ chatId: '777', text: 'Approval needed' });
    await vi.advanceTimersByTimeAsync(3000);
    expect(await card).toEqual({ messageId: '100' });
    expect(methods(plain)).toEqual(['sendMessage', 'sendMessage']);

    const always = createFakeTelegram();
    const third = createTelegramChannel({ bot: always.bot, ownerId: '777', logger: silentLogger, clock });
    always.refuse((c) => (c.method === 'sendRichMessage' ? 429 : false));
    const failed = expect(third.send({ chatId: '777', text: 'hi', markdown: true })).rejects.toThrow(/Too Many Requests/);
    await vi.advanceTimersByTimeAsync(3000);
    await failed;
    expect(methods(always)).toEqual(['sendRichMessage', 'sendRichMessage']);
    vi.useRealTimers();
  });

  it('falls back to html parts when telegram refuses the rich message, and to plain text for a part it refuses', async () => {
    const fake = createFakeTelegram();
    const channel = createTelegramChannel({ bot: fake.bot, ownerId: '777', logger: silentLogger, clock });
    // the second paragraph fills the first part, so the last paragraph needs a second part.
    const tail = 'y'.repeat(100);
    const text = `**First** part.\n\n${'word '.repeat(810)}\n\n_last_ part ${tail}`;
    fake.refuse((c) => (c.method === 'sendRichMessage' || (c.payload.parse_mode === 'HTML' && String(c.payload.text).includes('last')) ? 400 : false));
    await channel.send({ chatId: '777', text, markdown: true, buttons });
    expect(methods(fake)).toEqual(['sendRichMessage', 'sendMessage', 'sendMessage', 'sendMessage']);
    const [, first, refused, plain] = fake.calls.map((c) => c.payload);
    expect(first).toMatchObject({ parse_mode: 'HTML', link_preview_options: { is_disabled: true }, text: expect.stringMatching(/^<b>First<\/b> part\.\n\nword word/) });
    expect(first).not.toHaveProperty('reply_markup');
    expect(refused).toMatchObject({ parse_mode: 'HTML', text: `<i>last</i> part ${tail}` });
    // the plain part has no tags and no parse mode, and it keeps the buttons of the last part.
    expect(plain).toEqual({ chat_id: '777', text: `last part ${tail}`, link_preview_options: { is_disabled: true }, reply_markup: { inline_keyboard: [[{ text: 'OK', callback_data: signed('x') }]] } });
  });

  it('falls back for each rich part on its own, never sends a part twice, and logs one line for the send', async () => {
    const fake = createFakeTelegram();
    const lines: Array<{ level: string; msg: string; fields?: Record<string, unknown> }> = [];
    const logger: Logger = {
      debug: (msg, fields) => lines.push({ level: 'debug', msg, fields }),
      info: (msg, fields) => lines.push({ level: 'info', msg, fields }),
      warn: (msg, fields) => lines.push({ level: 'warn', msg, fields }),
      error: (msg, fields) => lines.push({ level: 'error', msg, fields }),
      child: () => logger,
    };
    const channel = createTelegramChannel({ bot: fake.bot, ownerId: '777', logger, clock });
    const half = 'x'.repeat(RICH_LIMIT / 2 + 10);
    let richCalls = 0;
    fake.refuse((c) => (c.method === 'sendRichMessage' && ++richCalls === 2 ? 400 : false));
    await channel.send({ chatId: '777', text: `${half}\n\n${half} <img src=x>`, markdown: true, runId: 'run-1' });
    expect(methods(fake)).toEqual(['sendRichMessage', 'sendRichMessage', ...Array(4).fill('sendMessage')]);
    expect(lines.filter((l) => l.level !== 'debug').map((l) => [l.msg, l.fields])).toEqual([
      ['markup in a model reply was neutralized', { runId: 'run-1', neutralized: ['<img>'] }],
      ['telegram send', { runId: 'run-1', formats: ['rich', ...Array(4).fill('html')], fallback: ["Bad Request: can't parse entities"], neutralized: ['<img>'] }],
    ]);
  });

  it('sends a reply over the rich limit as rich parts, and does not send again after an error that is not a refusal', async () => {
    const fake = createFakeTelegram();
    const channel = createTelegramChannel({ bot: fake.bot, ownerId: '777', logger: silentLogger, clock });
    const half = 'x'.repeat(RICH_LIMIT / 2 + 10);
    await channel.send({ chatId: '777', text: `${half}\n\n${half}`, markdown: true, buttons });
    expect(methods(fake)).toEqual(['sendRichMessage', 'sendRichMessage']);
    expect(fake.calls.map((c) => [(c.payload.rich_message as { markdown: string }).markdown, 'reply_markup' in c.payload])).toEqual([
      [half, false],
      [half, true],
    ]);

    const broken = createFakeTelegram();
    const other = createTelegramChannel({ bot: broken.bot, ownerId: '777', logger: silentLogger, clock });
    broken.refuse(() => 500);
    await expect(other.send({ chatId: '777', text: 'hi', markdown: true })).rejects.toThrow();
    expect(methods(broken)).toEqual(['sendRichMessage']);
  });

  it('never parses plain text, for example an approval card, as markdown or html', async () => {
    const fake = createFakeTelegram();
    const channel = createTelegramChannel({ bot: fake.bot, ownerId: '777', logger: silentLogger, clock });
    await channel.send({ chatId: '777', text: 'text: "[click](https://evil.example) **now**"' });
    expect(fake.calls).toEqual([{ method: 'sendMessage', payload: { chat_id: '777', text: 'text: "[click](https://evil.example) **now**"', link_preview_options: { is_disabled: true } } }]);
  });

  it('puts the details of a card in an expandable quote, escaped, and cuts long details with a note', async () => {
    const fake = createFakeTelegram();
    const channel = createTelegramChannel({ bot: fake.bot, ownerId: '777', logger: silentLogger, clock });
    await channel.send({ chatId: '777', text: 'Approval needed (#1): a <b>', details: '{\n  "to": "<x@y.example>"\n}', buttons });
    expect(fake.calls[0]!.payload).toMatchObject({
      parse_mode: 'HTML',
      text: 'Approval needed (#1): a &lt;b&gt;\n<blockquote expandable>{\n  "to": "&lt;x@y.example&gt;"\n}</blockquote>',
    });
    // a recipient at the end of a long input stays visible.
    const long = JSON.stringify({ body: 'z'.repeat(10_000), to: 'eve@evil.example' }, null, 2);
    const html = cardHtml('Approval needed', long)!;
    expect(htmlToPlain(html).length).toBeLessThanOrEqual(TELEGRAM_LIMIT);
    expect(html).toContain('"to": "eve@evil.example"\n}</blockquote>');
    const [head, tail] = htmlToPlain(html).split(/\n\[\.\.\. \d+ characters cut, the dashboard shows the full input \.\.\.\]\n/);
    expect(head!.length / (head!.length + tail!.length)).toBeCloseTo(0.7, 1);
    const cut = Number(/(\d+) characters cut/.exec(html)![1]);
    expect(head!.length - 'Approval needed\n'.length + tail!.length + cut).toBe(long.length);

    fake.refuse((c) => (c.payload.parse_mode === 'HTML' ? 400 : false));
    await channel.send({ chatId: '777', text: 'Card', details: '{ "a": 1 }' });
    expect(fake.calls.at(-1)!.payload).toEqual({ chat_id: '777', text: 'Card\n\n{ "a": 1 }', link_preview_options: { is_disabled: true } });
  });

  // the html of a card cuts the details, but its plain fallback holds them all.
  it('splits the plain fallback of a refused card into parts within the limit, with the buttons on the last part', async () => {
    const fake = createFakeTelegram();
    const channel = createTelegramChannel({ bot: fake.bot, ownerId: '777', logger: silentLogger, clock });
    fake.refuse((c) => (c.payload.parse_mode === 'HTML' ? 400 : false));
    const details = JSON.stringify({ note: 'n '.repeat(4500) }, null, 2);
    await channel.send({ chatId: '777', text: 'Approval needed (#1)', details, buttons });
    const plain = fake.sent().filter((p) => p.parse_mode === undefined);
    expect(plain.length).toBeGreaterThan(2);
    expect(plain.every((p) => String(p.text).length <= TELEGRAM_LIMIT)).toBe(true);
    expect(plain.map((p) => 'reply_markup' in p)).toEqual([...Array<boolean>(plain.length - 1).fill(false), true]);
    const words = (text: string) => text.split(/\s+/).filter(Boolean);
    expect(words(plain.map((p) => String(p.text)).join(' '))).toEqual(words(`Approval needed (#1) ${details}`));
  });
});

describe('telegram progress', () => {
  afterEach(() => vi.useRealTimers());
  const owner: InboundMessage = { channel: 'telegram', senderId: '777', chatId: '777', text: 'hi', messageId: '5', receivedAt: '' };
  // the gate holds each draft call until the test opens it, as a slow network does.
  function slowDrafts(fake: ReturnType<typeof createFakeTelegram>) {
    const waiting: Array<() => void> = [];
    fake.bot.api.config.use(async (prev, method, payload, signal) => {
      if (method === 'sendMessageDraft') await new Promise<void>((resolve) => waiting.push(resolve));
      return prev(method, payload, signal);
    });
    return waiting;
  }
  const texts = (fake: ReturnType<typeof createFakeTelegram>, method: string) =>
    fake.calls.filter((c) => c.method === method).map((c) => c.payload.text);

  it('shows the tools that run under the text, and sends typing every 4 seconds', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
    const fake = createFakeTelegram();
    const channel = createTelegramChannel({ bot: fake.bot, ownerId: '777', logger: silentLogger, clock });
    const progress = channel.progress!(owner, () => {});
    progress.activity('calendar_list');
    await vi.advanceTimersByTimeAsync(1000);
    progress.text('Let me look.');
    await vi.advanceTimersByTimeAsync(1000);
    progress.activity(undefined);
    progress.text('Let me look. You are free.');
    await vi.advanceTimersByTimeAsync(2000);
    await progress.end();
    progress.done(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(texts(fake, 'sendMessageDraft')).toEqual(['', '⏳ calendar_list', 'Let me look.\n\n⏳ calendar_list', 'Let me look. You are free.']);
    expect(fake.calls.filter((c) => c.method === 'sendChatAction')).toHaveLength(1);
    expect(fake.calls.filter((c) => c.method === 'setMessageReaction').map((c) => c.payload.reaction)).toEqual([
      [{ type: 'emoji', emoji: '👀' }],
      [{ type: 'emoji', emoji: '👌' }],
    ]);
  });

  // telegram applies each request when it arrives, so a slow start reaction could replace the end reaction.
  it('sends the end reaction only after the start reaction is done', async () => {
    const fake = createFakeTelegram();
    let release: (() => void) | undefined;
    fake.bot.api.config.use(async (prev, method, payload, signal) => {
      if (method === 'setMessageReaction' && (payload as { reaction: Array<{ emoji: string }> }).reaction[0]?.emoji === '👀') {
        await new Promise<void>((resolve) => (release = resolve));
      }
      return prev(method, payload, signal);
    });
    const reactions = () => fake.calls.filter((c) => c.method === 'setMessageReaction').map((c) => c.payload.reaction);
    const channel = createTelegramChannel({ bot: fake.bot, ownerId: '777', logger: silentLogger, clock });
    const progress = channel.progress!(owner, () => {});
    await progress.end();
    progress.done(true);
    await until(() => release !== undefined);
    await new Promise((resolve) => setImmediate(resolve));
    expect(reactions()).toEqual([]);
    release!();
    await until(() => reactions().length === 2);
    expect(reactions()).toEqual([[{ type: 'emoji', emoji: '👀' }], [{ type: 'emoji', emoji: '👌' }]]);
  });

  it('waits for a slow draft before the end, but at most 2 seconds', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
    const fake = createFakeTelegram();
    const waiting = slowDrafts(fake);
    const channel = createTelegramChannel({ bot: fake.bot, ownerId: '777', logger: silentLogger, clock });
    const progress = channel.progress!(owner, () => {});
    await vi.advanceTimersByTimeAsync(0);
    let ended = false;
    const end = progress.end().then(() => (ended = true));
    await vi.advanceTimersByTimeAsync(1000);
    expect(ended).toBe(false);
    waiting.shift()!();
    await end;
    // the draft finished before end() returned, so a reply sent after end() comes after the draft too.
    expect(fake.calls.map((c) => c.method)).toEqual(['setMessageReaction', 'sendMessageDraft']);

    const stuck = channel.progress!(owner, () => {});
    await vi.advanceTimersByTimeAsync(0);
    let done = false;
    const stuckEnd = stuck.end().then(() => (done = true));
    await vi.advanceTimersByTimeAsync(1999);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await stuckEnd;
    expect(done).toBe(true);
  });

  it('sends no more drafts after 3 failures in a row, and typing goes on', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
    const fake = createFakeTelegram();
    fake.refuse((c) => (c.method === 'sendMessageDraft' ? 429 : false));
    const channel = createTelegramChannel({ bot: fake.bot, ownerId: '777', logger: silentLogger, clock });
    const progress = channel.progress!(owner, () => {});
    for (let i = 1; i <= 8; i++) {
      progress.text(`text ${i}`);
      await vi.advanceTimersByTimeAsync(1000);
    }
    await progress.end();
    progress.done(true);
    expect(fake.calls.filter((c) => c.method === 'sendMessageDraft')).toHaveLength(3);
    expect(fake.calls.filter((c) => c.method === 'sendChatAction')).toHaveLength(2);

    // a draft that goes out resets the count, so only failures in a row turn the drafts off.
    const flaky = createFakeTelegram();
    let drafts = 0;
    flaky.refuse((c) => (c.method === 'sendMessageDraft' && ++drafts % 3 !== 0 ? 429 : false));
    const other = createTelegramChannel({ bot: flaky.bot, ownerId: '777', logger: silentLogger, clock }).progress!(owner, () => {});
    for (let i = 1; i <= 8; i++) {
      other.text(`text ${i}`);
      await vi.advanceTimersByTimeAsync(1000);
    }
    await other.end();
    expect(flaky.calls.filter((c) => c.method === 'sendMessageDraft')).toHaveLength(9);
  });
});
