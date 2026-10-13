import { describe, expect, it } from 'vitest';
import { openDb } from '../db/index.js';
import { silentLogger } from '../observability/logger.js';
import { HANDLE_OVER, modelView } from '../tools/results.js';
import { buildSnapshot, createCatalogStore, diffCatalogs, riskFrom, riskOf, type CatalogTool } from './catalog.js';
import { parseIntegrations, type IntegrationEntry } from './config.js';
import { search, type Discoverable } from './discovery.js';
import type { McpTool } from './mcp.js';

const clock = () => new Date('2026-10-13T10:00:00Z');

function entry(allow: string[], risk: Record<string, string> = {}): IntegrationEntry {
  const parsed = parseIntegrations({ integrations: [{ id: 'notes', kind: 'mcp-stdio', command: 'node', args: ['x'], tools: { allow }, risk }] });
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value[0]!;
}

const tool = (name: string, extra: Partial<McpTool> = {}): McpTool => ({ name, inputSchema: { type: 'object' }, ...extra }) as McpTool;

describe('catalog', () => {
  it('keeps only allowed tools, names each one, and says why a tool is missing', () => {
    const snapshot = buildSnapshot(entry(['echo', 'files.read', 'gone', 'bad']), [
      tool('echo', { description: 'x'.repeat(5_000) }),
      tool('files.read'),
      tool('hidden_admin'),
      tool('bad', { inputSchema: { type: 'object', properties: { a: { type: 'string', pattern: '(' } }, $defs: { d: 'x'.repeat(20_000) } } as never }),
    ]);
    expect(snapshot.tools.map((each) => each.mcpName)).toEqual(['echo', 'files.read']);
    expect(snapshot.tools[0]!.description).toHaveLength(1_024);
    expect(snapshot.rejected).toEqual([{ mcpName: 'bad', reason: expect.stringContaining('bytes') }]);
    expect(snapshot.missing).toEqual(['gone']);
    expect(snapshot.hidden).toEqual(['hidden_admin']);
  });

  it('keeps the names of hidden tools out of the version, so a server that changes only those makes no new version', () => {
    const db = openDb(':memory:');
    const store = createCatalogStore({ db, clock, logger: silentLogger, entries: [entry(['a'])] });
    const first = store.update(entry(['a']), [tool('a'), tool('x')]);
    const second = store.update(entry(['a']), [tool('a'), tool('y'), tool('z'.repeat(500))]);
    // the compiled catalog stays too, so a server that changes only hidden tools costs no compile.
    expect(second).toBe(first);
    expect(db.prepare('SELECT count(*) AS n FROM integration_catalogs').get()).toEqual({ n: 1 });
    // the page shows the newest hidden names, each cut to a short length.
    expect(second.hidden).toEqual(['y', 'z'.repeat(100)]);
  });

  it('names the change of each version, and the source of each risk', () => {
    const e = entry(['a', 'b', 'c'], { c: 'read' });
    const before = buildSnapshot(e, [tool('a', { description: 'old' }), tool('b')]).tools;
    const after = buildSnapshot(e, [tool('a', { description: 'new' }), tool('c', { annotations: { readOnlyHint: true } })]).tools;
    expect(diffCatalogs(before, after)).toEqual({ added: ['notes__c'], removed: ['notes__b'], changed: [{ name: 'notes__a', fields: ['description'] }] });
    const hinted = buildSnapshot(entry(['h']), [tool('h', { annotations: { readOnlyHint: true } })]).tools[0]!;
    expect([riskFrom(e, after[1]!), riskFrom(e, before[1]!), riskFrom(entry(['h']), hinted)]).toEqual([
      'okc.integrations.json',
      'default: the server does not say read only',
      'default: the server says read only',
    ]);
  });

  // a server names its tools. a plain risk map read constructor as the Object function, and the policy check failed
  // with no trace row.
  it('gives the default risk to a tool whose name is a key of Object.prototype', () => {
    const names = ['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__'];
    const e = entry(names);
    const tools = buildSnapshot(e, names.map((name) => tool(name))).tools;
    expect(tools).toHaveLength(names.length);
    for (const each of tools) expect([each.mcpName, riskOf(e, each), riskFrom(e, each)]).toEqual([each.mcpName, 'external', 'default: the server does not say read only']);
  });

  it('never trusts a read hint: the config decides, and the default is a review or an approval', () => {
    const e = entry(['a', 'b', 'c'], { c: 'read' });
    const snap = buildSnapshot(e, [tool('a', { annotations: { readOnlyHint: true } }), tool('b'), tool('c')]);
    expect(snap.tools.map((each) => riskOf(e, each))).toEqual(['write', 'external', 'read']);
  });

  it('records a version only when the catalog changed, and hides a stored tool that the config no longer allows', () => {
    const db = openDb(':memory:');
    const store = createCatalogStore({ db, clock, logger: silentLogger, entries: [entry(['a', 'b'])] });
    const first = store.update(entry(['a', 'b']), [tool('a'), tool('b')]);
    // an equal list keeps the compiled catalog, so a server that sends list_changed often costs little.
    expect(store.update(entry(['a', 'b']), [tool('b'), tool('a')])).toBe(first);
    expect(db.prepare('SELECT count(*) AS n FROM integration_catalogs').get()).toEqual({ n: 1 });
    store.update(entry(['a', 'b']), [tool('a')]);
    expect(db.prepare('SELECT count(*) AS n FROM integration_catalogs').get()).toEqual({ n: 2 });

    const restarted = createCatalogStore({ db, clock, logger: silentLogger, entries: [entry(['b'])] });
    expect(restarted.get('notes')).toMatchObject({ stored: true, snapshot: { tools: [] } });
  });

  it('puts a stored catalog through the guard of today, so a schema that an older guard kept cannot hold the app', () => {
    const db = openDb(':memory:');
    const e = entry(['evil', 'loop', 'ok']);
    const store = createCatalogStore({ db, clock, logger: silentLogger, entries: [e] });
    store.update(e, [tool('evil'), tool('loop'), tool('ok')]);
    // an older guard kept a pattern under draft-07 dependencies, and a recursion that comes back over the same input.
    const evil = { type: 'object', properties: { q: { type: 'string' } }, dependencies: { q: { properties: { q: { pattern: '^(a+)+$' } } } } };
    const loop = { type: 'object', properties: { a: { $ref: '#/$defs/a' } }, $defs: { a: { allOf: [{ items: { $ref: '#/$defs/a' } }, { items: { $ref: '#/$defs/a' } }] } } };
    const row = db.prepare('SELECT hash, tools FROM tool_catalog_snapshots').get()!;
    const stored = JSON.parse(String(row.tools)) as { tools: CatalogTool[] };
    for (const each of stored.tools) {
      if (each.mcpName === 'evil') each.inputSchema = evil;
      if (each.mcpName === 'loop') each.inputSchema = loop;
    }
    db.prepare('UPDATE tool_catalog_snapshots SET tools = ? WHERE hash = ?').run(JSON.stringify(stored), String(row.hash));

    const restarted = createCatalogStore({ db, clock, logger: silentLogger, entries: [e] }).get('notes')!;
    expect(restarted.snapshot.tools.map((each) => each.mcpName)).toEqual(['evil', 'ok']);
    expect(restarted.snapshot.rejected).toEqual([{ mcpName: 'loop', reason: expect.stringContaining('exponentially') }]);
    const start = performance.now();
    expect(restarted.validators.get('notes__evil')!({ q: 'a'.repeat(30) + '!' })).toEqual({ ok: true });
    expect(performance.now() - start).toBeLessThan(100);
  });
});

describe('tool_search', () => {
  const big = (i: number): Discoverable => ({
    tool: {
      name: `notes__tool_${i}`,
      integrationId: 'notes',
      mcpName: `tool_${i}`,
      description: `find notes ${'word '.repeat(150)}`,
      inputSchema: { type: 'object', properties: Object.fromEntries(Array.from({ length: 30 }, (_, k) => [`field_${k}`, { type: 'string', description: 'a field' }])) },
      readOnlyHint: false,
    } satisfies CatalogTool,
    risk: 'external',
    untrusted: true,
  });

  it('stays under the handle limit with its wrapper, so the model never gets a cut list', () => {
    const output = search(Array.from({ length: 10 }, (_, i) => big(i)), 'find notes', 10);
    const view = modelView(output);
    expect(view.truncated).toBe(false);
    expect(view.content.length).toBeLessThanOrEqual(HANDLE_OVER);
    expect(view.content).toContain('search for the exact name to see it');
  });

  it('gives the full schema for an exact name', () => {
    const output = search([big(1), big(2)], 'notes__tool_2', 5);
    expect(output.content).toContain('field_29');
    expect(output.content.startsWith('notes__tool_2')).toBe(true);
  });

  it('names the tools when nothing matches, and keeps their text untrusted', () => {
    expect(search([big(1), big(2)], 'calendar', 5)).toEqual({
      content: 'No tool matched "calendar". The tools are: notes__tool_1, notes__tool_2.',
      untrustedSource: 'mcp catalog: notes',
    });
    // a long list stops inside its own limit and counts the rest.
    const many = search(Array.from({ length: 300 }, (_, i) => big(i)), 'calendar', 5).content;
    expect(many.length).toBeLessThan(1_700);
    expect(many).toMatch(/, and \d+ more\.$/);
  });

  it('gives each hit its integration, its risk line and its state, without the dialect of the schema', () => {
    const hit = { ...big(1), tool: { ...big(1).tool, inputSchema: { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object' } } };
    expect(search([hit], 'notes__tool_1', 5).content.split('\n').slice(0, 2)).toEqual([
      'notes__tool_1',
      'integration: notes. risk external: the owner approves each call.',
    ]);
    expect(search([hit], 'notes__tool_1', 5).content).toContain('input schema: {"type":"object"}');
    const paused = { ...big(1), risk: 'read' as const, unavailable: 'the owner paused the notes integration.' };
    expect(search([paused], 'notes__tool_1', 5).content.split('\n')[1]).toBe(
      'integration: notes. risk read: it runs without approval. Not available now: the owner paused the notes integration.',
    );
  });
});
