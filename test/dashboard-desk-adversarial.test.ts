import { Hono } from 'hono';
import { afterEach, describe, expect, it } from 'vitest';
import type { DelegationDetail, DeskBoard } from '../src/dashboard/desk-types.js';
import { mountDesk } from '../src/dashboard/desk.js';
import { openDb, type Db } from '../src/db/index.js';
import { createDelegation, listDelegationEvents } from '../src/desk/store.js';

// tests that try to break the desk routes on their own server, with a clock and a time zone of the test: odd json,
// day boundaries of the due count, hostile text, and requests at one time.

let db: Db | undefined;
afterEach(() => {
  db?.close();
  db = undefined;
});

function serve(options: { now?: string; timeZone?: string } = {}) {
  const target = (db = openDb(':memory:'));
  const clock = { now: new Date(options.now ?? '2026-10-20T17:00:00.000Z') };
  const server = new Hono();
  mountDesk(server, { db: target, config: { timeZone: options.timeZone ?? 'America/Los_Angeles' }, clock: () => clock.now } as never);
  const post = (path: string, body: unknown) =>
    server.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) });
  const board = async (query = '') => (await (await server.request(`/api/desk${query}`)).json()) as DeskBoard;
  return { db: target, clock, server, post, board };
}

const count = (target: Db, table: string) => Number(target.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n);

describe('the desk routes with odd json', () => {
  it('gives 400 for a body that is json but not an object, and writes nothing', async () => {
    const { db, post } = serve();
    for (const body of ['[]', '"x"', '42', 'null', 'true', '[{"title":"x"}]']) {
      const response = await post('/api/desk/delegations', body);
      expect(response.status, body).toBe(400);
    }
    expect(count(db, 'delegations')).toBe(0);
  });

  it('refuses a __proto__ or constructor key as a key that the request does not take', async () => {
    const { db, post } = serve();
    expect((await post('/api/desk/delegations', '{"title":"x","__proto__":{"status":"done"}}')).status).toBe(400);
    expect((await post('/api/desk/delegations', '{"title":"x","constructor":{"prototype":{"admin":true}}}')).status).toBe(400);
    expect(count(db, 'delegations')).toBe(0);
    expect(({} as Record<string, unknown>).admin).toBeUndefined();
  });

  it('refuses a status on create, so the owner cannot skip the rules of waiting', async () => {
    const { db, post } = serve();
    expect((await post('/api/desk/delegations', { title: 'x', status: 'done' })).status).toBe(400);
    expect(count(db, 'delegations')).toBe(0);
  });

  it('keeps a title with html, quotes and emoji as the same text in the answer and the detail', async () => {
    const { server, post } = serve();
    const title = `<img src=x onerror=alert(1)> "quoted" 'single' 🚀 ‮evil`;
    const created = await post('/api/desk/delegations', { title });
    expect(created.status).toBe(201);
    const body = (await created.json()) as DelegationDetail;
    expect(body.title).toBe(title);
    const detail = (await (await server.request(`/api/desk/delegations/${body.id}`)).json()) as DelegationDetail;
    expect(detail.title).toBe(title);
    expect(detail.history.map((each) => each.kind)).toEqual(['created']);
  });

  it('trims the title and refuses one of only spaces and line breaks', async () => {
    const { db, post } = serve();
    expect((await post('/api/desk/delegations', { title: ' \r\n\t ' })).status).toBe(400);
    const made = (await (await post('/api/desk/delegations', { title: '  Pay the rent \r\n' })).json()) as DelegationDetail;
    expect(made.title).toBe('Pay the rent');
    expect(count(db, 'delegations')).toBe(1);
  });

  it('refuses a waiting-on email with a header break or a list', async () => {
    const { db, post } = serve();
    for (const email of ['dana@landlord.example\r\nBcc: eve@evil.example', 'a@b.example, c@d.example', 'Dana <dana@landlord.example>']) {
      expect((await post('/api/desk/delegations', { title: 'x', waitingOn: { email } })).status, email).toBe(400);
    }
    expect(count(db, 'delegations')).toBe(0);
  });

  it('stores an email in lower case and starts a delegation with a person as waiting', async () => {
    const { post } = serve();
    const made = (await (await post('/api/desk/delegations', { title: 'x', waitingOn: { email: ' DANA@Landlord.Example ' } })).json()) as DelegationDetail;
    expect(made).toMatchObject({ status: 'waiting', waitingOn: { name: null, email: 'dana@landlord.example' }, createdBy: 'owner' });
  });

  it('writes owner rows in the history, with no run', async () => {
    const { db, post } = serve();
    const made = (await (await post('/api/desk/delegations', { title: 'x', links: [{ kind: 'doc', ref: '1' }] })).json()) as DelegationDetail;
    await post(`/api/desk/delegations/${made.id}`, { note: 'called them' });
    expect(listDelegationEvents(db, made.id).map((each) => [each.kind, each.actor, each.runId])).toEqual([
      ['created', 'owner', null],
      ['link_added', 'owner', null],
      ['note', 'owner', null],
    ]);
  });

  it('takes the times of the owner in the time zone of the app', async () => {
    const { post } = serve({ timeZone: 'Asia/Tokyo' });
    const made = (await (await post('/api/desk/delegations', { title: 'x', dueAt: '2026-10-22', nextFollowUpAt: '2026-10-22 08:30' })).json()) as DelegationDetail;
    expect(made.dueAt).toBe('2026-10-22T14:59:00.000Z');
    expect(made.nextFollowUpAt).toBe('2026-10-21T23:30:00.000Z');
  });

  it('refuses a follow-up at the exact time of now', async () => {
    const { post } = serve();
    expect((await post('/api/desk/delegations', { title: 'x', nextFollowUpAt: '2026-10-20T17:00:00.000Z' })).status).toBe(400);
    expect((await post('/api/desk/delegations', { title: 'x', nextFollowUpAt: '2026-10-20T17:00:00.001Z' })).status).toBe(201);
  });
});

describe('the due count of the desk at day boundaries', () => {
  const make = (target: Db, title: string, dueAt: string, now: Date) => {
    const made = createDelegation(target, { title, dueAt, createdBy: 'owner' }, { actor: 'owner' }, now);
    if (!made.ok) throw new Error(made.error);
  };

  it('counts what is due before the next local midnight, on the night the clocks go back', async () => {
    // saturday october 31 at 23:30 pdt. the local day ends at 00:00 pdt on november 1, which is 07:00 utc.
    const { db, clock, board } = serve({ now: '2026-11-01T06:30:00.000Z' });
    make(db, 'today', '2026-11-01T06:59:00.000Z', clock.now);
    make(db, 'after midnight', '2026-11-01T07:00:00.000Z', clock.now);
    expect((await board()).dueToday).toBe(1);
  });

  it('counts the whole sunday when the clocks went back, a day of 25 hours', async () => {
    // sunday november 1 at 00:30 pdt. the day ends at 00:00 pst on november 2, which is 08:00 utc.
    const { db, clock, board } = serve({ now: '2026-11-01T07:30:00.000Z' });
    make(db, 'late sunday', '2026-11-02T07:59:00.000Z', clock.now);
    make(db, 'monday', '2026-11-02T08:00:00.000Z', clock.now);
    expect((await board()).dueToday).toBe(1);
  });

  it('counts by the local day in tokyo, not the utc day', async () => {
    // 08:00 on october 21 in tokyo.
    const { db, clock, board } = serve({ now: '2026-10-20T23:00:00.000Z', timeZone: 'Asia/Tokyo' });
    make(db, 'tokyo today', '2026-10-21T14:59:00.000Z', clock.now);
    make(db, 'tokyo tomorrow', '2026-10-21T15:00:00.000Z', clock.now);
    expect((await board()).dueToday).toBe(1);
  });

  it('leaves closed rows out of the due count and the people', async () => {
    const { db, clock, post, board } = serve();
    const made = createDelegation(db, { title: 'x', dueAt: clock.now.toISOString(), waitingOn: { name: 'Dana' }, createdBy: 'owner' }, { actor: 'owner' }, clock.now);
    if (!made.ok) throw new Error(made.error);
    expect((await board()).dueToday).toBe(1);
    await post(`/api/desk/delegations/${made.value.id}`, { status: 'done' });
    const after = await board();
    expect(after.dueToday).toBe(0);
    expect(after.people).toEqual([]);
  });
});

describe('the desk board filters', () => {
  it('matches % and _ in q as plain characters', async () => {
    const { post, board } = serve();
    await post('/api/desk/delegations', { title: 'Pay 100% of it' });
    await post('/api/desk/delegations', { title: 'Pay 100 of it' });
    const open = (await board(`?q=${encodeURIComponent('100%')}`)).columns.find((each) => each.status === 'open')!;
    expect(open.delegations.map((each) => each.title)).toEqual(['Pay 100% of it']);
    expect(open.total).toBe(1);
  });

  it('gives the same rows and totals for a status filter', async () => {
    const { post, board } = serve();
    await post('/api/desk/delegations', { title: 'a' });
    await post('/api/desk/delegations', { title: 'b', waitingOn: { name: 'Dana' } });
    const result = await board('?status=waiting');
    expect(result.columns.map((each) => [each.status, each.total, each.delegations.length])).toEqual([
      ['open', 0, 0],
      ['waiting', 1, 1],
      ['blocked', 0, 0],
      ['done', 0, 0],
      ['dropped', 0, 0],
    ]);
  });
});

describe('the desk routes at one time', () => {
  it('writes every note of many parallel requests, each with its own history row', async () => {
    const { db, post } = serve();
    const made = (await (await post('/api/desk/delegations', { title: 'x' })).json()) as DelegationDetail;
    const responses = await Promise.all(Array.from({ length: 20 }, (_, i) => post(`/api/desk/delegations/${made.id}`, { note: `note ${i}` })));
    expect(responses.every((each) => each.status === 200)).toBe(true);
    expect(listDelegationEvents(db, made.id).filter((each) => each.kind === 'note')).toHaveLength(20);
  });

  it('adds one link when two requests add the same link at one time', async () => {
    const { db, post } = serve();
    const made = (await (await post('/api/desk/delegations', { title: 'x' })).json()) as DelegationDetail;
    const link = { kind: 'thread', ref: 't-1', account: 'personal' };
    await Promise.all([post(`/api/desk/delegations/${made.id}`, { addLinks: [link] }), post(`/api/desk/delegations/${made.id}`, { addLinks: [link] })]);
    expect(count(db, 'delegation_links')).toBe(1);
    expect(listDelegationEvents(db, made.id).filter((each) => each.kind === 'link_added')).toHaveLength(1);
  });
});
