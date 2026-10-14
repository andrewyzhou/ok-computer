import type { Price } from '../config/schema.js';
import type { Usage } from './types.js';

// an unknown model has no price. null shows the gap, but zero would hide it.
export function costUsd(pricing: Record<string, Price>, modelRef: string, usage: Usage): number | null {
  const price = pricing[modelRef];
  if (!price) return null;
  const longWrites = usage.cacheWrite1hTokens ?? 0;
  return (
    (usage.inputTokens * price.input +
      usage.cacheReadTokens * price.cachedInput +
      (usage.cacheWriteTokens - longWrites) * price.cacheWrite +
      longWrites * (price.cacheWrite1h ?? price.cacheWrite * 1.6) +
      usage.outputTokens * price.output) /
    1_000_000
  );
}
