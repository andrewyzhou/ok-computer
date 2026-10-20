// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DeskBoard } from '../../../../src/dashboard/desk-types';
import { seedDashboard } from '../../../../test/seed';
import { setPrefs } from '../../shell/prefs';
import { FakeEventSource, inMain, installEventSource, openApp, stubFetch, type StubRoutes } from '../../testing';
import { FIXTURE_NOW, LONG_TITLE, board, delegation, delegations } from './fixtures';

// the edge cases of the desk board: a long title, html in a title, a closed column that the server cuts at 50, an
// unknown status in the hash, the reload on a run message of the stream, and the keyboard.

installEventSource();

let seeded: Awaited<ReturnType<typeof seedDashboard>>;

beforeEach(async () => {
  setPrefs({ theme: 'system', devMode: false, detailsHidden: false });
  seeded = await seedDashboard();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(FIXTURE_NOW);
});
afterEach(async () => {
  vi.useRealTimers();
  cleanup();
  await seeded.t.app.stop();
});

async function open(hash = '#/desk', routes: StubRoutes = { 'GET /api/desk': () => board() }) {
  const calls = stubFetch(seeded.dashboard, routes);
  openApp(hash);
  return calls;
}

const cardOf = (title: string) => inMain().getByText(title).closest('button') as HTMLButtonElement;
const deskCalls = (calls: Array<{ method: string; url: string }>) => calls.filter((call) => call.method === 'GET' && call.url.split('?')[0] === '/api/desk').map((call) => call.url);

describe('the desk board at its edges', () => {
  it('clamps a long title to two lines instead of stretching the card', async () => {
    await open();
    const title = await inMain().findByText(LONG_TITLE);
    expect(title.className).toContain('desk-clamp');
    expect(title.className).toContain('desk-card-title');
    expect(within(cardOf('Book the Denver flights')).getByText('Compare the morning flights on Oct 24').className).toContain('desk-clamp');
  });

  it('shows html in a title as text', async () => {
    const html = '<img src=x onerror=alert(1)>';
    await open('#/desk', { 'GET /api/desk': () => board([...delegations, delegation(9, { title: html, nextStep: '<b>bold</b>' })]) });
    expect(await inMain().findByText(html)).toBeTruthy();
    expect(inMain().getByText('<b>bold</b>')).toBeTruthy();
    expect(document.querySelector('main img')).toBeNull();
    expect(document.querySelector('main .desk-card b')).toBeNull();
  });

  it('says when a closed column shows only the newest 50 rows', async () => {
    const done = Array.from({ length: 50 }, (_, index) => delegation(100 + index, { title: `Closed ${index}`, status: 'done', closedAt: FIXTURE_NOW.toISOString() }));
    const full = board();
    const cut: DeskBoard = { ...full, columns: full.columns.map((column) => (column.status === 'done' ? { status: 'done', delegations: done, total: 73 } : column)) };
    await open('#/desk', { 'GET /api/desk': () => cut });
    expect(await inMain().findByText('Showing the newest 50 of 73')).toBeTruthy();
    expect(within(inMain().getByRole('list', { name: 'Done' })).getAllByRole('button').length).toBe(50);
    // the dropped column has all its rows, so it says nothing.
    expect(inMain().getAllByText(/^Showing the newest/).length).toBe(1);
    expect(screen.getByRole('button', { name: 'Show done and dropped (73 done, 1 dropped)' })).toBeTruthy();
  });

  it('ignores an unknown status in the hash', async () => {
    const calls = await open('#/desk?status=lost');
    await inMain().findByText('Book the Denver flights');
    expect(deskCalls(calls)).toEqual(['/api/desk']);
    expect(within(screen.getByRole('tablist', { name: 'status' })).getByRole('tab', { selected: true }).textContent).toBe('All8');
    expect(inMain().getAllByRole('heading', { level: 2 }).length).toBe(5);
    expect(screen.queryByRole('button', { name: 'Clear filters' })).toBeNull();
  });

  it('loads the board again when a run message comes on the stream', async () => {
    let title = 'Book the Denver flights';
    const calls = await open('#/desk', { 'GET /api/desk': () => board(delegations.map((each) => (each.id === 1 ? { ...each, title } : each))) });
    await inMain().findByText('Book the Denver flights');
    const before = deskCalls(calls).length;
    title = 'Book the Denver flights, two seats';
    FakeEventSource.find('/api/stream')!.emit({ kind: 'run', run: { id: 'run-9' } });
    expect(await inMain().findByText('Book the Denver flights, two seats')).toBeTruthy();
    expect(deskCalls(calls).length).toBe(before + 1);
  });

  it('selects a card from the keyboard', async () => {
    await open();
    await inMain().findByText('Renew the passport');
    const card = cardOf('Renew the passport');
    // the card is a native button, so the browser turns Enter and Space into a click. jsdom does not, so the test
    // sends the click that follows the key, as the browser does.
    expect(card.tagName).toBe('BUTTON');
    expect(card.getAttribute('type')).toBe('button');
    card.focus();
    expect(document.activeElement).toBe(card);
    fireEvent.keyDown(card, { key: 'Enter' });
    fireEvent.click(card);
    await waitFor(() => expect(location.hash).toBe('#/desk?id=4'));
    await waitFor(() => expect(cardOf('Renew the passport').getAttribute('aria-pressed')).toBe('true'));
  });

  it('opens the done and dropped columns when the selected card is in one of them', async () => {
    await open('#/desk?id=5');
    await inMain().findByText('Send the thank-you note to Prof. Lee');
    expect(document.querySelector('.desk-column.is-folded')).toBeNull();
    expect(screen.queryByRole('button', { name: /Show done and dropped/ })).toBeNull();
    expect(cardOf('Send the thank-you note to Prof. Lee').getAttribute('aria-pressed')).toBe('true');
  });

  it('folds the done and dropped columns of a narrow board behind a button with their counts', async () => {
    await open();
    await inMain().findByText('Book the Denver flights');
    expect(document.querySelectorAll('.desk-column.is-folded').length).toBe(2);
    const toggle = screen.getByRole('button', { name: 'Show done and dropped (1 done, 1 dropped)' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle);
    expect(document.querySelectorAll('.desk-column.is-folded').length).toBe(0);
    expect(screen.getByRole('button', { name: 'Hide done and dropped' }).getAttribute('aria-expanded')).toBe('true');
  });

  // the seeded server has no desk routes until the work package "dashboard routes" merges into the track, so this
  // test runs against the real seeded routes only after that merge. then remove the skip and check the seed of
  // test/seed-desk.ts, which matches the fixture.
  it.skip('shows the seeded delegations from the real routes', async () => {
    stubFetch(seeded.dashboard);
    vi.useRealTimers();
    openApp('#/desk');
    expect(await inMain().findByText('Book the Denver flights')).toBeTruthy();
    expect(inMain().getByText(LONG_TITLE)).toBeTruthy();
    expect(inMain().getAllByRole('heading', { level: 2 }).map((heading) => heading.textContent)).toEqual(['Open2', 'Waiting3', 'Needs you1', 'Done1', 'Dropped1']);
  });
});
