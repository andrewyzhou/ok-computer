// @vitest-environment jsdom
import { act, cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DocsPage } from '../../../../src/dashboard/docs-types';
import { seedDashboard } from '../../../../test/seed';
import { FakeEventSource, inMain, installEventSource, json, openApp, stubFetch, type StubRequest } from '../../testing';
import { setPrefs } from '../../shell/prefs';
import { docItem, docsPage, emptyDocsPage } from './fixtures';

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

function docsQueries(calls: Array<{ method: string; url: string }>): URLSearchParams[] {
  return calls.filter((call) => call.method === 'GET' && call.url.split('?')[0] === '/api/docs').map((call) => new URL(call.url, 'http://localhost').searchParams);
}

const table = () => within(inMain().getByRole('table', { name: 'docs' }));
async function findRow(text: string): Promise<HTMLElement> {
  return within(await inMain().findByRole('table', { name: 'docs' })).findByText(text);
}
const searchBox = () => inMain().getByRole('searchbox', { name: 'Search docs' }) as HTMLInputElement;

// a cursor with characters that a query must escape.
const CURSOR = 'MjAyNi0xMC0xMlQxNTowMDowMC4wMDBa/5+=';
const many = Array.from({ length: 31 }, (_, index) => docItem(100 - index, { title: `Doc number ${100 - index}` }));
function paged({ query }: StubRequest): DocsPage {
  if (query.get('cursor') === CURSOR) return { docs: many.slice(30), nextCursor: null, mode: null };
  return { docs: many.slice(0, 30), nextCursor: CURSOR, mode: null };
}

describe('the edges of the docs list', () => {
  it('shows a title with html as text', async () => {
    const title = '<img src=x onerror="alert(1)"><b>bold</b> & <script>x()</script>';
    stubFetch(seeded.dashboard, {
      'GET /api/docs': () => ({ ...docsPage, docs: [docItem(7, { title, snippet: '<i>not italic</i>', marks: [[0, 3]] })] }),
    });
    openApp('#/docs');
    expect((await findRow(title)).tagName).toBe('A');
    const main = inMain().getByRole('table', { name: 'docs' });
    expect(main.querySelector('img, b, script, i')).toBeNull();
    expect(main.querySelector('mark')!.textContent).toBe('<i>');
  });

  it('lets a very long title wrap in the table and clamps it on a card', async () => {
    const title = `${'A very long title of a doc that goes on '.repeat(8)}${'x'.repeat(120)}`;
    stubFetch(seeded.dashboard, { 'GET /api/docs': () => ({ ...docsPage, docs: [docItem(8, { title })] }) });
    openApp('#/docs');
    const link = await findRow(title);
    expect(link.closest('td')!.classList.contains('wrap')).toBe(true);
    expect(link.closest('.docs-title-cell')).toBeTruthy();
    cleanup();
    vi.stubGlobal('matchMedia', (text: string) => ({ matches: /max-width: 759/.test(text), addEventListener: () => {}, removeEventListener: () => {} }));
    openApp('#/docs');
    const card = await inMain().findByRole('link', { name: title });
    expect(card.classList.contains('docs-card-title')).toBe(true);
    expect(card.textContent).toBe(title);
  });

  it('round-trips a search with & and # through the hash', async () => {
    const calls = stubFetch(seeded.dashboard, { 'GET /api/docs': ({ query }) => (query.get('q') ? { ...docsPage, docs: [docItem(4, { title: 'R&D notes' })], mode: 'like' } : docsPage) });
    openApp('#/docs');
    await findRow('Trip plan: Lisbon');
    fireEvent.change(searchBox(), { target: { value: 'R&D #1' } });
    await waitFor(() => expect(location.hash).toBe('#/docs?q=R%26D+%231'));
    expect(await findRow('R&D notes')).toBeTruthy();
    expect(docsQueries(calls).at(-1)!.get('q')).toBe('R&D #1');
    expect(calls.at(-1)!.url).toContain('q=R%26D+%231');
    // the same hash opens the list with the text in the box.
    cleanup();
    openApp('#/docs?q=R%26D+%231');
    await findRow('R&D notes');
    expect(searchBox().value).toBe('R&D #1');
  });

  it('ignores a kind in the hash that is not a kind, and shows All', async () => {
    const calls = stubFetch(seeded.dashboard, { 'GET /api/docs': ({ query }) => (query.get('kind') ? json({ error: 'unknown kind' }, 400) : docsPage) });
    openApp('#/docs?kind=recipes');
    await findRow('Trip plan: Lisbon');
    expect(inMain().getByRole('button', { name: 'All' }).getAttribute('aria-pressed')).toBe('true');
    expect(docsQueries(calls).every((query) => !query.has('kind'))).toBe(true);
    expect(inMain().getByText('5 docs')).toBeTruthy();
  });

  it('shows only the answer of the last text when the owner types fast', async () => {
    let slow: (page: DocsPage) => void = () => {};
    stubFetch(seeded.dashboard, {
      'GET /api/docs': ({ query }) => {
        if (query.get('q') === 'tri') return new Promise<DocsPage>((done) => (slow = done));
        if (query.get('q') === 'trip') return { ...docsPage, docs: [docItem(1, { title: 'Answer to trip' })], mode: 'fts' };
        return docsPage;
      },
    });
    openApp('#/docs');
    await findRow('Laptop comparison');
    fireEvent.change(searchBox(), { target: { value: 'tri' } });
    await waitFor(() => expect(location.hash).toBe('#/docs?q=tri'));
    fireEvent.change(searchBox(), { target: { value: 'trip' } });
    await waitFor(() => expect(location.hash).toBe('#/docs?q=trip'));
    expect(await findRow('Answer to trip')).toBeTruthy();
    // the old answer comes later, and it changes nothing.
    act(() => slow({ ...docsPage, docs: [docItem(2, { title: 'Answer to tri' })], mode: 'fts' }));
    await new Promise((done) => setTimeout(done, 50));
    expect(table().getByText('Answer to trip')).toBeTruthy();
    expect(table().queryByText('Answer to tri')).toBeNull();
    expect(searchBox().value).toBe('trip');
  });

  it('sends the cursor of the last page, escaped, with the filters', async () => {
    const calls = stubFetch(seeded.dashboard, { 'GET /api/docs': paged });
    openApp('#/docs?kind=notes');
    await findRow('Doc number 100');
    fireEvent.click(inMain().getByRole('button', { name: 'Load more' }));
    expect(await findRow('Doc number 70')).toBeTruthy();
    const last = docsQueries(calls).at(-1)!;
    expect(Object.fromEntries(last.entries())).toEqual({ kind: 'notes', cursor: CURSOR, limit: '30' });
    expect(calls.at(-1)!.url).toContain(`cursor=${encodeURIComponent(CURSOR)}`);
  });

  it('says so when load more fails, and keeps the rows', async () => {
    stubFetch(seeded.dashboard, { 'GET /api/docs': (request) => (request.query.get('cursor') ? json({ error: 'cursor cannot be read' }, 400) : paged(request)) });
    openApp('#/docs');
    await findRow('Doc number 100');
    fireEvent.click(inMain().getByRole('button', { name: 'Load more' }));
    expect((await inMain().findByRole('alert')).textContent).toBe('Could not load more: cursor cannot be read');
    expect(table().getAllByRole('row')).toHaveLength(31);
  });

  it('keeps the rows that load more added when a run ends', async () => {
    const calls = stubFetch(seeded.dashboard, { 'GET /api/docs': paged });
    openApp('#/docs');
    await findRow('Doc number 100');
    fireEvent.click(inMain().getByRole('button', { name: 'Load more' }));
    await findRow('Doc number 70');
    const before = docsQueries(calls).length;
    act(() => FakeEventSource.find('/api/stream')!.emit({ kind: 'run', run: { id: 'run-9' } }));
    // the reload asks for the first page and the page after it again, so the list keeps its length.
    await waitFor(() => expect(docsQueries(calls).length).toBe(before + 2));
    await new Promise((done) => setTimeout(done, 50));
    expect(table().getByText('Doc number 70')).toBeTruthy();
    expect(table().getAllByRole('row')).toHaveLength(32);
    expect(inMain().queryByRole('button', { name: 'Load more' })).toBeNull();
  });

  it('shows the first run state again after a search is cleared on an empty list', async () => {
    stubFetch(seeded.dashboard, { 'GET /api/docs': () => emptyDocsPage });
    openApp('#/docs?q=trip');
    expect(await inMain().findByText('No docs match')).toBeTruthy();
    fireEvent.change(searchBox(), { target: { value: '' } });
    expect(await inMain().findByText('No docs yet')).toBeTruthy();
    expect(location.hash).toBe('#/docs');
  });
});
