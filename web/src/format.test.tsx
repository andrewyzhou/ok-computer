import { describe, expect, it } from 'vitest';
import { ms, plural } from './format';

describe('ms', () => {
  it('never shows 60 seconds in a minute', () => {
    expect(ms(119_700)).toBe('2 min 0 s');
    expect(ms(59_960)).toBe('1 min 0 s');
    expect(ms(61_000)).toBe('1 min 1 s');
    expect(ms(1500)).toBe('1.5 s');
    expect(ms(999)).toBe('999 ms');
  });
});

describe('plural', () => {
  it('says one noun for one and the plural for the other counts', () => {
    expect(plural(1, 'blob')).toBe('1 blob');
    expect(plural(0, 'blob')).toBe('0 blobs');
    expect(plural(2, 'failed run')).toBe('2 failed runs');
    expect(plural(3, 'child', 'children')).toBe('3 children');
  });
});
