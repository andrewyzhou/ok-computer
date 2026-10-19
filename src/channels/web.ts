import { randomBytes, randomUUID } from 'node:crypto';
import type { ChatSendResponse, ChatStreamEvent, ChatTurnSnapshot } from '../dashboard/types.js';
import type { Logger } from '../observability/logger.js';
import { NO_REPLY } from '../sessions/router.js';
import type { TurnHooks } from '../sessions/turns.js';
import type { Clock } from '../time.js';
import { buttonSigner } from './telegram-buttons.js';
import type { ChannelAdapter, InboundMessage, OutboundMessage, ReplyProgress } from './types.js';

export const WEB = 'web';
// the web chat has one chat, the owner's. the dashboard signed in the request, so the sender is the owner.
export const WEB_CHAT_ID = 'web';
export const WEB_SENDER_ID = 'owner';
// the prefix of the messageId of a web message. the rest is a random uuid.
export const WEB_TURN_PREFIX = 'web:';

// the part of the web channel that the dashboard uses. docs/API.md (m2) gives the routes on top of it.
export interface WebChat {
  // running is true after start() and before stop() of the channel. the routes answer 503 when it is false.
  running(): boolean;
  // submit gives the text to the router as an owner message of the web channel. it gives the turn id and the state of
  // the turn right after the router took it, or undefined when the channel does not run.
  submit(text: string): ChatSendResponse | undefined;
  // press gives the data of a button to the router, the same path as a pressed telegram button. data is the signed
  // data of a button of a reply event. it gives 'pressed', 'not running' when the channel does not run, or 'not issued'
  // for data without a valid mark.
  press(data: string, turnId?: string): PressResult;
  // stop calls the stop callback of the progress of the turn. it gives false for a turn that is not known, that waits
  // in the queue, or that has ended.
  stop(turnId: string): boolean;
  // snapshot gives the turns that have not ended, oldest first.
  snapshot(): ChatTurnSnapshot[];
  // subscribe gets each later event of the stream. the function that it gives ends the subscription. a listener that
  // throws is removed, and the others still get the event.
  subscribe(listener: (event: ChatStreamEvent) => void): () => void;
}

// the web channel is a channel adapter and the hub of the chat stream. the router calls turns for each turn of every
// channel, so a run that telegram started streams to the open web clients too.
export interface WebChannel extends ChannelAdapter {
  id: typeof WEB;
  chat: WebChat;
  turns: TurnHooks;
}

export interface WebChannelOptions {
  clock?: Clock;
  // the uuid part of a new turn id. tests give fixed ids.
  newId?: () => string;
  // the text of a run goes out at most once in this time, so the draft guard does not run for each token. the end of
  // the progress sends the rest at once.
  textTickMs?: number;
  logger?: Logger;
  // the secret of the button marks. by default each process makes a new one, so a card from before a restart needs
  // a fresh one, for example from /approve <n>.
  buttonSecret?: string;
}

export const TEXT_TICK_MS = 100;
export type PressResult = 'pressed' | 'not running' | 'not issued';

// a turn that has not ended. the snapshot is what a new client gets. stop is the stop callback of the progress of the
// turn while it runs, and cancel clears its text timer.
interface LiveTurn {
  snap: ChatTurnSnapshot;
  stop?: () => void;
  cancel?: () => void;
}

export function createWebChannel(options: WebChannelOptions = {}): WebChannel {
  const clock = options.clock ?? (() => new Date());
  const newId = options.newId ?? randomUUID;
  const textTickMs = options.textTickMs ?? TEXT_TICK_MS;
  const logger = options.logger;

  let running = false;
  let onMessage: ((message: InboundMessage) => void) | undefined;
  const listeners = new Set<(event: ChatStreamEvent) => void>();
  // the turns that have not ended, oldest first. a map keeps the order in which its keys came.
  const turns = new Map<string, LiveTurn>();
  // the timer cancels of all progress that has not ended, so the stop of the channel can clear each of them.
  const timers = new Set<() => void>();
  // a cli message has no messageId, so its turn id is made once and kept with the message object.
  const generated = new WeakMap<InboundMessage, string>();
  let sentCount = 0;
  // a reply can hold markdown that the model wrote, with the data of a real approval and a false label. so each button
  // of a reply event carries a mark from a key that the model never sees, as on telegram, and a press of a button
  // without a valid mark does nothing.
  const signer = buttonSigner(options.buttonSecret ?? randomBytes(32).toString('hex'));

  // the turn id names the channel, as in 'telegram:<message id>'. a web message id already starts with 'web:', and
  // the telegram channel keeps its message id a bare number, because its reactions read the number back.
  const turnIdOf = (message: InboundMessage): string => {
    if (message.messageId !== undefined) {
      const prefix = `${message.channel}:`;
      return message.messageId.startsWith(prefix) ? message.messageId : prefix + message.messageId;
    }
    let id = generated.get(message);
    if (id === undefined) {
      id = `${message.channel}:${newId()}`;
      generated.set(message, id);
    }
    return id;
  };

  // each listener gets each event. a listener can remove itself in its callback, so the loop runs over a copy.
  const emit = (event: ChatStreamEvent) => {
    for (const listener of [...listeners]) {
      try {
        listener(event);
      } catch (err) {
        listeners.delete(listener);
        logger?.warn('web chat listener failed and was removed', { err, kind: event.kind });
      }
    }
  };

  const liveTurn = (turnId: string, channel: string): LiveTurn => {
    let live = turns.get(turnId);
    if (!live) {
      live = { snap: { turnId, channel, state: 'running', runId: null, text: '', activity: null } };
      turns.set(turnId, live);
    }
    return live;
  };

  const replyEvent = (turnId: string | null, messageId: string, out: OutboundMessage): ChatStreamEvent => {
    // the reply replaces the streamed text of its turn, so a later client does not see both.
    const live = turnId === null ? undefined : turns.get(turnId);
    if (live) {
      live.snap.text = '';
      live.snap.activity = null;
    }
    return {
      kind: 'reply',
      turnId,
      messageId,
      runId: out.runId ?? null,
      text: out.text,
      markdown: out.markdown ?? false,
      details: out.details ?? null,
      buttons: (out.buttons ?? []).map((row) => row.map((button) => ({ text: button.text, data: signer.sign(button.data) }))),
      at: clock().toISOString(),
    };
  };

  // the progress of one turn on the stream. the web channel gives it for its own messages, and turns.started gives it
  // for the messages of other channels.
  const hubProgress = (turnId: string, channel: string, stop: () => void, guard: (text: string) => string): ReplyProgress => {
    const live = liveTurn(turnId, channel);
    live.stop = stop;
    let latest = '';
    let lastEmitted = '';
    let timer: NodeJS.Timeout | undefined;
    const cancel = () => {
      clearTimeout(timer);
      timer = undefined;
    };
    live.cancel = cancel;
    timers.add(cancel);

    // the router sends no message for a NO_REPLY answer, so no reply replaces its text. a text that can still become
    // NO_REPLY therefore never shows. the guard runs once for each tick, not once for each token.
    const visible = () => {
      if (NO_REPLY.startsWith(latest.trim())) return '';
      try {
        return guard(latest);
      } catch (err) {
        logger?.warn('web chat draft guard failed', { err, turnId });
        return '';
      }
    };
    const flush = () => {
      cancel();
      const shown = visible();
      if (shown === lastEmitted) return;
      if (shown.startsWith(lastEmitted)) emit({ kind: 'text', turnId, delta: shown.slice(lastEmitted.length), reset: false });
      // a new model call started, or the guard changed text that already went out.
      else emit({ kind: 'text', turnId, delta: shown, reset: true });
      lastEmitted = shown;
      const current = turns.get(turnId);
      if (current) current.snap.text = shown;
    };

    return {
      text(full) {
        latest = full;
        timer ??= setTimeout(flush, textTickMs);
      },
      activity(tools) {
        const value = tools ?? null;
        const current = turns.get(turnId);
        if (current) {
          if (current.snap.activity === value) return;
          current.snap.activity = value;
        }
        emit({ kind: 'activity', turnId, tools: value });
      },
      async end() {
        try {
          flush();
        } catch (err) {
          logger?.warn('web chat flush failed', { err, turnId });
        }
        cancel();
        timers.delete(cancel);
        // after the end, the stop of the turn gives false. a later progress of the same turn keeps its own stop.
        const current = turns.get(turnId);
        if (current?.stop === stop) delete current.stop;
        if (current?.cancel === cancel) delete current.cancel;
      },
      done(ok) {
        emit({ kind: 'done', turnId, ok });
      },
    };
  };

  const chat: WebChat = {
    running: () => running,
    submit(text) {
      const handler = onMessage;
      if (!running || !handler) return undefined;
      const turnId = WEB_TURN_PREFIX + newId();
      handler({ channel: WEB, senderId: WEB_SENDER_ID, chatId: WEB_CHAT_ID, text, messageId: turnId, receivedAt: clock().toISOString() });
      // the router calls turns.queued before its first await, so the turn is in the map when the handler returns. a
      // command such as /status makes no run and answers at once, so it counts as running, and its turn ends as done
      // after the answer.
      return { turnId, state: turns.get(turnId)?.snap.state === 'queued' ? 'queued' : 'running' };
    },
    press(signed, turnId) {
      const handler = onMessage;
      if (!running || !handler) return 'not running';
      const data = signer.check(signed);
      if (data === undefined) {
        logger?.warn('web button refused, because no card of the web had it', { turnId: turnId ?? null });
        return 'not issued';
      }
      logger?.info('web button pressed', { turnId: turnId ?? null });
      // the router handles a button message before the model path, so the data never goes to the model. a press is
      // not a turn, so it has no messageId, and its reply has no turn.
      handler({
        channel: WEB,
        senderId: WEB_SENDER_ID,
        chatId: WEB_CHAT_ID,
        text: '',
        button: data,
        receivedAt: clock().toISOString(),
        ...(turnId ? { replyToMessageId: turnId } : {}),
      });
      return 'pressed';
    },
    stop(turnId) {
      const stop = turns.get(turnId)?.stop;
      if (!stop) return false;
      try {
        stop();
      } catch (err) {
        logger?.warn('web chat stop failed', { err, turnId });
      }
      return true;
    },
    snapshot: () => [...turns.values()].map((live) => ({ ...live.snap })),
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };

  const hooks: TurnHooks = {
    owner(message) {
      emit({ kind: 'owner', turnId: turnIdOf(message), channel: message.channel, text: message.text, at: message.receivedAt });
    },
    queued(message, busy) {
      const turnId = turnIdOf(message);
      const state = busy ? 'queued' : 'running';
      turns.set(turnId, { snap: { turnId, channel: message.channel, state, runId: null, text: '', activity: null } });
      emit({ kind: 'state', turnId, state });
    },
    started(message, runId, stop, guard) {
      const turnId = turnIdOf(message);
      const before = turns.get(turnId)?.snap.state;
      const live = liveTurn(turnId, message.channel);
      live.snap.state = 'running';
      if (before === undefined || before === 'queued') emit({ kind: 'state', turnId, state: 'running' });
      live.snap.runId = runId;
      emit({ kind: 'run', turnId, runId });
      // the router tees this progress with the progress of the channel. the web channel's own progress already
      // streams a web turn, so a second one here would send each event twice.
      if (message.channel === WEB) return undefined;
      return hubProgress(turnId, message.channel, stop, guard);
    },
    replied(message, out) {
      // send() of the web channel already put this reply on the stream.
      if (message.channel === WEB) return;
      sentCount++;
      // a button press is not a turn, so its reply has no turn on the web.
      emit(replyEvent(message.button === undefined ? turnIdOf(message) : null, `${message.channel}-out:${sentCount}`, out));
    },
    ended(message, end, error) {
      const turnId = turnIdOf(message);
      if (end === 'failed' && error !== undefined) emit({ kind: 'error', turnId, error });
      emit({ kind: 'state', turnId, state: end });
      turns.get(turnId)?.cancel?.();
      turns.delete(turnId);
    },
  };

  return {
    id: WEB,
    chat,
    turns: hooks,
    async start(handler) {
      onMessage = handler;
      running = true;
    },
    async stop() {
      running = false;
      onMessage = undefined;
      for (const cancel of timers) cancel();
      timers.clear();
      // the stop callbacks of the turns are not known after the stop. the listeners stay subscribed.
      turns.clear();
    },
    // send works also while the channel does not run, so a reply that comes late still reaches the open clients.
    async send(out) {
      sentCount++;
      const messageId = `web-out:${sentCount}`;
      logger?.info('web send', { runId: out.runId ?? null, turnId: out.replyTo ?? null, buttons: out.buttons?.flat().length ?? 0 });
      emit(replyEvent(out.replyTo ?? null, messageId, out));
      return { messageId };
    },
    progress(message, stop, guard = (text: string) => text) {
      return hubProgress(turnIdOf(message), message.channel, stop, guard);
    },
  };
}

export function isWebChannel(channel: ChannelAdapter): channel is WebChannel {
  return channel.id === WEB && 'chat' in channel && 'turns' in channel;
}
