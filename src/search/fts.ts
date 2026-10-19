// the text rules of the dashboard search over events_fts (migration 018). the trigram index needs 3 or more
// characters, so a shorter query goes to a like scan instead.

export const TRIGRAM_MIN = 3;

export const searchMode = (q: string): 'fts' | 'like' => ([...q.trim()].length >= TRIGRAM_MIN ? 'fts' : 'like');

const withoutNul = (q: string) => q.replaceAll('\u0000', '');

// the fts5 match expression for the text of the owner. the whole text is one quoted phrase, so no character of it is
// fts5 syntax: a double quote is doubled, and AND, OR, NOT, NEAR, *, ^, :, (, ) and - lose their meaning. the caller
// binds the result as a parameter and never puts it in the sql text. sqlite ends a bound text at a nul character,
// which would cut off the closing quote, so each nul is dropped first.
export function ftsPhrase(q: string): string {
  return `"${withoutNul(q).trim().replaceAll('"', '""')}"`;
}

// the pattern of a like scan with ESCAPE '\'. %, _ and \ in the text match only themselves. sqlite compares ascii
// letters without case and every other character as it is.
export function likePattern(q: string): string {
  return `%${withoutNul(q).replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

export interface Snippet {
  snippet: string;
  marks: Array<[number, number]>;
}

const ELLIPSIS = '…';

// the start of each match of needle in haystack, left to right. the matches do not overlap.
function matchStarts(haystack: string, needle: string): number[] {
  const starts: number[] = [];
  if (!needle) return starts;
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + needle.length)) starts.push(at);
  return starts;
}

// a cut must not split a pair of utf-16 surrogates, so a cut inside a pair moves to the inside of the snippet.
const isHigh = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLow = (code: number) => code >= 0xdc00 && code <= 0xdfff;

// a short part of the text around the first match, at most width characters, with the [start, end) offsets of each
// case-blind match of q in the snippet.
export function snippetOf(text: string, q: string, width = 160): Snippet {
  const flat = text.replace(/\s+/g, ' ').trim();
  const needle = q.replace(/\s+/g, ' ').trim();
  // the fold must keep the length of both strings, or an offset in the folded text would not fit the real text.
  const lowerText = flat.toLowerCase();
  const lowerNeedle = needle.toLowerCase();
  const folded = lowerText.length === flat.length && lowerNeedle.length === needle.length;
  const starts = folded ? matchStarts(lowerText, lowerNeedle) : matchStarts(flat, needle);
  const size = Math.max(3, Math.trunc(width));

  let from = 0;
  let to = Math.min(flat.length, size);
  const first = starts[0];
  if (first !== undefined) {
    from = Math.max(0, first - Math.floor((size - needle.length) / 2));
    to = Math.min(flat.length, from + size);
    from = Math.max(0, to - size);
  }
  // each cut end gives one of its characters to the ellipsis, so the snippet stays at most width characters.
  if (from > 0) from += 1;
  if (to < flat.length) to -= 1;
  if (from > 0 && from < flat.length && isLow(flat.charCodeAt(from))) from += 1;
  if (to < flat.length && to > from && isHigh(flat.charCodeAt(to - 1))) to -= 1;
  if (to < from) to = from;

  const head = from > 0 ? ELLIPSIS : '';
  const tail = to < flat.length ? ELLIPSIS : '';
  const marks: Array<[number, number]> = [];
  for (const start of starts) {
    const end = start + needle.length;
    if (end <= from || start >= to) continue;
    marks.push([Math.max(start, from) - from + head.length, Math.min(end, to) - from + head.length]);
  }
  return { snippet: head + flat.slice(from, to) + tail, marks };
}
