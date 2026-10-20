import { afterEach, describe, expect, it } from 'vitest';
import { installBrief } from '../src/brief/install.js';
import type { Brief, BriefSchedule, BriefsPage } from '../src/dashboard/brief-types.js';
import { BRIEF_FULL, BRIEF_QUIET, BRIEFS_PAGE, TODAY_NOW } from './fixtures/today-data.js';
import { seedToday } from './seed-today.js';

// the /api/briefs and /api/brief routes of the today track (phase 6 t1) against docs/API.md, on the briefs of
// test/fixtures/today-data.ts.

type Seeded = ReturnType<typeof seedToday>;
type Dashboard = Seeded['dashboard'];

let seeded: Seeded | undefined;
const seed = (options: Parameters<typeof seedToday>[0] = {}) => (seeded = seedToday(options));
afterEach(() => {
  seeded?.close();
  seeded = undefined;
});

const json = { 'content-type': 'application/json' };
const send = (dashboard: Dashboard, method: 'PUT' | 'POST', path: string, body: string) => dashboard.request(path, { method, headers: json, body });

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

describe('the stored briefs', () => {
  it('answers the latest brief, the brief of a day and a brief by id', async () => {
    const { dashboard } = seed();
    expect(await get<Brief>(dashboard, '/api/briefs/latest')).toEqual(BRIEF_FULL);
    expect(await get<Brief>(dashboard, '/api/briefs/day/2026-10-11')).toEqual(BRIEF_QUIET);
    expect(await get<Brief>(dashboard, '/api/briefs/day/2026-10-12')).toEqual(BRIEF_FULL);
    expect(await get<Brief>(dashboard, '/api/briefs/1')).toEqual(BRIEF_QUIET);
  });

  it('lists the briefs newest first', async () => {
    const { dashboard } = seed();
    expect(await get<BriefsPage>(dashboard, '/api/briefs')).toEqual(BRIEFS_PAGE);
  });

  it('pages the list with the cursor that it gave', async () => {
    const { dashboard } = seed();
    const first = await get<BriefsPage>(dashboard, '/api/briefs?limit=1');
    expect(first.briefs).toEqual([BRIEFS_PAGE.briefs[0]]);
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = await get<BriefsPage>(dashboard, `/api/briefs?limit=1&cursor=${encodeURIComponent(first.nextCursor!)}`);
    expect(second).toEqual({ briefs: [BRIEFS_PAGE.briefs[1]], nextCursor: null });
  });

  it('clamps the limit, and gives the default for a limit that is not a number', async () => {
    const { dashboard } = seed();
    expect((await get<BriefsPage>(dashboard, '/api/briefs?limit=0')).briefs.map((brief) => brief.id)).toEqual([2]);
    expect((await get<BriefsPage>(dashboard, '/api/briefs?limit=abc')).briefs.map((brief) => brief.id)).toEqual([2, 1]);
    expect((await get<BriefsPage>(dashboard, '/api/briefs?limit=500')).briefs.map((brief) => brief.id)).toEqual([2, 1]);
  });

  it('gives 400 for a cursor that it did not write', async () => {
    const { dashboard } = seed();
    for (const cursor of ['nope', '', Buffer.from('0').toString('base64url'), Buffer.from('-1').toString('base64url')]) {
      expect(await error(dashboard.request(`/api/briefs?cursor=${encodeURIComponent(cursor)}`), 400), cursor).toBe('give cursor as the nextCursor of the last page');
    }
  });

  it('gives 404 for a brief that does not exist', async () => {
    const { dashboard } = seed();
    for (const id of ['3', '0', '-1', '1e0', '01', 'abc', '99999999999999999']) {
      expect(await error(dashboard.request(`/api/briefs/${id}`), 404), id).toBe('brief not found');
    }
    expect(await error(dashboard.request('/api/briefs/day/2026-10-01'), 404)).toBe('brief not found');
  });

  it('gives 404 for latest when no brief exists yet', async () => {
    const { dashboard } = seed({ empty: true });
    expect(await error(dashboard.request('/api/briefs/latest'), 404)).toBe('brief not found');
    expect(await get<BriefsPage>(dashboard, '/api/briefs')).toEqual({ briefs: [], nextCursor: null });
  });

  it('gives 400 for a day that is not a date of the calendar', async () => {
    const { dashboard } = seed();
    for (const day of ['2026-02-30', '2026-13-01', '20261012', 'today', '2026-10-1']) {
      expect(await error(dashboard.request(`/api/briefs/day/${day}`), 400), day).toBe('give day as yyyy-mm-dd');
    }
  });

  it('gives 500 for a row whose content cannot be read', async () => {
    const { dashboard, db } = seed();
    db.prepare("INSERT INTO briefs (id, day, runId, createdAt, shortText, content) VALUES (3, '2026-10-13', NULL, ?, 'x', 'nope')").run(TODAY_NOW);
    expect(await error(dashboard.request('/api/briefs/3'), 500)).toBe('a row could not be read');
    expect(await error(dashboard.request('/api/briefs/latest'), 500)).toBe('a row could not be read');
    expect(await error(dashboard.request('/api/briefs/day/2026-10-13'), 500)).toBe('a row could not be read');
    // the list still shows the row, with no items, so the page can link to it.
    expect((await get<BriefsPage>(dashboard, '/api/briefs')).briefs[0]).toMatchObject({ id: 3, items: 0, sent: false });
  });
});

describe('the schedule of the brief', () => {
  it('answers the automation that the app made', async () => {
    const { dashboard, db, config } = seed();
    installBrief(db, config, new Date(TODAY_NOW));
    const schedule = await get<BriefSchedule>(dashboard, '/api/brief/schedule');
    expect(schedule).toMatchObject({ automationId: expect.any(String), time: '07:30', enabled: true, running: false });
    expect(schedule.nextRunAt).toEqual(expect.any(String));
  });

  it('moves the brief and answers the new schedule', async () => {
    const { dashboard, db, config } = seed();
    installBrief(db, config, new Date(TODAY_NOW));
    const response = await send(dashboard, 'PUT', '/api/brief/schedule', JSON.stringify({ time: '08:00' }));
    expect(response.status).toBe(200);
    const moved = (await response.json()) as BriefSchedule;
    // 08:00 on 2026-10-12 in los angeles is after the seeded 07:30, so the next run is the same day.
    expect(moved).toMatchObject({ time: '08:00', enabled: true, running: false, nextRunAt: '2026-10-12T15:00:00.000Z' });
    expect(await get<BriefSchedule>(dashboard, '/api/brief/schedule')).toEqual(moved);
  });

  it('makes the automation again when the owner deleted it', async () => {
    const { dashboard } = seed();
    const response = await send(dashboard, 'PUT', '/api/brief/schedule', JSON.stringify({ time: '06:45' }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ automationId: expect.any(String), time: '06:45', enabled: true });
  });

  it('gives 400 with one sentence for a bad body', async () => {
    const { dashboard, db, config } = seed();
    installBrief(db, config, new Date(TODAY_NOW));
    const bodies: Array<[string, string]> = [
      ['{"time":"24:00"}', 'give time as hh:mm, from 00:00 to 23:59'],
      ['{"time":"7:30"}', 'give time as hh:mm, from 00:00 to 23:59'],
      ['{"time":"07:60"}', 'give time as hh:mm, from 00:00 to 23:59'],
      ['{"time":"07:30:00"}', 'give time as hh:mm, from 00:00 to 23:59'],
      ['{"time":730}', 'give time as hh:mm, from 00:00 to 23:59'],
      ['{}', 'give time as hh:mm, from 00:00 to 23:59'],
      ['{"time":"07:30","enabled":false}', 'leave out enabled, because this request does not take it'],
      ['[]', 'send a json object as the body'],
      ['null', 'send a json object as the body'],
      ['not json', 'send a json object as the body'],
    ];
    for (const [body, sentence] of bodies) expect(await error(send(dashboard, 'PUT', '/api/brief/schedule', body), 400), body).toBe(sentence);
    expect((await get<BriefSchedule>(dashboard, '/api/brief/schedule')).time).toBe('07:30');
  });
});

describe('a brief now', () => {
  it('starts a brief and answers 202', async () => {
    const { dashboard, today } = seed();
    const response = await send(dashboard, 'POST', '/api/brief/run', '{}');
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ started: true });
    expect(today.briefRuns).toBe(1);
  });

  it('works without a google block', async () => {
    const { dashboard, today } = seed({ google: false });
    expect((await send(dashboard, 'POST', '/api/brief/run', '{}')).status).toBe(202);
    expect(today.briefRuns).toBe(1);
  });

  it('gives 409 while a brief builds', async () => {
    const { dashboard, today } = seed();
    today.running = () => true;
    expect(await error(send(dashboard, 'POST', '/api/brief/run', '{}'), 409)).toBe('a brief is being built now');
    expect(today.briefRuns).toBe(0);
  });

  it('answers 202 when the brief fails later, and the failure stays in the log', async () => {
    const { dashboard, today } = seed();
    today.runBrief = async () => {
      today.briefRuns++;
      throw new Error('the brief broke');
    };
    expect((await send(dashboard, 'POST', '/api/brief/run', '{}')).status).toBe(202);
    await new Promise((resolve) => setImmediate(resolve));
    expect(today.briefRuns).toBe(1);
  });

  it('gives 400 for a body with a key', async () => {
    const { dashboard, today } = seed();
    expect(await error(send(dashboard, 'POST', '/api/brief/run', '{"force":true}'), 400)).toBe('leave out force, because this request does not take it');
    expect(await error(send(dashboard, 'POST', '/api/brief/run', '[]'), 400)).toBe('send a json object as the body');
    expect(today.briefRuns).toBe(0);
  });
});

describe('the auth and the body rules', () => {
  const reads = ['/api/briefs', '/api/briefs/latest', '/api/briefs/day/2026-10-12', '/api/briefs/2', '/api/brief/schedule'];

  it('gives 401 on every route with a token and no auth', async () => {
    const { dashboard, today } = seed({ token: 'secret' });
    for (const path of reads) expect((await dashboard.request(path)).status, path).toBe(401);
    expect((await send(dashboard, 'PUT', '/api/brief/schedule', '{"time":"08:00"}')).status).toBe(401);
    expect((await send(dashboard, 'POST', '/api/brief/run', '{}')).status).toBe(401);
    expect(today.briefRuns).toBe(0);
    const signedIn = await dashboard.request('/api/briefs/latest', { headers: { authorization: 'Bearer secret' } });
    expect(signedIn.status).toBe(200);
  });

  it('gives 415 for a write without json', async () => {
    const { dashboard, today } = seed();
    expect((await dashboard.request('/api/brief/schedule', { method: 'PUT', body: '{"time":"08:00"}' })).status).toBe(415);
    expect((await dashboard.request('/api/brief/run', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' })).status).toBe(415);
    expect(today.briefRuns).toBe(0);
  });
});
