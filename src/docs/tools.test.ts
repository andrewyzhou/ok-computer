import { beforeEach, describe, expect, it, vi } from 'vitest';
import { seedDocs, TRIP_V3 } from '../../test/docs-seed.js';
import { runTool } from '../../test/run-tool.js';
import type { DocListItem } from '../dashboard/docs-types.js';
import { openDb, type Db } from '../db/index.js';
import { appendEvent } from '../events/log.js';
import { createToolRegistry, type ToolContext } from '../tools/registry.js';
import { splitLines } from './diff.js';
import { searchDocs } from './fts.js';
import { addVersion, getDoc, getVersion, listDocs, listVersions, versionTaint } from './store.js';
import { createDocTools, DOC_TOOLS, LIST_TAINT_SOURCE } from './tools.js';

// another package builds the search. the tests here check only how doc_search uses it.
vi.mock('./fts.js', () => ({ searchDocs: vi.fn() }));
const search = vi.mocked(searchDocs);

const now = new Date('2026-10-13T16:00:00Z');
const ctx = (sessionKey = 'main'): ToolContext => ({
  runId: 'run-9',
  sessionKey,
  timeZone: 'America/Los_Angeles',
  clock: () => now,
  signal: new AbortController().signal,
  toolCallId: 'call-1',
});

let db: Db;
const setup = (dashboardUrl = 'http://127.0.0.1:4318') => {
  const registry = createToolRegistry(createDocTools({ db, dashboardUrl }));
  return (name: string, input: unknown, context = ctx()) => runTool(registry, { id: 'call-1', name, input }, DOC_TOOLS, context);
};

// a web_fetch result of the session, as the tool caller writes it.
function taintSession(sessionKey: string, source = 'web_fetch: https://evil.example/page') {
  appendEvent(db, { sessionKey, runId: 'run-1', type: 'tool_result', payload: { toolCallId: 'fetch-1', name: 'web_fetch', content: 'x', isError: false, untrustedSource: source } }, now);
}

const item = (id: number, overrides: Partial<DocListItem> = {}): DocListItem => ({
  ...getDoc(db, id)!,
  snippet: null,
  marks: [],
  ...overrides,
});

beforeEach(() => {
  db = openDb(':memory:');
  search.mockReset();
});

describe('doc_write', () => {
  it('saves version 1 with the ids of the call and gives the link', async () => {
    const call = setup();
    const out = await call('doc_write', { title: 'Trip plan', kind: 'plan', body: '# Trip\n\nday one', links: [{ label: 'source', href: 'https://a.example' }], note: 'first draft' });
    expect(out).toEqual({ content: 'Saved doc #1 "Trip plan" (version 1). Give the owner this link: http://127.0.0.1:4318/#/docs/1' });
    expect(getDoc(db, 1)).toMatchObject({ title: 'Trip plan', kind: 'plan', author: 'agent', version: 1, sessionKey: 'main', tainted: false });
    expect(getVersion(db, 1, 1)).toMatchObject({ runId: 'run-9', toolCallId: 'call-1', note: 'first draft', links: [{ label: 'source', href: 'https://a.example' }] });
  });

  it('strips one trailing slash of the dashboard url and uses other as the default kind', async () => {
    const out = await setup('https://okc.example.com/')('doc_write', { title: 'Notes', body: 'text' });
    expect(out.content).toBe('Saved doc #1 "Notes" (version 1). Give the owner this link: https://okc.example.com/#/docs/1');
    expect(getDoc(db, 1)!.kind).toBe('other');
  });

  it('keeps the taint of a tainted session on the version', async () => {
    taintSession('main');
    await setup()('doc_write', { title: 'Laptops', body: 'the pick' });
    expect(getDoc(db, 1)!.tainted).toBe(true);
    expect(versionTaint(db, 1, 1).map((each) => each.source)).toEqual(['web_fetch: https://evil.example/page']);
  });

  it('checks the limits of the store in its schema', async () => {
    const call = setup();
    const bad = [
      { title: '', body: 'x' },
      { title: 'x'.repeat(201), body: 'x' },
      { title: 'a', body: '' },
      { title: 'a', body: 'x'.repeat(200_001) },
      { title: 'a', body: 'x', kind: 'essay' },
      { title: 'a', body: 'x', note: 'n'.repeat(501) },
      { title: 'a', body: 'x', links: Array.from({ length: 21 }, (_, i) => ({ label: `l${i}`, href: 'https://a.example' })) },
      { title: 'a', body: 'x', links: [{ label: '', href: 'https://a.example' }] },
      { title: 'a', body: 'x', links: [{ label: 'l', href: `https://a.example/${'p'.repeat(2_000)}` }] },
    ];
    for (const input of bad) expect((await call('doc_write', input)).content).toMatch(/^invalid input for doc_write/);
    expect((await call('doc_write', { title: 't'.repeat(200), body: 'x'.repeat(200_000) })).isError).toBeUndefined();
    expect(listDocs(db, { limit: 10 }).docs).toHaveLength(1);
  });

  it('gives the error of the store with effect none and writes nothing', async () => {
    const out = await setup()('doc_write', { title: 'a', body: 'x', links: [{ label: 'bad', href: 'javascript:alert(1)' }] });
    expect(out).toEqual({ content: 'the link javascript:alert(1) is not an http(s) url or a #/ link of the dashboard', isError: true, effect: 'none' });
    expect(getDoc(db, 1)).toBeUndefined();
  });
});

describe('doc_update', () => {
  it('adds a version on the base version and gives the link with the new number', async () => {
    const { tripId } = seedDocs(db);
    const out = await setup()('doc_update', { id: tripId, baseVersion: 3, title: 'Trip plan: Lisbon and Porto', note: 'added Porto' });
    expect(out.content).toBe(`Saved doc #${tripId} "Trip plan: Lisbon and Porto" (version 4). Give the owner this link: http://127.0.0.1:4318/#/docs/${tripId}`);
    expect(getVersion(db, tripId, 4)).toMatchObject({ body: TRIP_V3, note: 'added Porto', author: 'agent', runId: 'run-9', toolCallId: 'call-1' });
  });

  it('refuses a stale base version, a missing doc and an empty change with effect none', async () => {
    const { tripId } = seedDocs(db);
    const call = setup();
    expect(await call('doc_update', { id: tripId, baseVersion: 2, body: 'new', note: 'n' })).toEqual({
      content: `doc #${tripId} is at version 3, not 2. Read it again before you change it`,
      isError: true,
      effect: 'none',
    });
    expect(await call('doc_update', { id: 99, baseVersion: 1, body: 'new', note: 'n' })).toEqual({ content: 'doc #99 not found', isError: true, effect: 'none' });
    expect(await call('doc_update', { id: tripId, baseVersion: 3, body: TRIP_V3, note: 'n' })).toEqual({
      content: `the change gives doc #${tripId} no new title, kind, body or links`,
      isError: true,
      effect: 'none',
    });
    expect(listVersions(db, tripId)).toHaveLength(3);
  });

  it('needs a base version and a note of 1 to 500 characters', async () => {
    const { tripId } = seedDocs(db);
    const call = setup();
    for (const input of [
      { id: tripId, body: 'new', note: 'n' },
      { id: tripId, baseVersion: 3, body: 'new' },
      { id: tripId, baseVersion: 3, body: 'new', note: '' },
      { id: tripId, baseVersion: 3, body: 'new', note: 'n'.repeat(501) },
      { id: 0, baseVersion: 3, body: 'new', note: 'n' },
      { id: tripId, baseVersion: 0, body: 'new', note: 'n' },
    ]) {
      expect((await call('doc_update', input)).content).toMatch(/^invalid input for doc_update/);
    }
  });

  it('adds the taint of the session to the new version', async () => {
    const { danaId } = seedDocs(db);
    taintSession('main');
    await setup()('doc_update', { id: danaId, baseVersion: 1, body: 'new prep', note: 'n' });
    expect(versionTaint(db, danaId, 2).map((each) => each.source)).toEqual(['web_fetch: https://evil.example/page']);
  });
});

describe('doc_read', () => {
  it('gives the header in local time, the links, the lines and the comments', async () => {
    const { tripId } = seedDocs(db);
    const out = await setup()('doc_read', { id: tripId, lines: 3 });
    const lines = out.content.split('\n');
    expect(lines[0]).toBe(`#${tripId} "Trip plan: Lisbon" [plan], version 3 of 3, updated Monday, October 12, 2026 at 17:45 PDT`);
    expect(lines.slice(1, 4)).toEqual(['links:', '- The run that wrote it: #/runs/run-1', '- Hotel booking page: https://hotel.example.com/alfama']);
    const total = TRIP_V3.split('\n').length;
    expect(lines.slice(4, 9)).toEqual([`lines 1-3 of ${total}:`, '# Trip plan: Lisbon', '', TRIP_V3.split('\n')[2], 'more: fromLine 4']);
    expect(lines.slice(9)).toEqual([
      "the owner's comments (newest 2):",
      '#1 on version 2: Can we find a hotel closer to the old town?',
      '#2 on version 3 (on the text "Free cancellation until November 10."): Set a reminder for November 9 so I can still cancel.',
    ]);
    expect(out.untrustedSource).toBeUndefined();
  });

  it('reads an older version from a line, and ends without a more line', async () => {
    const { tripId } = seedDocs(db);
    const body = splitLines(getVersion(db, tripId, 1)!.body);
    const out = await setup()('doc_read', { id: tripId, version: 1, fromLine: body.length - 1 });
    expect(out.content).toContain(`version 1 of 3, updated Saturday, October 10, 2026 at 09:00 PDT`);
    expect(out.content).toContain(`lines ${body.length - 1}-${body.length} of ${body.length}:\n${body.at(-2)}\n${body.at(-1)}\nthe owner's comments`);
    expect(out.content).not.toContain('more: fromLine');
  });

  it('shows only the newest 20 comments', async () => {
    const { danaId } = seedDocs(db);
    const insert = db.prepare("INSERT INTO doc_comments (docId, version, quote, text, author, sessionKey, createdAt) VALUES (?, 1, NULL, ?, 'owner', 'main', ?)");
    for (let i = 1; i <= 25; i++) insert.run(danaId, `comment ${i}`, now.toISOString());
    const out = await setup()('doc_read', { id: danaId });
    expect(out.content).toContain("the owner's comments (newest 20):");
    expect(out.content).not.toMatch(/: comment 5$/m);
    expect(out.content).toMatch(/: comment 6$/m);
    expect(out.content).toMatch(/: comment 25$/m);
  });

  it('marks a tainted version as untrusted with a source that stays the same on a second read', async () => {
    const { laptopsId } = seedDocs(db);
    const call = setup();
    const first = await call('doc_read', { id: laptopsId });
    const second = await call('doc_read', { id: laptopsId, fromLine: 2 });
    expect(first.untrustedSource).toBe(`doc #${laptopsId} version 1, written after reading web_fetch: https://reviews.example.com/laptops`);
    expect(second.untrustedSource).toBe(first.untrustedSource);
  });

  it('gives an error for a missing doc or version, and checks its limits', async () => {
    const { tripId } = seedDocs(db);
    const call = setup();
    expect(await call('doc_read', { id: 99 })).toEqual({ content: 'doc #99 not found', isError: true });
    expect(await call('doc_read', { id: tripId, version: 7 })).toEqual({ content: `doc #${tripId} has no version 7; its newest version is 3`, isError: true });
    expect((await call('doc_read', { id: tripId, lines: 1_001 })).content).toMatch(/^invalid input for doc_read/);
    expect((await call('doc_read', { id: tripId, lines: 1_000 })).isError).toBeUndefined();
    expect((await call('doc_read', { id: tripId, fromLine: 5_000 })).content).toContain('no lines from line 5000; the body has');
  });
});

describe('doc_list', () => {
  it('lists the docs newest first in local time and marks the titles of tainted docs', async () => {
    const { tripId, laptopsId, danaId, briefId, notesId } = seedDocs(db);
    const out = await setup()('doc_list', {});
    expect(out.content.split('\n')).toEqual([
      `#${tripId} [plan] Trip plan: Lisbon - v3, updated Monday, October 12, 2026 at 17:45 PDT, 2 comments`,
      `#${danaId} [meeting_prep] Prep: 1:1 with Dana - v1, updated Monday, October 12, 2026 at 08:00 PDT, 0 comments`,
      `#${briefId} [brief] Morning brief, October 12 - v1, updated Monday, October 12, 2026 at 07:30 PDT, 0 comments`,
      `#${notesId} [notes] Notes on the essay - v1, updated Sunday, October 11, 2026 at 20:00 PDT, 0 comments`,
      `#${laptopsId} [comparison] Laptop comparison - v1, updated Sunday, October 11, 2026 at 11:05 PDT, 0 comments`,
    ]);
    expect(out.untrustedSource).toBe(LIST_TAINT_SOURCE);
  });

  it('filters by kind, pages with the cursor and refuses a bad cursor', async () => {
    const { tripId, danaId } = seedDocs(db);
    const call = setup();
    const first = await call('doc_list', { limit: 1 });
    const cursor = /more: cursor (\S+)$/.exec(first.content)?.[1];
    expect(first.content).toMatch(new RegExp(`^#${tripId} `));
    expect(first.untrustedSource).toBeUndefined();
    const second = await call('doc_list', { limit: 1, cursor });
    expect(second.content).toMatch(new RegExp(`^#${danaId} `));
    expect((await call('doc_list', { kind: 'plan' })).content).not.toContain('more:');
    expect((await call('doc_list', { kind: 'other' })).content).toBe('no docs of kind other');
    expect(await call('doc_list', { cursor: 'nope' })).toEqual({ content: 'give cursor as the nextCursor of the last page', isError: true });
    expect((await call('doc_list', { limit: 51 })).content).toMatch(/^invalid input for doc_list/);
  });

  it('says so when there are no docs', async () => {
    expect((await setup()('doc_list', {})).content).toBe('no docs yet');
  });
});

describe('doc_search', () => {
  it('gives one line for each hit with its snippet, and marks tainted hits', async () => {
    const { tripId, laptopsId } = seedDocs(db);
    search.mockReturnValue({
      mode: 'fts',
      docs: [item(tripId, { snippet: 'The hotel moved to Alfama' }), item(laptopsId, { snippet: 'the Air 13' })],
    });
    const out = await setup()('doc_search', { query: 'hotel', kind: 'plan', limit: 3 });
    expect(search).toHaveBeenCalledWith(db, { q: 'hotel', kind: 'plan', limit: 3 });
    expect(out.content).toBe(`#${tripId} [plan] Trip plan: Lisbon - v3: The hotel moved to Alfama\n#${laptopsId} [comparison] Laptop comparison - v1: the Air 13`);
    expect(out.untrustedSource).toBe(LIST_TAINT_SOURCE);
  });

  it('says so when no doc matches, with the default limit', async () => {
    search.mockReturnValue({ mode: 'like', docs: [] });
    const out = await setup()('doc_search', { query: 'zz' });
    expect(search).toHaveBeenCalledWith(db, { q: 'zz', limit: 8 });
    expect(out).toEqual({ content: 'no doc matches "zz"' });
  });

  it('checks its limits', async () => {
    const call = setup();
    for (const input of [{ query: '' }, { query: 'q'.repeat(201) }, { query: 'a', limit: 21 }, { query: 'a', kind: 'essay' }]) {
      expect((await call('doc_search', input)).content).toMatch(/^invalid input for doc_search/);
    }
    expect(search).not.toHaveBeenCalled();
  });
});

describe('the doc tools', () => {
  it('are five, with read risk for the readers and write risk for the writers', () => {
    const tools = createDocTools({ db, dashboardUrl: 'http://x' });
    expect(Object.fromEntries(tools.map((tool) => [tool.name, tool.risk]))).toEqual({
      doc_write: 'write',
      doc_update: 'write',
      doc_read: 'read',
      doc_list: 'read',
      doc_search: 'read',
    });
    expect(tools.map((tool) => tool.name).sort()).toEqual([...DOC_TOOLS].sort());
  });

  it('keep a version of the store and a version of the tool in step', async () => {
    const { danaId } = seedDocs(db);
    expect(addVersion(db, danaId, { author: 'owner', body: 'owner text' }, now)).toMatchObject({ ok: true });
    expect((await setup()('doc_read', { id: danaId })).content).toContain('version 2 of 2');
  });
});
