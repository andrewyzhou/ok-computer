import { describe, expect, it } from 'vitest';
import { DEFAULT_PRICING } from '../config/schema.js';
import { costUsd } from './cost.js';

describe('the cost of a call', () => {
  // a 1-hour cache write costs 2x input, not the 1.25x of a 5-minute write.
  it('prices 1-hour cache writes at their own rate', () => {
    const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 3_000_000, cacheWrite1hTokens: 1_000_000 };
    expect(costUsd(DEFAULT_PRICING, 'anthropic/claude-sonnet-5-5', usage)).toBe(2 * 2.5 + 4);
    expect(costUsd({ m: { input: 1, cachedInput: 0.1, cacheWrite: 1.25, output: 5 } }, 'm', usage)).toBe(2 * 1.25 + 2);
  });
});
