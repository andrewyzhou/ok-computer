// the shapes of the docs api (phase 6 t4). the page imports them, so this file imports nothing. docs/API.md (T4) lists
// the routes, and src/dashboard/docs.ts serves them.

export const DOC_KINDS = ['brief', 'plan', 'notes', 'comparison', 'meeting_prep', 'other'] as const;
export type DocKind = (typeof DOC_KINDS)[number];

export type DocAuthor = 'agent' | 'owner';

// a link of a doc to its sources. href is an http(s) url, or a hash of the web app such as #/runs/run-1 or
// #/docs/12. the store refuses every other href, so a doc never holds a javascript: or a data: link.
export interface DocLink {
  label: string;
  href: string;
}

// one doc in a list. version is the number of the newest version, so it is also the count of versions.
export interface DocSummary {
  id: number;
  title: string;
  kind: DocKind;
  // the author of the newest version.
  author: DocAuthor;
  // true when the newest version has taint (DocVersionMeta.taint).
  tainted: boolean;
  version: number;
  // the characters of the newest body.
  chars: number;
  comments: number;
  sessionKey: string | null;
  createdAt: string;
  updatedAt: string;
}

// one version without its body, for the version history.
export interface DocVersionMeta {
  version: number;
  title: string;
  kind: DocKind;
  author: DocAuthor;
  note: string | null;
  runId: string | null;
  toolCallId: string | null;
  chars: number;
  // the names of the untrusted sources that the writing session had read. the page shows them, because such a version
  // can repeat outside text.
  taint: string[];
  createdAt: string;
}

export interface DocVersion extends DocVersionMeta {
  body: string;
  links: DocLink[];
}

export interface DocComment {
  id: number;
  docId: number;
  // the version that the owner read when they wrote the comment.
  version: number;
  quote: string | null;
  text: string;
  author: 'owner';
  sessionKey: string;
  // the system_event that carried the comment to its session. null while the comment waits for the session queue.
  eventId: number | null;
  deliveredAt: string | null;
  createdAt: string;
}

// GET /api/docs/:id. version is the version that the query asked for, or the newest one. versions is newest first.
export interface DocDetail {
  doc: DocSummary;
  version: DocVersion;
  versions: DocVersionMeta[];
  comments: DocComment[];
}

export interface DocsQuery {
  q?: string;
  kind?: DocKind;
  cursor?: string;
  limit?: number;
}

// a search hit has a snippet of the newest body with the [start, end) offsets of each match, as in SearchHit.
export interface DocListItem extends DocSummary {
  snippet: string | null;
  marks: Array<[number, number]>;
}

// GET /api/docs. newest updatedAt first. mode is null without q, else the search mode of src/search/fts.ts.
export interface DocsPage {
  docs: DocListItem[];
  nextCursor: string | null;
  mode: 'fts' | 'like' | null;
}

// a line of a diff. fromLine and toLine are 1-based line numbers of the two versions, null on the side without it.
export interface DocDiffLine {
  op: 'same' | 'add' | 'del';
  text: string;
  fromLine: number | null;
  toLine: number | null;
}

// a run of changed lines with up to 3 lines of context on each side, as in a unified diff.
export interface DocDiffHunk {
  fromStart: number;
  fromLines: number;
  toStart: number;
  toLines: number;
  lines: DocDiffLine[];
}

// GET /api/docs/:id/diff?from=&to=. added and removed count lines. a diff of two equal bodies has no hunks. title is
// set when the title changed between the versions.
export interface DocDiff {
  docId: number;
  from: number;
  to: number;
  added: number;
  removed: number;
  hunks: DocDiffHunk[];
  title: { from: string; to: string } | null;
  // true when a body was too long to compare line by line, and the diff shows the whole old body removed and the
  // whole new body added.
  coarse: boolean;
}

// POST /api/docs/:id/comments.
export interface DocCommentRequest {
  text: string;
  version: number;
  quote?: string;
}
