import { afterEach, describe, expect, it } from 'vitest';
import type { CalendarPage } from '../src/dashboard/calendar-types.js';
import type { Db } from '../src/db/index.js';
import { CALENDAR_EMPTY, CALENDAR_FAILED, CALENDAR_OFF, CALENDAR_WEEK, TODAY_PROPOSALS } from './fixtures/today-data.js';
import { seedToday } from './seed-today.js';

// GET /api/calendar of the today track (phase 6 t1) against docs/API.md, on the week of test/fixtures/today-data.ts.

type Seeded = ReturnType<typeof seedToday>;
type Dashboard = Seeded['dashboard'];

let seeded: Seeded | undefined;
const seed = (options: Parameters<typeof seedToday>[0] = {}) => (seeded = seedToday(options));
afterEach(() => {
  seeded?.close();
  seeded = undefined;
});

async function get<T>(dashboard: Dashboard, path: string): Promise<T> {
  const response = await dashboard.request(path);
  expect(response.status, path).toBe(200);
  return (await response.json()) as T;
}

async function error(response: Response | Promise<Response>, status: number): Promise<string> {
  const answer = await response;
  expect(answer.status).toBe(status);
  const body = (await answer.json()) as { error: string };
  expect(Object.keys(body)).toEqual(['error']);
  return body.error;
}

type ProposalRow = [id: number, account: string, kind: string, title: string, startAt: string, endAt: string | null, allDay: number, state: string, approvalId: number | null];

// proposal rows as the digest writes them, in the form of test/seed-inbox.ts.
function insertProposals(db: Db, rows: ProposalRow[]): void {
  const insert = db.prepare(
    `INSERT INTO inbox_proposals (id, account, calendarId, kind, title, startAt, endAt, allDay, description, sourceMessageId, sourceSubject, dedupeKey, state,
       approvalId, eventId, error, runId, createdAt, resolvedAt)
     VALUES (?, ?, 'primary', ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, NULL, NULL, 'run-digest-1', '2026-10-12T14:00:00Z', NULL)`,
  );
  for (const [id, account, kind, title, startAt, endAt, allDay, state, approvalId] of rows) {
    insert.run(id, account, kind, title, startAt, endAt, allDay, `m-${id}`, title, `m-${id}:${kind}:${startAt}`, state, approvalId);
  }
}

// proposal 7 of the fixture: "Problem set 4 due", all day on wed 2026-10-14, waiting for approval 11.
const PROPOSAL_7: ProposalRow = [7, 'school', 'course', 'Problem set 4 due', '2026-10-14', null, 1, 'proposed', 11];

describe('the calendar week', () => {
  it('answers the seeded week with its conflicts, travel gaps, invites and proposals', async () => {
    const { dashboard, db, today } = seed();
    insertProposals(db, [PROPOSAL_7]);
    expect(await get<CalendarPage>(dashboard, '/api/calendar?from=2026-10-12')).toEqual(CALENDAR_WEEK);
    expect(today.ranges).toEqual([{ startAt: CALENDAR_WEEK.startAt, endAt: CALENDAR_WEEK.endAt }]);
  });

  it('starts today when from is left out', async () => {
    const { dashboard, db } = seed();
    insertProposals(db, [PROPOSAL_7]);
    expect(await get<CalendarPage>(dashboard, '/api/calendar')).toEqual(CALENDAR_WEEK);
  });

  it('shows only the proposed proposals that touch the range', async () => {
    const { dashboard, db } = seed();
    insertProposals(db, [
      PROPOSAL_7,
      // a timed proposal without an end covers 30 minutes, so 23:45 on the last day touches the range.
      [8, 'personal', 'bill', 'Rent due', '2026-10-19T06:45:00.000Z', null, 0, 'proposed', 12],
      // an all-day proposal stored as an iso time covers its local day: 2026-10-18 in los angeles.
      [9, 'school', 'other', 'Club fair', '2026-10-18T07:00:00.000Z', null, 1, 'proposed', null],
      // 23:59 on 2026-10-11 in los angeles, the day before the range.
      [10, 'school', 'course', 'Quiz 3', '2026-10-12T06:59:00.000Z', null, 1, 'proposed', 13],
      // after the range.
      [11, 'school', 'course', 'Midterm', '2026-10-19T07:00:00.000Z', '2026-10-19T09:00:00.000Z', 0, 'proposed', 14],
      // in the range, but the owner already decided them.
      [12, 'school', 'course', 'Lab 4 due', '2026-10-13', null, 1, 'approved', 15],
      [13, 'personal', 'other', 'Concert', '2026-10-16T03:00:00.000Z', '2026-10-16T05:00:00.000Z', 0, 'declined', null],
      // a timed proposal that ends when the range starts does not touch it.
      [14, 'personal', 'other', 'Late call', '2026-10-12T06:30:00.000Z', '2026-10-12T07:00:00.000Z', 0, 'proposed', null],
    ]);
    const page = await get<CalendarPage>(dashboard, '/api/calendar?from=2026-10-12');
    expect(page.proposals).toEqual([
      TODAY_PROPOSALS[0],
      { proposalId: 9, account: 'school', title: 'Club fair', kind: 'other', startAt: '2026-10-18T07:00:00.000Z', endAt: null, allDay: true, approvalId: null },
      { proposalId: 8, account: 'personal', title: 'Rent due', kind: 'bill', startAt: '2026-10-19T06:45:00.000Z', endAt: null, allDay: false, approvalId: 12 },
    ]);
  });

  it('answers the empty week', async () => {
    const { dashboard } = seed({ calendar: 'empty' });
    expect(await get<CalendarPage>(dashboard, '/api/calendar?from=2026-10-12')).toEqual(CALENDAR_EMPTY);
  });

  it('answers 200 with skipped when every account failed', async () => {
    const { dashboard } = seed({ calendar: 'failed' });
    expect(await get<CalendarPage>(dashboard, '/api/calendar?from=2026-10-12')).toEqual(CALENDAR_FAILED);
  });

  it('answers 200 with configured false without a google block', async () => {
    const { dashboard } = seed({ google: false });
    expect(await get<CalendarPage>(dashboard, '/api/calendar?from=2026-10-12')).toEqual(CALENDAR_OFF);
  });

  it('gives 500 when the calendar cannot be read at all', async () => {
    const { dashboard, today } = seed();
    today.calendar = async () => {
      throw new Error('the calendar code broke');
    };
    expect(await error(dashboard.request('/api/calendar?from=2026-10-12'), 500)).toBe('a row could not be read');
  });
});

describe('the range of the calendar', () => {
  it('clamps days to 1 to 14, and gives 7 for a value that is not a number', async () => {
    const { dashboard } = seed();
    const cases: Array<[string, number]> = [
      ['0', 1],
      ['-3', 1],
      ['1', 1],
      ['2.7', 2],
      ['14', 14],
      ['99', 14],
      ['abc', 7],
      ['', 7],
    ];
    for (const [days, count] of cases) {
      const page = await get<CalendarPage>(dashboard, `/api/calendar?from=2026-10-12&days=${days}`);
      expect(page.days.length, days).toBe(count);
      expect(page.days[0]).toBe('2026-10-12');
      expect(page.to).toBe(page.days.at(-1));
    }
  });

  it('answers one day with the events of that day only', async () => {
    const { dashboard, today } = seed();
    const page = await get<CalendarPage>(dashboard, '/api/calendar?from=2026-10-13&days=1');
    expect(page).toMatchObject({ from: '2026-10-13', to: '2026-10-13', days: ['2026-10-13'], startAt: '2026-10-13T07:00:00.000Z', endAt: '2026-10-14T07:00:00.000Z' });
    expect(page.events.map((event) => event.key)).toEqual(['school/primary/office']);
    expect(page.conflicts).toEqual([]);
    expect(page.travelGaps).toEqual([]);
    expect(page.invites).toEqual([]);
    expect(today.ranges).toEqual([{ startAt: '2026-10-13T07:00:00.000Z', endAt: '2026-10-14T07:00:00.000Z' }]);
  });

  it('gives 400 for a from that is not a date of the calendar', async () => {
    const { dashboard, today } = seed();
    for (const from of ['2026-02-30', '2026-13-01', 'today', '2026-10-1', '']) {
      expect(await error(dashboard.request(`/api/calendar?from=${from}`), 400), from).toBe('give from as yyyy-mm-dd');
    }
    expect(today.ranges).toEqual([]);
  });

  it('keeps local midnight across the end of daylight saving time', async () => {
    const { dashboard, today } = seed({ calendar: 'empty' });
    // 2026-11-01 is the day the clocks go back in los angeles, so the start is at utc-7 and the end at utc-8.
    const page = await get<CalendarPage>(dashboard, '/api/calendar?from=2026-10-30&days=4');
    expect(page).toMatchObject({
      from: '2026-10-30',
      to: '2026-11-02',
      days: ['2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02'],
      startAt: '2026-10-30T07:00:00.000Z',
      endAt: '2026-11-03T08:00:00.000Z',
      timeZone: 'America/Los_Angeles',
    });
    expect(today.ranges).toEqual([{ startAt: '2026-10-30T07:00:00.000Z', endAt: '2026-11-03T08:00:00.000Z' }]);
    const day = await get<CalendarPage>(dashboard, '/api/calendar?from=2026-11-01&days=1');
    expect([day.startAt, day.endAt]).toEqual(['2026-11-01T07:00:00.000Z', '2026-11-02T08:00:00.000Z']);
  });
});

describe('the auth of the calendar', () => {
  it('gives 401 with a token and no auth', async () => {
    const { dashboard, today } = seed({ token: 'secret' });
    expect((await dashboard.request('/api/calendar?from=2026-10-12')).status).toBe(401);
    expect(today.ranges).toEqual([]);
    expect((await dashboard.request('/api/calendar?from=2026-10-12', { headers: { authorization: 'Bearer secret' } })).status).toBe(200);
  });
});
