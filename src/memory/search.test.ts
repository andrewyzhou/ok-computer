import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDb } from '../db/index.js';
import { createToolRegistry } from '../tools/registry.js';
import { chunkMarkdown, resolveMemoryPath, searchMemory, syncMemoryIndex, toMatchQuery } from './search.js';
import { createMemoryTools } from './tools.js';

const NOW = new Date('2026-10-13T03:15:00Z');

function setup() {
  const memoryDir = mkdtempSync(join(tmpdir(), 'okc-search-'));
  mkdirSync(join(memoryDir, 'daily'));
  mkdirSync(join(memoryDir, 'history'));
  const db = openDb(':memory:');
  const registry = createToolRegistry(createMemoryTools({ db, memoryDir }));
  const call = (name: string, input: unknown) =>
    registry.run({ id: 't', name, input }, ['memory_search', 'memory_get'], {
      runId: 'r',
      sessionKey: 'main',
      timeZone: 'UTC',
      clock: () => NOW,
      signal: new AbortController().signal,
    });
  return { memoryDir, db, call };
}

describe('memory chunks', () => {
  it('splits by heading and keeps the heading path and the line numbers', () => {
    const chunks = chunkMarkdown('# 2026-10-12\n\n## notes\n\nfirst line\nsecond line\n\nnext paragraph\n\n## mood and energy\n\ntired');
    expect(chunks).toEqual([
      { heading: '2026-10-12 > notes', text: 'first line\nsecond line\n\nnext paragraph', startLine: 5, endLine: 8 },
      { heading: '2026-10-12 > mood and energy', text: 'tired', startLine: 12, endLine: 12 },
    ]);
  });

  it('starts a new chunk when a heading gets too long', () => {
    const paragraph = 'word '.repeat(200).trim();
    const chunks = chunkMarkdown(`## notes\n\n${paragraph}\n\n${paragraph}\n\n${paragraph}`);
    expect(chunks.map((c) => [c.startLine, c.endLine])).toEqual([
      [3, 3],
      [5, 5],
      [7, 7],
    ]);
    expect(chunkMarkdown(`## notes\n\none\n\ntwo`)).toHaveLength(1);
  });

  it('quotes each word of a query', () => {
    expect(toMatchQuery('gym "streak" OR c++ NEAR(')).toBe('"gym" OR "streak" OR "OR" OR "c" OR "NEAR"');
    expect(toMatchQuery('?!')).toBeUndefined();
  });

  it('keeps paths inside the memory folder', () => {
    expect(resolveMemoryPath('/m', 'daily/a.md')).toBeDefined();
    expect(resolveMemoryPath('/m', '../secrets.md')).toBeUndefined();
    expect(resolveMemoryPath('/m', '/etc/passwd')).toBeUndefined();
  });
});

describe('memory index', () => {
  it('finds passages, follows file changes and leaves out the history folder', () => {
    const { memoryDir, db } = setup();
    const note = join(memoryDir, 'daily', '2026-10-12.md');
    writeFileSync(note, '# 2026-10-12\n\n## notes\n\nThe owner switched gyms to Fitness Plus.\n');
    writeFileSync(join(memoryDir, 'MEMORY.md'), '# memory\n\nThe owner is vegetarian.\n');
    writeFileSync(join(memoryDir, 'history', 'MEMORY.md.bak-2026-10-11'), 'The owner switched gyms long ago.');
    syncMemoryIndex(db, memoryDir, NOW);
    expect(searchMemory(db, 'gyms', 5).map((hit) => hit.path)).toEqual(['daily/2026-10-12.md']);
    expect(searchMemory(db, 'vegetarian food', 5).map((hit) => hit.path)).toEqual(['MEMORY.md']);

    writeFileSync(note, '# 2026-10-12\n\n## notes\n\nThe owner started climbing.\n');
    rmSync(join(memoryDir, 'MEMORY.md'));
    syncMemoryIndex(db, memoryDir, NOW);
    expect(searchMemory(db, 'gyms', 5)).toEqual([]);
    expect(searchMemory(db, 'climb', 5)).toHaveLength(1);
    expect(searchMemory(db, 'vegetarian', 5)).toEqual([]);
  });

  it('answers through memory_search and memory_get', async () => {
    const { memoryDir, call } = setup();
    writeFileSync(join(memoryDir, 'daily', '2026-10-12.md'), '# 2026-10-12\n\n## notes\n\nDentist on 2026-10-20 at 09:30.\n');
    const found = await call('memory_search', { query: 'dentist' });
    expect(found.content).toBe('daily/2026-10-12.md lines 5-5 (2026-10-12 > notes):\nDentist on 2026-10-20 at 09:30.');
    expect((await call('memory_search', { query: 'unicorn' })).content).toBe('no memory matches "unicorn"');

    const got = await call('memory_get', { path: 'daily/2026-10-12.md', fromLine: 3, lines: 3 });
    expect(got.content).toBe('daily/2026-10-12.md lines 3-5 of 6:\n## notes\n\nDentist on 2026-10-20 at 09:30.');
    expect((await call('memory_get', { path: '../okc.sqlite' })).isError).toBe(true);
    expect((await call('memory_get', { path: 'weekly/none.md' })).isError).toBe(true);
  });
});
