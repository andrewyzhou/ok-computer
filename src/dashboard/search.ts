import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Hono } from 'hono';
import type { Db } from '../db/index.js';
import { type SearchHit as MemoryHit, searchMemory, syncMemoryIndex } from '../memory/search.js';
import { ftsPhrase, likePattern, searchMode, snippetOf } from '../search/fts.js';
import { chatKeyOf, chatKindOf } from './chat-keys.js';
import { deliveredTexts } from './chats.js';
import { limitOf } from './params.js';
import type { DashboardDeps } from './server.js';
import type { SearchGroup, SearchHit, SearchResults, SearchScope } from './types.js';

// phase 5 m1 owns this module. it mounts GET /api/search. docs/PHASE5-API.md gives the shapes and the errors.
// server.ts calls it after the sign-in check, so each route is behind the dashboard auth.

// the order of the groups in an answer.
export const SEARCH_SCOPES: readonly SearchScope[] = ['messages', 'runs', 'tools', 'automations', 'memory', 'approvals'];

export interface SearchInput {
  // 1 to 200 characters.
  q: string;
  scope?: SearchScope;
  // the hits per scope, already clamped to 1 to 50.
  limit: number;
  // the memory folder, for searchMemory.
  memoryDir: string;
  now: Date;
}

type Row = Record<string, unknown>;
type Mode = 'fts' | 'like';

const MESSAGE_TITLES: Record<string, string> = {
  user_message: 'Owner message',
  assistant_message: 'Agent reply',
  note: 'Note',
  system_event: 'System event',
};

const str = (value: unknown) => (value === null || value === undefined ? null : String(value));

// newest first, and the larger id first at the same time, in the order of ORDER BY createdAt DESC, id DESC.
function newestFirst(a: { at: string; id: number }, b: { at: string; id: number }): number {
  if (a.at !== b.at) return a.at < b.at ? 1 : -1;
  return b.id - a.id;
}

// the where clause on the text of events_fts. fts mode matches the escaped phrase on the trigram index, and like mode
// scans the text, because the index has no trigram in a text of fewer than 3 characters.
function textClause(mode: Mode, q: string): { sql: string; param: string } {
  // fts5 names the match column after the table, so the queries do not give events_fts an alias.
  if (mode === 'fts') return { sql: 'events_fts MATCH ?', param: ftsPhrase(q) };
  return { sql: "events_fts.text LIKE ? ESCAPE '\\'", param: likePattern(q) };
}

interface Context {
  db: Db;
  q: string;
  mode: Mode;
  pattern: string;
  // the rows to fetch: one more than the limit, so the group knows when it has more.
  take: number;
  memoryDir: string;
  now: Date;
}

function hit(scope: SearchScope, q: string, text: string, fields: Omit<SearchHit, 'scope' | 'snippet' | 'marks'>): SearchHit {
  return { scope, ...fields, ...snippetOf(text, q) };
}

// a message hit shows the text that its chat got: a NO_REPLY answer, the draft of a tool turn and a reply that the guard
// held are left out, and a reply that the guard changed shows its changed text. a hit whose match is only in a part
// that the chat did not get is left out too. so the rows are read in batches until the group is full.
const MESSAGE_BATCH = 100;
const MESSAGE_SCAN = 2_000;

function messageHits({ db, q, mode, take }: Context): SearchHit[] {
  const where = textClause(mode, q);
  const read = db.prepare(
    `SELECT rowid AS id, sessionKey, runId, type, createdAt FROM events_fts
     WHERE ${where.sql} AND type IN ('user_message', 'assistant_message', 'note', 'system_event')
     ORDER BY createdAt DESC, rowid DESC LIMIT ? OFFSET ?`,
  );
  const needle = q.replace(/\s+/g, ' ').toLowerCase();
  const hits: SearchHit[] = [];
  for (let offset = 0; hits.length < take && offset < MESSAGE_SCAN; offset += MESSAGE_BATCH) {
    const rows = read.all(where.param, MESSAGE_BATCH, offset);
    const texts = deliveredTexts(db, rows.map((row) => Number(row.id)));
    for (const row of rows) {
      const text = texts.get(Number(row.id));
      if (text === undefined || !text.replace(/\s+/g, ' ').toLowerCase().includes(needle)) continue;
      const sessionKey = String(row.sessionKey);
      const chatKey = chatKeyOf(db, sessionKey, Number(row.id));
      const route = chatKindOf(sessionKey) === 'main' ? 'chats' : 'activity';
      hits.push(
        hit('messages', q, text, {
          id: String(row.id),
          title: MESSAGE_TITLES[String(row.type)] ?? String(row.type),
          sessionKey,
          runId: str(row.runId),
          chatKey,
          at: str(row.createdAt),
          href: `${route}/${encodeURIComponent(chatKey)}`,
        }),
      );
      if (hits.length >= take) break;
    }
    if (rows.length < MESSAGE_BATCH) break;
  }
  return hits;
}

function runHits({ db, q, pattern, take }: Context): SearchHit[] {
  return db
    .prepare(
      `SELECT id, sessionKey, startedAt, error, error LIKE ?1 ESCAPE '\\' AS errorHit FROM runs
       WHERE id LIKE ?1 ESCAPE '\\' OR sessionKey LIKE ?1 ESCAPE '\\' OR trigger LIKE ?1 ESCAPE '\\' OR error LIKE ?1 ESCAPE '\\'
       ORDER BY startedAt DESC, id DESC LIMIT ?2`,
    )
    .all(pattern, take)
    .map((row) =>
      hit('runs', q, Number(row.errorHit) === 1 ? String(row.error) : String(row.sessionKey), {
        id: String(row.id),
        title: `Run ${String(row.id)}`,
        sessionKey: String(row.sessionKey),
        runId: String(row.id),
        chatKey: null,
        at: str(row.startedAt),
        href: `runs/${String(row.id)}`,
      }),
    );
}

function toolHits({ db, q, mode, pattern, take }: Context): SearchHit[] {
  const where = textClause(mode, q);
  // a tool result names its call, and the newest tool_calls row of that call in the run is the hit. a result with no
  // row is left out.
  const results = db
    .prepare(
      `SELECT tc.id, tc.name, tc.runId, tc.createdAt, events_fts.text, r.sessionKey FROM events_fts
       JOIN events e ON e.id = events_fts.rowid
       JOIN tool_calls tc ON tc.id = (
         SELECT id FROM tool_calls WHERE runId = events_fts.runId AND toolCallId = json_extract(e.payload, '$.toolCallId')
         ORDER BY createdAt DESC, id DESC LIMIT 1
       )
       LEFT JOIN runs r ON r.id = tc.runId
       WHERE ${where.sql} AND events_fts.type = 'tool_result'
       ORDER BY tc.createdAt DESC, tc.id DESC LIMIT ?`,
    )
    .all(where.param, take);
  const names = db
    .prepare(
      `SELECT tc.id, tc.name, tc.runId, tc.createdAt, tc.name AS text, r.sessionKey FROM tool_calls tc
       LEFT JOIN runs r ON r.id = tc.runId
       WHERE tc.name LIKE ? ESCAPE '\\' ORDER BY tc.createdAt DESC, tc.id DESC LIMIT ?`,
    )
    .all(pattern, take);
  // a row found by its result and by its name is one hit, and the result gives the better snippet.
  const rows = new Map<number, Row>();
  for (const row of [...results, ...names]) if (!rows.has(Number(row.id))) rows.set(Number(row.id), row);
  return [...rows.values()]
    .map((row) => ({ row, at: String(row.createdAt), id: Number(row.id) }))
    .sort(newestFirst)
    .map(({ row }) =>
      hit('tools', q, String(row.text), {
        id: String(row.id),
        title: String(row.name),
        sessionKey: str(row.sessionKey),
        runId: String(row.runId),
        chatKey: null,
        at: str(row.createdAt),
        href: `runs/${String(row.runId)}`,
      }),
    );
}

function automationHits({ db, q, pattern, take }: Context): SearchHit[] {
  return db
    .prepare(
      `SELECT id, name, payload, updatedAt, name LIKE ?1 ESCAPE '\\' AS nameHit FROM automations
       WHERE name LIKE ?1 ESCAPE '\\' OR payload LIKE ?1 ESCAPE '\\'
       ORDER BY updatedAt DESC, id DESC LIMIT ?2`,
    )
    .all(pattern, take)
    .map((row) =>
      hit('automations', q, Number(row.nameHit) === 1 ? String(row.name) : String(row.payload), {
        id: String(row.id),
        title: String(row.name),
        sessionKey: null,
        runId: null,
        chatKey: null,
        at: str(row.updatedAt),
        href: 'automations',
      }),
    );
}

// the memory files have their own word index, so this scope ignores the mode.
const MEMORY_SCAN = 5_000;

function memoryHits({ db, q, take, memoryDir, now }: Context): SearchHit[] {
  if (!existsSync(memoryDir)) return [];
  syncMemoryIndex(db, memoryDir, now);
  // the chunks come best first, so the first chunk of each path is its best. one file can hold many of the best chunks,
  // so the read grows until it has take paths or no more chunks.
  const best = new Map<string, MemoryHit>();
  for (let size = take * 4; ; size *= 4) {
    const chunks = searchMemory(db, q, size);
    best.clear();
    for (const chunk of chunks) {
      if (best.size >= take) break;
      if (!best.has(chunk.path)) best.set(chunk.path, chunk);
    }
    if (best.size >= take || chunks.length < size || size >= MEMORY_SCAN) break;
  }
  return [...best.values()].map((chunk) =>
    hit('memory', q, chunk.text, {
      id: chunk.path,
      title: chunk.heading || chunk.path,
      sessionKey: null,
      runId: null,
      chatKey: null,
      at: null,
      href: `memory?path=${encodeURIComponent(chunk.path)}`,
    }),
  );
}

function approvalHits({ db, q, pattern, take }: Context): SearchHit[] {
  return db
    .prepare(
      `SELECT a.id, a.runId, a.toolName, a.summary, a.status, a.requestedAt, r.sessionKey FROM approvals a
       JOIN runs r ON r.id = a.runId
       WHERE a.summary LIKE ?1 ESCAPE '\\' OR a.toolName LIKE ?1 ESCAPE '\\'
       ORDER BY a.requestedAt DESC, a.id DESC LIMIT ?2`,
    )
    .all(pattern, take)
    .map((row) =>
      hit('approvals', q, String(row.summary), {
        id: String(row.id),
        title: `${String(row.toolName)} (${String(row.status)})`,
        sessionKey: str(row.sessionKey),
        runId: str(row.runId),
        chatKey: null,
        at: str(row.requestedAt),
        href: 'approvals',
      }),
    );
}

const SCOPE_HITS: Record<SearchScope, (context: Context) => SearchHit[]> = {
  messages: messageHits,
  runs: runHits,
  tools: toolHits,
  automations: automationHits,
  memory: memoryHits,
  approvals: approvalHits,
};

// each scope reads at most limit + 1 rows, and the group drops the extra row and sets more. the text of the owner
// reaches sql only as a bound parameter: an escaped fts5 phrase, or a like pattern with its wildcards escaped.
export function search(db: Db, input: SearchInput): SearchResults {
  const q = input.q.trim();
  const mode = searchMode(q);
  const context: Context = { db, q, mode, pattern: likePattern(q), take: input.limit + 1, memoryDir: input.memoryDir, now: input.now };
  const scopes = input.scope ? [input.scope] : SEARCH_SCOPES;
  const groups: SearchGroup[] = scopes.map((scope) => {
    const hits = SCOPE_HITS[scope](context);
    return { scope, hits: hits.slice(0, input.limit), more: hits.length > input.limit };
  });
  return { q: input.q, mode, groups };
}

export function mountSearch(server: Hono, deps: DashboardDeps): void {
  const { db, config, clock } = deps;
  const memoryDir = join(config.paths.data, 'memory');
  server.get('/api/search', (c) => {
    // sqlite ends a bound text at a nul character, so each nul is dropped once here, before the checks and the mode.
    const q = (c.req.query('q') ?? '').replaceAll('\u0000', '');
    if (!q.trim() || q.length > 200) return c.json({ error: 'give q as 1 to 200 characters' }, 400);
    const scope = c.req.query('scope') as SearchScope | undefined;
    if (scope !== undefined && !SEARCH_SCOPES.includes(scope)) return c.json({ error: `give scope as one of ${SEARCH_SCOPES.join(', ')}` }, 400);
    const limit = limitOf(c.req.query('limit'), 50, scope ? 30 : 8);
    return c.json(search(db, { q, ...(scope ? { scope } : {}), limit, memoryDir, now: clock() }));
  });
}
