import { describe, expect, it } from 'vitest';
import type { DocDiffHunk } from '../dashboard/docs-types.js';
import { TRIP_V2, TRIP_V3 } from '../../test/docs-seed.js';
import { DIFF_MAX_LINES, diffLines, diffVersions, splitLines } from './diff.js';

const lines = (count: number, prefix = 'line') => Array.from({ length: count }, (_, index) => `${prefix} ${index + 1}`);
const text = (each: string[]) => each.join('\n');
// the ops of each hunk as one letter for each line, so a test reads the shape at a glance.
const shape = (hunks: DocDiffHunk[]) => hunks.map((hunk) => hunk.lines.map((line) => line.op[0]).join(''));
const headers = (hunks: DocDiffHunk[]) => hunks.map((hunk) => [hunk.fromStart, hunk.fromLines, hunk.toStart, hunk.toLines]);

// the lines of the new text, rebuilt from the old text and the hunks, as a reader of a unified diff would.
function apply(from: string, hunks: DocDiffHunk[]): string[] {
  const old = splitLines(from);
  const out: string[] = [];
  let at = 0;
  for (const hunk of hunks) {
    const start = hunk.fromLines > 0 ? hunk.fromStart - 1 : hunk.fromStart;
    out.push(...old.slice(at, start));
    at = start;
    for (const line of hunk.lines) {
      if (line.op !== 'add') {
        expect(old[at]).toBe(line.text);
        at++;
      }
      if (line.op !== 'del') out.push(line.text);
    }
  }
  out.push(...old.slice(at));
  return out;
}

function lcs(a: string[], b: string[]): number {
  const row = new Array<number>(b.length + 1).fill(0);
  for (const x of a) {
    let diagonal = 0;
    for (let j = 1; j <= b.length; j++) {
      const up = row[j]!;
      row[j] = x === b[j - 1] ? diagonal + 1 : Math.max(row[j]!, row[j - 1]!);
      diagonal = up;
    }
  }
  return row[b.length]!;
}

const version = (n: number, body: string, title = 'Doc') => ({ version: n, title, body });

describe('splitLines', () => {
  it('reads an empty text as no lines and drops the empty line after a last line break', () => {
    expect(splitLines('')).toEqual([]);
    expect(splitLines('a')).toEqual(['a']);
    expect(splitLines('a\n')).toEqual(['a']);
    expect(splitLines('a\r\nb\r\n')).toEqual(['a', 'b']);
    expect(splitLines('\n')).toEqual(['']);
    expect(splitLines('a\n\n')).toEqual(['a', '']);
  });
});

describe('diffLines', () => {
  it('gives no hunks for equal texts, and treats a last line break and crlf as the same', () => {
    expect(diffLines('a\nb', 'a\nb')).toEqual([]);
    expect(diffLines('a\nb', 'a\nb\n')).toEqual([]);
    expect(diffLines('a\r\nb\r\n', 'a\nb')).toEqual([]);
    expect(diffLines('', '')).toEqual([]);
  });

  it('adds every line to an empty text and removes every line to an empty text', () => {
    const added = diffLines('', 'a\nb');
    expect(headers(added)).toEqual([[0, 0, 1, 2]]);
    expect(added[0]!.lines).toEqual([
      { op: 'add', text: 'a', fromLine: null, toLine: 1 },
      { op: 'add', text: 'b', fromLine: null, toLine: 2 },
    ]);
    const removed = diffLines('a\nb', '');
    expect(headers(removed)).toEqual([[1, 2, 0, 0]]);
    expect(shape(removed)).toEqual(['dd']);
  });

  it('inserts at the start, in the middle and at the end, with 3 lines of context', () => {
    const base = lines(10);
    const start = diffLines(text(base), text(['new', ...base]));
    expect(headers(start)).toEqual([[1, 3, 1, 4]]);
    expect(shape(start)).toEqual(['asss']);

    const middle = diffLines(text(base), text([...base.slice(0, 5), 'new', ...base.slice(5)]));
    expect(headers(middle)).toEqual([[3, 6, 3, 7]]);
    expect(shape(middle)).toEqual(['sssasss']);
    expect(middle[0]!.lines[3]).toEqual({ op: 'add', text: 'new', fromLine: null, toLine: 6 });
    expect(middle[0]!.lines[4]).toEqual({ op: 'same', text: 'line 6', fromLine: 6, toLine: 7 });

    const end = diffLines(text(base), text([...base, 'new']));
    expect(headers(end)).toEqual([[8, 3, 8, 4]]);
    expect(shape(end)).toEqual(['sssa']);
  });

  it('starts a side with no lines at the line before the change', () => {
    // a pure insert after line 5 with no context: the old side has 0 lines and starts at line 5.
    const hunks = diffLines(text(lines(10)), text([...lines(10).slice(0, 5), 'new', ...lines(10).slice(5)]), 0);
    expect(headers(hunks)).toEqual([[5, 0, 6, 1]]);
    // a pure delete of the first line: the new side has 0 lines and starts at 0.
    expect(headers(diffLines(text(lines(4)), text(lines(4).slice(1)), 0))).toEqual([[1, 1, 0, 0]]);
  });

  it('puts the removed lines of a replace before its added lines', () => {
    const hunks = diffLines('a\nb\nc\nd\ne', 'a\nX\nY\nZ\ne');
    expect(shape(hunks)).toEqual(['sdddaaas']);
    expect(hunks[0]!.lines.filter((line) => line.op !== 'same').map((line) => line.text)).toEqual(['b', 'c', 'd', 'X', 'Y', 'Z']);
    expect(headers(hunks)).toEqual([[1, 5, 1, 5]]);
  });

  it('keeps two changes far apart in two hunks and merges two close ones', () => {
    const base = lines(30);
    const far = [...base];
    far[2] = 'changed 3';
    far[25] = 'changed 26';
    const two = diffLines(text(base), text(far));
    expect(headers(two)).toEqual([
      [1, 6, 1, 6],
      [23, 7, 23, 7],
    ]);
    // the gap is exactly 6 same lines, so the contexts touch and the hunks merge.
    const touching = [...base];
    touching[9] = 'changed 10';
    touching[16] = 'changed 17';
    expect(headers(diffLines(text(base), text(touching)))).toEqual([[7, 14, 7, 14]]);
    // a gap of 7 same lines leaves one line between the contexts, so the hunks stay apart.
    const apart = [...base];
    apart[9] = 'changed 10';
    apart[17] = 'changed 18';
    expect(headers(diffLines(text(base), text(apart)))).toEqual([
      [7, 7, 7, 7],
      [15, 7, 15, 7],
    ]);
  });

  it('compares unicode lines as they are', () => {
    const hunks = diffLines('café ☕\n東京\n🎉 party', 'café ☕\n東京都\n🎉 party');
    expect(shape(hunks)).toEqual(['sdas']);
    expect(hunks[0]!.lines[1]!.text).toBe('東京');
    expect(hunks[0]!.lines[2]!.text).toBe('東京都');
  });

  it('finds a shortest edit script that rebuilds the new text', () => {
    // a small random walk with a fixed seed, so the test is the same on each run.
    let seed = 7;
    const random = () => (seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31) / 2 ** 31;
    const pick = () => 'abcde'[Math.floor(random() * 5)]!;
    for (let round = 0; round < 200; round++) {
      const a = Array.from({ length: Math.floor(random() * 12) }, pick);
      const b = Array.from({ length: Math.floor(random() * 12) }, pick);
      const hunks = diffLines(text(a), text(b));
      expect(apply(text(a), hunks)).toEqual(b);
      const changed = hunks.flatMap((hunk) => hunk.lines).filter((line) => line.op !== 'same').length;
      expect(changed).toBe(a.length + b.length - 2 * lcs(a, b));
    }
  });
});

describe('diffVersions', () => {
  it('counts the lines and names the versions', () => {
    const diff = diffVersions({ docId: 4, from: version(1, 'a\nb\nc'), to: version(2, 'a\nB\nc\nd') });
    expect(diff).toMatchObject({ docId: 4, from: 1, to: 2, added: 2, removed: 1, title: null, coarse: false });
    expect(shape(diff.hunks)).toEqual(['sdasa']);
  });

  it('gives no hunks for equal bodies, and the title only when it changed', () => {
    const same = diffVersions({ docId: 1, from: version(2, 'x\n'), to: version(2, 'x') });
    expect(same).toEqual({ docId: 1, from: 2, to: 2, added: 0, removed: 0, hunks: [], title: null, coarse: false });
    const renamed = diffVersions({ docId: 1, from: version(1, 'x', 'Old'), to: version(2, 'x', 'New') });
    expect(renamed.title).toEqual({ from: 'Old', to: 'New' });
    expect(renamed.hunks).toEqual([]);
  });

  it('goes from the text called from to the text called to, also when from is the newer version', () => {
    const back = diffVersions({ docId: 1, from: version(3, TRIP_V3), to: version(2, TRIP_V2) });
    const forward = diffVersions({ docId: 1, from: version(2, TRIP_V2), to: version(3, TRIP_V3) });
    expect(back).toMatchObject({ from: 3, to: 2, added: forward.removed, removed: forward.added });
    expect(apply(TRIP_V3, back.hunks)).toEqual(splitLines(TRIP_V2));
  });

  it('diffs the seed trip plan from version 2 to version 3', () => {
    const diff = diffVersions({ docId: 1, from: version(2, TRIP_V2), to: version(3, TRIP_V3) });
    // line 3 gets a new sentence, the hotel section adds 6 lines, each of the 5 lunches moves to Alfama, and the
    // packing, the checks and the notes add 24 lines at the end.
    expect(diff).toMatchObject({ added: 36, removed: 6, coarse: false, title: null });
    expect(headers(diff.hunks)).toEqual([
      [1, 6, 1, 6],
      [9, 39, 9, 69],
    ]);
    expect(diff.hunks.map((hunk) => hunk.lines.length)).toEqual([7, 74]);
    expect(apply(TRIP_V2, diff.hunks)).toEqual(splitLines(TRIP_V3));
  });

  it('gives a fast coarse diff for a body over the line limit', () => {
    const big = lines(DIFF_MAX_LINES + 1);
    const changed = big.map((line, index) => (index % 2 ? line : `${line} changed`));
    const started = performance.now();
    const diff = diffVersions({ docId: 1, from: version(1, text(big)), to: version(2, text(changed)) });
    expect(performance.now() - started).toBeLessThan(200);
    expect(diff).toMatchObject({ coarse: true, added: DIFF_MAX_LINES + 1, removed: DIFF_MAX_LINES + 1 });
    expect(headers(diff.hunks)).toEqual([[1, DIFF_MAX_LINES + 1, 1, DIFF_MAX_LINES + 1]]);
    expect(shape(diff.hunks)[0]).toBe('d'.repeat(DIFF_MAX_LINES + 1) + 'a'.repeat(DIFF_MAX_LINES + 1));
  });

  it('gives a coarse diff when the edit distance passes 2,000, and a full one just under it', () => {
    const old = lines(3_000, 'old');
    const coarse = diffVersions({ docId: 1, from: version(1, text(old)), to: version(2, text(lines(3_000, 'new'))) });
    expect(coarse).toMatchObject({ coarse: true, added: 3_000, removed: 3_000 });
    expect(headers(coarse.hunks)).toEqual([[1, 3_000, 1, 3_000]]);
    const near = diffVersions({ docId: 1, from: version(1, text(old)), to: version(2, text([...old.slice(0, 1_000), ...lines(1_000, 'new'), ...old.slice(2_000)])) });
    expect(near).toMatchObject({ coarse: false, added: 1_000, removed: 1_000 });
  });

  it('keeps a side with no lines at 0 in a coarse diff', () => {
    const diff = diffVersions({ docId: 1, from: version(1, ''), to: version(2, text(lines(DIFF_MAX_LINES + 1))) });
    expect(diff.coarse).toBe(true);
    expect(headers(diff.hunks)).toEqual([[0, 0, 1, DIFF_MAX_LINES + 1]]);
  });
});
