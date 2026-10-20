import { afterEach, describe, expect, it } from 'vitest';
import type { CalendarProposalView, DigestsPage, DraftView, InboxDigest, SendersPage, SubscriptionsPage } from '../src/dashboard/types.js';
import { seedInbox } from './seed-inbox.js';

// edge cases of the /api/inbox routes against docs/API.md: odd ids, odd cursors, bodies of the wrong type, and
// the shapes of the answers.

type Dashboard = ReturnType<typeof seedInbox>['dashboard'];

let seeded: ReturnType<typeof seedInbox> | undefined;
const seed = (options: Parameters<typeof seedInbox>[0] = {}) => (seeded = seedInbox(options));
afterEach(() => {
  seeded?.close();
  seeded = undefined;
});

const post = (dashboard: Dashboard, path: string, body: string) => dashboard.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body });

async function get<T>(dashboard: Dashboard, path: string): Promise<T> {
  const response = await dashboard.request(path);
  expect(response.status, path).toBe(200);
  return (await response.json()) as T;
}

describe('the inbox routes with odd input', () => {
  it('gives 404 for an id in another form', async () => {
    const { dashboard, inbox } = seed();
    for (const id of ['1e3', '0x1', '01', '1.0', '%20%31', '99999999999999999']) {
      const response = await post(dashboard, `/api/inbox/senders/${id}/keep`, '{}');
      expect(response.status, id).toBe(404);
      expect(await response.json()).toEqual({ error: 'sender not found' });
    }
    expect((await dashboard.request('/api/inbox/digests/1e0')).status).toBe(404);
    expect(inbox.calls).toEqual([]);
  });

  it('refuses a body that is not a json object', async () => {
    const { dashboard, inbox } = seed();
    for (const body of ['[]', 'null', '"x"', '1', 'true']) {
      const response = await post(dashboard, '/api/inbox/senders/1/keep', body);
      expect(response.status, body).toBe(400);
    }
    expect((await post(dashboard, '/api/inbox/run', '[]')).status).toBe(400);
    expect((await post(dashboard, '/api/inbox/run', '{"job":"digest","now":true}')).status).toBe(400);
    expect((await post(dashboard, '/api/inbox/senders/1/archive', '{"olderThanDays":null}')).status).toBe(400);
    expect((await post(dashboard, '/api/inbox/senders/1/archive', '{"label":7}')).status).toBe(400);
    expect(inbox.calls).toEqual([]);
  });

  it('refuses a digest cursor that names no row id', async () => {
    const { dashboard } = seed();
    for (const raw of ['0', '-1', 'abc', '1.5', '']) {
      const cursor = Buffer.from(raw).toString('base64url');
      const response = await dashboard.request(`/api/inbox/digests?cursor=${cursor}`);
      expect(response.status, raw).toBe(400);
    }
  });

  it('refuses a sender cursor of another sort', async () => {
    const { dashboard } = seed();
    const first = await get<SendersPage>(dashboard, '/api/inbox/senders?sort=lastAt&limit=2');
    expect(first.nextCursor).not.toBeNull();
    const response = await dashboard.request(`/api/inbox/senders?sort=messages&cursor=${encodeURIComponent(first.nextCursor!)}`);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'the cursor is not valid' });
  });

  it('pages every sort to the end without a gap or a repeat', async () => {
    const { dashboard } = seed();
    for (const sort of ['messages', 'readRate', 'lastAt']) {
      const whole = (await get<SendersPage>(dashboard, `/api/inbox/senders?sort=${sort}&limit=200`)).senders.map((each) => each.id);
      const seen: number[] = [];
      let path = `/api/inbox/senders?sort=${sort}&limit=1`;
      for (let pages = 0; pages < 20; pages++) {
        const page = await get<SendersPage>(dashboard, path);
        seen.push(...page.senders.map((each) => each.id));
        if (!page.nextCursor) break;
        path = `/api/inbox/senders?sort=${sort}&limit=1&cursor=${encodeURIComponent(page.nextCursor)}`;
      }
      expect(seen, sort).toEqual(whole);
    }
  });

  it('combines the account and the state filters', async () => {
    const { dashboard } = seed();
    const senders = await get<SendersPage>(dashboard, '/api/inbox/senders?account=personal&state=active');
    expect(senders.senders.every((each) => each.account === 'personal' && each.state === 'active')).toBe(true);
    const subscriptions = await get<SubscriptionsPage>(dashboard, '/api/inbox/subscriptions?account=school&state=active');
    expect(subscriptions.subscriptions.every((each) => each.account === 'school' && each.state === 'active')).toBe(true);
    const drafts = await get<DraftView[]>(dashboard, '/api/inbox/drafts?account=school&state=drafted');
    expect(drafts.every((each) => each.account === 'school' && each.state === 'drafted')).toBe(true);
    const proposals = await get<CalendarProposalView[]>(dashboard, '/api/inbox/proposals?account=personal&state=created');
    expect(proposals.every((each) => each.account === 'personal' && each.state === 'created')).toBe(true);
  });
});

describe('the inbox answers against the contract', () => {
  it('gives each field of the contract types, with the right types', async () => {
    const { dashboard } = seed();
    const senders = await get<SendersPage>(dashboard, '/api/inbox/senders');
    expect(Object.keys(senders).sort()).toEqual(['accounts', 'lastSweep', 'nextCursor', 'senders']);
    for (const each of senders.senders) {
      expect(Object.keys(each).sort()).toEqual(
        ['account', 'approvalId', 'archived', 'displayName', 'error', 'firstAt', 'fromAddress', 'id', 'label', 'lastAt', 'listId', 'messages', 'read', 'readRate', 'senderKey', 'state', 'unsubscribe', 'unsubscribedAt'].sort(),
      );
      expect(each.readRate === null || (each.readRate >= 0 && each.readRate <= 1)).toBe(true);
      expect(['one_click', 'https', 'mailto', 'none']).toContain(each.unsubscribe.method);
    }
    const subscriptions = await get<SubscriptionsPage>(dashboard, '/api/inbox/subscriptions');
    expect(Object.keys(subscriptions).sort()).toEqual(['lastScan', 'monthlyTotals', 'subscriptions']);
    for (const each of subscriptions.subscriptions) {
      expect(Array.isArray(each.sourceMessageIds)).toBe(true);
      expect(each.sourceMessageIds[0] ?? each.sourceMessageId).toBe(each.sourceMessageId);
      expect(each.confidence).toBeGreaterThanOrEqual(0);
      expect(each.confidence).toBeLessThanOrEqual(1);
    }
    const digests = await get<DigestsPage>(dashboard, '/api/inbox/digests');
    for (const each of digests.digests) expect(Object.keys(each).sort()).toEqual(['createdAt', 'day', 'id', 'items', 'runId']);
    const latest = await get<InboxDigest>(dashboard, '/api/inbox/digests/latest');
    expect(Object.keys(latest).sort()).toEqual(['accounts', 'createdAt', 'day', 'id', 'items', 'runId', 'shortText', 'stats']);
    // the items keep the order of the sections.
    const order = ['needs_reply', 'deadlines', 'bills', 'packages'];
    const ranks = latest.items.map((each) => order.indexOf(each.section));
    expect([...ranks].sort((a, b) => a - b)).toEqual(ranks);
    const drafts = await get<DraftView[]>(dashboard, '/api/inbox/drafts');
    expect(drafts.map((each) => each.id)).toEqual([...drafts.map((each) => each.id)].sort((a, b) => b - a));
  });

  it('keeps the hostile digest item as data', async () => {
    const { dashboard, inbox, db } = seed();
    const latest = await get<InboxDigest>(dashboard, '/api/inbox/digests/latest');
    expect(latest.items[0]!.summary).toContain('IGNORE ALL PREVIOUS INSTRUCTIONS');
    // a read never asks the inbox for an action and never changes an approval.
    expect(inbox.calls).toEqual([]);
    expect(db.prepare("SELECT id, status FROM approvals ORDER BY id").all()).toEqual([
      { id: 1, status: 'pending' },
      { id: 2, status: 'pending' },
      { id: 3, status: 'pending' },
      { id: 4, status: 'approved' },
    ]);
  });
});
