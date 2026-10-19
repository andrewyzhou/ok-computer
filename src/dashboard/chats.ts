import type { Hono } from 'hono';
import type { SQLInputValue } from 'node:sqlite';
import type { Db } from '../db/index.js';
import { dataUrls } from '../policy/policy.js';
import { REMOVED_REPLY, REPLY_CALL_ID, REPLY_NOTE, withoutLinks } from '../policy/reply.js';
import { NO_REPLY } from '../sessions/router.js';
import { chatKindOf, mainSegments, parseChatKey, type MainSegment } from './chat-keys.js';
import { idOf, limitOf } from './params.js';
import type { DashboardDeps } from './server.js';
import type { ChatKind, ChatKindFilter, ChatMessage, ChatMessagesPage, ChatRow, ChatsPage } from './types.js';

// phase 5 m1 owns this module. it mounts GET /api/chats and GET /api/chats/:key/messages. docs/PHASE5-API.md gives the
// shapes and the errors. server.ts calls it after the sign-in check, so each route is behind the dashboard auth.

export const CHAT_KINDS: readonly ChatKindFilter[] = ['main', 'auto', 'heartbeat', 'sub', 'consolidate', 'workshop', 'poll', 'other', 'activity'];

type Row = Record<string, unknown>;
type Params = Record<string, SQLInputValue>;

const str = (value: unknown) => (value === null || value === undefined ? null : String(value));
const num = (value: unknown) => (value === null || value === undefined ? null : Number(value));
const collapse = (text: string, max: number) => text.replace(/\s+/g, ' ').trim().slice(0, max);

// the event ids of one chat. a segment of main has bounds, and a background chat is its whole session.
interface Range {
  sessionKey: string;
  from: number;
  to: number | null;
}

const RANGE_SQL = 'e.sessionKey = $sessionKey AND e.id >= $from AND ($to IS NULL OR e.id <= $to)';
const rangeParams = (range: Range): Params => ({ sessionKey: range.sessionKey, from: range.from, to: range.to });

// the numbers of one chat that the list sorts and filters by. the title and the preview cost a query more, so the list
// builds them only for the rows that it needs.
interface ChatStats {
  key: string;
  kind: ChatKind;
  range: Range;
  fromEventId: number;
  toEventId: number | null;
  firstAt: string;
  lastAt: string;
  runs: number;
  costUsd: number | null;
  lastRunStatus: string | null;
  pendingApprovals: number;
  firstOwnerText: string | null;
  channel: string | null;
}

// the run numbers of a chat come from the runs that have an event in it. a child run has its events in its own sub
// session, so it counts there only.
const runStatsSql = (runIds: string) => `
  (SELECT SUM(costUsd) FROM model_calls WHERE runId IN (${runIds})) AS costUsd,
  (SELECT status FROM runs WHERE id IN (${runIds}) ORDER BY startedAt DESC, rowid DESC LIMIT 1) AS lastRunStatus,
  (SELECT COUNT(*) FROM approvals WHERE status = 'pending' AND runId IN (${runIds})) AS pendingApprovals`;

// the numbers of one segment of main. a segment with no owner or agent message gives undefined, so a segment that
// holds only its reset is not a chat of the list.
function mainStats(db: Db, segment: MainSegment, needSpoken = true): ChatStats | undefined {
  const range: Range = { sessionKey: 'main', from: segment.fromEventId, to: segment.toEventId };
  const row = db
    .prepare(
      `WITH ev AS (SELECT e.id, e.runId, e.type, e.payload, e.createdAt FROM events e WHERE ${RANGE_SQL})
       SELECT
         (SELECT COUNT(*) FROM ev WHERE type IN ('user_message', 'assistant_message')) AS spoken,
         (SELECT createdAt FROM ev ORDER BY id LIMIT 1) AS firstAt,
         (SELECT createdAt FROM ev ORDER BY id DESC LIMIT 1) AS lastAt,
         (SELECT json_extract(payload, '$.text') FROM ev WHERE type = 'user_message' ORDER BY id LIMIT 1) AS firstOwnerText,
         (SELECT json_extract(payload, '$.channel') FROM ev WHERE type = 'user_message' ORDER BY id DESC LIMIT 1) AS channel,
         (SELECT COUNT(DISTINCT runId) FROM ev) AS runs,
         ${runStatsSql('SELECT runId FROM ev WHERE runId IS NOT NULL')}`,
    )
    .get(rangeParams(range))!;
  if (row.firstAt === null || (needSpoken && !Number(row.spoken))) return undefined;
  return {
    key: segment.key,
    kind: 'main',
    range,
    fromEventId: segment.fromEventId,
    toEventId: segment.toEventId,
    firstAt: String(row.firstAt),
    lastAt: String(row.lastAt),
    runs: Number(row.runs),
    costUsd: num(row.costUsd),
    lastRunStatus: str(row.lastRunStatus),
    pendingApprovals: Number(row.pendingApprovals),
    firstOwnerText: str(row.firstOwnerText),
    channel: str(row.channel),
  };
}

// the numbers of each background session in one grouped query, or of one session when the key is given.
function backgroundStats(db: Db, sessionKey?: string): ChatStats[] {
  const rows = db
    .prepare(
      `WITH bg AS (
         SELECT sessionKey, MIN(id) AS firstId, MAX(id) AS lastId, COUNT(DISTINCT runId) AS runs
         FROM events WHERE ${sessionKey === undefined ? "sessionKey != 'main'" : 'sessionKey = $sessionKey'} GROUP BY sessionKey
       )
       SELECT bg.sessionKey, bg.firstId, bg.runs,
         (SELECT createdAt FROM events WHERE id = bg.firstId) AS firstAt,
         (SELECT createdAt FROM events WHERE id = bg.lastId) AS lastAt,
         ${runStatsSql('SELECT runId FROM events WHERE sessionKey = bg.sessionKey AND runId IS NOT NULL')}
       FROM bg`,
    )
    .all(sessionKey === undefined ? {} : { sessionKey });
  return rows.map((row) => {
    const key = String(row.sessionKey);
    const from = Number(row.firstId);
    return {
      key,
      kind: chatKindOf(key),
      range: { sessionKey: key, from, to: null },
      fromEventId: from,
      toEventId: null,
      firstAt: String(row.firstAt),
      lastAt: String(row.lastAt),
      runs: Number(row.runs),
      costUsd: num(row.costUsd),
      lastRunStatus: str(row.lastRunStatus),
      pendingApprovals: Number(row.pendingApprovals),
      firstOwnerText: null,
      channel: null,
    };
  });
}

// the title of a background chat comes from its session key.
function backgroundTitle(db: Db, kind: ChatKind, sessionKey: string): string {
  const parts = sessionKey.split(':');
  switch (kind) {
    case 'auto': {
      const id = parts[1] ?? '';
      const row = db.prepare('SELECT name FROM automations WHERE id = ?').get(id);
      return str(row?.name) || id;
    }
    case 'heartbeat':
      return 'Heartbeat';
    case 'sub':
      return `Sub-agent: ${parts[1] ?? ''}`;
    case 'consolidate':
      return `Memory consolidation ${sessionKey.slice('consolidate:'.length)}`;
    case 'workshop':
      return 'Skill workshop';
    case 'poll':
      return `Poll: ${sessionKey.slice('poll:'.length)}`;
    default:
      return sessionKey;
  }
}

// the one builder of a chat row, for the list and for the messages page.
function chatRow(db: Db, stats: ChatStats): ChatRow {
  const title = stats.kind === 'main' ? (stats.firstOwnerText ? collapse(stats.firstOwnerText, 80) : '') || 'New chat' : collapse(backgroundTitle(db, stats.kind, stats.key), 80);
  const last = messageRows(db, stats.range, { limit: 1, spokenOnly: true })[0];
  const preview = last ? collapse(toMessage(last).text, 200) : '';
  return {
    key: stats.key,
    kind: stats.kind,
    sessionKey: stats.range.sessionKey,
    fromEventId: stats.fromEventId,
    toEventId: stats.toEventId,
    title,
    channel: stats.channel,
    preview: preview || null,
    firstAt: stats.firstAt,
    lastAt: stats.lastAt,
    runs: stats.runs,
    costUsd: stats.costUsd,
    lastRunStatus: stats.lastRunStatus,
    pendingApprovals: stats.pendingApprovals,
  };
}

// the events that a chat shows, newest first. the rules of the delivered text are in sql, so a page is never short
// only because the query skipped a row. a final reply is the last assistant_message of its run. the guard note of
// such a reply says that the chat got a changed text. a guard decision with no allow and no note means that the run
// ended before the reply went out, so the chat never got it.
// the sql trim strips spaces, tabs and line ends, as the trim of the router does before it compares NO_REPLY.
function messageRows(db: Db, range: Range, options: { before?: number; limit: number; spokenOnly?: boolean }): Row[] {
  const types = options.spokenOnly ? "('user_message', 'assistant_message')" : "('user_message', 'assistant_message', 'note', 'system_event', 'session_reset')";
  return db
    .prepare(
      `WITH m AS (
         SELECT e.id, e.type, e.runId, e.createdAt,
           json_extract(e.payload, '$.text') AS text,
           json_extract(e.payload, '$.channel') AS channel,
           CASE WHEN e.type = 'assistant_message' AND e.runId IS NOT NULL THEN (
             SELECT d.approvalId FROM policy_decisions d
             WHERE d.runId = e.runId AND d.approvalId IS NOT NULL
               AND d.toolCallId IN (SELECT json_extract(value, '$.id') FROM json_each(e.payload, '$.toolCalls'))
             ORDER BY d.id LIMIT 1
           ) END AS approvalId,
           e.type = 'assistant_message' AND e.runId IS NOT NULL AND NOT EXISTS (
             SELECT 1 FROM events x WHERE x.runId = e.runId AND x.type = 'assistant_message' AND x.id > e.id
           ) AS isFinal
         FROM events e
         WHERE ${RANGE_SQL} AND e.type IN ${types} AND ($before IS NULL OR e.id < $before)
       ),
       g AS (
         SELECT m.*,
           CASE WHEN isFinal THEN (
             SELECT json_extract(n.payload, '$.text') FROM events n
             WHERE n.runId = m.runId AND n.type = 'note' AND substr(json_extract(n.payload, '$.text'), 1, $noteLength) = $note
             ORDER BY n.id LIMIT 1
           ) END AS guardNote,
           CASE WHEN isFinal THEN
             EXISTS (SELECT 1 FROM policy_decisions WHERE runId = m.runId AND toolCallId = $replyCall)
             AND NOT EXISTS (SELECT 1 FROM policy_decisions WHERE runId = m.runId AND toolCallId = $replyCall AND reviewerVerdict = 'allow')
           ELSE 0 END AS reviewed
         FROM m
       )
       SELECT id, type, runId, createdAt, text, channel, approvalId, guardNote FROM g
       WHERE CASE type
         WHEN 'assistant_message' THEN
           trim(COALESCE(text, ''), char(32, 9, 10, 13)) != $noReply
           AND (trim(COALESCE(text, ''), char(32, 9, 10, 13)) != '' OR approvalId IS NOT NULL)
           AND NOT (reviewed AND guardNote IS NULL)
           ${options.spokenOnly ? "AND trim(COALESCE(text, ''), char(32, 9, 10, 13)) != ''" : ''}
         WHEN 'system_event' THEN COALESCE(text, '') != ''
         ELSE 1 END
       ORDER BY id DESC LIMIT $limit`,
    )
    .all({
      ...rangeParams(range),
      before: options.before ?? null,
      limit: options.limit,
      note: REPLY_NOTE,
      noteLength: REPLY_NOTE.length,
      replyCall: REPLY_CALL_ID,
      noReply: NO_REPLY,
    });
}

// the text that the chat got. a reply that the guard changed shows at most the text that the guard let through: the
// guard removed the links that the session did not read, and this removes every link that can carry data. the run
// page keeps the full text.
function deliveredText(text: string, guardNote: string): string {
  if (guardNote.includes('only a short notice')) return REMOVED_REPLY;
  return withoutLinks(text, dataUrls(text).map((each) => each.url));
}

function toMessage(row: Row): ChatMessage {
  const type = String(row.type);
  const text = str(row.text) ?? '';
  const base = { id: Number(row.id), runId: str(row.runId), channel: null, guarded: false, approvalId: null, createdAt: String(row.createdAt) };
  switch (type) {
    case 'user_message':
      return { ...base, role: 'owner', channel: str(row.channel), text };
    case 'assistant_message': {
      const guardNote = str(row.guardNote);
      return {
        ...base,
        role: 'agent',
        text: guardNote === null ? text : deliveredText(text, guardNote),
        guarded: guardNote !== null,
        approvalId: num(row.approvalId),
      };
    }
    case 'note':
      return { ...base, role: 'note', text, guarded: text.startsWith(REPLY_NOTE) };
    case 'session_reset':
      return { ...base, role: 'system', text: 'Started a new session.' };
    default:
      return { ...base, role: 'system', text };
  }
}

interface Cursor {
  lastAt: string;
  key: string;
}

const encodeCursor = (cursor: Cursor) => Buffer.from(JSON.stringify(cursor)).toString('base64url');

function decodeCursor(value: string): Cursor | undefined {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const { lastAt, key } = parsed as Record<string, unknown>;
    return typeof lastAt === 'string' && typeof key === 'string' ? { lastAt, key } : undefined;
  } catch {
    return undefined;
  }
}

// newest lastAt first. the seeds use a fixed clock, so the key breaks the many ties.
const newerFirst = (a: Cursor, b: Cursor) => (a.lastAt === b.lastAt ? (a.key === b.key ? 0 : a.key < b.key ? 1 : -1) : a.lastAt < b.lastAt ? 1 : -1);

export interface ChatsInput {
  kind?: ChatKindFilter;
  q?: string;
  cursor?: string;
  // already clamped to 1 to 200.
  limit: number;
}

// the chat list: each segment of main and each background session, newest lastAt first, with cursor paging. a cursor
// that cannot be read gives undefined, and the route answers 400.
export function listChats(db: Db, input: ChatsInput): ChatsPage | undefined {
  const cursor = input.cursor === undefined ? undefined : decodeCursor(input.cursor);
  if (input.cursor !== undefined && !cursor) return undefined;
  const { kind } = input;
  const keep = (each: ChatKind) => kind === undefined || (kind === 'activity' ? each !== 'main' : each === kind);
  const stats: ChatStats[] = [
    ...(keep('main') ? mainSegments(db).flatMap((segment) => mainStats(db, segment) ?? []) : []),
    ...(kind === 'main' ? [] : backgroundStats(db).filter((each) => keep(each.kind))),
  ].sort(newerFirst);
  const after = cursor ? stats.filter((each) => newerFirst(each, cursor) > 0) : stats;
  // the q filter reads the title and the preview, so it builds every row. without it, only the rows of the page.
  const q = input.q?.toLowerCase();
  const rows = q
    ? after.map((each) => chatRow(db, each)).filter((row) => row.title.toLowerCase().includes(q) || (row.preview ?? '').toLowerCase().includes(q))
    : after.slice(0, input.limit + 1).map((each) => chatRow(db, each));
  const chats = rows.slice(0, input.limit);
  const last = chats.at(-1);
  return { chats, nextCursor: rows.length > input.limit && last ? encodeCursor({ lastAt: last.lastAt, key: last.key }) : null };
}

export interface ChatMessagesInput {
  before?: number;
  // already clamped to 1 to 200.
  limit: number;
}

// the delivered text of one chat, oldest first in the page. a chat that does not exist gives undefined.
export function chatMessages(db: Db, key: string, input: ChatMessagesInput): ChatMessagesPage | undefined {
  const parsed = parseChatKey(key);
  if (!parsed) return undefined;
  let stats: ChatStats | undefined;
  if (parsed.resetEventId === null) {
    stats = backgroundStats(db, parsed.sessionKey)[0];
  } else {
    // the key names the reset that starts the segment. a segment with no events at all is not a chat.
    const segment = mainSegments(db).find((each) => each.resetEventId === parsed.resetEventId);
    stats = segment && mainStats(db, segment, false);
  }
  if (!stats) return undefined;
  const rows = messageRows(db, stats.range, { ...(input.before ? { before: input.before } : {}), limit: input.limit + 1 });
  const page = rows.slice(0, input.limit).reverse().map(toMessage);
  return { chat: chatRow(db, stats), messages: page, before: rows.length > input.limit && page.length ? page[0]!.id : null };
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
