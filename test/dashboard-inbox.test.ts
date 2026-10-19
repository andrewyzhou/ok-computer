import { afterEach, describe, expect, it } from 'vitest';
import { resolveApproval } from '../src/approvals/store.js';
import type { CalendarProposalView, DigestsPage, DraftView, InboxDigest, SendersPage, SubscriptionsPage } from '../src/dashboard/types.js';
import { inboxAutomation } from '../src/inbox/inbox.js';
import { NOW, seedInbox } from './seed-inbox.js';

type Dashboard = ReturnType<typeof seedInbox>['dashboard'];

let seeded: ReturnType<typeof seedInbox> | undefined;
const seed = (options: Parameters<typeof seedInbox>[0] = {}) => (seeded = seedInbox(options));
afterEach(() => {
  seeded?.close();
  seeded = undefined;
});

const post = (dashboard: Dashboard, path: string, body: unknown = {}) =>
  dashboard.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

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

describe('the inbox reads', () => {
  it('answers each list with its contract shape', async () => {
    const { dashboard } = seed();
    const senders = await get<SendersPage>(dashboard, '/api/inbox/senders');
    expect(senders).toMatchObject({ accounts: ['personal', 'school'], nextCursor: null, lastSweep: { runId: 'run-sweep-1' } });
    expect(senders.senders.map((sender) => sender.id)).toEqual([2, 1, 4, 3, 8, 6, 7, 5]);

    const subscriptions = await get<SubscriptionsPage>(dashboard, '/api/inbox/subscriptions');
    expect(subscriptions.subscriptions.map((row) => row.id)).toEqual([1, 3, 4, 6, 2, 5]);
    expect(subscriptions.monthlyTotals).toEqual([
      { currency: 'EUR', amount: 3.33 },
      { currency: 'USD', amount: 24.24 },
    ]);
    expect(subscriptions.lastScan).toEqual({ runId: 'run-scan-1', at: '2026-10-18T10:05:00Z' });

    const digests = await get<DigestsPage>(dashboard, '/api/inbox/digests');
    expect(digests).toEqual({ digests: [expect.objectContaining({ id: 3, items: 4 }), expect.objectContaining({ id: 2 }), expect.objectContaining({ id: 1 })], nextCursor: null });
    expect((await get<InboxDigest>(dashboard, '/api/inbox/digests/latest')).id).toBe(3);
    expect(await get<InboxDigest>(dashboard, '/api/inbox/digests/1')).toMatchObject({ id: 1, day: '2026-10-16', accounts: ['personal'], items: [{ section: 'bills' }] });

    const drafts = await get<DraftView[]>(dashboard, '/api/inbox/drafts?state=drafted');
    expect(drafts.map((draft) => [draft.id, draft.to])).toEqual([
      [2, ['ta@school.example', 'lee@school.example']],
      [1, ['help@bank-alerts.example']],
    ]);
    const proposals = await get<CalendarProposalView[]>(dashboard, '/api/inbox/proposals?account=school&before=4');
    expect(proposals.map((proposal) => [proposal.id, proposal.allDay])).toEqual([
      [2, false],
      [1, true],
    ]);
  });

  it('pages the senders and the digests with the cursor that it gave', async () => {
    const { dashboard } = seed();
    const seen: number[] = [];
    let path = '/api/inbox/senders?sort=readRate&limit=3';
    for (let pages = 0; pages < 5; pages++) {
      const page = await get<SendersPage>(dashboard, path);
      seen.push(...page.senders.map((sender) => sender.id));
      if (!page.nextCursor) break;
      path = `/api/inbox/senders?sort=readRate&limit=3&cursor=${encodeURIComponent(page.nextCursor)}`;
    }
    expect(seen).toEqual([1, 8, 6, 4, 2, 3, 7, 5]);
    const first = await get<DigestsPage>(dashboard, '/api/inbox/digests?limit=2');
    const second = await get<DigestsPage>(dashboard, `/api/inbox/digests?limit=2&cursor=${first.nextCursor}`);
    expect(second.digests.map((digest) => digest.id)).toEqual([1]);
  });

  it('clamps the limit, and a limit that is not a number gives the default', async () => {
    const { dashboard } = seed();
    expect((await get<SendersPage>(dashboard, '/api/inbox/senders?limit=0')).senders.length).toBe(1);
    expect((await get<SendersPage>(dashboard, '/api/inbox/senders?limit=-5')).senders.length).toBe(1);
    expect((await get<SendersPage>(dashboard, '/api/inbox/senders?limit=9999')).senders.length).toBe(8);
    expect((await get<SendersPage>(dashboard, '/api/inbox/senders?limit=many')).senders.length).toBe(8);
    expect((await get<SendersPage>(dashboard, '/api/inbox/senders?limit=2.7')).senders.length).toBe(2);
    expect((await get<DigestsPage>(dashboard, '/api/inbox/digests?limit=0')).digests.length).toBe(1);
    expect((await get<DigestsPage>(dashboard, '/api/inbox/digests?limit=abc')).digests.length).toBe(3);
    expect((await get<DraftView[]>(dashboard, '/api/inbox/drafts?limit=1')).length).toBe(1);
    expect((await get<DraftView[]>(dashboard, '/api/inbox/drafts?limit=x')).length).toBe(4);
    expect((await get<CalendarProposalView[]>(dashboard, '/api/inbox/proposals?limit=0')).length).toBe(1);
  });

  it('refuses a query that is not valid', async () => {
    const { dashboard } = seed();
    expect(await error(dashboard.request('/api/inbox/senders?account=work'), 400)).toBe('give account as one of: personal, school');
    expect(await error(dashboard.request('/api/inbox/subscriptions?account=work'), 400)).toBe('give account as one of: personal, school');
    expect(await error(dashboard.request('/api/inbox/drafts?account=work'), 400)).toBe('give account as one of: personal, school');
    expect(await error(dashboard.request('/api/inbox/senders?state=cancelled'), 400)).toContain('give state as one of: active, kept');
    expect(await error(dashboard.request('/api/inbox/subscriptions?state=kept'), 400)).toContain('give state as one of: active, cancel_pending');
    expect(await error(dashboard.request('/api/inbox/drafts?state=proposed'), 400)).toContain('give state as one of: drafted');
    expect(await error(dashboard.request('/api/inbox/proposals?state=drafted'), 400)).toContain('give state as one of: proposed');
    expect(await error(dashboard.request('/api/inbox/senders?sort=name'), 400)).toBe('give sort as one of: messages, readRate, lastAt');
    expect(await error(dashboard.request('/api/inbox/senders?cursor=garbage'), 400)).toBe('the cursor is not valid');
    expect(await error(dashboard.request('/api/inbox/digests?cursor=garbage'), 400)).toBe('the cursor is not valid');
    for (const before of ['0', '-1', 'x', '1.5']) {
      expect(await error(dashboard.request(`/api/inbox/drafts?before=${before}`), 400)).toBe('give before as a positive whole number');
      expect(await error(dashboard.request(`/api/inbox/proposals?before=${before}`), 400)).toBe('give before as a positive whole number');
    }
  });

  it('gives 404 for an unknown digest and for the latest digest of an empty database', async () => {
    const { dashboard } = seed();
    expect(await error(dashboard.request('/api/inbox/digests/99'), 404)).toBe('digest not found');
    expect(await error(dashboard.request('/api/inbox/digests/abc'), 404)).toBe('digest not found');
    expect(await error(dashboard.request('/api/inbox/digests/0'), 404)).toBe('digest not found');
    seeded!.close();
    const empty = seed({ empty: true });
    expect(await error(empty.dashboard.request('/api/inbox/digests/latest'), 404)).toBe('digest not found');
    expect(await get<SendersPage>(empty.dashboard, '/api/inbox/senders')).toEqual({ accounts: ['personal', 'school'], senders: [], nextCursor: null, lastSweep: null });
  });

  it('shows a sender as active again after its approval was denied', async () => {
    const { dashboard, db } = seed();
    const before = await get<SendersPage>(dashboard, '/api/inbox/senders?state=unsubscribe_pending');
    expect(before.senders.map((sender) => [sender.id, sender.approvalId])).toEqual([[4, 1]]);
    expect(resolveApproval(db, 1, 'deny', 'dashboard', NOW).ok).toBe(true);
    expect((await get<SendersPage>(dashboard, '/api/inbox/senders?state=unsubscribe_pending')).senders).toEqual([]);
    expect((await get<SendersPage>(dashboard, '/api/inbox/senders?state=active&account=school')).senders.map((sender) => sender.id)).toEqual([4, 7]);
  });

  it('settles a denied cancellation and a denied proposal before the read', async () => {
    const { dashboard, db } = seed();
    resolveApproval(db, 2, 'deny', 'dashboard', NOW);
    resolveApproval(db, 3, 'deny', 'dashboard', NOW);
    const subscriptions = await get<SubscriptionsPage>(dashboard, '/api/inbox/subscriptions');
    expect(subscriptions.subscriptions.find((row) => row.id === 2)?.state).toBe('active');
    const proposals = await get<CalendarProposalView[]>(dashboard, '/api/inbox/proposals');
    expect(proposals.find((proposal) => proposal.id === 1)).toMatchObject({ state: 'declined', resolvedAt: NOW.toISOString() });
  });
});

describe('the inbox auth', () => {
  it('needs the token when the dashboard has one', async () => {
    const { dashboard } = seed({ token: 'secret-token' });
    for (const path of ['/api/inbox/senders', '/api/inbox/subscriptions', '/api/inbox/digests', '/api/inbox/digests/latest', '/api/inbox/drafts', '/api/inbox/proposals']) {
      expect(await error(dashboard.request(path), 401)).toBe('unauthorized');
    }
    expect(await error(post(dashboard, '/api/inbox/senders/1/keep'), 401)).toBe('unauthorized');
    expect(await error(post(dashboard, '/api/inbox/run', { job: 'digest' }), 401)).toBe('unauthorized');
    const signedIn = await dashboard.request('/api/inbox/senders', { headers: { authorization: 'Bearer secret-token' } });
    expect(signedIn.status).toBe(200);
    expect(seeded!.inbox.calls).toEqual([]);
  });
});

describe('the inbox actions', () => {
  it('gives 415 for a post without a json body', async () => {
    const { dashboard, inbox } = seed();
    const response = await dashboard.request('/api/inbox/senders/1/unsubscribe', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' });
    expect(await error(response, 415)).toBe('send a json body');
    expect(await error(dashboard.request('/api/inbox/run', { method: 'POST', body: '{"job":"digest"}' }), 415)).toBe('send a json body');
    expect(inbox.calls).toEqual([]);
  });

  it('calls the inbox with the parsed arguments', async () => {
    const { dashboard, inbox } = seed();
    expect(await (await post(dashboard, '/api/inbox/senders/1/unsubscribe')).json()).toEqual({ status: 'pending_approval', approvalId: 99, message: 'unsubscribe waits for approval #99.' });
    expect((await post(dashboard, '/api/inbox/senders/2/archive')).status).toBe(200);
    expect((await post(dashboard, '/api/inbox/senders/2/archive', { olderThanDays: 0, label: 'Old news' })).status).toBe(200);
    expect(await (await post(dashboard, '/api/inbox/senders/3/keep')).json()).toEqual({ status: 'done', approvalId: null, message: 'keep is done.' });
    expect((await post(dashboard, '/api/inbox/subscriptions/1/cancel')).status).toBe(200);
    expect((await post(dashboard, '/api/inbox/subscriptions/4/ignore')).status).toBe(200);
    expect(inbox.calls).toEqual([
      { action: 'unsubscribe', id: 1 },
      { action: 'archive', id: 2, request: { olderThanDays: 30 } },
      { action: 'archive', id: 2, request: { olderThanDays: 0, label: 'Old news' } },
      { action: 'keep', id: 3 },
      { action: 'cancel', id: 1 },
      { action: 'ignore', id: 4 },
    ]);
  });

  it('maps an error of the inbox to its status', async () => {
    const { dashboard, inbox } = seed();
    inbox.results.unsubscribe = { ok: false, status: 409, error: 'the sender is already unsubscribed' };
    inbox.results.cancel = { ok: false, status: 404, error: 'subscription not found' };
    expect(await error(post(dashboard, '/api/inbox/senders/5/unsubscribe'), 409)).toBe('the sender is already unsubscribed');
    expect(await error(post(dashboard, '/api/inbox/subscriptions/77/cancel'), 404)).toBe('subscription not found');
  });

  it('gives 404 for an id that is not a positive whole number', async () => {
    const { dashboard, inbox } = seed();
    expect(await error(post(dashboard, '/api/inbox/senders/abc/keep'), 404)).toBe('sender not found');
    expect(await error(post(dashboard, '/api/inbox/senders/0/unsubscribe'), 404)).toBe('sender not found');
    expect(await error(post(dashboard, '/api/inbox/subscriptions/-1/ignore'), 404)).toBe('subscription not found');
    expect(inbox.calls).toEqual([]);
  });

  it('refuses a body that is not valid', async () => {
    const { dashboard, inbox } = seed();
    expect(await error(post(dashboard, '/api/inbox/senders/1/archive', { olderThanDays: 4000 }), 400)).toBe('give olderThanDays as a whole number from 0 to 3650');
    expect(await error(post(dashboard, '/api/inbox/senders/1/archive', { olderThanDays: 1.5 }), 400)).toBe('give olderThanDays as a whole number from 0 to 3650');
    expect(await error(post(dashboard, '/api/inbox/senders/1/archive', { olderThanDays: '30' }), 400)).toBe('give olderThanDays as a whole number from 0 to 3650');
    expect(await error(post(dashboard, '/api/inbox/senders/1/archive', { label: 'INBOX' }), 400)).toContain('not a gmail system label');
    expect(await error(post(dashboard, '/api/inbox/senders/1/archive', { label: 'category_promotions' }), 400)).toContain('not a gmail system label');
    expect(await error(post(dashboard, '/api/inbox/senders/1/archive', { label: 'news\nletters' }), 400)).toBe('give label on one line, without a line break');
    expect(await error(post(dashboard, '/api/inbox/senders/1/archive', { label: '' }), 400)).toBe('give label as text of 1 to 100 characters');
    expect(await error(post(dashboard, '/api/inbox/senders/1/archive', { label: 'x'.repeat(101) }), 400)).toBe('give label as text of 1 to 100 characters');
    expect(await error(post(dashboard, '/api/inbox/senders/1/archive', { days: 3 }), 400)).toContain('leave out days');
    expect(await error(post(dashboard, '/api/inbox/senders/1/keep', { force: true }), 400)).toContain('leave out force');
    expect(await error(dashboard.request('/api/inbox/senders/1/keep', { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'not json' }), 400)).toBe('send a json object as the body');
    expect(inbox.calls).toEqual([]);
  });

  it('gives 503 for each action without the google integration', async () => {
    const { dashboard } = seed({ inbox: false });
    for (const path of ['/api/inbox/senders/1/unsubscribe', '/api/inbox/senders/1/archive', '/api/inbox/senders/1/keep', '/api/inbox/subscriptions/1/cancel', '/api/inbox/subscriptions/1/ignore']) {
      expect(await error(post(dashboard, path), 503)).toBe('the inbox jobs need the google integration');
    }
    // the reads still answer from the tables.
    expect((await get<SendersPage>(dashboard, '/api/inbox/senders')).senders.length).toBe(8);
  });
});

describe('POST /api/inbox/run', () => {
  it('runs the automation of the job now', async () => {
    const { dashboard, db, runNow } = seed();
    const response = await post(dashboard, '/api/inbox/run', { job: 'newsletters' });
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ started: true });
    expect(runNow).toEqual([inboxAutomation(db, 'newsletters')!.id]);
    expect(await error(post(dashboard, '/api/inbox/run', { job: 'calendar' }), 400)).toBe('give job as one of: newsletters, subscriptions, digest');
    expect(await error(post(dashboard, '/api/inbox/run', {}), 400)).toBe('give job as one of: newsletters, subscriptions, digest');
  });

  it('gives 503 for POST /api/inbox/run without the google integration', async () => {
    const { dashboard, runNow } = seed({ inbox: false });
    expect(await error(post(dashboard, '/api/inbox/run', { job: 'digest' }), 503)).toBe('the inbox jobs need the google integration');
    expect(runNow).toEqual([]);
  });

  it('gives 409 while the job runs', async () => {
    const { dashboard, inbox, runNow } = seed();
    inbox.runningJobs.add('digest');
    expect(await error(post(dashboard, '/api/inbox/run', { job: 'digest' }), 409)).toBe('the digest job is already running');
    expect(runNow).toEqual([]);
  });

  it('gives 400 for a label with spaces around a system label', async () => {
    const { dashboard, inbox } = seed();
    expect(await error(post(dashboard, '/api/inbox/senders/1/archive', { label: ' INBOX ' }), 400)).toBe('give a label of your own, not a gmail system label such as INBOX or SPAM');
    expect(inbox.calls).toEqual([]);
  });

  it('gives 404 when the automation of the job is missing', async () => {
    const { dashboard, runNow } = seed({ jobs: false });
    expect(await error(post(dashboard, '/api/inbox/run', { job: 'digest' }), 404)).toBe('inbox automation not found');
    expect(runNow).toEqual([]);
  });
});
