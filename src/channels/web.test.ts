import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunInput, RunResult } from '../agent/loop.js';
import type { ChatStreamEvent } from '../dashboard/types.js';
import { openDb } from '../db/index.js';
import { silentLogger, type Logger } from '../observability/logger.js';
import { createRunQueue } from '../sessions/queue.js';
import { createRouter } from '../sessions/router.js';
import type { ChannelAdapter, InboundMessage } from './types.js';
import { createWebChannel, isWebChannel, TEXT_TICK_MS, WEB_TURN_PREFIX, type WebChannelOptions } from './web.js';

const AT = new Date('2026-10-18T09:00:00.000Z');

function setup(options: WebChannelOptions = {}) {
  let n = 0;
  const web = createWebChannel({ clock: () => AT, newId: () => `id${++n}`, ...options });
  const events: ChatStreamEvent[] = [];
  web.chat.subscribe((event) => events.push(event));
  return { web, events };
}

const telegram = (extra: Partial<InboundMessage> = {}): InboundMessage => ({
  channel: 'telegram',
  senderId: '42',
  chatId: '42',
  text: 'hi from the phone',
  messageId: 'telegram:5',
  receivedAt: AT.toISOString(),
  ...extra,
});

const webMessage = (id = 'web:abc'): InboundMessage => ({
  channel: 'web',
  senderId: 'owner',
  chatId: 'web',
  text: 'hi',
  messageId: id,
  receivedAt: AT.toISOString(),
});

const texts = (events: ChatStreamEvent[]) => events.filter((event) => event.kind === 'text');

describe('web channel', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('has the id web and is a web channel, and a cli channel is not', () => {
    const { web } = setup();
    expect(web.id).toBe('web');
    expect(isWebChannel(web)).toBe(true);
    const cli: ChannelAdapter = { id: 'cli', start: async () => {}, stop: async () => {}, send: async () => ({ messageId: '1' }) };
    expect(isWebChannel(cli)).toBe(false);
  });

  it('gives undefined for a submit before the start, and an owner message of the web channel after it', async () => {
    const { web } = setup();
    expect(web.chat.running()).toBe(false);
    expect(web.chat.submit('hello')).toBeUndefined();
    const got: InboundMessage[] = [];
    await web.start((message) => got.push(message));
    expect(web.chat.running()).toBe(true);
    expect(web.chat.submit('hello')).toEqual({ turnId: 'web:id1', state: 'running' });
    expect(got).toEqual([{ channel: 'web', senderId: 'owner', chatId: 'web', text: 'hello', messageId: 'web:id1', receivedAt: AT.toISOString() }]);
    expect(WEB_TURN_PREFIX).toBe('web:');
    await web.stop();
    expect(web.chat.running()).toBe(false);
    expect(web.chat.submit('again')).toBeUndefined();
  });

  it('gives the state of the turn right after the router took the message', async () => {
    const { web } = setup();
    let mode: 'busy' | 'free' | 'command' = 'busy';
    await web.start((message) => {
      if (mode !== 'command') web.turns.queued(message, mode === 'busy');
    });
    expect(web.chat.submit('one')?.state).toBe('queued');
    mode = 'free';
    expect(web.chat.submit('two')?.state).toBe('running');
    mode = 'command';
    expect(web.chat.submit('/status')).toEqual({ turnId: 'web:id3', state: 'running' });
  });

  it('sends a pressed button as a button message with empty text, and gives false before the start', async () => {
    const { web } = setup();
    expect(web.chat.press('approve:1')).toBe(false);
    const got: InboundMessage[] = [];
    await web.start((message) => got.push(message));
    expect(web.chat.press('approve:1', 'web:turn')).toBe(true);
    expect(web.chat.press('deny:2')).toBe(true);
    expect(got[0]).toEqual({
      channel: 'web',
      senderId: 'owner',
      chatId: 'web',
      text: '',
      button: 'approve:1',
      messageId: 'web:id1',
      receivedAt: AT.toISOString(),
      replyToMessageId: 'web:turn',
    });
    expect(got[1]).not.toHaveProperty('replyToMessageId');
    expect(got[1]?.button).toBe('deny:2');
  });

  describe('progress', () => {
    it('sends the new part of the text, and a reset for a new model call', async () => {
      const { web, events } = setup();
      const progress = web.progress!(webMessage(), () => {});
      progress.text('he');
      vi.advanceTimersByTime(TEXT_TICK_MS);
      progress.text('hello');
      vi.advanceTimersByTime(TEXT_TICK_MS);
      progress.text('x');
      vi.advanceTimersByTime(TEXT_TICK_MS);
      expect(texts(events)).toEqual([
        { kind: 'text', turnId: 'web:abc', delta: 'he', reset: false },
        { kind: 'text', turnId: 'web:abc', delta: 'llo', reset: false },
        { kind: 'text', turnId: 'web:abc', delta: 'x', reset: true },
      ]);
    });

    it('applies the guard to the shown text', async () => {
      const { web, events } = setup();
      const progress = web.progress!(webMessage(), () => {}, (text) => text.replace('secret', '[hidden]'));
      progress.text('the secret is');
      await progress.end();
      expect(texts(events)).toEqual([{ kind: 'text', turnId: 'web:abc', delta: 'the [hidden] is', reset: false }]);
    });

    it('shows nothing for a text that can still become NO_REPLY', async () => {
      const { web, events } = setup();
      const guard = vi.fn((text: string) => text);
      const progress = web.progress!(webMessage(), () => {}, guard);
      progress.text('NO_');
      vi.advanceTimersByTime(TEXT_TICK_MS);
      progress.text('NO_REPLY');
      await progress.end();
      expect(texts(events)).toEqual([]);
      expect(guard).not.toHaveBeenCalled();
    });

    it('sends one event for the text of one tick, and runs the guard once', async () => {
      const { web, events } = setup();
      const guard = vi.fn((text: string) => text);
      const progress = web.progress!(webMessage(), () => {}, guard);
      progress.text('a');
      progress.text('ab');
      progress.text('abc');
      vi.advanceTimersByTime(TEXT_TICK_MS - 1);
      expect(texts(events)).toEqual([]);
      vi.advanceTimersByTime(1);
      expect(texts(events)).toEqual([{ kind: 'text', turnId: 'web:abc', delta: 'abc', reset: false }]);
      expect(guard).toHaveBeenCalledTimes(1);
    });

    it('sends the pending text at the end, and nothing after it', async () => {
      const { web, events } = setup();
      const progress = web.progress!(webMessage(), () => {});
      progress.text('almost');
      await progress.end();
      expect(texts(events)).toEqual([{ kind: 'text', turnId: 'web:abc', delta: 'almost', reset: false }]);
      vi.advanceTimersByTime(TEXT_TICK_MS * 5);
      expect(texts(events)).toHaveLength(1);
    });

    it('shows nothing for a tick in which the guard throws', async () => {
      const warn = vi.fn();
      const logger: Logger = { ...silentLogger, warn };
      const { web, events } = setup({ logger });
      const progress = web.progress!(webMessage(), () => {}, () => {
        throw new Error('guard broke');
      });
      progress.text('anything');
      await expect(progress.end()).resolves.toBeUndefined();
      expect(texts(events)).toEqual([]);
      expect(warn).toHaveBeenCalled();
    });

    it('sends the activity only when it changes, with null for no tools', async () => {
      const { web, events } = setup();
      const progress = web.progress!(webMessage(), () => {});
      progress.activity('memory_search');
      progress.activity('memory_search');
      progress.activity(undefined);
      progress.activity(undefined);
      expect(events.filter((event) => event.kind === 'activity')).toEqual([
        { kind: 'activity', turnId: 'web:abc', tools: 'memory_search' },
        { kind: 'activity', turnId: 'web:abc', tools: null },
      ]);
    });

    it('sends done', async () => {
      const { web, events } = setup();
      const progress = web.progress!(webMessage(), () => {});
      progress.done(true);
      progress.done(false);
      expect(events).toEqual([
        { kind: 'done', turnId: 'web:abc', ok: true },
        { kind: 'done', turnId: 'web:abc', ok: false },
      ]);
    });
  });

  it('sends a reply with its turn and fields, and clears the streamed text of the turn', async () => {
    const { web, events } = setup();
    web.turns.queued(webMessage(), false);
    const progress = web.progress!(webMessage(), () => {});
    progress.text('streamed');
    progress.activity('now');
    await progress.end();
    expect(web.chat.snapshot()[0]).toMatchObject({ text: 'streamed', activity: 'now' });

    const buttons = [[{ text: 'Approve', data: 'approve:1' }, { text: 'Deny', data: 'deny:1' }]];
    expect(await web.send({ chatId: 'web', text: 'the answer', markdown: true, runId: 'r1', details: 'more', buttons, replyTo: 'web:abc' })).toEqual({ messageId: 'web-out:1' });
    expect(await web.send({ chatId: 'web', text: 'a card' })).toEqual({ messageId: 'web-out:2' });
    expect(events.filter((event) => event.kind === 'reply')).toEqual([
      { kind: 'reply', turnId: 'web:abc', messageId: 'web-out:1', runId: 'r1', text: 'the answer', markdown: true, details: 'more', buttons, at: AT.toISOString() },
      { kind: 'reply', turnId: null, messageId: 'web-out:2', runId: null, text: 'a card', markdown: false, details: null, buttons: [], at: AT.toISOString() },
    ]);
    expect(web.chat.snapshot()[0]).toMatchObject({ text: '', activity: null });
  });

  it('follows a telegram turn through the hooks', async () => {
    const { web, events } = setup();
    const message = telegram();
    web.turns.owner(message);
    web.turns.queued(message, true);
    expect(web.chat.snapshot()).toEqual([{ turnId: 'telegram:5', channel: 'telegram', state: 'queued', runId: null, text: '', activity: null }]);
    const stop = vi.fn();
    const progress = web.turns.started(message, 'run1', stop, (text) => text.toUpperCase());
    expect(progress).toBeDefined();
    progress!.text('streaming');
    vi.advanceTimersByTime(TEXT_TICK_MS);
    expect(web.chat.snapshot()).toEqual([{ turnId: 'telegram:5', channel: 'telegram', state: 'running', runId: 'run1', text: 'STREAMING', activity: null }]);
    await progress!.end();
    web.turns.replied(message, { chatId: '42', text: 'the answer', markdown: true, runId: 'run1', replyTo: 'telegram:5' });
    progress!.done(true);
    web.turns.ended(message, 'done');
    expect(web.chat.snapshot()).toEqual([]);
    expect(events).toEqual([
      { kind: 'owner', turnId: 'telegram:5', channel: 'telegram', text: 'hi from the phone', at: AT.toISOString() },
      { kind: 'state', turnId: 'telegram:5', state: 'queued' },
      { kind: 'state', turnId: 'telegram:5', state: 'running' },
      { kind: 'run', turnId: 'telegram:5', runId: 'run1' },
      { kind: 'text', turnId: 'telegram:5', delta: 'STREAMING', reset: false },
      { kind: 'reply', turnId: 'telegram:5', messageId: 'telegram-out:1', runId: 'run1', text: 'the answer', markdown: true, details: null, buttons: [], at: AT.toISOString() },
      { kind: 'done', turnId: 'telegram:5', ok: true },
      { kind: 'state', turnId: 'telegram:5', state: 'done' },
    ]);
  });

  it('sends no second state for a turn that already runs', async () => {
    const { web, events } = setup();
    web.turns.queued(telegram(), false);
    web.turns.started(telegram(), 'run1', () => {}, (text) => text);
    expect(events.filter((event) => event.kind === 'state')).toEqual([{ kind: 'state', turnId: 'telegram:5', state: 'running' }]);
  });

  it('gives no hub progress and no reply event for a web turn, because the channel itself sends them', async () => {
    const { web, events } = setup();
    const message = webMessage();
    web.turns.queued(message, false);
    expect(web.turns.started(message, 'run1', () => {}, (text) => text)).toBeUndefined();
    web.turns.replied(message, { chatId: 'web', text: 'the answer', replyTo: 'web:abc' });
    expect(events.filter((event) => event.kind === 'reply')).toEqual([]);
  });

  it('keeps one generated turn id for a message without a messageId', async () => {
    const { web, events } = setup();
    const message: InboundMessage = { channel: 'cli', senderId: 'me', chatId: 'c', text: 'hi', receivedAt: AT.toISOString() };
    web.turns.owner(message);
    web.turns.queued(message, false);
    web.turns.started(message, 'run1', () => {}, (text) => text);
    web.turns.ended(message, 'done');
    const ids = new Set(events.map((event) => ('turnId' in event ? event.turnId : undefined)));
    expect(ids).toEqual(new Set(['cli:id1']));
  });

  describe('stop', () => {
    it('calls the stop of a running turn', async () => {
      const { web } = setup();
      const stop = vi.fn();
      web.turns.queued(telegram(), false);
      web.turns.started(telegram(), 'run1', stop, (text) => text);
      expect(web.chat.stop('telegram:5')).toBe(true);
      expect(stop).toHaveBeenCalledOnce();
    });

    it('calls the stop of the web progress of a web turn', async () => {
      const { web } = setup();
      const stop = vi.fn();
      web.progress!(webMessage(), stop);
      expect(web.chat.stop('web:abc')).toBe(true);
      expect(stop).toHaveBeenCalledOnce();
    });

    it('gives true when the stop callback throws', async () => {
      const { web } = setup();
      web.progress!(webMessage(), () => {
        throw new Error('stop broke');
      });
      expect(web.chat.stop('web:abc')).toBe(true);
    });

    it('gives false for an unknown, a queued, an ended progress and an ended turn', async () => {
      const { web } = setup();
      expect(web.chat.stop('nothing')).toBe(false);
      web.turns.queued(telegram(), true);
      expect(web.chat.stop('telegram:5')).toBe(false);

      const stop = vi.fn();
      const progress = web.turns.started(telegram(), 'run1', stop, (text) => text)!;
      await progress.end();
      expect(web.chat.stop('telegram:5')).toBe(false);

      const other = telegram({ messageId: 'telegram:6' });
      web.turns.queued(other, false);
      web.turns.started(other, 'run2', stop, (text) => text);
      web.turns.ended(other, 'stopped');
      expect(web.chat.stop('telegram:6')).toBe(false);
      expect(stop).not.toHaveBeenCalled();
    });

    it('forgets the turns when the channel stops, and keeps the listeners', async () => {
      const { web, events } = setup();
      const stop = vi.fn();
      const progress = web.progress!(webMessage(), stop);
      progress.text('pending');
      await web.stop();
      expect(web.chat.stop('web:abc')).toBe(false);
      expect(web.chat.snapshot()).toEqual([]);
      vi.advanceTimersByTime(TEXT_TICK_MS);
      expect(texts(events)).toEqual([]);
      await web.send({ chatId: 'web', text: 'late' });
      expect(events.at(-1)).toMatchObject({ kind: 'reply', text: 'late' });
    });
  });

  it('keeps the live turns in the snapshot, oldest first, as copies', async () => {
    const { web } = setup();
    web.turns.queued(telegram(), false);
    web.turns.started(telegram(), 'run1', () => {}, (text) => text);
    web.turns.queued(webMessage('web:later'), true);
    const progress = web.progress!(webMessage('web:later'), () => {});
    progress.activity('now');
    const snapshot = web.chat.snapshot();
    expect(snapshot).toEqual([
      { turnId: 'telegram:5', channel: 'telegram', state: 'running', runId: 'run1', text: '', activity: null },
      { turnId: 'web:later', channel: 'web', state: 'queued', runId: null, text: '', activity: 'now' },
    ]);
    snapshot[0]!.text = 'changed';
    expect(web.chat.snapshot()[0]?.text).toBe('');
  });

  it('keeps text that came before any client, so a later client sees it in the snapshot', async () => {
    const web = createWebChannel({ clock: () => AT });
    const progress = web.progress!(webMessage(), () => {});
    progress.text('early words');
    vi.advanceTimersByTime(TEXT_TICK_MS);
    expect(web.chat.snapshot()[0]?.text).toBe('early words');
  });

  it('gives each subscriber the same events, and drops one that throws or unsubscribes', async () => {
    const warn = vi.fn();
    const { web, events } = setup({ logger: { ...silentLogger, warn } });
    const second: ChatStreamEvent[] = [];
    const third: ChatStreamEvent[] = [];
    const unsubscribe = web.chat.subscribe((event) => second.push(event));
    const broken = vi.fn(() => {
      throw new Error('socket closed');
    });
    web.chat.subscribe(broken);
    web.chat.subscribe((event) => third.push(event));
    const self: ChatStreamEvent[] = [];
    const once = web.chat.subscribe((event) => {
      self.push(event);
      once();
    });

    web.turns.owner(telegram());
    web.turns.queued(telegram(), false);
    unsubscribe();
    web.turns.ended(telegram(), 'failed');

    expect(events.map((event) => event.kind)).toEqual(['owner', 'state', 'state']);
    expect(third).toEqual(events);
    expect(second).toEqual(events.slice(0, 2));
    expect(self).toEqual(events.slice(0, 1));
    expect(broken).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledOnce();
  });

  it('still sends events for a turn that already ended', async () => {
    const { web, events } = setup();
    web.turns.ended(telegram(), 'done');
    const progress = web.progress!(telegram(), () => {});
    web.turns.ended(telegram(), 'done');
    progress.done(true);
    progress.activity('late');
    expect(events).toEqual([
      { kind: 'state', turnId: 'telegram:5', state: 'done' },
      { kind: 'state', turnId: 'telegram:5', state: 'done' },
      { kind: 'done', turnId: 'telegram:5', ok: true },
      { kind: 'activity', turnId: 'telegram:5', tools: 'late' },
    ]);
  });
});

describe('web channel with the router', () => {
  it('streams a submitted message through its own progress and sends the reply', async () => {
    const web = createWebChannel({ textTickMs: 0 });
    const events: ChatStreamEvent[] = [];
    web.chat.subscribe((event) => events.push(event));
    const agent = vi.fn(async (input: RunInput): Promise<RunResult> => {
      input.onActivity?.('memory_search');
      input.onText?.('Hel');
      input.onText?.('Hello there');
      input.onActivity?.(undefined);
      return { runId: 'r1', status: 'completed', text: 'Hello there' };
    });
    const router = createRouter({
      db: openDb(':memory:'),
      logger: silentLogger,
      clock: () => AT,
      queue: createRunQueue(),
      channels: new Map([['web', web]]),
      agent,
      isOwner: () => true,
    });
    const handled: Promise<void>[] = [];
    await web.start((message) => handled.push(router.handle(message)));
    const response = web.chat.submit('hi');
    expect(response?.turnId).toMatch(/^web:/);
    await Promise.all(handled);

    const turnId = response!.turnId;
    expect(agent).toHaveBeenCalledOnce();
    expect(agent.mock.calls[0]?.[0]).toMatchObject({ channel: 'web', events: [{ type: 'user_message', payload: { text: 'hi', channel: 'web', chatId: 'web' } }] });
    expect(events.filter((event) => event.kind !== 'reply')).toEqual([
      { kind: 'activity', turnId, tools: 'memory_search' },
      { kind: 'activity', turnId, tools: null },
      { kind: 'text', turnId, delta: 'Hello there', reset: false },
      { kind: 'done', turnId, ok: true },
    ]);
    // the router sets replyTo to the message id, so the reply names the turn that it answers.
    const reply = events.find((event) => event.kind === 'reply');
    expect(reply).toMatchObject({ kind: 'reply', turnId, runId: 'r1', text: 'Hello there', markdown: true });
    expect(events.indexOf(reply!)).toBe(events.length - 2);
  });
});
