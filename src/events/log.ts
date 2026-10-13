import type { Db } from '../db/index.js';
import type { AssistantTurn } from '../models/types.js';
import { redactedJson } from '../observability/redact.js';
import type { TaintSource } from '../policy/policy.js';

export interface EventPayloads {
  user_message: { text: string; channel: string; chatId: string };
  assistant_message: AssistantTurn;
  // untrustedSource names the outside source of the content. such a result taints the session.
  tool_result: { toolCallId: string; name: string; content: string; isError: boolean; untrustedSource?: string };
  // the volatile part of the system prompt, recorded at the start of each run.
  context: { text: string };
  // a message from the system, not from the owner: an automation prompt, a check-in, or an approval result. taint
  // lists the untrusted sources behind the text, for example the sources that an automation run read.
  system_event: { text: string; taint?: TaintSource[] };
  note: { text: string };
  // the summary replaces the events before firstKeptEventId. clearToolResults freezes the trim of the kept events.
  compaction: {
    summary: string;
    firstKeptEventId: number;
    tokensBefore: number;
    tokensAfter: number;
    model: string;
    clearToolResults: boolean;
  };
  session_reset: Record<string, never>;
}

export type EventType = keyof EventPayloads;

export type StoredEvent = {
  [T in EventType]: {
    id: number;
    sessionKey: string;
    runId: string | null;
    seq: number;
    type: T;
    payload: EventPayloads[T];
    createdAt: string;
  };
}[EventType];

export type EventInput = { [T in EventType]: { type: T; payload: EventPayloads[T] } }[EventType];

export type NewEvent = EventInput & { sessionKey: string; runId: string | null };

// the log has no update or delete function. triggers in the database also stop both operations.
export function appendEvent(db: Db, event: NewEvent, now = new Date()): StoredEvent {
  const row = db
    .prepare(
      `INSERT INTO events (sessionKey, runId, seq, type, payload, createdAt)
       SELECT ?, ?, COALESCE(MAX(seq), 0) + 1, ?, ?, ? FROM events WHERE sessionKey = ?
       RETURNING id, sessionKey, runId, seq, type, payload, createdAt`,
    )
    .get(event.sessionKey, event.runId, event.type, redactedJson(event.payload), now.toISOString(), event.sessionKey);
  return toEvent(row);
}

export function listEvents(db: Db, sessionKey: string): StoredEvent[] {
  return db
    .prepare('SELECT id, sessionKey, runId, seq, type, payload, createdAt FROM events WHERE sessionKey = ? ORDER BY seq')
    .all(sessionKey)
    .map(toEvent);
}

// succeededCalls gives the input of each call of the named tool in a run whose result is not an error, in order. a job
// that acts on what the model gave reads it here and not from tool_calls: the caller fails open on the trace, but the
// run cannot go on without these events. a provider can use the same call id again in a later reply, so each result
// takes the input of the newest call with its id.
export function succeededCalls(db: Db, sessionKey: string, runId: string, name: string): unknown[] {
  const inputs = new Map<string, unknown>();
  const found: unknown[] = [];
  for (const event of listEvents(db, sessionKey)) {
    if (event.runId !== runId) continue;
    if (event.type === 'assistant_message') for (const call of event.payload.toolCalls) inputs.set(call.id, call.input);
    if (event.type === 'tool_result' && event.payload.name === name && !event.payload.isError) found.push(inputs.get(event.payload.toolCallId));
  }
  return found;
}

function toEvent(row: Record<string, unknown> | undefined): StoredEvent {
  if (!row) throw new Error('event row is missing');
  return {
    id: Number(row.id),
    sessionKey: String(row.sessionKey),
    runId: row.runId === null ? null : String(row.runId),
    seq: Number(row.seq),
    type: row.type as EventType,
    payload: JSON.parse(String(row.payload)),
    createdAt: String(row.createdAt),
  } as StoredEvent;
}
