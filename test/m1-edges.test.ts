import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { migrate } from '../src/db/index.js';
import { createDashboard } from '../src/dashboard/server.js';
import { runSpans } from '../src/dashboard/spans.js';
import { createTraceFeed } from '../src/dashboard/stream.js';
import type { ChatMessagesPage, ChatsPage, LogLine, RunRow, RunSpans, SearchResults } from '../src/dashboard/types.js';
import { appendEvent } from '../src/events/log.js';
import { silentLogger } from '../src/observability/logger.js';
import { REPLY_CALL_ID, REPLY_NOTE, REPLY_TOOL } from '../src/policy/reply.js';
import { NO_REPLY } from '../src/sessions/router.js';
import { at, NOW, seedM1, TRACE_RUN } from './seed-m1.js';
import { seedDashboard } from './seed.js';

// the edges of the m1 endpoints: keys and params that are not valid, paging under filters, the auth of each new route,
// and the rows that the seed does not have.

const messagesPath = (key: string, query = '') => `/api/chats/${encodeURIComponent(key)}/messages${query}`;

async function json<T>(response: Response | Promise<Response>): Promise<T> {
  return (await (await response).json()) as T;
}

describe('the chat keys and params that are not valid', () => {
  it('answers 404 for a key that names no chat', async () => {
    const { dashboard, ids } = await seedM1();
    const keys = ['main', 'main@', 'main@-1', 'main@01', 'main@1e3', 'main@x', 'nosuch:session', `main@${ids.ownerEvent}`];
    for (const key of keys) {
      const response = await dashboard.request(messagesPath(key));
      expect(response.status, key).toBe(404);
      expect(await response.json()).toEqual({ error: 'chat not found' });
    }
  });

  it('clamps the limit of the messages and answers 400 for a before that is not an id', async () => {
    const { dashboard, resetEventId } = await seedM1();
    const key = `main@${resetEventId}`;
    for (const [query, count] of [
      ['?limit=0', 1],
      ['?limit=-4', 1],
      ['?limit=1.9', 1],
    ] as const) {
      const response = await dashboard.request(messagesPath(key, query));
      expect(response.status, query).toBe(200);
      expect(((await response.json()) as ChatMessagesPage).messages, query).toHaveLength(count);
    }
    expect((await dashboard.request(messagesPath(key, '?limit=abc'))).status).toBe(200);
    for (const query of ['?before=0', '?before=-1', '?before=abc', '?before=1.5']) {
      const response = await dashboard.request(messagesPath(key, query));
      expect(response.status, query).toBe(400);
      expect(((await response.json()) as { error: string }).error).toBeTruthy();
    }
  });

  it('keeps each segment of main to its own events, oldest first', async () => {
    const { dashboard, resetEventId } = await seedM1();
    const first = await json<ChatMessagesPage>(dashboard.request(messagesPath('main@0', '?limit=200')));
    expect(first.messages.length).toBeGreaterThan(0);
    expect(first.messages.every((message) => message.id < resetEventId)).toBe(true);
    const second = await json<ChatMessagesPage>(dashboard.request(messagesPath(`main@${resetEventId}`, '?limit=200')));
    expect(second.messages.every((message) => message.id >= resetEventId)).toBe(true);
    const ids = second.messages.map((message) => message.id);
    expect([...ids].sort((a, b) => a - b)).toEqual(ids);
  });

  it('clamps the limit of the list and answers 400 for each cursor that it cannot read', async () => {
    const { dashboard } = await seedM1();
    for (const query of ['limit=0', 'limit=-1', 'limit=abc', 'limit=9999']) expect((await dashboard.request(`/api/chats?${query}`)).status, query).toBe(200);
    expect((await json<ChatsPage>(dashboard.request('/api/chats?limit=0'))).chats).toHaveLength(1);
    const cursors = ['%%%', 'null', ...['null', '[]', '"x"', '{}'].map((text) => Buffer.from(text).toString('base64url'))];
    for (const cursor of cursors) expect((await dashboard.request(`/api/chats?cursor=${encodeURIComponent(cursor)}`)).status, cursor).toBe(400);
  });

  it('opens a background chat whose key has a slash in it', async () => {
    const { t, dashboard } = await seedM1();
    appendEvent(t.db, { sessionKey: 'poll:a/b', runId: null, type: 'note', payload: { text: 'a note of the poll' } });
    const page = await json<ChatMessagesPage>(dashboard.request(messagesPath('poll:a/b')));
    expect(page.chat).toMatchObject({ key: 'poll:a/b', kind: 'poll' });
    expect(page.messages.map((message) => message.text)).toEqual(['a note of the poll']);
  });

  it('pages the q filter with a cursor, with no duplicates and no gaps', async () => {
    const { dashboard } = await seedM1();
    const all = (await json<ChatsPage>(dashboard.request('/api/chats?q=e'))).chats.map((chat) => chat.key);
    expect(all.length).toBeGreaterThan(1);
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page: ChatsPage = await json<ChatsPage>(dashboard.request(`/api/chats?q=e&limit=1${cursor ? `&cursor=${cursor}` : ''}`));
      seen.push(...page.chats.map((chat) => chat.key));
      cursor = page.nextCursor;
    } while (cursor && seen.length < 50);
    expect(seen).toEqual(all);
  });
});

describe('the search edges', () => {
  it('gives the default for a limit that is not a number', async () => {
    const { dashboard } = await seedM1();
    for (const query of ['limit=abc', 'limit=-3', 'limit=1e9', 'limit=']) {
      const response = await dashboard.request(`/api/search?q=the&${query}`);
      expect(response.status, query).toBe(200);
      const results = (await response.json()) as SearchResults;
      for (const group of results.groups) expect(group.hits.length, query).toBeLessThanOrEqual(50);
    }
  });

  it('gives one tool hit for a call with two results, and still sets more', async () => {
    const { t, dashboard, ids } = await seedM1();
    const result = (toolCallId: string, name: string, content: string) =>
      appendEvent(t.db, { sessionKey: 'main', runId: TRACE_RUN, type: 'tool_result', payload: { toolCallId, name, content, isError: false } });
    result('tc-gmail', 'gmail_search', 'quokka one');
    result('tc-gmail', 'gmail_search', 'quokka two');
    result('tc-mcp', 'fs__read', 'quokka three');
    const all = await json<SearchResults>(dashboard.request('/api/search?q=quokka&scope=tools'));
    expect(all.groups[0]!.hits.map((hit) => hit.id).sort()).toEqual([String(ids.gmailRow), String(ids.mcpRow)].sort());
    const one = await json<SearchResults>(dashboard.request('/api/search?q=quokka&scope=tools&limit=1'));
    expect(one.groups[0]!.hits).toHaveLength(1);
    expect(one.groups[0]!.more).toBe(true);
  });
});

describe('the spans edges', () => {
  it('reads a run id that needs url encoding', async () => {
    const { t, dashboard } = await seedM1();
    const id = 'a b?c#d';
    t.db.prepare("INSERT INTO runs (id, sessionKey, trigger, slot, status, startedAt) VALUES (?, 'main', 'message', 'main', 'running', ?)").run(id, at(0));
    const result = await json<RunSpans>(dashboard.request(`/api/runs/${encodeURIComponent(id)}/spans`));
    expect(result).toMatchObject({ runId: id, endedAt: null, durationMs: null, costUsd: null });
    expect(result.spans.map((span) => [span.id, span.endMs])).toEqual([[`run:${id}`, null]]);
  });

  it('counts the cost of the child run once in the total', async () => {
    const { t } = await seedM1();
    const result = runSpans(t.db, TRACE_RUN)!;
    const priced = result.spans.filter((span) => span.kind === 'model' || span.kind === 'review');
    const sum = priced.reduce((total, span) => total + (span.costUsd ?? 0), 0);
    expect(result.costUsd).toBeCloseTo(sum, 10);
  });
});

describe('the runs filters together', () => {
  it('pages one session with before, and ignores an empty before', async () => {
    const { dashboard } = await seedDashboard();
    const all = await json<RunRow[]>(dashboard.request('/api/runs?sessionKey=main'));
    expect(all.length).toBeGreaterThan(1);
    const rest = await json<RunRow[]>(dashboard.request(`/api/runs?sessionKey=main&before=${all[0]!.id}`));
    expect(rest.map((run) => run.id)).toEqual(all.slice(1).map((run) => run.id));
    expect((await dashboard.request('/api/runs?before=')).status).toBe(200);
  });

  it('answers 400 for an empty day of the logs and reads a day that has no file', async () => {
    const { dashboard } = await seedDashboard();
    expect((await dashboard.request('/api/logs?day=')).status).toBe(400);
    expect(await json<unknown[]>(dashboard.request('/api/logs?day=2020-01-01'))).toEqual([]);
  });
});

describe('the auth of the m1 routes', () => {
  it('answers 401 without the token and 200 with it', async () => {
    const { t } = await seedM1();
    const dashboard = createDashboard({
      db: t.db,
      config: t.config,
      clock: () => new Date(NOW),
      logger: silentLogger,
      app: t.app,
      webDir: join(t.dataDir, 'no-web'),
      token: 'test-token',
    });
    const paths = [
      '/api/chats',
      messagesPath('main@0'),
      '/api/search?q=coast',
      `/api/runs/${TRACE_RUN}/spans`,
      '/api/browser/live',
      '/api/runs?sessionKey=main',
      '/api/logs?runId=x',
    ];
    for (const path of paths) {
      const refused = await dashboard.request(path);
      expect(refused.status, path).toBe(401);
      expect(await refused.json()).toEqual({ error: 'unauthorized' });
      expect((await dashboard.request(path, { headers: { authorization: 'Bearer test-token' } })).status, path).toBe(200);
      const separator = path.includes('?') ? '&' : '?';
      expect((await dashboard.request(`${path}${separator}token=test-token`)).status, path).toBe(200);
    }
  });
});

describe('the trace feed edges', () => {
  it('sends a model call with no run, and never its request or response', async () => {
    const { t } = await seedM1();
    const feed = createTraceFeed(t.db);
    t.db
      .prepare(
        `INSERT INTO model_calls (runId, slot, provider, model, inputTokens, outputTokens, costUsd, latencyMs, stopReason, request, response, createdAt)
         VALUES (NULL, 'utility', 'fake', 'm', 1, 1, NULL, 10, 'end_turn', '{"words":"inside the request"}', '{"words":"inside the response"}', ?)`,
      )
      .run(at(1));
    const messages = feed();
    expect(messages).toMatchObject([{ kind: 'model_call', call: { runId: null, slot: 'utility', costUsd: null, latencyMs: 10 } }]);
    expect(JSON.stringify(messages)).not.toContain('inside the');
    expect(feed()).toEqual([]);
  });
});

describe('migration 018 on payloads of other shapes', () => {
  it('indexes a text that is not a string and a tool result whose content is a list', () => {
    const real = join(import.meta.dirname, '..', 'src', 'db', 'migrations');
    const dir = mkdtempSync(join(tmpdir(), 'okc-migrations-'));
    for (const file of readdirSync(real).filter((name) => name.endsWith('.sql') && name < '018')) writeFileSync(join(dir, file), readFileSync(join(real, file), 'utf8'));
    const db = new DatabaseSync(':memory:');
    migrate(db, dir);
    db.exec(`INSERT INTO events (sessionKey, runId, seq, type, payload, createdAt) VALUES
      ('main', NULL, 1, 'note', '{"text":42}', 't1'),
      ('main', NULL, 2, 'tool_result', '{"toolCallId":"c","name":"n","content":[{"type":"text","text":"blocky"}],"isError":false}', 't2')`);
    migrate(db, real);
    expect(db.prepare('SELECT rowid FROM events_fts WHERE events_fts MATCH ? ORDER BY rowid').all('"blocky"')).toHaveLength(1);
    expect(db.prepare('SELECT COUNT(*) AS n FROM events_fts').get()).toEqual({ n: 2 });
  });
});

const turn = (text: string, toolCalls: Array<{ id: string; name: string; input: Record<string, unknown> }> = []) => ({
  provider: 'fake',
  model: 'm',
  content: [{ type: 'text' as const, text }, ...toolCalls.map((call) => ({ type: 'tool_use' as const, ...call }))],
  text,
  toolCalls,
  stopReason: toolCalls.length ? ('tool_use' as const) : ('end_turn' as const),
});

describe('the search edges after the review', () => {
  it('finds no message hit in a link that the guard held, or in NO_REPLY', async () => {
    const { dashboard } = await seedM1();
    const held = await json<SearchResults>(dashboard.request('/api/search?q=owner-notes&scope=messages'));
    expect(held.groups[0]!.hits.filter((hit) => hit.snippet.includes('owner-notes'))).toEqual([]);
    const silent = await json<SearchResults>(dashboard.request(`/api/search?q=${NO_REPLY}&scope=messages`));
    expect(silent.groups[0]!.hits).toEqual([]);
  });

  it('shows the delivered text of a reply that got only a short notice, and finds no draft of a tool turn', async () => {
    const { t, dashboard } = await seedM1();
    t.db.prepare("INSERT INTO runs (id, sessionKey, trigger, slot, status, startedAt) VALUES ('held-run', 'main', 'message', 'main', 'completed', ?)").run(at(30_000));
    appendEvent(t.db, { sessionKey: 'main', runId: 'held-run', type: 'assistant_message', payload: turn('draft https://d.example/?d=zzqqdraft', [{ id: 'tc-x', name: 'now', input: {} }]) });
    appendEvent(t.db, { sessionKey: 'main', runId: 'held-run', type: 'assistant_message', payload: turn('secret https://evil.example/?d=zzqqxx') });
    t.db
      .prepare(
        `INSERT INTO policy_decisions (runId, toolCallId, toolName, decision, rule, reason, reviewerVerdict, createdAt)
         VALUES ('held-run', ?, ?, 'review', 'exfiltration', 'seeded', 'hold', ?)`,
      )
      .run(REPLY_CALL_ID, REPLY_TOOL, at(31_000));
    appendEvent(t.db, { sessionKey: 'main', runId: 'held-run', type: 'note', payload: { text: `${REPLY_NOTE}: the review failed, so the chat got only a short notice in its place.` } });
    for (const q of ['zzqqxx', 'zzqqdraft']) {
      const results = await json<SearchResults>(dashboard.request(`/api/search?q=${q}&scope=messages`));
      expect(results.groups[0]!.hits, q).toEqual([]);
    }
  });

  it('answers 400 for a q of nul characters and counts the mode without them', async () => {
    const { dashboard } = await seedM1();
    for (const q of ['\u0000', '\u0000\u0000\u0000', ' \u0000 ']) {
      expect((await dashboard.request(`/api/search?q=${encodeURIComponent(q)}`)).status, JSON.stringify(q)).toBe(400);
    }
    const short = await json<SearchResults>(dashboard.request(`/api/search?q=${encodeURIComponent('co\u0000')}&scope=messages`));
    const plain = await json<SearchResults>(dashboard.request('/api/search?q=co&scope=messages'));
    expect(short.mode).toBe('like');
    expect(plain.groups[0]!.hits.length).toBeGreaterThan(0);
    expect(short.groups[0]!.hits.map((hit) => hit.id)).toEqual(plain.groups[0]!.hits.map((hit) => hit.id));
  });

  it('fills the limit with paths and sets more when another path matches', async () => {
    const { t, dashboard } = await seedM1();
    const dir = join(t.dataDir, 'memory');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'aaa.md'), '# one\n\nzephyr zephyr zephyr zephyr\n\n# two\n\nzephyr zephyr zephyr zephyr\n\n# three\n\nzephyr zephyr zephyr\n');
    writeFileSync(join(dir, 'bbb.md'), '# b\n\nthe long note about many things and also zephyr once among the other words of it\n');
    const one = await json<SearchResults>(dashboard.request('/api/search?q=zephyr&scope=memory&limit=1'));
    expect(one.groups[0]!.hits).toHaveLength(1);
    expect(one.groups[0]!.more).toBe(true);
    const two = await json<SearchResults>(dashboard.request('/api/search?q=zephyr&scope=memory&limit=2'));
    expect(two.groups[0]!.hits.map((hit) => hit.id).sort()).toEqual(['aaa.md', 'bbb.md']);
    expect(two.groups[0]!.more).toBe(false);
  });
});

describe('the logs and runs edges after the review', () => {
  it('answers 400 for a day that is not a date of the calendar', async () => {
    const { dashboard } = await seedDashboard();
    for (const day of ['2026-13-01', '9999-99-99', '2026-00-10', '2026-02-30', '2026-13-45']) {
      for (const path of [`/api/logs?day=${day}`, `/api/runs?day=${day}`]) {
        const response = await dashboard.request(path);
        expect(response.status, path).toBe(400);
        expect(((await response.json()) as { error: string }).error).toBeTruthy();
      }
    }
    expect((await dashboard.request('/api/logs?day=2028-02-29')).status).toBe(200);
  });

  it('clamps a negative limit to 1', async () => {
    const { dashboard } = await seedDashboard();
    const all = await json<LogLine[]>(dashboard.request('/api/logs'));
    expect(all.length).toBeGreaterThan(2);
    const one = await json<LogLine[]>(dashboard.request('/api/logs?limit=-1'));
    expect(one).toEqual(all.slice(-1));
  });
});

describe('the dashboard errors', () => {
  it('answers a route that throws with 500 and a json error', async () => {
    const { t, dashboard } = await seedM1();
    t.db.prepare("INSERT INTO runs (id, sessionKey, trigger, slot, status, startedAt) VALUES ('broken-run', 'main', 'message', 'main', 'running', ?)").run(at(0));
    t.db.prepare("INSERT INTO mcp_messages (runId, serverId, direction, rpcId, method, payload, createdAt) VALUES ('broken-run', 's', 'out', 1, 'tools/call', 'not json', ?)").run(at(1));
    const response = await dashboard.request('/api/runs/broken-run/spans');
    expect(response.status).toBe(500);
    expect(((await response.json()) as { error: string }).error).toBeTruthy();
  });
});
