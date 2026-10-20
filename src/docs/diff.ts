import type { DocDiff, DocDiffHunk } from '../dashboard/docs-types.js';
import { NotBuilt } from './not-built.js';

// the line diff between two versions of a doc, for the version history of the docs view. it is a pure function, so
// the route and its tests need no database.

// a body with more lines than this on either side gets a coarse diff (DocDiff.coarse), so a diff never takes more
// than a few milliseconds on the request path.
export const DIFF_MAX_LINES = 5_000;
export const CONTEXT_LINES = 3;

export interface DiffInput {
  docId: number;
  from: { version: number; title: string; body: string };
  to: { version: number; title: string; body: string };
}

export function diffVersions(input: DiffInput): DocDiff {
  void input;
  throw new NotBuilt('diffVersions');
}

// the hunks of a line diff of two texts, with CONTEXT_LINES lines of context around each change.
export function diffLines(from: string, to: string, context = CONTEXT_LINES): DocDiffHunk[] {
  void from;
  void to;
  void context;
  throw new NotBuilt('diffLines');
}
