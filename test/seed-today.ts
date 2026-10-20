import type { Today } from '../src/brief/today.js';
import type { Brief } from '../src/dashboard/brief-types.js';
import type { CalendarPage } from '../src/dashboard/calendar-types.js';
import type { DashboardDeps } from '../src/dashboard/server.js';
import { createDashboard } from '../src/dashboard/server.js';
import type { Db } from '../src/db/index.js';
import { googleConfigSchema } from '../src/google/config.js';
import { silentLogger } from '../src/observability/logger.js';
import type { JobResult } from '../src/scheduler/scheduler.js';
import { createTestApp } from './app-harness.js';
import { BRIEF_FULL, BRIEF_QUIET, CALENDAR_EMPTY, CALENDAR_FAILED, CALENDAR_OFF, CALENDAR_WEEK, TODAY_NOW } from './fixtures/today-data.js';

// the today pages (phase 6 t1) on a seeded database. the data is in test/fixtures/today-data.ts, and its comments name
// each value that a test may depend on.
//
// seedBriefRows writes the two briefs of the fixture with sql, as the brief job would write them: brief 1 (2026-10-11,
// a quiet day, not sent) and brief 2 (2026-10-12, full, sent to telegram). fakeToday is a Today whose calendar answers
// from the fixture week, so the routes and the pages can be tested without google.

export function seedBriefRows(db: Db, briefs: Brief[] = [BRIEF_QUIET, BRIEF_FULL]): void {
  const brief = db.prepare('INSERT INTO briefs (id, day, runId, createdAt, shortText, content) VALUES (?, ?, ?, ?, ?, ?)');
  const delivery = db.prepare('INSERT INTO brief_deliveries (briefId, channel, ok, error, at) VALUES (?, ?, ?, ?, ?)');
  for (const each of briefs) {
    brief.run(each.id, each.day, each.runId, each.createdAt, each.shortText, JSON.stringify(each.content));
    if (each.delivery) delivery.run(each.id, each.delivery.channel, each.delivery.ok ? 1 : 0, each.delivery.error, each.delivery.at);
  }
}

export type CalendarState = 'full' | 'empty' | 'failed' | 'off';

const PAGES: Record<CalendarState, CalendarPage> = { full: CALENDAR_WEEK, empty: CALENDAR_EMPTY, failed: CALENDAR_FAILED, off: CALENDAR_OFF };

export interface FakeToday extends Today {
  // the ranges that calendar() was asked for, and the number of runBrief() calls.
  ranges: Array<{ startAt: string; endAt: string }>;
  briefRuns: number;
  // the answer of the next runBrief().
  briefResult: JobResult;
}

// the events of the fixture that touch the range. calendar() never fails: a failed account is in skipped.
export function fakeToday(state: CalendarState = 'full'): FakeToday {
  const page = PAGES[state];
  const fake: FakeToday = {
    tools: [],
    ranges: [],
    briefRuns: 0,
    briefResult: { status: 'completed', runId: 'run-brief-3' },
    async calendar(range) {
      fake.ranges.push({ startAt: range.startAt.toISOString(), endAt: range.endAt.toISOString() });
      const events = page.events.filter((each) => Date.parse(each.startAt) < range.endAt.getTime() && Date.parse(each.endAt) > range.startAt.getTime());
      return { configured: page.configured, calendars: page.calendars, events, skipped: page.skipped };
    },
    async runBrief() {
      fake.briefRuns++;
      return fake.briefResult;
    },
    running: () => false,
  };
  return fake;
}

// options: token signs the dashboard in, google false leaves out the google block (as on a first run), calendar picks
// the state of the fake calendar, and empty true writes no brief rows.
export function seedToday(options: { token?: string; google?: boolean; calendar?: CalendarState; empty?: boolean } = {}) {
  const now = new Date(TODAY_NOW);
  const t = createTestApp([], { start: TODAY_NOW, config: { timeZone: 'America/Los_Angeles' } });
  const { db } = t;
  if (!options.empty) seedBriefRows(db);
  const today = fakeToday(options.calendar ?? (options.google === false ? 'off' : 'full'));
  const google =
    options.google === false ? undefined : googleConfigSchema.parse({ clientId: 'seed.apps.googleusercontent.com', accounts: [{ alias: 'personal' }, { alias: 'school' }] });
  const app: DashboardDeps['app'] = { ...t.app, today };
  const dashboard = createDashboard({
    db,
    config: { ...t.config, ...(google ? { google } : {}) },
    clock: () => now,
    logger: silentLogger,
    app,
    ...(options.token ? { token: options.token } : {}),
  });
  return { db, dashboard, today, config: t.config, close: () => db.close() };
}
