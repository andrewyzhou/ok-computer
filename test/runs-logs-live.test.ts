import { describe, expect, it } from 'vitest';
import type { BrowserLive, LogLine, RunRow } from '../src/dashboard/types.js';
import { seedBrowser } from './seed-browser.js';
import { seedDashboard } from './seed.js';
import { seedM1 } from './seed-m1.js';

type Dashboard = Awaited<ReturnType<typeof seedDashboard>>['dashboard'];

async function get<T>(dashboard: Dashboard, path: string): Promise<T> {
  const response = await dashboard.request(path);
  expect(response.status).toBe(200);
  return (await response.json()) as T;
}

describe('the runs of one session', () => {
  it('keeps the runs of the session key', async () => {
    const { dashboard } = await seedDashboard();
    const all = await get<RunRow[]>(dashboard, '/api/runs');
    const main = await get<RunRow[]>(dashboard, '/api/runs?sessionKey=main');
    expect(main.length).toBeGreaterThan(0);
    expect(main.every((run) => run.sessionKey === 'main')).toBe(true);
    expect(main.map((run) => run.id)).toEqual(all.filter((run) => run.sessionKey === 'main').map((run) => run.id));
    const heartbeat = all.find((run) => run.slot === 'heartbeat')!;
    expect(heartbeat.sessionKey).not.toBe('main');
    const own = await get<RunRow[]>(dashboard, `/api/runs?sessionKey=${encodeURIComponent(heartbeat.sessionKey)}`);
    expect(own.map((run) => run.id)).toEqual([heartbeat.id]);
  });
});

describe('the before paging of the runs', () => {
  // the runs of the seed start at the same or nearly the same time, so the rowid breaks the ties.
  it('gives every run once, in the order of the whole list', async () => {
    const { dashboard } = await seedDashboard();
    const all = await get<RunRow[]>(dashboard, '/api/runs');
    expect(all.length).toBeGreaterThan(2);
    const seen: string[] = [];
    let before: string | undefined;
    for (;;) {
      const page = await get<RunRow[]>(dashboard, `/api/runs?limit=2${before ? `&before=${before}` : ''}`);
      seen.push(...page.map((run) => run.id));
      if (page.length < 2) break;
      before = page[page.length - 1]!.id;
    }
    expect(seen).toEqual(all.map((run) => run.id));
  });

  it('answers 400 for a before that is not a run', async () => {
    const { dashboard } = await seedDashboard();
    expect((await dashboard.request('/api/runs?before=nosuch')).status).toBe(400);
  });
});

describe('the live browser tasks', () => {
  it('gives the open task with its latest step', async () => {
    const { dashboard, ids } = await seedM1();
    const live = await get<BrowserLive>(dashboard, '/api/browser/live');
    expect(live.tasks.map((task) => task.id)).toEqual(['bt_live']);
    expect(live.tasks[0]).toMatchObject({ steps: 2, allowlist: ['rail.example'], kind: 'task', sessionKey: 'main' });
    expect(live.tasks[0]!.latest).toMatchObject({
      id: ids.snapshotStep,
      action: 'snapshot',
      urlAfter: 'https://rail.example/times',
      target: 'https://rail.example/',
    });
  });

  it('gives no task when none is open', async () => {
    const { dashboard } = seedBrowser();
    expect(await get<BrowserLive>(dashboard, '/api/browser/live')).toEqual({ tasks: [] });
  });
});

describe('the logs of one run', () => {
  it('keeps the lines of the run id', async () => {
    const { dashboard } = await seedDashboard();
    const lines = await get<LogLine[]>(dashboard, '/api/logs?runId=run-3');
    expect(lines.map((line) => line.msg)).toEqual(['transient model error', 'model request failed']);
  });

  it('answers 400 for a day that is not yyyy-mm-dd', async () => {
    const { dashboard } = await seedDashboard();
    expect((await dashboard.request('/api/logs?day=12-10-2026')).status).toBe(400);
  });
});
