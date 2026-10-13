import { describe, expect, it } from 'vitest';
import { headOf, safeEnd, safeStart, tailOf } from './text.js';

const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

describe('surrogate safe cuts', () => {
  it('moves a cut out of the middle of a pair and keeps other cuts as they are', () => {
    const text = 'a😀b';
    expect(safeEnd(text, 2)).toBe(1);
    expect(safeEnd(text, 3)).toBe(3);
    expect(safeStart(text, 2)).toBe(3);
    expect(safeStart(text, 1)).toBe(1);
    expect(safeStart(text, 0)).toBe(0);
    expect(safeEnd(text, 0)).toBe(0);
  });

  it('gives a head and a tail without a lone half for every length', () => {
    const text = `x${'😀'.repeat(20)}`;
    for (let n = 0; n <= text.length + 1; n++) {
      expect(headOf(text, n)).not.toMatch(LONE);
      expect(tailOf(text, n)).not.toMatch(LONE);
      expect(headOf(text, n).length).toBeLessThanOrEqual(n);
      expect(tailOf(text, n).length).toBeLessThanOrEqual(n);
    }
  });
});
