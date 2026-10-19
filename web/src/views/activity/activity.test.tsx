// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ChatRow } from '../../../../src/dashboard/types';
import { seedDashboard } from '../../../../test/seed';
import { setPrefs } from '../../shell/prefs';
import { inMain, installEventSource, json, openApp, stubFetch } from '../../testing';
import { chatRow, message } from '../chats/testdata';

installEventSource();

let seeded: Awaited<ReturnType<typeof seedDashboard>>;

beforeEach(async () => {
  setPrefs({ theme: 'system', devMode: false, detailsHidden: false });
  seeded = await seedDashboard();
});
afterEach(() => cleanup());

const ROWS: ChatRow[] = [
  chatRow({ key: 'heartbeat:2026-10-13', kind: 'heartbeat', sessionKey: 'heartbeat:2026-10-13', title: 'heartbeat', channel: null, lastRunStatus: 'completed' }),
  chatRow({ key: 'auto:goals-ask', kind: 'auto', sessionKey: 'auto:goals-ask', title: 'goals: ask', channel: null, lastRunStatus: 'failed', costUsd: 0.2 }),
];

function stubs() {
  return stubFetch(seeded.dashboard, {
    'GET /api/chats': ({ query }) => {
      const kind = query.get('kind');
      const q = query.get('q') ?? '';
      const rows = ROWS.filter((row) => (kind === 'activity' || row.kind === kind) && row.title.includes(q));
      return { chats: rows, nextCursor: kind === 'activity' && !query.get('cursor') && !q ? 'page-2' : null };
    },
    'GET /api/chats/:key/messages': ({ params }) => {
      const chat = ROWS.find((row) => row.key === params.key);
      if (!chat) return json({ error: 'chat not found' }, 404);
      return { chat, messages: [message({ id: 1, role: 'agent', text: 'checked the goals, nothing to say' })], before: null };
    },
  });
}

describe('the activity views', () => {
  it('lists the background sessions, binds the tab to ?kind= and pages with the cursor', async () => {
    const calls = stubs();
    openApp('#/activity');
    const table = await inMain().findByRole('table', { name: 'background sessions' });
    expect(within(table).getAllByRole('row')).toHaveLength(3);
    expect(within(table).getByText('failed')).toBeTruthy();
    expect(calls.some((call) => call.url === '/api/chats?kind=activity')).toBe(true);

    fireEvent.click(inMain().getByRole('button', { name: 'Load more' }));
    await waitFor(() => expect(calls.some((call) => call.url === '/api/chats?kind=activity&cursor=page-2')).toBe(true));

    fireEvent.click(inMain().getByRole('tab', { name: 'Heartbeat' }));
    await waitFor(() => expect(location.hash).toBe('#/activity?kind=heartbeat'));
    await waitFor(() => expect(within(inMain().getByRole('table', { name: 'background sessions' })).getAllByRole('row')).toHaveLength(2));
    expect(calls.some((call) => call.url === '/api/chats?kind=heartbeat')).toBe(true);
    expect(inMain().getByRole('tab', { name: 'Heartbeat' }).getAttribute('aria-selected')).toBe('true');

    fireEvent.change(inMain().getByRole('searchbox', { name: 'Search activity' }), { target: { value: 'nope' } });
    expect(await inMain().findByText('No session matches.')).toBeTruthy();
  });

  it('shows the facts of the selected session in the details panel with a link to its transcript', async () => {
    stubs();
    openApp('#/activity?kind=auto');
    const row = (await inMain().findByText('goals: ask')).closest('tr')!;
    fireEvent.click(row.querySelector('td:nth-child(2)')!);
    const details = (await screen.findByRole('heading', { level: 2, name: 'goals: ask' })).closest('.details-inner') as HTMLElement;
    expect(within(details).getByText('$0.20')).toBeTruthy();
    expect(within(details).getByRole('link', { name: 'Open the transcript' }).getAttribute('href')).toBe('#/activity/auto%3Agoals-ask');
  });

  it('opens a background transcript read-only, and says when it does not exist', async () => {
    stubs();
    openApp('#/activity/heartbeat%3A2026-10-13');
    expect(await inMain().findByText('checked the goals, nothing to say')).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1, name: 'heartbeat' })).toBeTruthy();
    expect(inMain().queryByRole('textbox', { name: 'Message' })).toBeNull();
    expect(inMain().getByText('A background session is read-only.')).toBeTruthy();
    const crumbs = within(screen.getByRole('navigation', { name: 'breadcrumb' }));
    expect(crumbs.getAllByRole('link', { name: 'Activity' })[0]!.getAttribute('href')).toBe('#/activity');
    cleanup();
    openApp('#/activity/auto%3Agone');
    expect(await inMain().findByText('This chat does not exist.')).toBeTruthy();
  });
});
