import { describe, expect, it } from 'vitest';
import { openDb } from '../db/index.js';
import { appendEvent } from '../events/log.js';
import { ftsPhrase, likePattern, searchMode, snippetOf } from './fts.js';

// the text that an owner can type into the search box and that must never reach fts5 or like as syntax.
const HOSTILE = [
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
  'AND',
  'NOT x',
  'a OR b',
  '""""',
  '   ',
];

describe('ftsPhrase', () => {
  it('makes one quoted phrase and doubles each quote', () => {
    expect(ftsPhrase('coast')).toBe('"coast"');
    expect(ftsPhrase('  a" OR "b ')).toBe('"a"" OR ""b"');
    expect(ftsPhrase('"')).toBe('""""');
    expect(ftsPhrase('NEAR(a b)')).toBe('"NEAR(a b)"');
    // sqlite would end the bound text at a nul, so the nul is dropped.
    expect(ftsPhrase('a\u0000b')).toBe('"ab"');
    expect(likePattern('a\u0000b')).toBe('%ab%');
  });
});

describe('likePattern', () => {
  it('escapes the wildcards and the escape character', () => {
    expect(likePattern('co')).toBe('%co%');
    expect(likePattern('%')).toBe('%\\%%');
    expect(likePattern('_')).toBe('%\\_%');
    expect(likePattern('\\')).toBe('%\\\\%');
    expect(likePattern('50%_off\\')).toBe('%50\\%\\_off\\\\%');
  });
});

describe('searchMode', () => {
  it('uses like under 3 code points and fts from 3', () => {
    expect(searchMode('a')).toBe('like');
    expect(searchMode(' ab ')).toBe('like');
    expect(searchMode('abc')).toBe('fts');
    // one emoji is two utf-16 units but one code point.
    expect(searchMode('🧭🧭')).toBe('like');
  });
});

describe('snippetOf', () => {
  it('marks every case-blind match in a short text', () => {
    expect(snippetOf('Coast and coast', 'COAST')).toEqual({ snippet: 'Coast and coast', marks: [[0, 5], [10, 15]] });
  });

  it('collapses runs of whitespace before it finds the match', () => {
    const { snippet, marks } = snippetOf('plan   the\n\n\ttrip  to the coast', 'the coast');
    expect(snippet).toBe('plan the trip to the coast');
    expect(marks).toEqual([[17, 26]]);
    expect(snippet.slice(17, 26)).toBe('the coast');
  });

  it('centres a long text on the match and counts the leading ellipsis', () => {
    const text = `${'a'.repeat(300)} needle ${'b'.repeat(300)}`;
    const { snippet, marks } = snippetOf(text, 'needle', 40);
    expect(snippet.length).toBeLessThanOrEqual(40);
    expect(snippet.startsWith('…')).toBe(true);
    expect(snippet.endsWith('…')).toBe(true);
    expect(marks).toHaveLength(1);
    const [start, end] = marks[0]!;
    expect(snippet.slice(start, end)).toBe('needle');
    // the match is near the middle.
    expect(Math.abs(start - (40 - 6) / 2)).toBeLessThanOrEqual(2);
  });

  it('cuts only the end when the match is near the start', () => {
    const { snippet, marks } = snippetOf(`needle ${'b'.repeat(300)}`, 'needle', 20);
    expect(snippet).toBe(`needle ${'b'.repeat(12)}…`);
    expect(marks).toEqual([[0, 6]]);
  });

  it('cuts only the start when the match is near the end', () => {
    const { snippet, marks } = snippetOf(`${'a'.repeat(300)} needle`, 'needle', 20);
    expect(snippet).toBe(`…${'a'.repeat(12)} needle`);
    expect(snippet.slice(...marks[0]!)).toBe('needle');
  });

  it('gives the start of the text and no marks when nothing matches', () => {
    expect(snippetOf('short text', 'zzz')).toEqual({ snippet: 'short text', marks: [] });
    const long = snippetOf('x'.repeat(500), 'zzz', 30);
    expect(long.snippet).toBe(`${'x'.repeat(29)}…`);
    expect(long.marks).toEqual([]);
  });

  it('searches the original text when the fold would change its length', () => {
    // the lower case of İ is two utf-16 units, so the folded offsets would not fit.
    const { snippet, marks } = snippetOf('İstanbul trip', 'trip');
    expect(snippet.slice(...marks[0]!)).toBe('trip');
  });

  it('does not split an emoji at a cut', () => {
    const text = `${'🧭'.repeat(100)} needle ${'🧭'.repeat(100)}`;
    const { snippet, marks } = snippetOf(text, 'needle', 41);
    expect(snippet.slice(...marks[0]!)).toBe('needle');
    expect(snippet.length).toBeLessThanOrEqual(41);
    expect(snippet).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/);
  });

  it('never throws on hostile input', () => {
    for (const q of HOSTILE) {
      const { snippet, marks } = snippetOf(`some text with ${q} inside`, q);
      for (const [start, end] of marks) {
        expect(start).toBeGreaterThanOrEqual(0);
        expect(end).toBeLessThanOrEqual(snippet.length);
        expect(start).toBeLessThan(end);
      }
    }
  });
});

describe('the hostile input against a real events_fts table', () => {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO runs (id, sessionKey, trigger, slot, status, startedAt) VALUES ('r', 'main', 'message', 'main', 'completed', 'x')").run();
  const texts = [
    'plan the trip to the coast',
    'a" OR "b and NEAR(a b) and text:foo',
    '50% off_today \\ back',
    "'; DROP TABLE events; --",
    'the compass 🧭 points north',
  ];
  for (const text of texts) appendEvent(db, { sessionKey: 'main', runId: 'r', type: 'note', payload: { text } });
  const count = (sql: string, param: string) => Number(db.prepare(sql).get(param)!.n);
  const matchCount = (q: string) => count('SELECT COUNT(*) AS n FROM events_fts WHERE events_fts MATCH ?', ftsPhrase(q));
  const likeCount = (q: string) => count("SELECT COUNT(*) AS n FROM events_fts WHERE text LIKE ? ESCAPE '\\'", likePattern(q));

  it('runs every hostile input through MATCH and LIKE without an error', () => {
    for (const q of HOSTILE) {
      expect(() => matchCount(q), q).not.toThrow();
      expect(() => likeCount(q), q).not.toThrow();
    }
    expect(Number(db.prepare('SELECT COUNT(*) AS n FROM events').get()!.n)).toBe(texts.length);
  });

  it('matches the syntax characters as plain text', () => {
    expect(matchCount('a" OR "b')).toBe(1);
    expect(matchCount('NEAR(a b)')).toBe(1);
    expect(matchCount('text:foo')).toBe(1);
    expect(matchCount('DROP TABLE')).toBe(1);
    expect(matchCount('COAST')).toBe(1);
    expect(matchCount('nothing here')).toBe(0);
  });

  it('matches the like wildcards only as themselves', () => {
    expect(likeCount('%')).toBe(1);
    expect(likeCount('_')).toBe(1);
    expect(likeCount('\\')).toBe(1);
    expect(likeCount('f_')).toBe(1);
    expect(likeCount('%x')).toBe(0);
    expect(likeCount('🧭')).toBe(1);
  });
});
