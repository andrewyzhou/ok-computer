import type { Hono } from 'hono';
import type { Db } from '../db/index.js';
import { parseChatKey } from './chat-keys.js';
import { idOf, limitOf, notBuilt } from './params.js';
import type { DashboardDeps } from './server.js';
import type { ChatKindFilter, ChatMessagesPage, ChatsPage } from './types.js';

// phase 5 m1 owns this module. it mounts GET /api/chats and GET /api/chats/:key/messages. docs/PHASE5-API.md gives the
// shapes and the errors. server.ts calls it after the sign-in check, so each route is behind the dashboard auth.

export const CHAT_KINDS: readonly ChatKindFilter[] = ['main', 'auto', 'heartbeat', 'sub', 'consolidate', 'workshop', 'poll', 'other', 'activity'];

export interface ChatsInput {
  kind?: ChatKindFilter;
  q?: string;
  cursor?: string;
  // already clamped to 1 to 200.
  limit: number;
}

// the chat list: each segment of main and each background session, newest lastAt first, with cursor paging. a cursor
// that cannot be read gives undefined, and the route answers 400.
export function listChats(_db: Db, _input: ChatsInput): ChatsPage | undefined {
  return notBuilt('the chat list');
}

export interface ChatMessagesInput {
  before?: number;
  // already clamped to 1 to 200.
  limit: number;
}

// the delivered text of one chat, oldest first in the page. a chat that does not exist gives undefined.
export function chatMessages(_db: Db, _key: string, _input: ChatMessagesInput): ChatMessagesPage | undefined {
  return notBuilt('the chat messages');
}

export function mountChats(server: Hono, deps: DashboardDeps): void {
  const { db } = deps;
  server.get('/api/chats', (c) => {
    const query = c.req.query();
    const kind = query.kind as ChatKindFilter | undefined;
    if (kind !== undefined && !CHAT_KINDS.includes(kind)) return c.json({ error: `give kind as one of ${CHAT_KINDS.join(', ')}` }, 400);
    const page = listChats(db, {
      ...(kind ? { kind } : {}),
      ...(query.q ? { q: query.q.slice(0, 200) } : {}),
      ...(query.cursor ? { cursor: query.cursor } : {}),
      limit: limitOf(query.limit, 200, 50),
    });
    return page ? c.json(page) : c.json({ error: 'give cursor as the nextCursor of the page before' }, 400);
  });
  server.get('/api/chats/:key/messages', (c) => {
    const key = c.req.param('key');
    const before = c.req.query('before');
    if (before !== undefined && idOf(before) === undefined) return c.json({ error: 'give before as the id of an event' }, 400);
    const page = parseChatKey(key) && chatMessages(db, key, { ...(before ? { before: Number(before) } : {}), limit: limitOf(c.req.query('limit'), 200, 50) });
    return page ? c.json(page) : c.json({ error: 'chat not found' }, 404);
  });
}
