import type { ChatSendResponse, ChatStreamEvent, ChatTurnSnapshot } from '../dashboard/types.js';
import type { Logger } from '../observability/logger.js';
import type { TurnHooks } from '../sessions/turns.js';
import type { Clock } from '../time.js';
import type { ChannelAdapter } from './types.js';

export const WEB = 'web';
// the web chat has one chat, the owner's. the dashboard signed in the request, so the sender is the owner.
export const WEB_CHAT_ID = 'web';
export const WEB_SENDER_ID = 'owner';
// the prefix of the messageId of a web message. the rest is a random uuid.
export const WEB_TURN_PREFIX = 'web:';

// the part of the web channel that the dashboard uses. docs/PHASE5-API.md (m2) gives the routes on top of it.
export interface WebChat {
  // running is true after start() and before stop() of the channel. the routes answer 503 when it is false.
  running(): boolean;
  // submit gives the text to the router as an owner message of the web channel. it gives the turn id and the state of
  // the turn right after the router took it, or undefined when the channel does not run.
  submit(text: string): ChatSendResponse | undefined;
  // press gives the data of a button to the router, the same path as a pressed telegram button. it gives false when
  // the channel does not run.
  press(data: string, turnId?: string): boolean;
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
}

export const TEXT_TICK_MS = 100;

export function createWebChannel(_options: WebChannelOptions = {}): WebChannel {
  throw new Error('not built: createWebChannel');
}

export function isWebChannel(channel: ChannelAdapter): channel is WebChannel {
  return channel.id === WEB && 'chat' in channel && 'turns' in channel;
}
