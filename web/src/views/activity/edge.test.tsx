// @vitest-environment jsdom
import { cleanup, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { seedDashboard } from '../../../../test/seed';
import { setPrefs } from '../../shell/prefs';
import { inMain, installEventSource, json, openApp, stubFetch } from '../../testing';
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
});
