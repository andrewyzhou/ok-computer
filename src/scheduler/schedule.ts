import { Cron } from 'croner';
import { z } from 'zod';
import { formatLocal } from '../time.js';

// an iso time without an offset means a different moment on each machine, so the schema requires one.
const isoWithOffset = z
  .string()
  .regex(/(Z|[+-]\d{2}:\d{2})$/, 'give an iso time with an offset, for example 2026-10-12T21:00:00-07:00')
  .refine((value) => !Number.isNaN(Date.parse(value)), 'not a valid iso time');

const cronExpr = z.string().refine((expr) => {
  try {
    new Cron(expr, { paused: true });
    return true;
  } catch {
    return false;
  }
}, 'not a valid cron expression');

export const scheduleSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('at'), at: isoWithOffset }),
  // an interval under one minute is almost always a mistake, and it can send the owner a flood of messages.
  z.object({ kind: z.literal('every'), everyMs: z.number().int().min(60_000), anchor: isoWithOffset.optional() }),
  z.object({ kind: z.literal('cron'), expr: cronExpr, tz: z.string().optional() }),
]);
export type Schedule = z.infer<typeof scheduleSchema>;

// the result is strictly after the given time. a one-shot schedule gives null when its time has passed.
export function nextRun(schedule: Schedule, after: Date, createdAt: Date, timeZone: string): Date | null {
  switch (schedule.kind) {
    case 'at': {
      const at = new Date(schedule.at);
      return at > after ? at : null;
    }
    case 'every': {
      const anchor = schedule.anchor ? Date.parse(schedule.anchor) : createdAt.getTime();
      if (after.getTime() < anchor) return new Date(anchor);
      const steps = Math.floor((after.getTime() - anchor) / schedule.everyMs) + 1;
      return new Date(anchor + steps * schedule.everyMs);
    }
    case 'cron':
      return new Cron(schedule.expr, { timezone: schedule.tz ?? timeZone, paused: true }).nextRun(after);
  }
}

export function describeSchedule(schedule: Schedule, timeZone: string): string {
  switch (schedule.kind) {
    case 'at':
      return `once at ${formatLocal(new Date(schedule.at), timeZone)}`;
    case 'every': {
      const minutes = schedule.everyMs / 60_000;
      return minutes % 60 === 0 ? `every ${minutes / 60} h` : `every ${minutes} min`;
    }
    case 'cron':
      return `cron "${schedule.expr}" (${schedule.tz ?? timeZone})`;
  }
}
