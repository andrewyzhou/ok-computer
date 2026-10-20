import { describe, expect, it, vi } from 'vitest';
import type { BriefInput } from '../src/brief/build.js';
import type { BriefContext } from '../src/brief/context.js';
import { PEOPLE_SOURCE, runBriefJob } from '../src/brief/job.js';
import { openDb } from '../src/db/index.js';
import { silentLogger } from '../src/observability/logger.js';
import { createRunQueue } from '../src/sessions/queue.js';

// the brief names the organizer of an invitation by the people memory, whose names come from the headers of other
// people's mail. this file gives the brief one such name, so the run carries the taint of the people memory.

vi.mock('../src/brief/sources.js', async (original) => ({
  ...(await original<typeof import('../src/brief/sources.js')>()),
  gatherBriefInput: async (ctx: BriefContext, day: string): Promise<BriefInput> => ({
    day,
    timeZone: ctx.timeZone,
    now: ctx.clock(),
    events: [],
    sources: { calendar: 'off', skipped: [], digest: null, desk: true },
    inbox: null,
    proposals: [],
    delegations: [],
    goals: [],
    organizerNames: { 'lee@school.example.edu': 'Lee Park' },
  }),
}));

describe('the brief with names from the people memory', () => {
  it('carries the taint of the people memory into the run', async () => {
    const db = openDb(':memory:');
    const ctx: BriefContext = {
      db,
      clock: () => new Date('2026-10-12T07:30:00-07:00'),
      logger: silentLogger,
      timeZone: 'America/Los_Angeles',
      owner: { send: async () => true, chat: () => ({ channel: 'telegram', chatId: '42' }) },
      queue: createRunQueue(),
      dashboardUrl: 'http://127.0.0.1:7777',
      signal: new AbortController().signal,
      replan: () => {},
      newId: () => 'run-p',
    };
    expect((await runBriefJob(ctx)).status).toBe('completed');
    const events = db
      .prepare("SELECT payload FROM events WHERE sessionKey = 'brief:run-p' AND type = 'system_event' ORDER BY seq")
      .all()
      .map((row) => JSON.parse(String(row.payload)) as { text: string; taint?: Array<{ source: string }> });
    expect(events[1]).toMatchObject({ text: `The brief read ${PEOPLE_SOURCE}.`, taint: [{ source: PEOPLE_SOURCE }] });
  });
});
