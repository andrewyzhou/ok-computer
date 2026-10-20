import { describe, expect, it } from 'vitest';
import type { DocComment } from '../src/dashboard/docs-types.js';
import { listEvents } from '../src/events/log.js';
import { seedDashboard } from './seed.js';

type Dashboard = Awaited<ReturnType<typeof seedDashboard>>['dashboard'];

const post = (dashboard: Dashboard, path: string, body: unknown, headers: Record<string, string> = { 'content-type': 'application/json' }) =>
  dashboard.request(path, { method: 'POST', headers, body: JSON.stringify(body) });

async function error(response: Response | Promise<Response>, status: number): Promise<string> {
  const answer = await response;
  expect(answer.status).toBe(status);
  const body = (await answer.json()) as { error: string };
  expect(Object.keys(body)).toEqual(['error']);
  return body.error;
}

describe('POST /api/docs/:id/comments', () => {
  it('stores the comment, answers 201 and delivers it after the queue', async () => {
    const { t, dashboard, docs } = await seedDashboard();
    const response = await post(dashboard, `/api/docs/${docs.tripId}/comments`, { text: ' Move dinner to 20:00. ', version: 3, quote: 'the rooftop bar' });
    expect(response.status).toBe(201);
    const comment = (await response.json()) as DocComment;
    expect(comment).toMatchObject({ docId: docs.tripId, version: 3, text: 'Move dinner to 20:00.', quote: 'the rooftop bar', author: 'owner', sessionKey: 'main', eventId: null, deliveredAt: null });
    await t.app.idle();
    const row = t.db.prepare('SELECT eventId FROM doc_comment_deliveries WHERE commentId = ?').get(comment.id);
    const event = listEvents(t.db, 'main').find((each) => each.id === Number(row?.eventId));
    expect(event?.type).toBe('system_event');
    expect(JSON.stringify(event?.payload)).toContain('Move dinner to 20:00.');
    // the seed comments were stored after the app started, so only the new one went out.
    expect(t.db.prepare('SELECT count(*) AS n FROM doc_comment_deliveries').get()).toEqual({ n: 1 });
  });

  it('answers 400 for a bad body, with a sentence that names the limit', async () => {
    const { dashboard, docs } = await seedDashboard();
    const path = `/api/docs/${docs.tripId}/comments`;
    expect(await error(post(dashboard, path, { text: '   ', version: 3 }), 400)).toContain('4,000');
    expect(await error(post(dashboard, path, { text: 'a'.repeat(4001), version: 3 }), 400)).toBe('the comment has more than 4,000 characters');
    expect(await error(post(dashboard, path, { text: 'a', version: 3, quote: 'q'.repeat(501) }), 400)).toBe('the quote has more than 500 characters');
    expect(await error(post(dashboard, path, { text: 'a', version: 3, author: 'agent' }), 400)).toBe('leave out author, because this request does not take it');
    expect(await error(post(dashboard, path, { text: 'a', version: 0 }), 400)).toBe('give version as a whole number from 1');
    expect(await error(post(dashboard, path, { text: 'a', version: 1.5 }), 400)).toBe('give version as a whole number from 1');
    expect(await error(post(dashboard, path, { text: 'a' }), 400)).toContain('give version');
    expect(await error(post(dashboard, path, [1]), 400)).toBeTruthy();
  });

  it('answers 404 for a doc or a version that does not exist', async () => {
    const { dashboard, docs } = await seedDashboard();
    expect(await error(post(dashboard, '/api/docs/99/comments', { text: 'a', version: 1 }), 404)).toBe('doc not found');
    expect(await error(post(dashboard, '/api/docs/abc/comments', { text: 'a', version: 1 }), 404)).toBe('doc not found');
    expect(await error(post(dashboard, `/api/docs/${docs.tripId}/comments`, { text: 'a', version: 9 }), 404)).toBe('version not found');
  });

  it('answers 500 with json when the store throws', async () => {
    const { t, dashboard, docs } = await seedDashboard();
    t.app.docs.add = () => {
      throw new Error('database is locked');
    };
    expect(await error(post(dashboard, `/api/docs/${docs.tripId}/comments`, { text: 'a', version: 1 }), 500)).toBe('the comment could not be saved');
  });

  it('answers 415 without json and 401 without the token', async () => {
    const plain = await seedDashboard();
    expect(await error(post(plain.dashboard, `/api/docs/${plain.docs.tripId}/comments`, { text: 'a', version: 1 }, { 'content-type': 'text/plain' }), 415)).toBe('send a json body');
    const locked = await seedDashboard({ token: 'secret-token' });
    expect(await error(post(locked.dashboard, `/api/docs/${locked.docs.tripId}/comments`, { text: 'a', version: 1 }), 401)).toBe('unauthorized');
    expect(locked.t.db.prepare('SELECT count(*) AS n FROM doc_comments').get()).toEqual({ n: 2 });
  });
});
