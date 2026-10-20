import { afterEach, describe, expect, it } from 'vitest';
import type { AutonomyHistoryPage, AutonomyPage, AutonomySetResponse } from '../src/dashboard/autonomy-types.js';
import { createDashboard } from '../src/dashboard/server.js';
import type { Logger } from '../src/observability/logger.js';
import { silentLogger } from '../src/observability/logger.js';
import { DOMAINS, LEVEL_TEXT } from '../src/policy/autonomy.js';
import { changeLevel } from '../src/policy/autonomy-store.js';
import type { Rule } from '../src/policy/policy.js';
import { createTestApp } from './app-harness.js';

const NOW = new Date('2026-10-19T17:00:00Z');

// the autonomy routes on a fresh database. the app has no model steps, because the routes only read and write the
// autonomy tables.
function seed(options: { token?: string; rules?: Rule[] } = {}) {
  const t = createTestApp([], { start: NOW.toISOString() });
  const logged: Array<{ message: string; fields: unknown }> = [];
  const logger: Logger = { ...silentLogger, info: (message: string, fields?: unknown) => void logged.push({ message, fields }) };
  const dashboard = createDashboard({
    db: t.db,
    config: t.config,
    clock: () => NOW,
    logger,
    app: options.rules ? { ...t.app, rules: [...t.app.rules, ...options.rules] } : t.app,
    ...(options.token ? { token: options.token } : {}),
  });
  return { db: t.db, dashboard, logged, close: () => t.db.close() };
}

type Seeded = ReturnType<typeof seed>;
let seeded: Seeded | undefined;
const fresh = (options: { token?: string; rules?: Rule[] } = {}) => (seeded = seed(options));
afterEach(() => {
  seeded?.close();
  seeded = undefined;
});

const post = (dashboard: Seeded['dashboard'], path: string, body: unknown, headers: Record<string, string> = {}) =>
  dashboard.request(path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

async function get<T>(dashboard: Seeded['dashboard'], path: string): Promise<T> {
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

const count = (db: Seeded['db'], table: string) => Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n);

describe('GET /api/autonomy', () => {
  it('shows the 10 domains at their defaults with an empty history on a fresh database', async () => {
    const { dashboard } = fresh();
    const page = await get<AutonomyPage>(dashboard, '/api/autonomy');
    expect(page.domains.map((domain) => domain.id)).toEqual(DOMAINS.map((spec) => spec.id));
    expect(page.domains).toHaveLength(10);
    for (const [index, view] of page.domains.entries()) {
      const spec = DOMAINS[index]!;
      expect(view).toEqual({
        id: spec.id,
        label: spec.label,
        explanation: spec.explanation,
        tools: [...spec.tools],
        level: spec.defaultLevel,
        defaultLevel: spec.defaultLevel,
        maxLevel: spec.maxLevel,
        levels: expect.any(Array),
        fixed: spec.fixedReason !== null,
        fixedReason: spec.fixedReason,
        updatedAt: null,
        changeId: null,
        overriddenBy: null,
      });
    }
    const byId = Object.fromEntries(page.domains.map((domain) => [domain.id, domain]));
    expect(byId.mail_drafts!.levels).toEqual(['ask', 'review', 'auto']);
    expect(byId.browser_submits!.levels).toEqual(['ask', 'review']);
    expect(byId.purchases!).toMatchObject({ levels: ['ask'], fixed: true, level: 'ask' });
    expect(byId.calendar_guests!).toMatchObject({ levels: ['ask'], fixed: true });
    expect(byId.unsubscribes!).toMatchObject({ levels: ['ask'], fixed: true });
    expect(page.levelText).toEqual(LEVEL_TEXT);
    expect(page.history).toEqual([]);
    expect(page.before).toBeNull();
  });
});

describe('GET /api/autonomy with allow rules of the owner', () => {
  it('names the allow rule that lets the calls of a domain at its default level run without the review', async () => {
    const { dashboard, db } = fresh({
      rules: [
        { id: 'okc.policy.json#1', tool: 'google__gmail_draft', effect: 'allow' },
        { id: 'okc.policy.json#2', tool: 'google__calendar_*', effect: 'allow' },
        { id: 'okc.policy.json#3', tool: 'browser_submit', effect: 'allow' },
        { id: 'okc.policy.json#4', tool: 'google__gmail_label', effect: 'deny' },
      ],
    });
    const byId = async () => Object.fromEntries((await get<AutonomyPage>(dashboard, '/api/autonomy')).domains.map((domain) => [domain.id, domain.overriddenBy]));
    expect(await byId()).toEqual({
      mail_drafts: 'okc.policy.json#1',
      // a deny rule only adds checks.
      mail_labels: null,
      calendar_holds: 'okc.policy.json#2',
      // the tools of a domain whose default is ask always ask the owner, so an allow rule changes nothing there.
      calendar_guests: null,
      delegations: null,
      // the default of docs and notes is auto, so their calls run without the reviewer anyway.
      local_writes: null,
      browser_submits: null,
      unsubscribes: null,
      sandbox_network: null,
      purchases: null,
    });
    // a raised or a lowered level decides over the rule.
    changeLevel(db, { domain: 'mail_drafts', level: 'auto', actor: 'owner', via: 'dashboard' }, NOW);
    changeLevel(db, { domain: 'calendar_holds', level: 'ask', actor: 'owner', via: 'dashboard' }, NOW);
    expect(await byId()).toMatchObject({ mail_drafts: null, calendar_holds: null });
  });

  it('names a broad allow rule for every domain whose default is review', async () => {
    const { dashboard } = fresh({ rules: [{ id: 'okc.policy.json#1', tool: '*', effect: 'allow' }] });
    const page = await get<AutonomyPage>(dashboard, '/api/autonomy');
    expect(page.domains.filter((domain) => domain.overriddenBy !== null).map((domain) => domain.id)).toEqual(['mail_drafts', 'mail_labels', 'calendar_holds', 'delegations']);
  });
});

describe('POST /api/autonomy/:domain', () => {
  it('raises mail drafts from review to auto, and the page shows the level and the history row', async () => {
    const { dashboard, logged } = fresh();
    const response = await post(dashboard, '/api/autonomy/mail_drafts', { level: 'auto', from: 'review', note: 'drafts are fine' });
    expect(response.status).toBe(200);
    const answer = (await response.json()) as AutonomySetResponse;
    expect(answer.domain).toMatchObject({ id: 'mail_drafts', level: 'auto', updatedAt: NOW.toISOString(), changeId: answer.change!.id });
    expect(answer.change).toMatchObject({
      domain: 'mail_drafts',
      fromLevel: 'review',
      toLevel: 'auto',
      actor: 'owner',
      via: 'dashboard',
      runId: null,
      toolCallId: null,
      sessionKey: null,
      note: 'drafts are fine',
      createdAt: NOW.toISOString(),
    });
    expect(logged).toContainEqual({ message: 'autonomy level changed', fields: { domain: 'mail_drafts', from: 'review', to: 'auto' } });

    const page = await get<AutonomyPage>(dashboard, '/api/autonomy');
    expect(page.domains.find((domain) => domain.id === 'mail_drafts')).toMatchObject({ level: 'auto', changeId: answer.change!.id });
    expect(page.history).toEqual([answer.change]);
    expect(page.before).toBeNull();
  });

  it('lowers a level', async () => {
    const { dashboard } = fresh();
    const answer = (await (await post(dashboard, '/api/autonomy/calendar_holds', { level: 'ask', from: 'review' })).json()) as AutonomySetResponse;
    expect(answer.domain.level).toBe('ask');
    expect(answer.change).toMatchObject({ fromLevel: 'review', toLevel: 'ask', actor: 'owner', via: 'dashboard', note: null });
    const page = await get<AutonomyPage>(dashboard, '/api/autonomy');
    expect(page.domains.find((domain) => domain.id === 'calendar_holds')!.level).toBe('ask');
  });

  it('refuses a stale from with 409 and writes nothing', async () => {
    const { dashboard, db, logged } = fresh();
    expect(await error(post(dashboard, '/api/autonomy/mail_labels', { level: 'auto', from: 'ask' }), 409)).toContain('is at review now');
    expect(count(db, 'autonomy_changes')).toBe(0);
    expect(count(db, 'autonomy_levels')).toBe(0);
    expect(logged).toEqual([]);
  });

  it('keeps purchases at ask', async () => {
    const { dashboard, db } = fresh();
    expect(await error(post(dashboard, '/api/autonomy/purchases', { level: 'review', from: 'ask' }), 409)).toContain('always stays at ask');
    expect(count(db, 'autonomy_changes')).toBe(0);
  });

  it('refuses a level above the most of the domain', async () => {
    const { dashboard, db } = fresh();
    expect(await error(post(dashboard, '/api/autonomy/browser_submits', { level: 'auto', from: 'ask' }), 409)).toContain('can go up to review');
    expect(count(db, 'autonomy_changes')).toBe(0);
  });

  it('gives 404 for an unknown domain', async () => {
    const { dashboard } = fresh();
    expect(await error(post(dashboard, '/api/autonomy/everything', { level: 'auto', from: 'ask' }), 404)).toBe('autonomy domain not found');
    expect(await error(post(dashboard, '/api/autonomy/__proto__', { level: 'auto', from: 'ask' }), 404)).toBe('autonomy domain not found');
  });

  it('gives 400 for a body with extra keys, a missing from, a bad level or a long note', async () => {
    const { dashboard, db } = fresh();
    for (const body of [
      { level: 'auto', from: 'review', actor: 'agent' },
      { level: 'auto' },
      { level: 'max', from: 'review' },
      { level: 'auto', from: 'review', note: 'x'.repeat(501) },
      [],
    ]) {
      expect(await error(post(dashboard, '/api/autonomy/mail_drafts', body), 400)).toBe('send {level, from}');
    }
    const broken = await dashboard.request('/api/autonomy/mail_drafts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' });
    expect(await error(broken, 400)).toBe('send {level, from}');
    expect(count(db, 'autonomy_changes')).toBe(0);
  });

  it('gives 415 for a text or a form body', async () => {
    const { dashboard, db } = fresh();
    for (const [type, body] of [
      ['text/plain', JSON.stringify({ level: 'auto', from: 'review' })],
      ['application/x-www-form-urlencoded', 'level=auto&from=review'],
    ]) {
      const response = await dashboard.request('/api/autonomy/mail_drafts', { method: 'POST', headers: { 'content-type': type! }, body: body! });
      expect(response.status).toBe(415);
    }
    expect(count(db, 'autonomy_changes')).toBe(0);
  });

  it('answers 200 with change null for the level that is already set', async () => {
    const { dashboard, db, logged } = fresh();
    const response = await post(dashboard, '/api/autonomy/mail_drafts', { level: 'review', from: 'review' });
    expect(response.status).toBe(200);
    const answer = (await response.json()) as AutonomySetResponse;
    expect(answer.change).toBeNull();
    expect(answer.domain).toMatchObject({ id: 'mail_drafts', level: 'review', updatedAt: null, changeId: null });
    expect(count(db, 'autonomy_changes')).toBe(0);
    expect(logged).toEqual([]);
    // a fixed domain at ask is the same level too.
    expect(((await (await post(dashboard, '/api/autonomy/purchases', { level: 'ask', from: 'ask' })).json()) as AutonomySetResponse).change).toBeNull();
  });
});

describe('autonomy access', () => {
  it('needs the token for each route when DASHBOARD_TOKEN is set', async () => {
    const { dashboard, db } = fresh({ token: 'secret-token' });
    expect((await dashboard.request('/api/autonomy')).status).toBe(401);
    expect((await dashboard.request('/api/autonomy/history')).status).toBe(401);
    expect((await post(dashboard, '/api/autonomy/mail_drafts', { level: 'auto', from: 'review' })).status).toBe(401);
    expect((await post(dashboard, '/api/autonomy/mail_drafts', { level: 'auto', from: 'review' }, { authorization: 'Bearer wrong' })).status).toBe(401);
    expect(count(db, 'autonomy_changes')).toBe(0);

    const auth = { authorization: 'Bearer secret-token' };
    expect((await dashboard.request('/api/autonomy', { headers: auth })).status).toBe(200);
    expect((await post(dashboard, '/api/autonomy/mail_drafts', { level: 'auto', from: 'review' }, auth)).status).toBe(200);
    expect(count(db, 'autonomy_changes')).toBe(1);
  });
});

describe('GET /api/autonomy/history', () => {
  // writes n changes, each a flip of mail drafts between review and ask, and one of calendar holds at the end.
  function flips(db: Seeded['db'], n: number): void {
    let level: 'ask' | 'review' = 'review';
    for (let i = 0; i < n; i++) {
      const next: 'ask' | 'review' = level === 'review' ? 'ask' : 'review';
      changeLevel(db, { domain: 'mail_drafts', level: next, actor: 'owner', via: 'dashboard' }, new Date(NOW.getTime() + i * 1000));
      level = next;
    }
    changeLevel(db, { domain: 'calendar_holds', level: 'ask', actor: 'owner', via: 'dashboard' }, new Date(NOW.getTime() + n * 1000));
  }

  it('pages with before and limit, newest first', async () => {
    const { dashboard, db } = fresh();
    flips(db, 5);
    const first = await get<AutonomyHistoryPage>(dashboard, '/api/autonomy/history?limit=2');
    expect(first.changes.map((change) => change.id)).toEqual([6, 5]);
    expect(first.before).toBe(5);
    const second = await get<AutonomyHistoryPage>(dashboard, `/api/autonomy/history?limit=2&before=${first.before}`);
    expect(second.changes.map((change) => change.id)).toEqual([4, 3]);
    expect(second.before).toBe(3);
    const last = await get<AutonomyHistoryPage>(dashboard, '/api/autonomy/history?limit=2&before=3');
    expect(last.changes.map((change) => change.id)).toEqual([2, 1]);
    expect(last.before).toBeNull();
    expect(await get<AutonomyHistoryPage>(dashboard, '/api/autonomy/history?before=1')).toEqual({ changes: [], before: null });

    const drafts = await get<AutonomyHistoryPage>(dashboard, '/api/autonomy/history?domain=mail_drafts&limit=3');
    expect(drafts.changes.map((change) => change.id)).toEqual([5, 4, 3]);
    expect(drafts.changes.every((change) => change.domain === 'mail_drafts')).toBe(true);
    expect(drafts.before).toBe(3);
    expect((await get<AutonomyHistoryPage>(dashboard, '/api/autonomy/history?domain=calendar_holds')).changes.map((change) => change.id)).toEqual([6]);
  });

  it('clamps the limit to 1 to 200 with a default of 50, and the page has a first page of 50', async () => {
    const { dashboard, db } = fresh();
    flips(db, 250);
    expect((await get<AutonomyHistoryPage>(dashboard, '/api/autonomy/history')).changes).toHaveLength(50);
    expect((await get<AutonomyHistoryPage>(dashboard, '/api/autonomy/history?limit=many')).changes).toHaveLength(50);
    expect((await get<AutonomyHistoryPage>(dashboard, '/api/autonomy/history?limit=0')).changes).toHaveLength(1);
    const most = await get<AutonomyHistoryPage>(dashboard, '/api/autonomy/history?limit=1000');
    expect(most.changes).toHaveLength(200);
    expect(most.before).toBe(52);
    const tail = await get<AutonomyHistoryPage>(dashboard, '/api/autonomy/history?limit=200&before=52');
    expect(tail.changes).toHaveLength(51);
    expect(tail.before).toBeNull();
    // a full page of 200 with nothing older ends the paging too.
    expect((await get<AutonomyHistoryPage>(dashboard, '/api/autonomy/history?limit=200&before=201')).before).toBeNull();

    const page = await get<AutonomyPage>(dashboard, '/api/autonomy');
    expect(page.history).toHaveLength(50);
    expect(page.history[0]!.id).toBe(251);
    expect(page.before).toBe(202);
  });

  it('gives 400 for an unknown domain or a bad before', async () => {
    const { dashboard } = fresh();
    expect(await error(dashboard.request('/api/autonomy/history?domain=everything'), 400)).toBe(`domain must be one of ${DOMAINS.map((spec) => spec.id).join(', ')}`);
    for (const before of ['0', '-1', '1.5', 'abc']) {
      expect(await error(dashboard.request(`/api/autonomy/history?before=${before}`), 400)).toBe('before must be the id of a change');
    }
  });
});
