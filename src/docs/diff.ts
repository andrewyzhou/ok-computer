import type { DocDiff, DocDiffHunk, DocDiffLine } from '../dashboard/docs-types.js';

// the line diff between two versions of a doc, for the version history of the docs view. it is a pure function, so
// the route and its tests need no database.

// a body with more lines than this on either side gets a coarse diff (DocDiff.coarse), so a diff never takes more
// than a few milliseconds on the request path.
export const DIFF_MAX_LINES = 5_000;
export const CONTEXT_LINES = 3;
// a diff that needs more added and removed lines than this also gets a coarse diff. the work of the diff grows with
// the number of lines times this distance, so the limit keeps a request short.
export const DIFF_MAX_EDITS = 2_000;

export interface DiffInput {
  docId: number;
  from: { version: number; title: string; body: string };
  to: { version: number; title: string; body: string };
}

// the lines of a text. an empty text has no lines, a last line break adds no empty line, and a crlf line break is the
// same as a lf one.
export function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

type Op = 'same' | 'add' | 'del';

// the edit script of a and b by the greedy diff of myers, which finds a shortest one in o((n + m) d) time for an edit
// distance d. the lines are numbers, so each compare is cheap. the result is undefined when d would pass maxEdits.
function myers(a: Int32Array, b: Int32Array, maxEdits: number): Op[] | undefined {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  const limit = Math.min(max, maxEdits);
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  // trace[d] holds v[k] for k from -d to d at the end of round d, so the walk back can find the step of each round.
  const trace: Int32Array[] = [];
  let end = -1;
  for (let d = 0; d <= limit && end < 0; d++) {
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!) ? v[offset + k + 1]! : v[offset + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) end = d;
    }
    trace.push(v.slice(offset - d, offset + d + 1));
  }
  if (end < 0) return undefined;

  const ops: Op[] = [];
  let x = n;
  let y = m;
  for (let d = end; d > 0; d--) {
    const prev = trace[d - 1]!;
    const at = (k: number) => prev[k + d - 1]!;
    const k = x - y;
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const prevX = at(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push('same');
      x--;
      y--;
    }
    ops.push(x === prevX ? 'add' : 'del');
    x = prevX;
    y = prevY;
  }
  while (x > 0 && y > 0) {
    ops.push('same');
    x--;
    y--;
  }
  return ops.reverse();
}

// the lines of the diff in order, with each run of changes as all its removed lines and then all its added lines.
// undefined when the edit distance passes maxEdits.
function diffOps(fromLines: string[], toLines: string[], maxEdits: number): DocDiffLine[] | undefined {
  // the same lines at the start and the end need no search, which keeps the search small for a usual edit.
  let head = 0;
  while (head < fromLines.length && head < toLines.length && fromLines[head] === toLines[head]) head++;
  let tail = 0;
  while (
    tail < fromLines.length - head &&
    tail < toLines.length - head &&
    fromLines[fromLines.length - 1 - tail] === toLines[toLines.length - 1 - tail]
  ) {
    tail++;
  }
  const ids = new Map<string, number>();
  const idsOf = (lines: string[]) =>
    Int32Array.from(lines, (line) => {
      let id = ids.get(line);
      if (id === undefined) ids.set(line, (id = ids.size));
      return id;
    });
  const middle = myers(idsOf(fromLines.slice(head, fromLines.length - tail)), idsOf(toLines.slice(head, toLines.length - tail)), maxEdits);
  if (!middle) return undefined;
  const ops: Op[] = [...Array<Op>(head).fill('same'), ...middle, ...Array<Op>(tail).fill('same')];

  const lines: DocDiffLine[] = [];
  let a = 0;
  let b = 0;
  for (let index = 0; index < ops.length; ) {
    if (ops[index] === 'same') {
      lines.push({ op: 'same', text: toLines[b]!, fromLine: a + 1, toLine: b + 1 });
      a++;
      b++;
      index++;
      continue;
    }
    let dels = 0;
    let adds = 0;
    for (; index < ops.length && ops[index] !== 'same'; index++) {
      if (ops[index] === 'del') dels++;
      else adds++;
    }
    for (let each = 0; each < dels; each++, a++) lines.push({ op: 'del', text: fromLines[a]!, fromLine: a + 1, toLine: null });
    for (let each = 0; each < adds; each++, b++) lines.push({ op: 'add', text: toLines[b]!, fromLine: null, toLine: b + 1 });
  }
  return lines;
}

// the header of a hunk in the unified format. a side with no lines starts at the line before the change, or at 0.
function toHunk(lines: DocDiffLine[], fromBefore: number, toBefore: number): DocDiffHunk {
  const fromLines = lines.filter((line) => line.op !== 'add').length;
  const toLines = lines.filter((line) => line.op !== 'del').length;
  return {
    fromStart: fromLines > 0 ? fromBefore + 1 : fromBefore,
    fromLines,
    toStart: toLines > 0 ? toBefore + 1 : toBefore,
    toLines,
    lines,
  };
}

// the hunks of a list of diff lines. each hunk has up to context same lines on each side of its changes, and two
// hunks whose context touches or overlaps become one.
function toHunks(lines: DocDiffLine[], context: number): DocDiffHunk[] {
  const changes: number[] = [];
  lines.forEach((line, index) => {
    if (line.op !== 'same') changes.push(index);
  });
  const hunks: DocDiffHunk[] = [];
  let at = 0;
  while (at < changes.length) {
    let last = changes[at]!;
    let next = at + 1;
    while (next < changes.length && changes[next]! - last - 1 <= 2 * context) last = changes[next++]!;
    const start = Math.max(0, changes[at]! - context);
    const stop = Math.min(lines.length, last + context + 1);
    const before = lines.slice(0, start);
    hunks.push(
      toHunk(
        lines.slice(start, stop),
        before.filter((line) => line.op !== 'add').length,
        before.filter((line) => line.op !== 'del').length,
      ),
    );
    at = next;
  }
  return hunks;
}

const sameLines = (a: string[], b: string[]) => a.length === b.length && a.every((line, index) => line === b[index]);

// the hunks of a line diff of two texts, with CONTEXT_LINES lines of context around each change. it has no limit on
// the edit distance, so the request path uses diffVersions instead.
export function diffLines(from: string, to: string, context = CONTEXT_LINES): DocDiffHunk[] {
  const lines = diffOps(splitLines(from), splitLines(to), Number.POSITIVE_INFINITY)!;
  return toHunks(lines, Math.max(0, Math.trunc(context) || 0));
}

// the diff of two versions. from may be the newer version: the diff then goes from its text to the older text.
export function diffVersions(input: DiffInput): DocDiff {
  const fromLines = splitLines(input.from.body);
  const toLines = splitLines(input.to.body);
  const base = {
    docId: input.docId,
    from: input.from.version,
    to: input.to.version,
    title: input.from.title === input.to.title ? null : { from: input.from.title, to: input.to.title },
  };
  if (sameLines(fromLines, toLines)) return { ...base, added: 0, removed: 0, hunks: [], coarse: false };
  const lines =
    fromLines.length > DIFF_MAX_LINES || toLines.length > DIFF_MAX_LINES ? undefined : diffOps(fromLines, toLines, DIFF_MAX_EDITS);
  if (!lines) {
    // the coarse diff removes every old line and adds every new line, in one hunk.
    const all: DocDiffLine[] = [
      ...fromLines.map((text, index): DocDiffLine => ({ op: 'del', text, fromLine: index + 1, toLine: null })),
      ...toLines.map((text, index): DocDiffLine => ({ op: 'add', text, fromLine: null, toLine: index + 1 })),
    ];
    return { ...base, added: toLines.length, removed: fromLines.length, hunks: [toHunk(all, 0, 0)], coarse: true };
  }
  return {
    ...base,
    added: lines.filter((line) => line.op === 'add').length,
    removed: lines.filter((line) => line.op === 'del').length,
    hunks: toHunks(lines, CONTEXT_LINES),
    coarse: false,
  };
}
