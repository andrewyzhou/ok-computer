import type { Db } from '../db/index.js';
import type { ChatKind } from './types.js';

// the chats, the search and the stream of phase 5 m1 name a chat the same way, so the rules are in this one file.
// main is the owner's session. a session_reset starts a new segment of it, and each segment is one chat with the key
// main@<id of its session_reset>. the segment before the first reset has the key main@0. a background session is one
// chat, and its key is the session key.

export const MAIN_KEY_PREFIX = 'main@';

// the prefix of a background session key gives its kind. the order does not matter, because no prefix starts another.
export const KIND_PREFIXES: ReadonlyArray<[string, ChatKind]> = [
  ['auto:', 'auto'],
  ['heartbeat:', 'heartbeat'],
  ['sub:', 'sub'],
  ['consolidate:', 'consolidate'],
  ['workshop:', 'workshop'],
  ['poll:', 'poll'],
];

export function chatKindOf(sessionKey: string): ChatKind {
  if (sessionKey === 'main') return 'main';
  return KIND_PREFIXES.find(([prefix]) => sessionKey.startsWith(prefix))?.[1] ?? 'other';
}

export interface ParsedChatKey {
  sessionKey: string;
  // the id of the session_reset that starts the segment, 0 for the first segment, and null for a background chat.
  resetEventId: number | null;
}

// a key that is not valid gives undefined. the bare key main is not valid, because main is always split. a main@<id>
// key is valid when the id is 0 or a whole number; the caller checks that the reset exists.
export function parseChatKey(key: string): ParsedChatKey | undefined {
  if (!key || key.length > 300) return undefined;
  if (key.startsWith(MAIN_KEY_PREFIX)) {
    const id = key.slice(MAIN_KEY_PREFIX.length);
    return /^(0|[1-9]\d{0,15})$/.test(id) ? { sessionKey: 'main', resetEventId: Number(id) } : undefined;
  }
  if (key === 'main') return undefined;
  return { sessionKey: key, resetEventId: null };
}

export const mainKey = (resetEventId: number) => `${MAIN_KEY_PREFIX}${resetEventId}`;

export interface MainSegment {
  key: string;
  resetEventId: number;
  // the first and the last event id that the segment can hold. the reset event itself is the first event of its
  // segment. toEventId is null for the last segment, which is still open.
  fromEventId: number;
  toEventId: number | null;
}

// the ids of the session_reset events of main, oldest first. the events_reset index makes this a short read.
export function mainResets(db: Db): number[] {
  return db
    .prepare("SELECT id FROM events WHERE sessionKey = 'main' AND type = 'session_reset' ORDER BY seq")
    .all()
    .map((row) => Number(row.id));
}

// each segment of main, oldest first. the first segment main@0 is in the list also when it has no events, so the
// caller leaves out a segment with no events.
export function mainSegments(db: Db): MainSegment[] {
  const starts = [0, ...mainResets(db)];
  return starts.map((start, i) => {
    const next = starts[i + 1];
    return { key: mainKey(start), resetEventId: start, fromEventId: start, toEventId: next === undefined ? null : next - 1 };
  });
}

// the chat key of an event, for example of a search hit.
export function chatKeyOf(db: Db, sessionKey: string, eventId: number): string {
  if (sessionKey !== 'main') return sessionKey;
  const row = db
    .prepare("SELECT MAX(id) AS id FROM events WHERE sessionKey = 'main' AND type = 'session_reset' AND id <= ?")
    .get(eventId);
  return mainKey(row?.id === null || row?.id === undefined ? 0 : Number(row.id));
}
