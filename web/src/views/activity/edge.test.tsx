// @vitest-environment jsdom
import { act, cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { seedDashboard } from '../../../../test/seed';
import { setPrefs } from '../../shell/prefs';
import { FakeEventSource, inMain, installEventSource, json, openApp, stubFetch } from '../../testing';
import { chatRow } from '../chats/testdata';

// the edge cases of the activity list: a kind in the hash that the contract does not have, the main chat, which is
// never activity, and a server error.

installEventSource();

let seeded: Awaited<ReturnType<typeof seedDashboard>>;

beforeEach(async () => {
  setPrefs({ theme: 'system', devMode: false, detailsHidden: false });
  seeded = await seedDashboard();
});
afterEach(() => cleanup());

// the chat list of the nav asks for the main chats with a limit, and the activity list asks with no limit.
const chats = (calls: Array<{ url: string }>) =>
  calls
    .filter((call) => call.url.startsWith('/api/chats?'))
    .map((call) => new URL(call.url, 'http://localhost').searchParams)
    .filter((query) => query.get('limit') === null);

describe('the activity list', () => {
  it('asks for every background kind for a kind it does not know, and for main', async () => {
    for (const kind of ['bogus', 'main', 'activity']) {
      const calls = stubFetch(seeded.dashboard, { 'GET /api/chats': () => ({ chats: [], nextCursor: null }) });
      openApp(`#/activity?kind=${kind}`);
      await waitFor(() => expect(chats(calls).length).toBeGreaterThan(0));
      expect(chats(calls).every((query) => query.get('kind') === 'activity'), kind).toBe(true);
      cleanup();
    }
  });

  it('sends a kind of the contract as it is', async () => {
    const calls = stubFetch(seeded.dashboard, {
      'GET /api/chats': () => ({ chats: [chatRow({ key: 'auto:daily', kind: 'auto', sessionKey: 'auto:daily', title: 'daily brief', channel: null })], nextCursor: null }),
    });
    openApp('#/activity?kind=auto');
    expect(await inMain().findByRole('link', { name: 'daily brief' })).toBeTruthy();
    expect(inMain().getByRole('link', { name: 'daily brief' }).getAttribute('href')).toBe('#/activity/auto%3Adaily');
    expect(chats(calls)[0]!.get('kind')).toBe('auto');
  });

  it('shows the error of the server', async () => {
    stubFetch(seeded.dashboard, { 'GET /api/chats': () => json({ error: 'give a known kind' }, 400) });
    openApp('#/activity');
    expect(await inMain().findByText(/give a known kind/)).toBeTruthy();
  });

  it('keeps the rows of Load more when a background run loads the list again', async () => {
    const all = Array.from({ length: 60 }, (_, index) =>
      chatRow({ key: `auto:job-${index}`, kind: 'auto', sessionKey: `auto:job-${index}`, title: `job ${index}`, channel: null }),
    );
    const calls = stubFetch(seeded.dashboard, {
      'GET /api/chats': ({ query }) => {
        if (query.get('kind') !== 'activity') return { chats: [], nextCursor: null };
        const start = query.get('cursor') ? 50 : 0;
        const limit = Number(query.get('limit') ?? 50);
        const rows = all.slice(start, start + limit);
        return { chats: rows, nextCursor: start + limit < all.length ? 'next' : null };
      },
    });
    openApp('#/activity');
    const table = () => within(inMain().getByRole('table', { name: 'background sessions' }));
    await inMain().findByRole('link', { name: 'job 0' });
    fireEvent.click(inMain().getByRole('button', { name: 'Load more' }));
    expect(await inMain().findByRole('link', { name: 'job 59' })).toBeTruthy();
    act(() =>
      FakeEventSource.find('/api/stream')!.emit({
        kind: 'run',
        run: { id: 'run-bg', sessionKey: 'auto:job-1', trigger: 'automation', slot: 'main', status: 'completed', startedAt: '2026-10-13T01:00:00.000Z', endedAt: '2026-10-13T01:00:01.000Z', error: null, costUsd: null, modelCalls: 0, toolCalls: 0 },
      }),
    );
    await waitFor(() => expect(calls.some((call) => call.url.includes('limit=60'))).toBe(true));
    expect(table().getByRole('link', { name: 'job 59' })).toBeTruthy();
    expect(table().getAllByRole('row')).toHaveLength(61);
  });
});
