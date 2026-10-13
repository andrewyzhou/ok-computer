import { z } from 'zod';
import { googleConfigSchema } from '../google/config.js';

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

const timeOfDay = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'use 24-hour time in the form HH:MM');

// node sets a timer over 2^31-1 ms (about 24.8 days) to 1 ms. a large value would then stop each run at once, while
// its tools go on to run.
const MAX_TIMER_MS = 2_147_483_647;
const timeoutMs = z.number().int().positive().max(MAX_TIMER_MS, `use at most ${MAX_TIMER_MS} ms (about 24 days), the limit of a node timer`);

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
      chatTimeoutMs: timeoutMs.default(10 * 60_000),
      backgroundTimeoutMs: timeoutMs.default(30 * 60_000),
    })
    .prefault({}),
  // the window is a budget for the input of one model call, not the limit of the model. a long session compacts
  // when it nears the budget, so the cost of each call stays bounded.
  context: z
    .object({
      windowTokens: z.number().int().min(1000).default(200_000),
    })
    .prefault({}),
  paths: z
    .object({
      data: z.string().default('data'),
      workspace: z.string().default('workspace'),
      skills: z.string().default('skills'),
    })
    .prefault({}),
  scheduler: z
    .object({
      missedGraceMs: z.number().int().nonnegative().default(2 * 60 * 60_000),
    })
    .prefault({}),
  heartbeat: z
    .object({
      every: z
        .string()
        .regex(/^(0|[1-9]\d*[mh])$/, 'use a value like "15m", "30m", "1h", or "0" to turn the heartbeat off')
        .default('30m'),
      activeHours: z
        .object({ start: timeOfDay.default('08:00'), end: timeOfDay.default('23:00') })
        .prefault({}),
    })
    .prefault({}),
  routine: z
    .object({
      askAt: timeOfDay.default('19:00'),
      reminders: z.array(timeOfDay).default(['20:00', '21:00', '22:00']),
      resultsAt: timeOfDay.default('23:45'),
    })
    .prefault({}),
  memory: z
    .object({
      consolidateAt: timeOfDay.default('03:00'),
    })
    .prefault({}),
  dashboard: z
    .object({
      port: z.number().int().min(1).max(65535).default(4317),
      // the https address of the dashboard on another device, for example a tailscale serve url. /dashboard sends a
      // sign-in link to it, and the server accepts its host name only when DASHBOARD_TOKEN is set.
      publicUrl: z.url({ protocol: /^https$/ }).optional(),
    })
    .prefault({}),
  // the google integration is off without this block. see docs/setup/google.md.
  google: googleConfigSchema.optional(),
});

// the result is in milliseconds. "0" gives 0.
export function durationMs(value: string): number {
  const match = /^(\d+)([mh])$/.exec(value);
  if (!match) return 0;
  return Number(match[1]) * (match[2] === 'h' ? 60 * 60_000 : 60_000);
}

export type Config = z.infer<typeof configSchema>;
