import { notBuilt } from '../dashboard/params.js';

// the text rules of the dashboard search over events_fts (migration 018). the trigram index needs 3 or more
// characters, so a shorter query goes to a like scan instead.

export const TRIGRAM_MIN = 3;

export const searchMode = (q: string): 'fts' | 'like' => ([...q.trim()].length >= TRIGRAM_MIN ? 'fts' : 'like');

// the fts5 match expression for the text of the owner. the whole text is one quoted phrase, so no character of it is
// fts5 syntax: a double quote is doubled, and AND, OR, NOT, NEAR, *, ^, :, (, ) and - lose their meaning.
export function ftsPhrase(_q: string): string {
  return notBuilt('the fts phrase');
}

// the pattern of a like scan with ESCAPE '\'. %, _ and \ in the text match only themselves.
export function likePattern(_q: string): string {
  return notBuilt('the like pattern');
}

export interface Snippet {
  snippet: string;
  marks: Array<[number, number]>;
}

// a short part of the text around the first match, at most width characters, with the [start, end) offsets of each
// case-blind match of q in the snippet.
export function snippetOf(_text: string, _q: string, _width = 160): Snippet {
  return notBuilt('the snippet');
}
