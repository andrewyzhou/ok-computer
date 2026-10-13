import { z } from 'zod';

export const SLOTS = ['main', 'heartbeat', 'utility', 'batch', 'consolidation', 'compaction'] as const;
export type Slot = (typeof SLOTS)[number];

export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = (typeof EFFORTS)[number];

const modelRef = z
  .string()
  .regex(/^[a-z][a-z-]*\/.+$/, 'use the form "provider/model", for example "anthropic/claude-haiku-5-5"');

const slotSchema = z.object({
  chain: z.array(modelRef).min(1),
  effort: z.enum(EFFORTS).optional(),
  maxTokens: z.number().int().positive().default(16000),
});
export type SlotConfig = z.infer<typeof slotSchema>;

// the default effort differs between models, so every slot sets it explicitly.
const DEFAULT_SLOTS: Record<Slot, z.input<typeof slotSchema>> = {
  main: { chain: ['anthropic/claude-sonnet-5-5', 'anthropic/claude-opus-5-5'], effort: 'medium' },
  heartbeat: { chain: ['anthropic/claude-haiku-5-5'], effort: 'low' },
  utility: { chain: ['anthropic/claude-haiku-5-5'], effort: 'low' },
  batch: { chain: ['anthropic/claude-haiku-5-5'], effort: 'low' },
  consolidation: { chain: ['anthropic/claude-sonnet-5-5'], effort: 'medium' },
  compaction: { chain: ['anthropic/claude-sonnet-5-5'], effort: 'medium' },
};

const priceSchema = z.object({
  input: z.number().nonnegative(),
  cachedInput: z.number().nonnegative(),
  cacheWrite: z.number().nonnegative(),
  output: z.number().nonnegative(),
});
export type Price = z.infer<typeof priceSchema>;

// prices are in us dollars per million tokens. cache writes use the 5-minute rate.
// haiku uses the rate for prompts of 100k tokens or fewer.
export const DEFAULT_PRICING: Record<string, Price> = {
  'anthropic/claude-opus-5-5': { input: 4, cachedInput: 0.2, cacheWrite: 5, output: 20 },
  'anthropic/claude-sonnet-5-5': { input: 2, cachedInput: 0.2, cacheWrite: 2.5, output: 10 },
  'anthropic/claude-haiku-5-5': { input: 0.1, cachedInput: 0.01, cacheWrite: 0.125, output: 0.5 },
};

const timeZone = z.string().refine((tz) => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}, 'unknown time zone');

export const configSchema = z.object({
  timeZone: timeZone.default('America/Los_Angeles'),
  slots: z
    .object(
      Object.fromEntries(SLOTS.map((slot) => [slot, slotSchema.prefault(DEFAULT_SLOTS[slot])])) as Record<
        Slot,
        z.ZodPrefault<typeof slotSchema>
      >,
    )
    .prefault({}),
  pricing: z.record(z.string(), priceSchema).default({}),
  agent: z
    .object({
      maxIterations: z.number().int().positive().default(20),
      chatTimeoutMs: z.number().int().positive().default(10 * 60_000),
      backgroundTimeoutMs: z.number().int().positive().default(30 * 60_000),
    })
    .prefault({}),
  paths: z
    .object({
      data: z.string().default('data'),
      workspace: z.string().default('workspace'),
    })
    .prefault({}),
});

export type Config = z.infer<typeof configSchema>;
