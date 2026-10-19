import { describe, expect, it } from 'vitest';
import { ms } from './format';

describe('ms', () => {
  it('never shows 60 seconds in a minute', () => {
    expect(ms(119_700)).toBe('2 min 0 s');
    expect(ms(59_960)).toBe('1 min 0 s');
    expect(ms(61_000)).toBe('1 min 1 s');
    expect(ms(1500)).toBe('1.5 s');
    expect(ms(999)).toBe('999 ms');
  });
});
