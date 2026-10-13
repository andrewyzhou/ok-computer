import type { Price } from '../config/schema.js';
import type { Usage } from './types.js';

// an unknown model has no price. null shows the gap, but zero would hide it.
export function costUsd(pricing: Record<string, Price>, modelRef: string, usage: Usage): number | null {
  const price = pricing[modelRef];
  if (!price) return null;
  return (
    (usage.inputTokens * price.input +
      usage.cacheReadTokens * price.cachedInput +
      usage.cacheWriteTokens * price.cacheWrite +
      usage.outputTokens * price.output) /
    1_000_000
  );
}
