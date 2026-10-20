import type { Db } from '../db/index.js';
import type { DocKind, DocListItem } from '../dashboard/docs-types.js';
import { ftsPhrase, likePattern, searchMode, snippetOf } from '../search/fts.js';
import { summariesWithBody } from './store.js';

// the search over the newest version of each doc, through docs_fts (022_docs.sql). it follows the text rules of the
// dashboard search in src/search/fts.ts: 3 or more characters use the trigram index with the input as one quoted
// phrase (ftsPhrase), and a shorter query is a like scan over the title and the body (likePattern). each hit has a
// snippet of its body with the marks of the matches (snippetOf). hits are newest updatedAt first.

export interface DocSearchInput {
  q: string;
  kind?: DocKind;
  limit: number;
}

export interface DocSearchResult {
  mode: 'fts' | 'like';
  docs: DocListItem[];
}

export const SNIPPET_CHARS = 160;

// the trigger of docs_fts keeps one row for each doc, with the text of its newest version, so a match there is a match
// in the newest version. the like scan reads the newest version through v, so an old version never gives a hit there
// either. sqlite compares ascii letters without case in a like scan, and the trigram index folds the case of every
// letter.
const FTS_WHERE = 'd.id IN (SELECT rowid FROM docs_fts WHERE docs_fts MATCH $match)';
const LIKE_WHERE = "(v.title LIKE $pattern ESCAPE '\\' OR v.body LIKE $pattern ESCAPE '\\')";
const KIND_WHERE = ' AND ($kind IS NULL OR d.kind = $kind)';

export function searchDocs(db: Db, input: DocSearchInput): DocSearchResult {
  const q = input.q.replaceAll('\u0000', '').trim();
  // the route refuses an empty query before it gets here. this guard keeps a match of everything out of the store.
  if (!q) return { mode: 'like', docs: [] };
  const mode = searchMode(q);
  const kind = input.kind ?? null;
  const rows =
    mode === 'fts'
      ? summariesWithBody(db, FTS_WHERE + KIND_WHERE, { match: ftsPhrase(q), kind }, input.limit)
      : summariesWithBody(db, LIKE_WHERE + KIND_WHERE, { pattern: likePattern(q), kind }, input.limit);
  // a hit in the title alone finds no match in the body, so its snippet is the start of the body with no marks.
  const docs = rows.map(({ summary, body }): DocListItem => ({ ...summary, ...snippetOf(body, q, SNIPPET_CHARS) }));
  return { mode, docs };
}
