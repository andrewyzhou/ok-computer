// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DocsPage } from '../../../../src/dashboard/docs-types';
import { seedDashboard } from '../../../../test/seed';
import { FakeEventSource, inMain, installEventSource, json, openApp, stubFetch, type StubRequest } from '../../testing';
import { setPrefs } from '../../shell/prefs';
import { docItem, docsList, docsPage, emptyDocsPage, searchPage } from './fixtures';

installEventSource();

let seeded: Awaited<ReturnType<typeof seedDashboard>>;

beforeEach(async () => {
  setPrefs({ theme: 'system', devMode: false, detailsHidden: false });
  seeded = await seedDashboard();
});
afterEach(async () => {
  cleanup();
  vi.stubGlobal('matchMedia', undefined);
  await seeded.t.app.stop();
});

// the query of each request to /api/docs, in order.
function docsQueries(calls: Array<{ method: string; url: string }>): URLSearchParams[] {
  return calls.filter((call) => call.method === 'GET' && call.url.split('?')[0] === '/api/docs').map((call) => new URL(call.url, 'http://localhost').searchParams);
}

const queryOf = (params: URLSearchParams) => Object.fromEntries(params.entries());

// 31 docs: a first page of 30 with a cursor, then a last page of one.
const many = Array.from({ length: 31 }, (_, index) => docItem(100 - index, { title: `Doc number ${100 - index}` }));
function paged({ query }: StubRequest): DocsPage {
  if (query.get('cursor') === 'c30') return { docs: many.slice(30), nextCursor: null, mode: null };
  return { docs: many.slice(0, 30), nextCursor: 'c30', mode: null };
}

const table = () => within(inMain().getByRole('table', { name: 'docs' }));
// waits for the table, then for a text in it.
async function findRow(text: string): Promise<HTMLElement> {
  return within(await inMain().findByRole('table', { name: 'docs' })).findByText(text);
}

describe('the docs list', () => {
  it('shows skeleton rows while the first page loads', async () => {
    let answer: (page: DocsPage) => void = () => {};
    stubFetch(seeded.dashboard, { 'GET /api/docs': () => new Promise<DocsPage>((done) => (answer = done)) });
    openApp('#/docs');
    expect(await inMain().findByText('Loading the docs…')).toBeTruthy();
    expect(inMain().getByText('Loading the docs…').closest('[aria-busy="true"]')).toBeTruthy();
    act(() => answer(docsPage));
    expect(await inMain().findByText('Trip plan: Lisbon')).toBeTruthy();
    expect(inMain().queryByText('Loading the docs…')).toBeNull();
  });

  it('shows the first run state when there are no docs at all', async () => {
    stubFetch(seeded.dashboard, { 'GET /api/docs': () => emptyDocsPage });
    openApp('#/docs');
    expect(await inMain().findByText('No docs yet')).toBeTruthy();
    expect(inMain().getByText(/^When an answer is long, the agent writes a doc here/)).toBeTruthy();
    expect(inMain().queryByRole('button', { name: 'Clear filters' })).toBeNull();
    // the first run has nothing to filter, so the filters stay hidden, and the next step is a question in the chat.
    expect(inMain().queryByRole('searchbox')).toBeNull();
    expect(inMain().queryByLabelText('Search docs')).toBeNull();
    expect(inMain().getByRole('link', { name: 'Ask in chat' }).getAttribute('href')).toBe('#/chats');
  });

  it('says that no doc matches a filter, and clears the filters', async () => {
    const calls = stubFetch(seeded.dashboard, { 'GET /api/docs': ({ query }) => (query.get('kind') ? emptyDocsPage : docsPage) });
    openApp('#/docs?kind=brief&q=zebra');
    expect(await inMain().findByText('No docs match')).toBeTruthy();
    expect(queryOf(docsQueries(calls)[0]!)).toEqual({ q: 'zebra', kind: 'brief', limit: '30' });
    fireEvent.click(inMain().getByRole('button', { name: 'Clear filters' }));
    await waitFor(() => expect(location.hash).toBe('#/docs'));
    expect(await inMain().findByText('Trip plan: Lisbon')).toBeTruthy();
    expect((inMain().getByRole('searchbox', { name: 'Search docs' }) as HTMLInputElement).value).toBe('');
  });

  it('shows the error of the server with a button to try again', async () => {
    let fail = true;
    stubFetch(seeded.dashboard, { 'GET /api/docs': () => (fail ? json({ error: 'the docs table is locked' }, 500) : docsPage) });
    openApp('#/docs');
    expect((await inMain().findByRole('alert')).textContent).toContain('the docs table is locked');
    fail = false;
    fireEvent.click(inMain().getByRole('button', { name: 'Try again' }));
    expect(await inMain().findByText('Trip plan: Lisbon')).toBeTruthy();
    expect(inMain().queryByRole('alert')).toBeNull();
  });

  it('shows the sentence of a 400 for a bad search', async () => {
    stubFetch(seeded.dashboard, { 'GET /api/docs': () => json({ error: 'q must be 1 to 200 characters' }, 400) });
    openApp('#/docs?q=bad');
    expect((await inMain().findByRole('alert')).textContent).toBe('Could not load the docs: q must be 1 to 200 characters');
    expect(inMain().getByRole('button', { name: 'Try again' })).toBeTruthy();
  });

  it('lists the seeded docs with their columns', async () => {
    const calls = stubFetch(seeded.dashboard, { 'GET /api/docs': () => docsPage });
    openApp('#/docs');
    expect(await findRow('Trip plan: Lisbon')).toBeTruthy();
    expect(queryOf(docsQueries(calls)[0]!)).toEqual({ limit: '30' });
    expect(inMain().getByText('5 docs')).toBeTruthy();
    expect(table().getAllByRole('columnheader').map((cell) => cell.textContent)).toEqual(['Title', 'Kind', 'Version', 'Comments', 'Author', 'Updated']);
    const rows = table().getAllByRole('row').slice(1);
    expect(rows).toHaveLength(docsList.length);
    const trip = within(rows[0]!).getAllByRole('cell').map((cell) => cell.textContent);
    expect(trip.slice(0, 5)).toEqual(['Trip plan: Lisbon', 'Plan', 'v3', '2', 'agent']);
    expect(trip[5]).toMatch(/^Oct 12, 17:45/);
    expect(within(rows[1]!).getAllByRole('cell')[3]!.textContent).toBe('');
    expect(within(rows[1]!).getByText('Meeting prep')).toBeTruthy();
    expect(within(rows[3]!).getAllByRole('cell')[4]!.textContent).toBe('you');
    const taint = within(rows[4]!).getByText('outside text');
    expect(taint.getAttribute('title')).toMatch(/untrusted content/);
    expect(table().getAllByText('outside text')).toHaveLength(1);
    expect(table().getByRole('link', { name: 'Trip plan: Lisbon' }).getAttribute('href')).toBe('#/docs/1');
  });

  it('opens a doc with a click on its row or Enter on its row', async () => {
    stubFetch(seeded.dashboard, { 'GET /api/docs': () => docsPage, 'GET /api/docs/:id': () => json({ error: 'doc not found' }, 404) });
    openApp('#/docs');
    const row = (await findRow('Prep: 1:1 with Dana')).closest('tr')!;
    fireEvent.click(within(row).getByText('Meeting prep'));
    await waitFor(() => expect(location.hash).toBe('#/docs/3'));
    location.hash = '#/docs';
    const again = (await findRow('Laptop comparison')).closest('tr')!;
    fireEvent.keyDown(again, { key: 'Enter' });
    await waitFor(() => expect(location.hash).toBe('#/docs/2'));
  });

  it('shows search results with highlighted snippets', async () => {
    const calls = stubFetch(seeded.dashboard, { 'GET /api/docs': ({ query }) => (query.get('q') ? searchPage : docsPage) });
    openApp('#/docs?q=alfama');
    expect(await inMain().findByText('Search results')).toBeTruthy();
    await findRow('Trip plan: Lisbon');
    // the marks are offsets into the snippet, and the text between them is a mark element.
    const [start, end] = searchPage.docs[0]!.marks[0]!;
    const mark = table().getByText(searchPage.docs[0]!.snippet!.slice(start, end));
    expect(mark.tagName).toBe('MARK');
    expect(mark.parentElement!.textContent).toBe('…The hotel moved to Alfama, closer to the walks…');
    expect(queryOf(docsQueries(calls)[0]!)).toEqual({ q: 'alfama', limit: '30' });
    expect(inMain().queryByRole('button', { name: 'Load more' })).toBeNull();
  });

  it('types a search into the hash after a pause, and keeps the focus in the box', async () => {
    const calls = stubFetch(seeded.dashboard, { 'GET /api/docs': ({ query }) => (query.get('q') ? searchPage : docsPage) });
    openApp('#/docs');
    await findRow('Laptop comparison');
    const box = inMain().getByRole('searchbox', { name: 'Search docs' }) as HTMLInputElement;
    box.focus();
    const length = history.length;
    fireEvent.change(box, { target: { value: 'al' } });
    fireEvent.change(box, { target: { value: 'alfa' } });
    expect(location.hash).toBe('#/docs');
    await waitFor(() => expect(location.hash).toBe('#/docs?q=alfa'));
    fireEvent.change(box, { target: { value: 'alfama' } });
    await waitFor(() => expect(location.hash).toBe('#/docs?q=alfama'));
    // the first change of the search adds one entry, and the next ones replace it.
    expect(history.length).toBe(length + 1);
    expect(await inMain().findByText('Search results')).toBeTruthy();
    await waitFor(() => expect(table().queryByText('Laptop comparison')).toBeNull());
    expect(document.activeElement).toBe(box);
    const texts = docsQueries(calls).map((query) => query.get('q'));
    expect(texts).not.toContain('al');
    expect(texts).toContain('alfama');
    // an empty box is the plain list again.
    fireEvent.change(box, { target: { value: '' } });
    await waitFor(() => expect(location.hash).toBe('#/docs'));
    expect(await inMain().findByText('5 docs')).toBeTruthy();
    expect(document.activeElement).toBe(box);
  });

  it('filters by kind through the hash, and the back button brings the filter back', async () => {
    const calls = stubFetch(seeded.dashboard, {
      'GET /api/docs': ({ query }) => (query.get('kind') === 'plan' ? { ...docsPage, docs: docsList.slice(0, 1) } : docsPage),
    });
    openApp('#/docs');
    await findRow('Laptop comparison');
    const kinds = inMain().getByRole('group', { name: 'kind' });
    expect(within(kinds).getAllByRole('button').map((button) => button.textContent)).toEqual(['All', 'Brief', 'Plan', 'Notes', 'Comparison', 'Meeting prep', 'Other']);
    expect(within(kinds).getByRole('button', { name: 'All' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(within(kinds).getByRole('button', { name: 'Plan' }));
    await waitFor(() => expect(location.hash).toBe('#/docs?kind=plan'));
    await waitFor(() => expect(table().queryByText('Laptop comparison')).toBeNull());
    expect(queryOf(docsQueries(calls).at(-1)!)).toEqual({ kind: 'plan', limit: '30' });
    expect(inMain().getByRole('button', { name: 'Plan' }).getAttribute('aria-pressed')).toBe('true');
    expect(inMain().getByText('1 doc')).toBeTruthy();
    // the back button goes to the hash before the filter.
    location.hash = '#/docs';
    await waitFor(() => expect(inMain().getByRole('button', { name: 'All' }).getAttribute('aria-pressed')).toBe('true'));
    expect(await findRow('Laptop comparison')).toBeTruthy();
  });

  it('keeps the old rows on view, faded, while a new filter loads', async () => {
    let answer: (page: DocsPage) => void = () => {};
    stubFetch(seeded.dashboard, { 'GET /api/docs': ({ query }) => (query.get('kind') ? new Promise<DocsPage>((done) => (answer = done)) : docsPage) });
    openApp('#/docs');
    await findRow('Laptop comparison');
    fireEvent.click(inMain().getByRole('button', { name: 'Brief' }));
    await waitFor(() => expect(document.querySelector('.docs-list.is-loading')).toBeTruthy());
    expect(table().getByText('Laptop comparison')).toBeTruthy();
    expect(document.querySelector('.docs-list')!.getAttribute('aria-busy')).toBe('true');
    act(() => answer({ ...docsPage, docs: docsList.slice(2, 3) }));
    await waitFor(() => expect(table().queryByText('Laptop comparison')).toBeNull());
    expect(table().getByText('Morning brief, October 12')).toBeTruthy();
    expect(document.querySelector('.docs-list.is-loading')).toBeNull();
  });

  it('loads more docs with the cursor and appends them', async () => {
    const calls = stubFetch(seeded.dashboard, { 'GET /api/docs': paged });
    openApp('#/docs');
    await findRow('Doc number 100');
    expect(table().getAllByRole('row')).toHaveLength(31);
    expect(inMain().getByText('30 docs so far')).toBeTruthy();
    fireEvent.click(inMain().getByRole('button', { name: 'Load more' }));
    expect(await findRow('Doc number 70')).toBeTruthy();
    expect(table().getByText('Doc number 100')).toBeTruthy();
    expect(table().getAllByRole('row')).toHaveLength(32);
    expect(queryOf(docsQueries(calls).at(-1)!)).toEqual({ cursor: 'c30', limit: '30' });
    expect(inMain().queryByRole('button', { name: 'Load more' })).toBeNull();
    expect(inMain().getByText('31 docs')).toBeTruthy();
  });

  it('loads again when a run ends, so a new doc shows without a reload', async () => {
    let docs = docsList;
    const calls = stubFetch(seeded.dashboard, { 'GET /api/docs': () => ({ ...docsPage, docs }) });
    openApp('#/docs');
    await findRow('Laptop comparison');
    const before = docsQueries(calls).length;
    docs = [docItem(9, { title: 'Packing list', updatedAt: '2026-10-14T00:00:00.000Z' }), ...docsList];
    // a message of another kind does not load the list again.
    act(() => FakeEventSource.find('/api/stream')!.emit({ kind: 'log', log: { id: 1 } }));
    act(() => FakeEventSource.find('/api/stream')!.emit({ kind: 'run', run: { id: 'run-9' } }));
    expect(await findRow('Packing list')).toBeTruthy();
    expect(docsQueries(calls).length).toBe(before + 1);
    expect(inMain().getByText('6 docs')).toBeTruthy();
  });

  it('shows each doc as a card on a phone, with no table', async () => {
    vi.stubGlobal('matchMedia', (text: string) => ({ matches: /max-width: 759/.test(text), addEventListener: () => {}, removeEventListener: () => {} }));
    stubFetch(seeded.dashboard, { 'GET /api/docs': () => docsPage });
    openApp('#/docs');
    const cards = within(await inMain().findByRole('list', { name: 'docs' }));
    expect(inMain().queryByRole('table')).toBeNull();
    const items = cards.getAllByRole('listitem');
    expect(items).toHaveLength(5);
    const trip = within(items[0]!);
    expect(trip.getByRole('link', { name: 'Trip plan: Lisbon' }).getAttribute('href')).toBe('#/docs/1');
    expect(trip.getByText('Plan')).toBeTruthy();
    expect(trip.getByText('v3')).toBeTruthy();
    // a phone shows the comment count too, and a doc with no comment shows none.
    expect(trip.getByLabelText('2 comments').textContent).toBe('2');
    expect(within(items[1]!).queryByLabelText(/comment/)).toBeNull();
    // the time has no seconds.
    expect(trip.getByText(/^Oct 12, 17:45$/)).toBeTruthy();
    expect(within(items[4]!).getByText('outside text').getAttribute('title')).toMatch(/untrusted content/);
    // the kind is a select on a phone, so the bar never scrolls sideways.
    expect(inMain().queryByRole('group', { name: 'kind' })).toBeNull();
    const select = screen.getByRole('combobox', { name: 'kind' }) as HTMLSelectElement;
    expect([...select.options].map((option) => option.textContent)).toEqual(['All', 'Brief', 'Plan', 'Notes', 'Comparison', 'Meeting prep', 'Other']);
    fireEvent.change(select, { target: { value: 'notes' } });
    await waitFor(() => expect(location.hash).toBe('#/docs?kind=notes'));
  });
});
