import { useEffect, useRef, useSyncExternalStore } from 'react';
import type { ChatButton, ChatStreamEvent, ChatTurnState } from '../../src/dashboard/types';
import { sharedStream, type Connection } from './api';

// the live stream of the web chat. it is a second event stream next to /api/stream, so the app opens it one time and
// every part of the page shares it. a browser allows six connections to one host, and a second copy of a stream would
// take one of them.

type Listener = (event: ChatStreamEvent) => void;
const listeners = new Set<Listener>();
let connection: Connection = 'connecting';
const connectionListeners = new Set<() => void>();

const KINDS = new Set<string>(['snapshot', 'owner', 'state', 'run', 'text', 'activity', 'reply', 'done', 'error']);

function setConnection(next: Connection): void {
  if (next === connection) return;
  connection = next;
  for (const each of connectionListeners) each();
}

const stream = sharedStream({
  path: '/api/chat/stream',
  setConnection,
  hasListeners: () => listeners.size > 0,
  onMessage: (message) => {
    let event: ChatStreamEvent;
    try {
      event = JSON.parse(String(message.data)) as ChatStreamEvent;
    } catch {
      return;
    }
    // a kind from a newer server is left out, as the contract asks.
    if (!event || typeof event !== 'object' || !KINDS.has(event.kind)) return;
    applyTurnAction(event);
    for (const each of [...listeners]) each(event);
  },
});

// the stream opens with the first subscriber. the server sends ready and ping as named events, and the unnamed
// messages are the chat events, so only onmessage reads them.
export function subscribeChat(listener: Listener): () => void {
  stream.ensure();
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

// the listener can change on each render. the subscription stays, and each event goes to the newest listener.
export function useChatStream(listener: Listener): void {
  const latest = useRef(listener);
  latest.current = listener;
  useEffect(() => subscribeChat((event) => latest.current(event)), []);
}

export function useChatConnection(): Connection {
  useEffect(() => subscribeChat(() => {}), []);
  return useSyncExternalStore(
    (listener) => {
      connectionListeners.add(listener);
      return () => void connectionListeners.delete(listener);
    },
    () => connection,
    () => connection,
  );
}

export interface LiveReply {
  text: string;
  markdown: boolean;
  details: string | null;
  buttons: ChatButton[][];
  messageId: string;
}

// one turn that the page follows live. ownerText is known when the owner event came, or when this page sent the turn.
export interface LiveTurn {
  turnId: string;
  channel: string;
  ownerText?: string;
  state: ChatTurnState;
  runId: string | null;
  // the streamed text of the current model call. the reply replaces it.
  text: string;
  activity: string | null;
  reply?: LiveReply;
  error?: string;
}

// a reply with no turn, for example an approval card from the agent. the page shows it after the transcript.
export interface StandaloneReply extends LiveReply {
  runId: string | null;
  at: string;
}

// the page adds two actions of its own: sent, when its post gave a turn id, and drop, when the transcript holds the
// ended turns after its reload.
export type TurnAction =
  | ChatStreamEvent
  | { kind: 'sent'; turnId: string; text: string; state: ChatTurnState }
  | { kind: 'drop'; turnIds: string[] };

export type Turns = Map<string, LiveTurn>;

// the channel of a turn that the page did not see start is the part of its id before the colon, for example telegram.
function channelOf(turnId: string): string {
  const colon = turnId.indexOf(':');
  return colon > 0 ? turnId.slice(0, colon) : 'web';
}

function blank(turnId: string): LiveTurn {
  return { turnId, channel: channelOf(turnId), state: 'queued', runId: null, text: '', activity: null };
}

function change(state: Turns, turnId: string, update: (turn: LiveTurn) => LiveTurn): Turns {
  const next = new Map(state);
  next.set(turnId, update(state.get(turnId) ?? blank(turnId)));
  return next;
}

// the live turns, by turn id in the order they started. the reducer is pure, so a test can drive it with events.
export function turnsReducer(state: Turns, event: TurnAction): Turns {
  switch (event.kind) {
    case 'snapshot': {
      // a snapshot comes first on each connection, also after a reconnect, so it replaces every turn. the owner text
      // of a turn that the page already knew stays, because the snapshot does not carry it.
      const next: Turns = new Map();
      for (const turn of event.turns) {
        const old = state.get(turn.turnId);
        next.set(turn.turnId, {
          turnId: turn.turnId,
          channel: turn.channel,
          ...(old?.ownerText !== undefined ? { ownerText: old.ownerText } : {}),
          state: turn.state,
          runId: turn.runId,
          text: turn.text,
          activity: turn.activity,
          ...(old?.reply ? { reply: old.reply } : {}),
        });
      }
      return next;
    }
    case 'sent':
      return change(state, event.turnId, (turn) => ({ ...turn, channel: 'web', ownerText: event.text, state: turn.state === 'queued' ? event.state : turn.state }));
    case 'owner':
      return change(state, event.turnId, (turn) => ({ ...turn, channel: event.channel, ownerText: event.text }));
    case 'state':
      // the end of a turn that the page never saw, or already dropped, adds nothing to the page.
      if (!state.has(event.turnId) && !isActive({ state: event.state })) return state;
      return change(state, event.turnId, (turn) => ({ ...turn, state: event.state }));
    case 'run':
      return change(state, event.turnId, (turn) => ({ ...turn, runId: event.runId }));
    case 'text':
      return change(state, event.turnId, (turn) => ({ ...turn, text: event.reset ? event.delta : turn.text + event.delta }));
    case 'activity':
      return change(state, event.turnId, (turn) => ({ ...turn, activity: event.tools }));
    case 'reply': {
      if (event.turnId === null) return state;
      const reply: LiveReply = { text: event.text, markdown: event.markdown, details: event.details, buttons: event.buttons, messageId: event.messageId };
      return change(state, event.turnId, (turn) => ({ ...turn, reply, text: '', activity: null, runId: turn.runId ?? event.runId }));
    }
    case 'done':
      if (!state.has(event.turnId)) return state;
      return change(state, event.turnId, (turn) => ({
        ...turn,
        activity: null,
        // a stopped or failed turn keeps its word. a turn that ended well is done.
        state: event.ok ? 'done' : turn.state === 'stopped' ? 'stopped' : 'failed',
      }));
    case 'error':
      if (event.turnId === null) return state;
      return change(state, event.turnId, (turn) => ({ ...turn, error: event.error }));
    case 'drop': {
      if (!event.turnIds.some((id) => state.has(id))) return state;
      const next = new Map(state);
      for (const id of event.turnIds) next.delete(id);
      return next;
    }
    default:
      return state;
  }
}

// the replies with no turn, oldest first. a reply with a turn id goes to its turn in turnsReducer instead.
export function standaloneReducer(list: StandaloneReply[], event: TurnAction): StandaloneReply[] {
  if (event.kind !== 'reply' || event.turnId !== null) return list;
  if (list.some((each) => each.messageId === event.messageId)) return list;
  return [
    ...list,
    { text: event.text, markdown: event.markdown, details: event.details, buttons: event.buttons, messageId: event.messageId, runId: event.runId, at: event.at },
  ];
}

// a turn is active while it waits or runs, so the page offers Stop for it.
export function isActive(turn: Pick<LiveTurn, 'state'>): boolean {
  return turn.state === 'queued' || turn.state === 'running';
}

// the module keeps the live turns of the shared stream, so a chat that opens late still has the turns of the snapshot
// that came when the stream opened.
let live: { turns: Turns; standalone: StandaloneReply[] } = { turns: new Map(), standalone: [] };
const liveListeners = new Set<() => void>();

// the turns that ended, or that the page dropped. the answer of the post can come after the stream ended the turn,
// and its sent action must not make a new turn that never ends. the set keeps the newest ids only.
const ended = new Set<string>();
const ENDED_KEEP = 200;

function markEnded(turnId: string): void {
  ended.delete(turnId);
  ended.add(turnId);
  if (ended.size > ENDED_KEEP) ended.delete(ended.values().next().value!);
}

export function applyTurnAction(action: TurnAction): void {
  if (action.kind === 'sent' && ended.has(action.turnId)) return;
  const turns = turnsReducer(live.turns, action);
  const standalone = standaloneReducer(live.standalone, action);
  if (action.kind === 'done') markEnded(action.turnId);
  else if (action.kind === 'drop') for (const id of action.turnIds) markEnded(id);
  else if (action.kind === 'state' && !isActive(action)) markEnded(action.turnId);
  // a turn that a snapshot left out ended while the stream was down.
  else if (action.kind === 'snapshot') for (const id of live.turns.keys()) if (!turns.has(id)) markEnded(id);
  if (turns === live.turns && standalone === live.standalone) return;
  live = { turns, standalone };
  for (const each of liveListeners) each();
}

// the live turns of the shared stream at this moment, for a handler that runs outside a render.
export function currentTurns(): Turns {
  return live.turns;
}

export function useLiveTurns(): { turns: Turns; standalone: StandaloneReply[] } {
  useEffect(() => subscribeChat(() => {}), []);
  return useSyncExternalStore(
    (listener) => {
      liveListeners.add(listener);
      return () => void liveListeners.delete(listener);
    },
    () => live,
    () => live,
  );
}
