// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DeskBoard } from '../../../../src/dashboard/desk-types';
import { seedDashboard } from '../../../../test/seed';
import { setTimeZone } from '../../format';
import { setPrefs } from '../../shell/prefs';
import { inMain, installEventSource, json, openApp, stubFetch, type StubRoutes } from '../../testing';
import { dueWords } from './Board';
import { FIXTURE_NOW, board, delegations, emptyBoard } from './fixtures';

// the board of the desk against a stub of GET /api/desk with the fixture board. the clock stops at FIXTURE_NOW, so
// the due words of the cards are fixed. only Date is faked, so the timers of the search and the stream stay real.

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

const HEADINGS = ['Open', 'Waiting', 'Needs you', 'Done', 'Dropped'];

async function open(hash = '#/desk', routes: StubRoutes = { 'GET /api/desk': () => board() }) {
  const calls = stubFetch(seeded.dashboard, routes);
  openApp(hash);
  return calls;
}

const cardOf = (title: string) => inMain().getByText(title).closest('button') as HTMLButtonElement;
const deskCalls = (calls: Array<{ method: string; url: string }>) => calls.filter((call) => call.method === 'GET' && call.url.split('?')[0] === '/api/desk').map((call) => call.url);

// a board whose columns are all empty, as the server answers for a filter that matches nothing.
const nothing: DeskBoard = { ...emptyBoard, people: board().people };

describe('the desk board', () => {
  it('shows the five columns in order, and each card with its title, person, due words and next step', async () => {
    await open();
    await inMain().findByText('Book the Denver flights');
    const headings = inMain()
      .getAllByRole('heading', { level: 2 })
      .map((heading) => heading.textContent);
    expect(headings).toEqual(['Open2', 'Waiting3', 'Needs you1', 'Done1', 'Dropped1']);
    expect(headings.map((heading) => heading!.replace(/\d+$/, ''))).toEqual(HEADINGS);

    const waiting = within(inMain().getByRole('list', { name: 'Waiting' }));
    expect(waiting.getAllByRole('button').map((card) => card.querySelector('.desk-card-title')!.textContent)).toEqual([
      'Reschedule the dentist',
      'Get the lease renewal from Dana',
      'Ask Dana about the parking spot',
    ]);

    const lease = within(cardOf('Get the lease renewal from Dana'));
    expect(lease.getByText('Dana Park')).toBeTruthy();
    expect(lease.getByText('since Oct 8')).toBeTruthy();
    expect(lease.getByText('Due Oct 17')).toBeTruthy();
    expect(lease.getByText('1 nudge')).toBeTruthy();
    expect(lease.getByText("Wait for Dana's reply with the new lease")).toBeTruthy();
    expect(lease.queryByText('Follow-up due')).toBeNull();

    const dentist = within(cardOf('Reschedule the dentist'));
    expect(dentist.getByText('front@dentist.example')).toBeTruthy();
    expect(dentist.getByText('Overdue by 1 day').className).toContain('tone-critical');
    expect(dentist.getByText('Follow-up due')).toBeTruthy();
    expect(dentist.getByText('Pick a time next week from the slots they send')).toBeTruthy();

    const flights = within(cardOf('Book the Denver flights'));
    expect(flights.getByText('Due Oct 15')).toBeTruthy();
    expect(flights.getByText('Compare the morning flights on Oct 24')).toBeTruthy();
    expect(within(cardOf('Renew the passport')).getByText('Due Nov 1')).toBeTruthy();
    expect(within(cardOf('Send the thank-you note to Prof. Lee')).getByText('Done Oct 10')).toBeTruthy();
    expect(within(cardOf('Find a cheaper phone plan')).getByText('Dropped Oct 7')).toBeTruthy();
    expect(inMain().getByText('1 due today')).toBeTruthy();
  });

  it('selects a card into the hash and marks it', async () => {
    await open();
    await inMain().findByText('Get the lease renewal from Dana');
    fireEvent.click(cardOf('Get the lease renewal from Dana'));
    await waitFor(() => expect(location.hash).toBe('#/desk?id=2'));
    await waitFor(() => expect(cardOf('Get the lease renewal from Dana').getAttribute('aria-pressed')).toBe('true'));
    expect(cardOf('Book the Denver flights').getAttribute('aria-pressed')).toBe('false');
  });

  it('writes the status filter to the hash and the request', async () => {
    const calls = await open('#/desk', { 'GET /api/desk': ({ query }) => (query.get('status') === 'blocked' ? board(delegations.filter((each) => each.status === 'blocked')) : board()) });
    await inMain().findByText('Book the Denver flights');
    const tabs = within(screen.getByRole('tablist', { name: 'status' }));
    expect(tabs.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['All8', 'Open2', 'Waiting3', 'Needs you1', 'Done1', 'Dropped1']);
    fireEvent.click(tabs.getByRole('tab', { name: /Needs you/ }));
    await waitFor(() => expect(location.hash).toBe('#/desk?status=blocked'));
    await inMain().findByText('Renew the passport');
    await waitFor(() => expect(inMain().queryByText('Book the Denver flights')).toBeNull());
    expect(deskCalls(calls)).toContain('/api/desk?status=blocked');
    expect(inMain().getAllByRole('heading', { level: 2 }).map((heading) => heading.textContent)).toEqual(['Needs you1']);
  });

  it('writes the person filter to the hash and the request, and Everyone clears it', async () => {
    const calls = await open();
    await inMain().findByText('Book the Denver flights');
    const person = screen.getByRole('combobox', { name: /Person/ }) as HTMLSelectElement;
    expect([...person.options].map((option) => option.textContent)).toEqual(['Everyone', 'Dana', 'Dana Park', 'front@dentist.example']);
    fireEvent.change(person, { target: { value: 'dana@landlord.example' } });
    await waitFor(() => expect(location.hash).toBe('#/desk?person=dana%40landlord.example'));
    await waitFor(() => expect(deskCalls(calls)).toContain('/api/desk?person=dana%40landlord.example'));
    fireEvent.change(screen.getByRole('combobox', { name: /Person/ }), { target: { value: '' } });
    await waitFor(() => expect(location.hash).toBe('#/desk'));
  });

  it('writes the search to the hash after a pause, and keeps the text while the owner types', async () => {
    const calls = await open();
    await inMain().findByText('Book the Denver flights');
    const search = screen.getByRole('searchbox', { name: 'Search the desk' }) as HTMLInputElement;
    fireEvent.change(search, { target: { value: 'le' } });
    fireEvent.change(search, { target: { value: 'lease' } });
    expect(search.value).toBe('lease');
    expect(location.hash).toBe('#/desk');
    await waitFor(() => expect(location.hash).toBe('#/desk?q=lease'));
    await waitFor(() => expect(deskCalls(calls)).toContain('/api/desk?q=lease'));
    expect(deskCalls(calls)).not.toContain('/api/desk?q=le');
    expect(search.value).toBe('lease');
  });

  it('clears every filter with the clear button', async () => {
    await open('#/desk?status=waiting&person=dana&q=dana', { 'GET /api/desk': () => board(delegations.filter((each) => each.id === 8)) });
    await inMain().findByText('Ask Dana about the parking spot');
    expect((screen.getByRole('searchbox', { name: 'Search the desk' }) as HTMLInputElement).value).toBe('dana');
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    await waitFor(() => expect(location.hash).toBe('#/desk'));
    await waitFor(() => expect((screen.getByRole('searchbox', { name: 'Search the desk' }) as HTMLInputElement).value).toBe(''));
    expect(screen.queryByRole('button', { name: 'Clear filters' })).toBeNull();
  });

  it('opens the create form with the New delegation button', async () => {
    await open('#/desk?id=2');
    await inMain().findByText('Book the Denver flights');
    fireEvent.click(screen.getAllByRole('button', { name: 'New delegation' })[0]!);
    await waitFor(() => expect(location.hash).toBe('#/desk?new=1'));
  });

  it('shows the first run when the desk has nothing and no filter is set', async () => {
    await open('#/desk', { 'GET /api/desk': () => emptyBoard });
    expect(await inMain().findByText('Nothing on your desk yet.')).toBeTruthy();
    expect(inMain().getByText(/can you handle the lease renewal\?/)).toBeTruthy();
    const buttons = screen.getAllByRole('button', { name: 'New delegation' });
    expect(buttons.length).toBe(2);
    fireEvent.click(within(inMain().getByText('Nothing on your desk yet.').parentElement!).getByRole('button', { name: 'New delegation' }));
    await waitFor(() => expect(location.hash).toBe('#/desk?new=1'));
  });

  it('shows the filtered empty state with a clear action when a filter matches nothing', async () => {
    await open('#/desk?status=blocked&q=nothing', { 'GET /api/desk': () => nothing });
    expect(await inMain().findByText('No delegation matches these filters.')).toBeTruthy();
    expect(inMain().queryByText('Nothing on your desk yet.')).toBeNull();
    expect(screen.getAllByRole('button', { name: 'Clear filters' }).length).toBe(2);
    fireEvent.click(within(inMain().getByText('No delegation matches these filters.').parentElement!).getByRole('button', { name: 'Clear filters' }));
    await waitFor(() => expect(location.hash).toBe('#/desk'));
  });

  it('shows the error with a button that loads again', async () => {
    let fail = true;
    const calls = await open('#/desk', { 'GET /api/desk': () => (fail ? json({ error: 'a row could not be read' }, 500) : board()) });
    const alert = await inMain().findByRole('alert');
    expect(alert.textContent).toContain('a row could not be read');
    fail = false;
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(await inMain().findByText('Book the Denver flights')).toBeTruthy();
    expect(deskCalls(calls).length).toBe(2);
  });
});

describe('dueWords', () => {
  it('words each due time from FIXTURE_NOW in the time zone of the app', () => {
    setTimeZone('America/Los_Angeles');
    // FIXTURE_NOW is Oct 12, 18:00 in los angeles.
    expect(dueWords(null, FIXTURE_NOW)).toBeNull();
    expect(dueWords('2026-10-13T06:00:00.000Z', FIXTURE_NOW)).toBe('Due today');
    expect(dueWords('2026-10-13T08:00:00.000Z', FIXTURE_NOW)).toBe('Due tomorrow');
    expect(dueWords('2026-10-16T19:00:00.000Z', FIXTURE_NOW)).toBe('Due Oct 16');
    expect(dueWords('2026-10-11T01:00:00.000Z', FIXTURE_NOW)).toBe('Overdue by 2 days');
    expect(dueWords('2026-10-12T01:00:00.000Z', FIXTURE_NOW)).toBe('Overdue by 1 day');
    expect(dueWords('2026-10-12T23:00:00.000Z', FIXTURE_NOW)).toBe('Overdue since 16:00');
    // in utc FIXTURE_NOW is already Oct 13, so the same due time is a day later.
    setTimeZone('UTC');
    expect(dueWords('2026-10-13T08:00:00.000Z', FIXTURE_NOW)).toBe('Due today');
    expect(dueWords('2026-10-14T08:00:00.000Z', FIXTURE_NOW)).toBe('Due tomorrow');
    setTimeZone('Asia/Tokyo');
    expect(dueWords('2026-10-13T16:00:00.000Z', FIXTURE_NOW)).toBe('Due tomorrow');
    setTimeZone('America/Los_Angeles');
  });
});
