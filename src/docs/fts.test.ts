import { describe, expect, it } from 'vitest';
import { seedDocs } from '../../test/docs-seed.js';
import type { DocKind, DocListItem } from '../dashboard/docs-types.js';
import { openDb, type Db } from '../db/index.js';
import { searchDocs } from './fts.js';
import { addVersion, createDoc } from './store.js';

const base = new Date('2026-10-12T12:00:00Z');
const minutes = (n: number) => new Date(base.getTime() + n * 60_000);

function add(db: Db, title: string, body: string, kind: DocKind = 'notes', when = base): number {
  const result = createDoc(db, { title, kind, body, author: 'agent' }, when);
  if (!result.ok) throw new Error(result.error);
  return result.value.id;
}

const ids = (docs: DocListItem[]) => docs.map((each) => each.id);
// the text under each mark, so a test can see that the marks fit the snippet.
const marked = (hit: DocListItem) => hit.marks.map(([start, end]) => hit.snippet!.slice(start, end));

describe('searchDocs on the seed', () => {
  it('finds a part of a word without case in fts mode, with a snippet and marks', () => {
    const db = openDb(':memory:');
    const { tripId } = seedDocs(db);
    const result = searchDocs(db, { q: 'LISBONpublic', limit: 10 });
    expect(result.mode).toBe('fts');
    expect(ids(result.docs)).toEqual([tripId]);
    const hit = result.docs[0]!;
    expect(hit).toMatchObject({ title: 'Trip plan: Lisbon', kind: 'plan', version: 3, comments: 2 });
    expect(hit.snippet!.length).toBeLessThanOrEqual(160);
    expect(marked(hit)).toEqual(['Lisbonpublic']);

    const part = searchDocs(db, { q: 'lis', limit: 10 });
    expect(part.mode).toBe('fts');
    expect(ids(part.docs)).toContain(tripId);
    expect(marked(part.docs.find((each) => each.id === tripId)!)[0]!.toLowerCase()).toBe('lis');
  });

  it('filters by kind and stops at the limit, newest first', () => {
    const db = openDb(':memory:');
    const { tripId, danaId, briefId, notesId, laptopsId } = seedDocs(db);
    // every seed body starts with a heading.
    expect(ids(searchDocs(db, { q: '# ', limit: 10 }).docs)).toEqual([tripId, danaId, briefId, notesId, laptopsId]);
    expect(ids(searchDocs(db, { q: '# ', limit: 2 }).docs)).toEqual([tripId, danaId]);
    expect(ids(searchDocs(db, { q: '# ', kind: 'comparison', limit: 10 }).docs)).toEqual([laptopsId]);
    expect(searchDocs(db, { q: 'Lisbon', kind: 'brief', limit: 10 }).docs).toEqual([]);
  });

  it('marks a tainted doc in a hit', () => {
    const db = openDb(':memory:');
    const { laptopsId } = seedDocs(db);
    const hit = searchDocs(db, { q: 'Air 13', limit: 10 }).docs;
    expect(hit.map((each) => [each.id, each.tainted])).toEqual([[laptopsId, true]]);
  });
});

describe('searchDocs', () => {
  it('uses a like scan for 1 and 2 characters, without case for ascii letters', () => {
    const db = openDb(':memory:');
    const a = add(db, 'One', 'Ox and cart');
    add(db, 'Two', 'nothing here');
    expect(searchDocs(db, { q: 'x', limit: 10 })).toMatchObject({ mode: 'like', docs: [{ id: a }] });
    const two = searchDocs(db, { q: 'OX', limit: 10 });
    expect(two.mode).toBe('like');
    expect(ids(two.docs)).toEqual([a]);
    expect(marked(two.docs[0]!)).toEqual(['Ox']);
  });

  it('reads quotes and fts5 operators as plain text', () => {
    const db = openDb(':memory:');
    const tricky = add(db, 'Tricky', 'say "hi" AND (x OR y) NEAR* ^a -b c:d');
    add(db, 'Plain', 'hi and x or y near a b c d');
    for (const q of ['"hi"', 'AND (x OR', 'NEAR*', '^a -b', 'c:d', '(x', 'y)', '"', '-b']) {
      expect(ids(searchDocs(db, { q, limit: 10 }).docs), q).toEqual([tricky]);
    }
    // a word of fts5 syntax alone is a plain word too, so it finds both docs without case.
    expect(searchDocs(db, { q: 'NEAR', limit: 10 }).docs).toHaveLength(2);
    expect(searchDocs(db, { q: 'OR', limit: 10 }).docs).toHaveLength(2);
    expect(searchDocs(db, { q: 'NOT', limit: 10 }).docs).toEqual([]);
    expect(ids(searchDocs(db, { q: '*', limit: 10 }).docs)).toEqual([tricky]);
  });

  it('matches % and _ only as themselves in a like scan', () => {
    const db = openDb(':memory:');
    const percent = add(db, 'P', 'up 5% today');
    const under = add(db, 'U', 'snake_case');
    add(db, 'N', 'nothing special ab');
    expect(ids(searchDocs(db, { q: '%', limit: 10 }).docs)).toEqual([percent]);
    expect(ids(searchDocs(db, { q: '_', limit: 10 }).docs)).toEqual([under]);
    expect(ids(searchDocs(db, { q: 'e_', limit: 10 }).docs)).toEqual([under]);
    expect(searchDocs(db, { q: 'a%', limit: 10 }).docs).toEqual([]);
    expect(searchDocs(db, { q: '\\', limit: 10 }).docs).toEqual([]);
  });

  it('finds text that is not ascii', () => {
    const db = openDb(':memory:');
    const cafe = add(db, 'Café', 'Le café est bon');
    const tokyo = add(db, 'Tokyo', '東京都庁 は高い');
    const party = add(db, 'Party', 'party 🎉🎉🎉 time');
    expect(searchDocs(db, { q: 'é', limit: 10 })).toMatchObject({ mode: 'like' });
    expect(ids(searchDocs(db, { q: 'é', limit: 10 }).docs)).toEqual([cafe]);
    const folded = searchDocs(db, { q: 'CAFÉ', limit: 10 });
    expect(folded.mode).toBe('fts');
    expect(ids(folded.docs)).toEqual([cafe]);
    expect(marked(folded.docs[0]!)).toEqual(['café']);
    expect(ids(searchDocs(db, { q: '東京都', limit: 10 }).docs)).toEqual([tokyo]);
    // one emoji is two utf-16 units but one character, so it is a like scan, and three are a trigram.
    expect(searchDocs(db, { q: '🎉', limit: 10 })).toMatchObject({ mode: 'like', docs: [{ id: party }] });
    const three = searchDocs(db, { q: '🎉🎉🎉', limit: 10 });
    expect(three.mode).toBe('fts');
    expect(marked(three.docs[0]!)).toEqual(['🎉🎉🎉']);
  });

  it('searches only the newest version', () => {
    const db = openDb(':memory:');
    const id = add(db, 'Draft', 'alpha version text');
    expect(addVersion(db, id, { author: 'agent', body: 'beta version text', title: 'Final' }, minutes(1)).ok).toBe(true);
    expect(searchDocs(db, { q: 'alpha', limit: 10 }).docs).toEqual([]);
    expect(searchDocs(db, { q: 'Draft', limit: 10 }).docs).toEqual([]);
    expect(searchDocs(db, { q: 'ph', limit: 10 }).docs).toEqual([]);
    expect(searchDocs(db, { q: 'beta', limit: 10 }).docs).toMatchObject([{ id, version: 2, title: 'Final' }]);
    expect(ids(searchDocs(db, { q: 'Fi', limit: 10 }).docs)).toEqual([id]);
  });

  it('gives a title-only hit the start of its body with no marks, and an empty snippet for a blank body', () => {
    const db = openDb(':memory:');
    const long = add(db, 'Packing list', `${'word '.repeat(100)}end`);
    const blank = add(db, 'Packing blank', '  \n\t ');
    const hits = searchDocs(db, { q: 'packing', limit: 10 }).docs;
    expect(ids(hits)).toEqual([blank, long]);
    expect(hits[0]).toMatchObject({ snippet: '', marks: [] });
    expect(hits[1]!.snippet!.startsWith('word word')).toBe(true);
    expect(hits[1]!.snippet!.endsWith('…')).toBe(true);
    expect(hits[1]!.marks).toEqual([]);
  });

  it('orders equal times by the higher id, and newer times first', () => {
    const db = openDb(':memory:');
    const first = add(db, 'A', 'same text');
    const second = add(db, 'B', 'same text');
    const older = add(db, 'C', 'same text', 'notes', minutes(-5));
    const newer = add(db, 'D', 'same text', 'notes', minutes(5));
    for (let round = 0; round < 3; round++) {
      expect(ids(searchDocs(db, { q: 'same', limit: 10 }).docs)).toEqual([newer, second, first, older]);
      expect(ids(searchDocs(db, { q: 'sa', limit: 10 }).docs)).toEqual([newer, second, first, older]);
    }
  });

  it('drops nul characters, trims the query, and answers an empty one with nothing', () => {
    const db = openDb(':memory:');
    const id = add(db, 'Trip', 'Lisbon in November');
    expect(ids(searchDocs(db, { q: '  Lis\u0000bon  ', limit: 10 }).docs)).toEqual([id]);
    expect(searchDocs(db, { q: '', limit: 10 })).toEqual({ mode: 'like', docs: [] });
    expect(searchDocs(db, { q: ' \u0000 ', limit: 10 })).toEqual({ mode: 'like', docs: [] });
    // 'L' and a nul are one character, so it is a like scan.
    expect(searchDocs(db, { q: 'L\u0000', limit: 10 }).mode).toBe('like');
  });

  it('takes a query of 200 characters', () => {
    const db = openDb(':memory:');
    const body = 'abcdefghij'.repeat(30);
    const id = add(db, 'Long', body);
    expect(ids(searchDocs(db, { q: body.slice(5, 205), limit: 10 }).docs)).toEqual([id]);
    expect(searchDocs(db, { q: 'z'.repeat(200), limit: 10 })).toEqual({ mode: 'fts', docs: [] });
    expect(searchDocs(db, { q: '"'.repeat(200), limit: 10 }).docs).toEqual([]);
  });
});
