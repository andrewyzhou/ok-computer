import type { Hono } from 'hono';
import type { SQLInputValue } from 'node:sqlite';
import type { Db } from '../db/index.js';
import { dataUrls } from '../policy/policy.js';
import { REMOVED_REPLY, REPLY_CALL_ID, REPLY_NOTE, withoutLinks } from '../policy/reply.js';
import { NO_REPLY } from '../sessions/router.js';
import { chatKindOf, KIND_PREFIXES, mainKey, mainSegments, parseChatKey, type MainSegment } from './chat-keys.js';
import { idOf, limitOf } from './params.js';
import type { DashboardDeps } from './server.js';
import type { ChatKind, ChatKindFilter, ChatMessage, ChatMessagesPage, ChatRow, ChatsPage } from './types.js';

// phase 5 m1 owns this module. it mounts GET /api/chats and GET /api/chats/:key/messages. docs/API.md gives the
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

// the numbers of one background session. a session with no events gives undefined.
function backgroundStats(db: Db, sessionKey: string): ChatStats | undefined {
  const rows = db
    .prepare(
      `WITH bg AS (
         SELECT sessionKey, MIN(id) AS firstId, MAX(id) AS lastId, COUNT(DISTINCT runId) AS runs
         FROM events WHERE sessionKey = $sessionKey GROUP BY sessionKey
       )
       SELECT bg.sessionKey, bg.firstId, bg.runs,
         (SELECT createdAt FROM events WHERE id = bg.firstId) AS firstAt,
         (SELECT createdAt FROM events WHERE id = bg.lastId) AS lastAt,
         ${runStatsSql('SELECT runId FROM events WHERE sessionKey = bg.sessionKey AND runId IS NOT NULL')}
       FROM bg`,
    )
    .all({ sessionKey });
  return rows.map((row): ChatStats => {
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
  })[0];
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

// the title and the preview of a chat. they need the range and the first owner text, but not the numbers of a chat.
interface ChatHead {
  title: string;
  preview: string | null;
}

function chatHead(db: Db, kind: ChatKind, key: string, range: Range, firstOwnerText: string | null): ChatHead {
  const title = kind === 'main' ? (firstOwnerText ? collapse(firstOwnerText, 80) : '') || 'New chat' : collapse(backgroundTitle(db, kind, key), 80);
  const last = messageRows(db, range, { limit: 1, spokenOnly: true })[0];
  const preview = last ? collapse(toMessage(last).text, 200) : '';
  return { title, preview: preview || null };
}

const headMatches = (head: ChatHead, q: string) => head.title.toLowerCase().includes(q) || (head.preview ?? '').toLowerCase().includes(q);

// the one builder of a chat row, for the list and for the messages page. the list passes the head when it has already
// read it for q.
function chatRow(db: Db, stats: ChatStats, head = chatHead(db, stats.kind, stats.key, stats.range, stats.firstOwnerText)): ChatRow {
  return {
    key: stats.key,
    kind: stats.kind,
    sessionKey: stats.range.sessionKey,
    fromEventId: stats.fromEventId,
    toEventId: stats.toEventId,
    title: head.title,
    channel: stats.channel,
    preview: head.preview,
    firstAt: stats.firstAt,
    lastAt: stats.lastAt,
    runs: stats.runs,
    costUsd: stats.costUsd,
    lastRunStatus: stats.lastRunStatus,
    pendingApprovals: stats.pendingApprovals,
  };
}

// the events that a chat shows, newest first. the rules of the delivered text are in sql, so a page is never short
// only because the query skipped a row. the router and the loop send only the final reply of a run, which is its last
// assistant_message with no tool calls, and the reply guard checks only that one. the text of a turn that also asked
// for tools was a draft, so the chat never got it, except for a turn whose call made an approval: the chat got the
// approval card. the guard note of a final reply says that the chat got a changed text. a guard decision with no allow
// and no note means that the run ended before the reply went out, so the chat never got it.
// the sql trim strips spaces, tabs and line ends, as the trim of the router does before it compares NO_REPLY.
// with ids, the rows are the events of those ids that a chat shows, for the search. without them, the rows of range.
function messageRows(db: Db, range: Range | undefined, options: { before?: number; limit: number; spokenOnly?: boolean; ids?: number[] }): Row[] {
  const types = options.spokenOnly ? "('user_message', 'assistant_message')" : "('user_message', 'assistant_message', 'note', 'system_event', 'session_reset')";
  const where = options.ids ? 'e.id IN (SELECT value FROM json_each($ids))' : RANGE_SQL;
  const noCalls = (alias: string) => `COALESCE(json_array_length(${alias}.payload, '$.toolCalls'), 0) = 0`;
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
           ${noCalls('e')} AS noCalls,
           e.type = 'assistant_message' AND e.runId IS NOT NULL AND ${noCalls('e')} AND NOT EXISTS (
             SELECT 1 FROM events x WHERE x.runId = e.runId AND x.type = 'assistant_message' AND x.id > e.id AND ${noCalls('x')}
           ) AS isFinal
         FROM events e
         WHERE ${where} AND e.type IN ${types} AND ($before IS NULL OR e.id < $before)
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
           (noCalls OR approvalId IS NOT NULL)
           AND trim(COALESCE(text, ''), char(32, 9, 10, 13)) != $noReply
           AND (trim(COALESCE(text, ''), char(32, 9, 10, 13)) != '' OR approvalId IS NOT NULL)
           AND NOT (reviewed AND guardNote IS NULL)
           ${options.spokenOnly ? "AND trim(COALESCE(text, ''), char(32, 9, 10, 13)) != ''" : ''}
         WHEN 'system_event' THEN COALESCE(text, '') != ''
         ELSE 1 END
       ORDER BY id DESC LIMIT $limit`,
    )
    .all({
      ...(options.ids ? { ids: JSON.stringify(options.ids) } : rangeParams(range!)),
      before: options.before ?? null,
      limit: options.limit,
      note: REPLY_NOTE,
      noteLength: REPLY_NOTE.length,
      replyCall: REPLY_CALL_ID,
      noReply: NO_REPLY,
    });
}

// the text that a chat shows for each of these events, by event id. an event that no chat shows, for example a
// NO_REPLY answer, a draft of a tool turn or a reply that the guard held, is not in the map. the search uses this, so
// a hit never shows a text that the chat did not get.
export function deliveredTexts(db: Db, ids: number[]): Map<number, string> {
  if (!ids.length) return new Map();
  const rows = messageRows(db, undefined, { ids, limit: ids.length });
  return new Map(rows.map((row) => [Number(row.id), toMessage(row).text]));
}

// the text that the chat got. a reply that the guard changed shows at most the text that the guard let through: the
// guard removed the links that the session did not read, and this removes every link that can carry data. the run
// page keeps the full text.
function deliveredText(text: string, guardNote: string): string {
  if (guardNote.includes('only a short notice')) return REMOVED_REPLY;
  return withoutLinks(text, dataUrls(text).map((each) => each.url));
}

// the model gets outside text inside an untrusted wrapper. the chat shows the text without the tags, and the stored
// event keeps them. the wrapper turns each closing tag in the outside text into square brackets, so a closing tag here
// is always the end of a wrapper.
const WRAPPER_TAGS = /<untrusted source="[^"]*">\n?|\n?<\/untrusted>/g;

export function withoutWrapper(text: string): string {
  return text.replace(WRAPPER_TAGS, '');
}

function toMessage(row: Row): ChatMessage {
  const type = String(row.type);
  const raw = str(row.text) ?? '';
  const text = withoutWrapper(raw);
  const base = { id: Number(row.id), runId: str(row.runId), channel: null, guarded: false, approvalId: null, createdAt: String(row.createdAt) };
  switch (type) {
    case 'user_message':
      return { ...base, role: 'owner', channel: str(row.channel), text: raw };
    case 'assistant_message': {
      const guardNote = str(row.guardNote);
      const approvalId = num(row.approvalId);
      // a turn that only asked for an approval has no text, so it gets a short label, and the page draws the card under it.
      const shown = guardNote === null ? text : deliveredText(text, guardNote);
      return {
        ...base,
        role: 'agent',
        text: approvalId !== null && shown.trim() === '' ? `Asked for approval #${approvalId}.` : shown,
        guarded: guardNote !== null,
        approvalId,
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

// newest lastAt first. the seeds use a fixed clock, so the key breaks the many ties. the keys compare as utf-8 bytes,
// as sqlite compares text, so the order here and the order of the sql below agree.
const newerFirst = (a: Cursor, b: Cursor) => {
  if (a.lastAt !== b.lastAt) return a.lastAt < b.lastAt ? 1 : -1;
  return -Buffer.compare(Buffer.from(a.key), Buffer.from(b.key));
};

export interface ChatsInput {
  kind?: ChatKindFilter;
  q?: string;
  cursor?: string;
  // already clamped to 1 to 200.
  limit: number;
}

// a chat of the list before its numbers are known. stats reads them, and it gives undefined for a segment of main
// that is not a chat. a background chat also has head, which reads its title and preview without the numbers, so
// with q the list reads the numbers only of the chats that match.
interface Candidate extends Cursor {
  stats: () => ChatStats | undefined;
  head?: () => ChatHead;
}

// with q, one page reads at most this many background chats. a page can then hold fewer chats than the limit and still
// have a nextCursor, and the next page goes on from the last chat that this page read.
export const CHATS_Q_SCAN = 500;

// the segments of main with the time of the last event of each. the seq of the next reset bounds a segment, so each
// segment costs one read of the (sessionKey, seq) index.
function mainCandidates(db: Db): Candidate[] {
  const resets = db.prepare("SELECT id, seq FROM events WHERE sessionKey = 'main' AND type = 'session_reset' ORDER BY seq").all();
  const starts = [{ id: 0, seq: null as number | null }, ...resets.map((row) => ({ id: Number(row.id), seq: Number(row.seq) }))];
  const lastBefore = db.prepare("SELECT createdAt FROM events WHERE sessionKey = 'main' AND seq < ? ORDER BY seq DESC LIMIT 1");
  const lastOf = db.prepare("SELECT createdAt FROM events WHERE sessionKey = 'main' ORDER BY seq DESC LIMIT 1");
  return starts.flatMap((start, i) => {
    const next = starts[i + 1];
    const last = next ? lastBefore.get(next.seq) : lastOf.get();
    // the segment before the first reset can have no events. every other segment holds at least its reset.
    if (!last) return [];
    const segment: MainSegment = { key: mainKey(start.id), resetEventId: start.id, fromEventId: start.id, toEventId: next ? next.id - 1 : null };
    return [{ key: segment.key, lastAt: String(last.createdAt), stats: () => mainStats(db, segment) }];
  });
}

// the where clause on the session key for a kind. a kind with a prefix reads a range of the index.
function kindClause(kind: ChatKindFilter | undefined): { sql: string; params: Params } {
  const prefix = KIND_PREFIXES.find(([, each]) => each === kind)?.[0];
  if (prefix) {
    const end = prefix.slice(0, -1) + String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1);
    return { sql: 'sessionKey >= $prefix AND sessionKey < $prefixEnd', params: { prefix, prefixEnd: end } };
  }
  if (kind === 'other') {
    const known = KIND_PREFIXES.map(([each]) => `substr(sessionKey, 1, ${each.length}) = '${each}'`).join(' OR ');
    return { sql: `sessionKey != 'main' AND NOT (${known})`, params: {} };
  }
  return { sql: "sessionKey != 'main'", params: {} };
}

// the background sessions after the cursor, newest lastAt first, at most limit of them. the grouped read uses only the
// (sessionKey, seq) index, because each of its rows holds the event id.
function backgroundCandidates(db: Db, kind: ChatKindFilter | undefined, cursor: Cursor | undefined, limit: number): Candidate[] {
  const where = kindClause(kind);
  return db
    .prepare(
      `WITH bg AS (SELECT sessionKey, MAX(id) AS lastId FROM events WHERE ${where.sql} GROUP BY sessionKey)
       SELECT bg.sessionKey, e.createdAt AS lastAt FROM bg JOIN events e ON e.id = bg.lastId
       WHERE $cursorAt IS NULL OR e.createdAt < $cursorAt OR (e.createdAt = $cursorAt AND bg.sessionKey < $cursorKey)
       ORDER BY e.createdAt DESC, bg.sessionKey DESC LIMIT $limit`,
    )
    .all({ ...where.params, cursorAt: cursor?.lastAt ?? null, cursorKey: cursor?.key ?? null, limit })
    .map((row) => {
      const key = String(row.sessionKey);
      // a background chat is every event of its session, so its range starts at event 0.
      const head = () => chatHead(db, chatKindOf(key), key, { sessionKey: key, from: 0, to: null }, null);
      return { key, lastAt: String(row.lastAt), stats: () => backgroundStats(db, key), head };
    });
}

// the chat list: each segment of main and each background session, newest lastAt first, with cursor paging. the sort
// and the cursor are in sql, and the numbers of a chat are read only for the chats that the page looks at. a cursor
// that cannot be read gives undefined, and the route answers 400.
export function listChats(db: Db, input: ChatsInput): ChatsPage | undefined {
  const cursor = input.cursor === undefined ? undefined : decodeCursor(input.cursor);
  if (input.cursor !== undefined && !cursor) return undefined;
  const { kind } = input;
  const q = input.q?.toLowerCase();
  const withMain = kind === undefined || kind === 'main';
  const withBackground = kind !== 'main';
  // without q every background chat is a row, so limit + 1 of them fill the page.
  const take = q ? CHATS_Q_SCAN : input.limit + 1;
  const background = withBackground ? backgroundCandidates(db, kind === 'activity' ? undefined : kind, cursor, take) : [];
  const cut = background.length === take ? background.at(-1) : undefined;
  const after = (each: Cursor) => !cursor || newerFirst(each, cursor) > 0;
  // when the background read was cut, a chat older than its last one may have a background chat before it that the read
  // did not get, so the page stops there.
  const candidates = [...(withMain ? mainCandidates(db).filter(after) : []), ...background]
    .sort(newerFirst)
    .filter((each) => !cut || newerFirst(each, cut) <= 0);
  const rows: ChatRow[] = [];
  let seen: Cursor | undefined;
  for (const each of candidates) {
    if (rows.length > input.limit) break;
    seen = each;
    const head = q && each.head ? each.head() : undefined;
    if (q && head && !headMatches(head, q)) continue;
    const stats = each.stats();
    if (!stats) continue;
    const row = chatRow(db, stats, head);
    if (q && !headMatches(row, q)) continue;
    rows.push(row);
  }
  const chats = rows.slice(0, input.limit);
  const last = chats.at(-1);
  if (rows.length > input.limit && last) return { chats, nextCursor: encodeCursor({ lastAt: last.lastAt, key: last.key }) };
  return { chats, nextCursor: cut && seen ? encodeCursor({ lastAt: seen.lastAt, key: seen.key }) : null };
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
    stats = backgroundStats(db, parsed.sessionKey);
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
