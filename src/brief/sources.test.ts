import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CalendarRead } from './calendar.js';
import { openDb, type Db } from '../db/index.js';
import { addGoal } from '../goals/store.js';
import { silentLogger } from '../observability/logger.js';
import { createRunQueue } from '../sessions/queue.js';
import type { BriefContext } from './context.js';
import { gatherBriefInput } from './sources.js';
import { seedPeople } from '../../test/seed-people.js';
import { TODAY_EVENTS } from '../../test/fixtures/today-data.js';
import type { CalendarEvent } from '../dashboard/calendar-types.js';

// the calendar of a test answers from calendarAnswer, so these tests do not need google.
let calendarAnswer: (range: { startAt: Date; endAt: Date }) => Promise<CalendarRead>;
const ranges: Array<{ startAt: string; endAt: string }> = [];
vi.mock('./calendar.js', () => ({
  readCalendar: (_ctx: unknown, range: { startAt: Date; endAt: Date }) => {
    ranges.push({ startAt: range.startAt.toISOString(), endAt: range.endAt.toISOString() });
    return calendarAnswer(range);
  },
}));

const TZ = 'America/Los_Angeles';
const DAY = '2026-10-12';
const NOW = new Date('2026-10-12T14:30:00Z');

function digest(db: Db, day: string, accounts: string[] = ['personal']): number {
  const result = db
    .prepare('INSERT INTO inbox_digests (day, runId, createdAt, accounts, shortText, items) VALUES (?, ?, ?, ?, ?, ?)')
    .run(day, `run-${day}`, `${day}T14:00:00.000Z`, JSON.stringify(accounts), `digest of ${day}`, '[]');
  return Number(result.lastInsertRowid);
}

function proposal(db: Db, title: string, state: string): void {
  db.prepare("INSERT INTO inbox_proposals (account, kind, title, startAt, allDay, dedupeKey, state, createdAt) VALUES ('school', 'course', ?, '2026-10-14', 1, ?, ?, ?)").run(
    title,
    title,
    state,
    NOW.toISOString(),
  );
}

function context(db: Db, aliases?: string[]): BriefContext {
  return {
    db,
    clock: () => NOW,
    logger: silentLogger,
    timeZone: TZ,
    ...(aliases ? { google: { accounts: { aliases } as never } } : {}),
    owner: { send: async () => true, chat: () => undefined },
    queue: createRunQueue(),
    dashboardUrl: 'http://127.0.0.1:7777',
    signal: new AbortController().signal,
    replan: () => {},
    newId: () => 'run-1',
  };
}

const read = (skipped: string[], configured = true): CalendarRead => ({
  configured,
  calendars: [],
  events: [],
  skipped: skipped.map((account) => ({ account, reason: `${account} is signed out.` })),
});

describe('brief sources', () => {
  beforeEach(() => {
    ranges.length = 0;
    calendarAnswer = async () => read([], false);
  });

  it('uses the newest digest of the day, else the newest older one, through the read api of the inbox', async () => {
    const db = openDb(':memory:');
    const digestOf = async () => (await gatherBriefInput(context(db), DAY)).inbox;
    expect(await digestOf()).toBeNull();
    const oldest = digest(db, '2026-10-10');
    expect(await digestOf()).toMatchObject({ digestId: oldest, stale: true });
    const before = digest(db, '2026-10-11');
    const older = digest(db, '2026-10-11');
    expect((await digestOf())?.digestId).toBe(older);
    expect(before).toBeLessThan(older);
    const today = digest(db, DAY, ['personal', 'school']);
    digest(db, '2026-10-13');
    expect(await digestOf()).toMatchObject({ digestId: today, day: DAY, stale: false, accounts: ['personal', 'school'] });
  });

  it('names the configured accounts that the digest did not read', async () => {
    const db = openDb(':memory:');
    digest(db, DAY, ['personal']);
    expect((await gatherBriefInput(context(db, ['personal', 'school']), DAY)).inbox?.unread).toEqual(['school']);
  });

  it('reads the calendar of the day and the week after it, the proposals and the goals of the day', async () => {
    const db = openDb(':memory:');
    const id = digest(db, '2026-10-11');
    proposal(db, 'Problem set 4 due', 'proposed');
    proposal(db, 'Old quiz', 'declined');
    addGoal(db, { day: DAY, title: 'finish essay', eta: '2026-10-13T04:00:00.000Z' }, NOW);
    addGoal(db, { day: '2026-10-13', title: 'not today' }, NOW);
    const input = await gatherBriefInput(context(db), DAY);
    // midnight of the day to midnight after the seventh day after it, in pdt.
    expect(ranges).toEqual([{ startAt: '2026-10-12T07:00:00.000Z', endAt: '2026-10-20T07:00:00.000Z' }]);
    expect(input.day).toBe(DAY);
    expect(input.timeZone).toBe(TZ);
    expect(input.now).toEqual(NOW);
    expect(input.events).toEqual([]);
    expect(input.sources).toEqual({ calendar: 'off', skipped: [], digest: { id, day: '2026-10-11' }, desk: true });
    expect(input.inbox?.digestId).toBe(id);
    expect(input.proposals.map((each) => [each.title, each.state])).toEqual([['Problem set 4 due', 'proposed']]);
    expect(input.delegations).toEqual([]);
    expect(input.goals).toEqual([{ id: 1, day: DAY, title: 'finish essay', eta: '2026-10-13T04:00:00.000Z', status: 'open', completedAt: null, note: null }]);
  });

  it('gives the state of the calendar from the accounts that were skipped', async () => {
    const db = openDb(':memory:');
    const state = async (aliases: string[], skipped: string[]) => {
      calendarAnswer = async () => read(skipped);
      return (await gatherBriefInput(context(db, aliases), DAY)).sources;
    };
    expect((await state(['personal', 'school'], [])).calendar).toBe('ok');
    expect(await state(['personal', 'school'], ['school'])).toMatchObject({ calendar: 'partial', skipped: [{ account: 'school', reason: 'school is signed out.' }] });
    expect((await state(['personal', 'school'], ['school', 'personal'])).calendar).toBe('failed');
    expect((await state([], [])).calendar).toBe('ok');
  });

  it('gives the names of the people memory for organizers that the calendar gave as an address', async () => {
    const db = openDb(':memory:');
    seedPeople(db);
    const event = (key: string, organizer: string | null, organizerSelf = false): CalendarEvent => ({ ...TODAY_EVENTS[0]!, key, organizer, organizerSelf });
    calendarAnswer = async () => ({
      ...read([]),
      events: [
        event('a', 'Maya@Northwind.example'),
        event('b', 'maya@northwind.example'),
        event('c', 'k.osei@fabrikam.example'),
        event('d', 'Tomas Okafor'),
        event('e', 'stranger@nowhere.example'),
        event('f', 'praman@berkeley.edu', true),
        event('g', null),
      ],
    });
    const input = await gatherBriefInput(context(db, ['personal']), DAY);
    // k.osei has no name, a display name is no address, and the owner's own events need no name.
    expect(input.organizerNames).toEqual({ 'maya@northwind.example': 'Maya Lindqvist' });
  });

  it('keeps the brief going when a source throws', async () => {
    const db = openDb(':memory:');
    calendarAnswer = async () => {
      throw new Error('the calendar broke');
    };
    const withGoogle = await gatherBriefInput(context(db, ['personal']), DAY);
    expect(withGoogle.sources).toEqual({ calendar: 'failed', skipped: [{ account: 'personal', reason: 'The calendar could not be read.' }], digest: null, desk: true });
    expect((await gatherBriefInput(context(db), DAY)).sources.calendar).toBe('off');
    db.exec('DROP TABLE inbox_proposals; DROP TABLE delegation_links; DROP TABLE delegation_nudges; DROP TABLE delegation_events; DROP TABLE delegations');
    const input = await gatherBriefInput(context(db), DAY);
    expect(input.proposals).toEqual([]);
    expect(input.goals).toEqual([]);
    // a desk that cannot be read gives null, so the page does not say that nothing waits.
    expect(input.delegations).toBeNull();
    expect(input.sources.desk).toBe(false);
  });
});
