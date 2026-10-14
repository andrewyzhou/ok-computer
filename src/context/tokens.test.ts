import { describe, expect, it } from 'vitest';
import { estimateTokens } from './tokens.js';

describe('the token estimate', () => {
  // 4 characters for each token was 26 to 50% low in real sessions, so compaction started too late.
  it('counts 3 characters of the json text as one token', () => {
    expect(estimateTokens('x'.repeat(298))).toBe(100);
  });
});
