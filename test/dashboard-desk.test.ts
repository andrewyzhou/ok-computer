import { describe, expect, it } from 'vitest';
import type { Delegation, DelegationDetail, DeskBoard } from '../src/dashboard/desk-types.js';
import { seedDashboard } from './seed.js';

// the desk routes of phase 6 t3 on the seeded dashboard. the ids, people and history come from the table at the top of
// test/seed-desk.ts.

type Dashboard = Awaited<ReturnType<typeof seedDashboard>>['dashboard'];

const post = (dashboard: Dashboard, path: string, body: unknown) =>
  dashboard.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

async function get<T>(dashboard: Dashboard, path: string): Promise<T> {
  const response = await dashboard.request(path);
  expect(response.status, path).toBe(200);
  return (await response.json()) as T;
}

const ids = (board: DeskBoard) => Object.fromEntries(board.columns.map((column) => [column.status, column.delegations.map((each) => each.id)]));
const totals = (board: DeskBoard) => Object.fromEntries(board.columns.map((column) => [column.status, column.total]));

describe('the desk board', () => {
  it('gives the five columns in order, each in its own order', async () => {
    const { dashboard } = await seedDashboard();
    const board = await get<DeskBoard>(dashboard, '/api/desk');
    expect(board.columns.map((column) => column.status)).toEqual(['open', 'waiting', 'blocked', 'done', 'dropped']);
    expect(ids(board)).toEqual({ open: [1, 7], waiting: [3, 2, 8], blocked: [4], done: [5], dropped: [6] });
    expect(totals(board)).toEqual({ open: 2, waiting: 3, blocked: 1, done: 1, dropped: 1 });
    const lease = board.columns[1]!.delegations.find((each) => each.id === 2)!;
    expect(lease.waitingOn).toEqual({ name: 'Dana Park', email: 'dana@landlord.example' });
    expect(lease.nextStep).toBe("Wait for Dana's reply with the new lease");
    expect(lease.nudgeCount).toBe(1);
    expect(lease.links).toEqual([{ kind: 'thread', ref: 't-lease', account: 'personal', label: 'Lease renewal', href: null }]);
  });

  it('lists the people of the active rows by name, and counts what is due today', async () => {
    const { dashboard } = await seedDashboard();
    const board = await get<DeskBoard>(dashboard, '/api/desk');
    expect(board.people).toEqual([
      { key: 'dana', name: 'Dana', email: null, active: 1 },
      { key: 'dana@landlord.example', name: 'Dana Park', email: 'dana@landlord.example', active: 1 },
      { key: 'front@dentist.example', name: null, email: 'front@dentist.example', active: 1 },
    ]);
    // 3 is a day overdue and its follow-up passed an hour ago. nothing else is due before tomorrow.
    expect(board.dueToday).toBe(1);
  });

  it('filters by status, by person and by text', async () => {
    const { dashboard } = await seedDashboard();
    const waiting = await get<DeskBoard>(dashboard, '/api/desk?status=waiting');
    expect(ids(waiting)).toEqual({ open: [], waiting: [3, 2, 8], blocked: [], done: [], dropped: [] });
    expect(totals(waiting)).toEqual({ open: 0, waiting: 3, blocked: 0, done: 0, dropped: 0 });
    // the filter does not change the people or the count of today.
    expect(waiting.people).toHaveLength(3);
    expect(waiting.dueToday).toBe(1);

    const dana = await get<DeskBoard>(dashboard, `/api/desk?person=${encodeURIComponent('dana@landlord.example')}`);
    expect(ids(dana)).toEqual({ open: [], waiting: [2], blocked: [], done: [], dropped: [] });
    expect(dana.people).toHaveLength(3);

    const text = await get<DeskBoard>(dashboard, '/api/desk?q=dana');
    expect(ids(text)).toEqual({ open: [], waiting: [2, 8], blocked: [], done: [], dropped: [] });
    expect(totals(text).waiting).toBe(2);
  });

  it('answers through the token middleware', async () => {
    const { dashboard } = await seedDashboard({ token: 'secret-token' });
    const response = await dashboard.request('/api/desk', { headers: { authorization: 'Bearer secret-token' } });
    expect(response.status).toBe(200);
    expect(ids((await response.json()) as DeskBoard).waiting).toEqual([3, 2, 8]);
  });
});

describe('a delegation', () => {
  it('gives the detail of 2 with its history and its nudge', async () => {
    const { dashboard } = await seedDashboard();
    const detail = await get<DelegationDetail>(dashboard, '/api/desk/delegations/2');
    expect(detail.title).toBe('Get the lease renewal from Dana');
    expect(detail.history.map((event) => event.kind)).toEqual(['created', 'link_added', 'follow_up_checked', 'nudge_drafted', 'note']);
    expect(detail.history.at(-1)).toMatchObject({ actor: 'owner', text: 'Dana said on the phone that the lease comes this week.' });
    expect(detail.nudges).toHaveLength(1);
    expect(detail.nudges[0]).toMatchObject({ gmailDraftId: 'd-nudge-1', toAddress: 'dana@landlord.example', threadId: 't-lease' });
  });

  it('is created by the owner with every field', async () => {
    const { t, dashboard } = await seedDashboard();
    const response = await post(dashboard, '/api/desk/delegations', {
      title: '  Get the car serviced  ',
      details: 'The oil light came on.',
      nextStep: 'Wait for the quote',
      waitingOn: { name: 'Sam', email: 'Sam@Garage.example' },
      dueAt: '2026-10-20',
      nextFollowUpAt: '2026-10-14 10:30',
      links: [
        { kind: 'run', ref: 'run-2', label: 'The chat' },
        { kind: 'thread', ref: 't-car', account: 'personal' },
      ],
    });
    expect(response.status).toBe(201);
    const made = (await response.json()) as Delegation;
    expect(made).toMatchObject({
      title: 'Get the car serviced',
      details: 'The oil light came on.',
      nextStep: 'Wait for the quote',
      status: 'waiting',
      waitingOn: { name: 'Sam', email: 'sam@garage.example' },
      waitingSince: t.clock().toISOString(),
      // the end of the day and a local time, in the time zone of the app (pacific daylight time).
      dueAt: '2026-10-21T06:59:00.000Z',
      nextFollowUpAt: '2026-10-14T17:30:00.000Z',
      createdBy: 'owner',
      sessionKey: null,
      runId: null,
    });
    expect(made.links.map((each) => [each.kind, each.ref, each.account, each.href])).toEqual([
      ['run', 'run-2', null, 'runs/run-2'],
      ['thread', 't-car', 'personal', null],
    ]);
    const detail = await get<DelegationDetail>(dashboard, `/api/desk/delegations/${made.id}`);
    expect(detail.history.map((event) => [event.kind, event.actor])).toEqual([
      ['created', 'owner'],
      ['link_added', 'owner'],
      ['link_added', 'owner'],
    ]);
    const board = await get<DeskBoard>(dashboard, '/api/desk?person=sam%40garage.example');
    expect(ids(board).waiting).toEqual([made.id]);
  });

  it('is closed, noted and relinked by the owner', async () => {
    const { t, dashboard } = await seedDashboard();
    const done = await post(dashboard, '/api/desk/delegations/1', { status: 'done', note: 'Booked both seats.' });
    expect(done.status).toBe(200);
    const closed = (await done.json()) as Delegation;
    expect(closed.status).toBe('done');
    expect(closed.closedAt).toBe(t.clock().toISOString());
    const board = await get<DeskBoard>(dashboard, '/api/desk');
    expect(ids(board).open).toEqual([7]);
    expect(ids(board).done).toEqual([1, 5]);

    const relinked = await post(dashboard, '/api/desk/delegations/4', {
      addLinks: [{ kind: 'doc', ref: 'doc-2', label: 'The photo rules' }],
      removeLinks: [{ kind: 'doc', ref: 'doc-1' }],
    });
    expect(relinked.status).toBe(200);
    expect(((await relinked.json()) as Delegation).links.map((each) => each.ref)).toEqual(['doc-2']);

    const one = await get<DelegationDetail>(dashboard, '/api/desk/delegations/1');
    expect(one.history.slice(-2).map((event) => [event.kind, event.actor, event.text])).toEqual([
      ['status', 'owner', null],
      ['note', 'owner', 'Booked both seats.'],
    ]);
    expect(one.history.at(-2)!.data).toEqual({ from: 'open', to: 'done' });
    const four = await get<DelegationDetail>(dashboard, '/api/desk/delegations/4');
    expect(four.history.slice(-2).map((event) => [event.kind, event.data.ref])).toEqual([
      ['link_removed', 'doc-1'],
      ['link_added', 'doc-2'],
    ]);
  });

  it('clears fields with null', async () => {
    const { dashboard } = await seedDashboard();
    const response = await post(dashboard, '/api/desk/delegations/2', { status: 'open', waitingOn: null, dueAt: null, nextFollowUpAt: null, nextStep: null });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: 'open', waitingOn: null, waitingSince: null, dueAt: null, nextFollowUpAt: null, nextStep: null });
  });
});
