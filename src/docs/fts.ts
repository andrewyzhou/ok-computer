import type { Db } from '../db/index.js';
import type { DocKind, DocListItem } from '../dashboard/docs-types.js';
import { NotBuilt } from './not-built.js';

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

export function searchDocs(db: Db, input: DocSearchInput): DocSearchResult {
  void db;
  void input;
  throw new NotBuilt('searchDocs');
}
