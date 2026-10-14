import { Cron } from 'croner';
import { z } from 'zod';
import { formatLocal } from '../time.js';

// the store compares times as iso text. a time in the year 10000 or later has the form "+010000-...", which sorts
// before "2026-...", so such a job would be due at once and on each tick. the schema and nextRun stop at this limit.
const LAST_TIME = Date.parse('9999-12-31T23:59:59.999Z');

// an iso time without an offset means a different moment on each machine, so the schema requires one.
const isoWithOffset = z
  .string()
  .regex(/(Z|[+-]\d{2}:\d{2})$/, 'give an iso time with an offset, for example 2026-10-12T21:00:00-07:00')
  .refine((value) => !Number.isNaN(Date.parse(value)), 'not a valid iso time')
  .refine((value) => Date.parse(value) <= LAST_TIME, 'give a time before the year 10000');

// a sixth field gives seconds, so a cron could run each second and get past the one-minute minimum of an interval.
// the schema accepts only the five fields of minute, hour, day of month, month and day of week.
const cronExpr = z.string().refine((expr) => {
  if (expr.trim().split(/\s+/).length !== 5) return false;
  try {
    new Cron(expr, { paused: true });
    return true;
  } catch {
    return false;
  }
}, 'not a valid cron expression with five fields: minute, hour, day of month, month, day of week');

export const scheduleSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('at'), at: isoWithOffset }),
  // an interval under one minute is usually a mistake. it can send the owner too many messages. an interval over a
  // year is a mistake too, and a very long one gives a time past the limit of the store.
  z.object({
    kind: z.literal('every'),
    everyMs: z.number().int().min(60_000).max(366 * 24 * 60 * 60_000, 'use at most 366 days, or a cron or a one-shot time'),
    anchor: isoWithOffset.optional(),
  }),
  z.object({ kind: z.literal('cron'), expr: cronExpr, tz: z.string().optional() }),
]);
export type Schedule = z.infer<typeof scheduleSchema>;

// the result is strictly after the given time. a one-shot schedule gives null when its time has passed. a time past
// the limit of the store also gives null, so a row from before the schema limit cannot run on each tick.
export function nextRun(schedule: Schedule, after: Date, createdAt: Date, timeZone: string): Date | null {
  const next = plannedRun(schedule, after, createdAt, timeZone);
  return next && next.getTime() <= LAST_TIME ? next : null;
}

function plannedRun(schedule: Schedule, after: Date, createdAt: Date, timeZone: string): Date | null {
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

// the last planned time at or before the given time. a retry runs after its planned time, and some jobs take their
// day from the planned time.
export function previousRun(schedule: Schedule, atOrBefore: Date, createdAt: Date, timeZone: string): Date {
  switch (schedule.kind) {
    case 'at':
      return new Date(schedule.at);
    case 'every': {
      const anchor = schedule.anchor ? Date.parse(schedule.anchor) : createdAt.getTime();
      if (atOrBefore.getTime() < anchor) return atOrBefore;
      return new Date(anchor + Math.floor((atOrBefore.getTime() - anchor) / schedule.everyMs) * schedule.everyMs);
    }
    case 'cron': {
      // croner looks strictly before the reference and drops the milliseconds, so the reference is one second later.
      const cron = new Cron(schedule.expr, { timezone: schedule.tz ?? timeZone, paused: true });
      return cron.previousRuns(1, new Date(atOrBefore.getTime() + 1000))[0] ?? atOrBefore;
    }
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
    case 'cron': {
      const cron = `cron "${schedule.expr}" (${schedule.tz ?? timeZone})`;
      const daily = /^(\d{1,2}) (\d{1,2}) \* \* \*$/.exec(schedule.expr.trim());
      if (!daily) return cron;
      return `every day at ${daily[2]!.padStart(2, '0')}:${daily[1]!.padStart(2, '0')}, ${cron}`;
    }
  }
}
