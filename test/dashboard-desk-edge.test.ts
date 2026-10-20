import { describe, expect, it } from 'vitest';
import type { DelegationDetail, DeskBoard } from '../src/dashboard/desk-types.js';
import { DESK_CLOSED_LIMIT } from '../src/desk/shared.js';
import { createDelegation, updateDelegation } from '../src/desk/store.js';
import { seedDashboard } from './seed.js';

// edge cases of the desk routes against docs/API.md (T3): every input error, odd ids, a closed delegation, the auth
// and the json rules, an update that changes nothing, the append-only history and the cap of the closed columns.

type Dashboard = Awaited<ReturnType<typeof seedDashboard>>['dashboard'];

const post = (dashboard: Dashboard, path: string, body: unknown) =>
  dashboard.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) });

async function expectError(response: Response, status: number, error?: string | RegExp) {
  expect(response.status).toBe(status);
  const body = (await response.json()) as { error: unknown };
  expect(Object.keys(body)).toEqual(['error']);
  expect(typeof body.error).toBe('string');
  if (typeof error === 'string') expect(body.error).toBe(error);
  else if (error) expect(body.error).toMatch(error);
}

const historyCount = (t: Awaited<ReturnType<typeof seedDashboard>>['t']) => Number(t.db.prepare('SELECT COUNT(*) AS n FROM delegation_events').get()!.n);

describe('the desk routes with bad input', () => {
  it('gives 400 for a bad query', async () => {
    const { dashboard } = await seedDashboard();
    await expectError(await dashboard.request('/api/desk?status=later'), 400, 'use one of open, waiting, blocked, done, dropped');
    await expectError(await dashboard.request(`/api/desk?q=${'x'.repeat(201)}`), 400, 'give q as text of 1 to 200 characters');
    await expectError(await dashboard.request('/api/desk?q=%20%20'), 400, 'give q as text of 1 to 200 characters');
    await expectError(await dashboard.request(`/api/desk?person=${'p'.repeat(321)}`), 400);
    // 200 characters is still a query.
    expect((await dashboard.request(`/api/desk?q=${'x'.repeat(200)}`)).status).toBe(200);
  });

  it('gives 400 for each bad field of a create', async () => {
    const { t, dashboard } = await seedDashboard();
    const before = historyCount(t);
    const create = (body: unknown) => post(dashboard, '/api/desk/delegations', body);
    await expectError(await create({ title: 'x', owner: 'me' }), 400, 'leave out owner, because this request does not take it');
    await expectError(await create({ title: 'x', waitingOn: { email: 'not an email' } }), 400, 'give waitingOn.email as one plain email address');
    await expectError(await create({ title: 'x', waitingOn: { email: 'a@b.example, c@d.example' } }), 400, 'give waitingOn.email as one plain email address');
    await expectError(await create({ title: 'x', waitingOn: {} }), 400, 'give waitingOn a name or an email');
    await expectError(await create({ title: 'x', waitingOn: { name: '  ' } }), 400, 'give waitingOn a name or an email');
    await expectError(await create({ title: 'x', links: [{ kind: 'thread', ref: 't-1' }] }), 400, 'give a thread or an event link its google account');
    await expectError(await create({ title: 'x', links: [{ kind: 'event', ref: 'e-1', account: '' }] }), 400);
    await expectError(await create({ title: 'x', links: [{ kind: 'page', ref: 'p-1' }] }), 400, /give the link kind/);
    await expectError(await create({ title: 'x', links: Array.from({ length: 21 }, (_, i) => ({ kind: 'run', ref: `run-${i}` })) }), 400, 'give at most 20 links');
    await expectError(await create({ title: 'x'.repeat(201) }), 400, 'give title as text of 1 to 200 characters');
    await expectError(await create({ title: '   ' }), 400, 'give title as text of 1 to 200 characters');
    await expectError(await create({}), 400);
    await expectError(await create({ title: 'x', details: 'd'.repeat(4001) }), 400, 'give details as text of at most 4000 characters');
    await expectError(await create({ title: 'x', nextStep: 'n'.repeat(501) }), 400);
    await expectError(await create({ title: 'x', dueAt: '2026-02-30' }), 400, '2026-02-30 is not a day of the calendar');
    await expectError(await create({ title: 'x', dueAt: 'soon' }), 400, /is not a time/);
    await expectError(await create({ title: 'x', nextFollowUpAt: '2026-10-01' }), 400, 'the follow-up time is in the past');
    await expectError(await create({ title: 'x', nextFollowUpAt: t.clock().toISOString() }), 400, 'the follow-up time is in the past');
    await expectError(await create('[]'), 400, 'send a json object as the body');
    await expectError(await create('{"title":'), 400, 'send a json object as the body');
    // nothing was written.
    expect(historyCount(t)).toBe(before);
    expect(Number(t.db.prepare('SELECT COUNT(*) AS n FROM delegations').get()!.n)).toBe(8);
  });

  it('gives 400 for each bad field of an update', async () => {
    const { t, dashboard } = await seedDashboard();
    const before = historyCount(t);
    const update = (body: unknown) => post(dashboard, '/api/desk/delegations/2', body);
    await expectError(await update({ status: 'later' }), 400, 'use one of open, waiting, blocked, done, dropped');
    await expectError(await update({ status: 'waiting', waitingOn: null }), 400, 'a waiting delegation needs a person or an email to wait on');
    await expectError(await update({ note: '' }), 400, 'give note as text of 1 to 2000 characters');
    await expectError(await update({ note: 'n'.repeat(2001) }), 400);
    await expectError(await update({ title: null }), 400);
    await expectError(await update({ removeLinks: [{ kind: 'thread', ref: 't-lease', label: 'x' }] }), 400, 'leave out label, because this request does not take it');
    await expectError(await update({ dueAt: '2026-02-30' }), 400, '2026-02-30 is not a day of the calendar');
    await expectError(await update({ nextFollowUpAt: '2026-10-01 09:00' }), 400, 'the follow-up time is in the past');
    expect(historyCount(t)).toBe(before);
  });

  it('gives 404 for an id that names no delegation', async () => {
    const { dashboard } = await seedDashboard();
    for (const id of ['abc', '0', '99999999999999999999', '999', '01', '1e3', '-1']) {
      await expectError(await dashboard.request(`/api/desk/delegations/${id}`), 404, 'delegation not found');
      await expectError(await post(dashboard, `/api/desk/delegations/${id}`, { note: 'hello' }), 404, 'delegation not found');
    }
  });

  it('gives 409 for a follow-up time on a done delegation', async () => {
    const { t, dashboard } = await seedDashboard();
    const before = historyCount(t);
    await expectError(await post(dashboard, '/api/desk/delegations/5', { nextFollowUpAt: '2026-12-01' }), 409, 'delegation #5 is done, so it takes no follow-up time');
    expect(historyCount(t)).toBe(before);
  });
});

describe('the desk routes and the dashboard rules', () => {
  it('gives 415 for a write without json', async () => {
    const { dashboard } = await seedDashboard();
    const plain = await dashboard.request('/api/desk/delegations', { method: 'POST', body: '{"title":"x"}' });
    await expectError(plain, 415);
    const form = await dashboard.request('/api/desk/delegations/1', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{"note":"x"}' });
    await expectError(form, 415);
  });

  it('gives 401 without the token when the dashboard has one', async () => {
    const { t, dashboard } = await seedDashboard({ token: 'secret-token' });
    await expectError(await dashboard.request('/api/desk'), 401);
    await expectError(await dashboard.request('/api/desk/delegations/2'), 401);
    await expectError(await post(dashboard, '/api/desk/delegations', { title: 'x' }), 401);
    await expectError(await post(dashboard, '/api/desk/delegations/2', { note: 'x' }), 401);
    expect(Number(t.db.prepare('SELECT COUNT(*) AS n FROM delegations').get()!.n)).toBe(8);
    expect((await dashboard.request('/api/desk/delegations/2?token=secret-token')).status).toBe(200);
  });

  it('writes no history row for an update that changes nothing', async () => {
    const { t, dashboard } = await seedDashboard();
    const before = (await (await dashboard.request('/api/desk/delegations/2')).json()) as DelegationDetail;
    const count = historyCount(t);
    // the same values, an empty body, a link that is already there and a link that is not there change nothing.
    for (const body of [
      {},
      { title: before.title, status: 'waiting', waitingOn: { name: 'Dana Park', email: 'dana@landlord.example' } },
      { addLinks: [{ kind: 'thread', ref: 't-lease', account: 'personal' }], removeLinks: [{ kind: 'doc', ref: 'doc-9' }] },
    ]) {
      const response = await post(dashboard, '/api/desk/delegations/2', body);
      expect(response.status).toBe(200);
      const { history: _history, nudges: _nudges, ...row } = before;
      expect(await response.json()).toEqual(row);
    }
    expect(historyCount(t)).toBe(count);
  });

  it('keeps the history append-only', async () => {
    const { t } = await seedDashboard();
    expect(() => t.db.prepare("UPDATE delegation_events SET text = 'changed' WHERE delegationId = 2").run()).toThrow();
    expect(() => t.db.prepare('DELETE FROM delegation_events WHERE delegationId = 2').run()).toThrow();
    expect(historyCount(t)).toBeGreaterThan(0);
  });

  it('keeps the newest 50 rows of done and counts them all', async () => {
    const { t, dashboard } = await seedDashboard();
    const base = t.clock().getTime();
    for (let i = 1; i <= 60; i++) {
      const made = createDelegation(t.db, { title: `Old job ${i}`, createdBy: 'owner' }, { actor: 'owner' }, new Date(base + i * 1000));
      if (!made.ok) throw new Error(made.error);
      const done = updateDelegation(t.db, made.value.id, { status: 'done' }, { actor: 'owner' }, new Date(base + i * 1000 + 500));
      if (!done.ok) throw new Error(done.error);
    }
    const board = (await (await dashboard.request('/api/desk')).json()) as DeskBoard;
    const done = board.columns.find((column) => column.status === 'done')!;
    expect(done.delegations).toHaveLength(DESK_CLOSED_LIMIT);
    expect(done.total).toBe(61);
    // the newest close first: job 60 is id 68, and the seeded 5 closed before every one of them, so it is left out.
    expect(done.delegations[0]!.id).toBe(68);
    expect(done.delegations.at(-1)!.id).toBe(19);
    expect(done.delegations.some((each) => each.id === 5)).toBe(false);
    const filtered = (await (await dashboard.request('/api/desk?status=done&q=old%20job%205')).json()) as DeskBoard;
    expect(filtered.columns[3]!.delegations.map((each) => each.title)).toEqual(['Old job 59', 'Old job 58', 'Old job 57', 'Old job 56', 'Old job 55', 'Old job 54', 'Old job 53', 'Old job 52', 'Old job 51', 'Old job 50', 'Old job 5']);
    expect(filtered.columns[3]!.total).toBe(11);
  });

  it('gives a title with a script tag back as plain json text', async () => {
    const { dashboard } = await seedDashboard();
    const title = '<script>alert(1)</script> & "quotes"';
    const made = await post(dashboard, '/api/desk/delegations', { title });
    expect(made.status).toBe(201);
    const id = ((await made.json()) as { id: number }).id;
    const response = await dashboard.request(`/api/desk/delegations/${id}`);
    expect(response.headers.get('content-type')).toMatch(/^application\/json/);
    const raw = await response.text();
    expect(raw).toContain(JSON.stringify(title));
    expect((JSON.parse(raw) as DelegationDetail).title).toBe(title);
  });
});
