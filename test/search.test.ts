import { beforeAll, describe, expect, it } from 'vitest';
import { SEARCH_SCOPES } from '../src/dashboard/search.js';
import type { SearchGroup, SearchHit, SearchResults, SearchScope } from '../src/dashboard/types.js';
import { appendEvent } from '../src/events/log.js';
import { CHILD_RUN, CHILD_SESSION, seedM1, TRACE_RUN } from './seed-m1.js';

type Seeded = Awaited<ReturnType<typeof seedM1>>;

let seeded: Seeded;
let harbourEvent: number;

beforeAll(async () => {
  seeded = await seedM1();
  const { t } = seeded;
  t.db
    .prepare(
      `INSERT INTO automations (id, name, schedule, payload, sessionMode, slot, enabled, createdBy, createdAt, updatedAt)
       VALUES ('auto-1', 'morning tide check', '{"kind":"cron","expr":"0 7 * * *"}', '{"prompt":"look at the tide tables"}', 'isolated', 'main', 1, 'owner', ?, ?)`,
    )
    .run(t.clock().toISOString(), t.clock().toISOString());
  harbourEvent = appendEvent(t.db, {
    sessionKey: 'main',
    runId: TRACE_RUN,
    type: 'note',
    payload: { text: 'lots   of\n\n\tspace    before the harbour   and after' },
  }).id;
});

async function find(query: string): Promise<SearchResults> {
  const response = await seeded.dashboard.request(`/api/search?${query}`);
  expect(response.status, query).toBe(200);
  return (await response.json()) as SearchResults;
}

const group = (results: SearchResults, scope: SearchScope): SearchGroup => results.groups.find((g) => g.scope === scope)!;
const marked = (hit: SearchHit) => hit.marks.map(([start, end]) => hit.snippet.slice(start, end));

describe('GET /api/search on the m1 seed', () => {
  it('finds the owner message of the traced run in its main segment', async () => {
    const results = await find('q=coast');
    expect(results.q).toBe('coast');
    expect(results.mode).toBe('fts');
    expect(results.groups.map((g) => g.scope)).toEqual(SEARCH_SCOPES);
    const { hits, more } = group(results, 'messages');
    expect(more).toBe(false);
    expect(hits).toEqual([
      {
        scope: 'messages',
        id: String(seeded.ids.ownerEvent),
        title: 'Owner message',
        snippet: 'plan the trip to the coast',
        marks: [[21, 26]],
        sessionKey: 'main',
        runId: TRACE_RUN,
        chatKey: `main@${seeded.resetEventId}`,
        at: expect.any(String),
        href: `chats/main%40${seeded.resetEventId}`,
      },
    ]);
  });

  it('maps a main message from before the reset to main@0', async () => {
    const { hits } = group(await find('q=gym&scope=messages'), 'messages');
    const owner = hits.find((hit) => hit.title === 'Owner message')!;
    expect(owner.sessionKey).toBe('main');
    expect(Number(owner.id)).toBeLessThan(seeded.resetEventId);
    expect(owner.chatKey).toBe('main@0');
    expect(owner.href).toBe('chats/main%400');
    expect(marked(owner)).toEqual(['gym']);
  });

  it('finds the tool results as tool hits and the child chat under activity', async () => {
    const results = await find('q=ferry');
    const tools = group(results, 'tools');
    const { gmailRow, browserRow, mcpRow, delegateRow } = seeded.ids;
    // newest first by the end of each tool call.
    expect(tools.hits.map((hit) => [hit.id, hit.title])).toEqual([
      [String(delegateRow), 'delegate'],
      [String(browserRow), 'browser_open'],
      [String(mcpRow), 'fs__read'],
      [String(gmailRow), 'gmail_search'],
    ]);
    for (const hit of tools.hits) {
      expect(hit.href).toBe(`runs/${TRACE_RUN}`);
      expect(hit.runId).toBe(TRACE_RUN);
      expect(hit.sessionKey).toBe('main');
      expect(marked(hit)).toEqual(['ferry']);
    }
    const child = group(results, 'messages').hits.filter((hit) => hit.sessionKey === CHILD_SESSION);
    expect(child.map((hit) => hit.title).sort()).toEqual(['Agent reply', 'System event']);
    for (const hit of child) {
      expect(hit.chatKey).toBe(CHILD_SESSION);
      expect(hit.href).toBe(`activity/${encodeURIComponent(CHILD_SESSION)}`);
      expect(hit.runId).toBe(CHILD_RUN);
    }
  });

  it('finds a tool call by its name', async () => {
    const { hits } = group(await find('q=gmail_s&scope=tools'), 'tools');
    expect(hits.map((hit) => hit.id)).toEqual([String(seeded.ids.gmailRow)]);
    expect(marked(hits[0]!)).toEqual(['gmail_s']);
  });

  it('finds runs, automations, memory and approvals', async () => {
    const runs = group(await find('q=trace-1&scope=runs'), 'runs');
    expect(runs.hits.map((hit) => [hit.id, hit.title, hit.href])).toEqual([
      [CHILD_RUN, `Run ${CHILD_RUN}`, `runs/${CHILD_RUN}`],
      [TRACE_RUN, `Run ${TRACE_RUN}`, `runs/${TRACE_RUN}`],
    ]);

    const automations = group(await find('q=tide'), 'automations');
    expect(automations.hits).toMatchObject([{ id: 'auto-1', title: 'morning tide check', href: 'automations', sessionKey: null, runId: null }]);
    expect(marked(automations.hits[0]!)).toEqual(['tide']);
    // the payload matches when the name does not.
    expect(group(await find('q=tables&scope=automations'), 'automations').hits.map((hit) => hit.id)).toEqual(['auto-1']);

    const memory = group(await find('q=essays'), 'memory');
    // the memory index has its own word rules, so other files can match too, but each path gives one hit.
    const paths = memory.hits.map((hit) => hit.id);
    expect(new Set(paths).size).toBe(paths.length);
    const file = memory.hits.find((hit) => hit.id === 'MEMORY.md')!;
    expect(file).toMatchObject({ title: 'memory', href: 'memory?path=MEMORY.md', at: null, chatKey: null, sessionKey: null });
    expect(marked(file)).toEqual(['essays']);

    const approvals = group(await find('q=browser_submit'), 'approvals');
    expect(approvals.hits).toMatchObject([
      { id: String(seeded.ids.approvalId), title: 'browser_submit (pending)', sessionKey: 'main', runId: TRACE_RUN, href: 'approvals' },
    ]);
    expect(marked(approvals.hits[0]!)).toEqual(['browser_submit']);
  });

  it('filters by scope, clamps the limit and sets more', async () => {
    const one = await find('q=the&scope=messages&limit=1');
    expect(one.groups.map((g) => g.scope)).toEqual(['messages']);
    expect(one.groups[0]!.hits).toHaveLength(1);
    expect(one.groups[0]!.more).toBe(true);
    // a limit of 0 is clamped to 1, and a large one to 50.
    expect((await find('q=the&scope=messages&limit=0')).groups[0]!.hits).toHaveLength(1);
    const all = await find('q=the&scope=messages&limit=999');
    expect(all.groups[0]!.hits.length).toBeLessThanOrEqual(50);
    expect(all.groups[0]!.hits.length).toBeGreaterThan(1);
    // the hits are newest first.
    const ats = all.groups[0]!.hits.map((hit) => hit.at!);
    expect([...ats].sort().reverse()).toEqual(ats);
    // with no scope the default is 8 for each scope.
    expect(group(await find('q=the'), 'messages').hits.length).toBeLessThanOrEqual(8);
  });

  it('uses a like scan under 3 characters', async () => {
    const results = await find('q=co&scope=messages&limit=50');
    expect(results.mode).toBe('like');
    const owner = results.groups[0]!.hits.find((hit) => hit.id === String(seeded.ids.ownerEvent))!;
    expect(owner.snippet.slice(...owner.marks.at(-1)!).toLowerCase()).toBe('co');
    expect((await find('q=a')).mode).toBe('like');
  });

  it('gives empty groups when nothing matches', async () => {
    const results = await find('q=zqxjvw');
    expect(results.groups).toEqual(SEARCH_SCOPES.map((scope) => ({ scope, hits: [], more: false })));
  });

  it('collapses repeated whitespace in a snippet', async () => {
    const { hits } = group(await find('q=harbour&scope=messages'), 'messages');
    expect(hits).toHaveLength(1);
    expect(hits[0]!.id).toBe(String(harbourEvent));
    expect(hits[0]!.snippet).toBe('lots of space before the harbour and after');
    expect(marked(hits[0]!)).toEqual(['harbour']);
  });

  it('answers 400 for no q, a long q or an unknown scope', async () => {
    for (const query of ['', 'q=', `q=${encodeURIComponent('   ')}`, `q=${'x'.repeat(201)}`, 'q=coast&scope=nope']) {
      const response = await seeded.dashboard.request(`/api/search?${query}`);
      expect(response.status, query).toBe(400);
      expect(((await response.json()) as { error: string }).error).toBeTruthy();
    }
  });

  it('answers hostile input with 200 and never changes the event log', async () => {
    const events = () => Number(seeded.t.db.prepare('SELECT COUNT(*) AS n FROM events').get()!.n);
    const before = events();
    const hostile = [
      '"',
      'a" OR "b',
      'NEAR(a b)',
      '*',
      '^x',
      'text:foo',
      ')(',
      '-x',
      '%',
      '_',
      '\\',
      'a',
      'ab',
      'abc',
      'x'.repeat(200),
      '🧭',
      'a\u0000b',
      '\u0000\u0000\u0000',
      "'; DROP TABLE events; --",
      'line one\nline two',
      'NOT coast',
      'coast*',
    ];
    for (const q of hostile) {
      const results = await find(`q=${encodeURIComponent(q)}`);
      expect(results.mode, q).toBe([...q.trim()].length >= 3 ? 'fts' : 'like');
      expect(results.groups).toHaveLength(SEARCH_SCOPES.length);
    }
    // a wildcard of like matches only itself: no text of the seed has a % sign.
    expect(group(await find(`q=${encodeURIComponent('%')}`), 'messages').hits).toEqual([]);
    // fts5 syntax is plain text, so NOT coast does not match the coast message.
    expect(group(await find(`q=${encodeURIComponent('NOT coast')}`), 'messages').hits).toEqual([]);
    expect(events()).toBe(before);
  });
});
