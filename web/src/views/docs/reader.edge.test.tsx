// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DocDetail } from '../../../../src/dashboard/docs-types';
import { seedDashboard } from '../../../../test/seed';
import { TRIP_V2 } from '../../../../test/docs-seed';
import { FakeEventSource, inMain, installEventSource, json, openApp, stubFetch } from '../../testing';
import { setPrefs } from '../../shell/prefs';
import type { DocCommentsProps } from './Comments';
import { tripDetail, tripDiff, tripVersions } from './fixtures';

const spy = vi.hoisted(() => ({ comments: [] as unknown[] }));

// comments.test.tsx checks the inside of DocComments, so this file checks only the props that the page gives it.
vi.mock('./Comments', () => ({
  DocComments: (props: DocCommentsProps) => {
    spy.comments.push(props);
    return <div data-testid="doc-comments" />;
  },
}));

installEventSource();

let seeded: Awaited<ReturnType<typeof seedDashboard>>;

beforeEach(async () => {
  setPrefs({ theme: 'system', devMode: false, detailsHidden: false });
  spy.comments.length = 0;
  seeded = await seedDashboard();
});
afterEach(async () => {
  cleanup();
  await seeded.t.app.stop();
});

const tripV2: DocDetail = { ...tripDetail, version: { ...tripVersions[1]!, body: TRIP_V2, links: [] } };
const lastComments = () => spy.comments[spy.comments.length - 1] as DocCommentsProps;
const docCalls = (calls: Array<{ url: string }>) => calls.filter((call) => /^\/api\/docs\/1(\?|$)/.test(call.url)).length;

describe('the doc reader at its edges', () => {
  it('shows not found for an id that is not a positive whole number, without a request', async () => {
    const calls = stubFetch(seeded.dashboard, {});
    openApp('#/docs/abc');
    expect(await inMain().findByText('This doc does not exist.')).toBeTruthy();
    expect(inMain().getByRole('link', { name: 'Go to the docs' }).getAttribute('href')).toBe('#/docs');
    expect(calls.some((call) => call.url.startsWith('/api/docs'))).toBe(false);
  });

  it('shows not found for a doc that the server does not have', async () => {
    stubFetch(seeded.dashboard, { 'GET /api/docs/:id': () => json({ error: 'doc not found' }, 404) });
    openApp('#/docs/99');
    expect(await inMain().findByText('This doc does not exist.')).toBeTruthy();
    expect(inMain().queryByRole('button', { name: 'Try again' })).toBeNull();
    expect(inMain().getByRole('link', { name: 'Go to the docs' }).className).toContain('btn');
  });

  it('shows not found for a version that the doc does not have, with a link to the newest', async () => {
    const calls = stubFetch(seeded.dashboard, { 'GET /api/docs/1': () => json({ error: 'version not found' }, 404) });
    openApp('#/docs/1?version=9');
    expect(await inMain().findByText('This version does not exist.')).toBeTruthy();
    expect(inMain().getByRole('link', { name: 'Read the newest version' }).getAttribute('href')).toBe('#/docs/1');
    expect(calls.some((call) => call.url === '/api/docs/1?version=9')).toBe(true);
  });

  it('shows not found for a version in the query that is not a positive whole number', async () => {
    const calls = stubFetch(seeded.dashboard, {});
    openApp('#/docs/1?version=0');
    expect(await inMain().findByText('This version does not exist.')).toBeTruthy();
    expect(calls.some((call) => call.url.startsWith('/api/docs'))).toBe(false);
  });

  it('shows a server error with Try again, which loads the doc again', async () => {
    let fail = true;
    stubFetch(seeded.dashboard, { 'GET /api/docs/1': () => (fail ? json({ error: 'database is locked' }, 500) : tripDetail) });
    openApp('#/docs/1');
    const main = inMain();
    expect(await main.findByText('Could not load the doc: database is locked')).toBeTruthy();
    expect(main.getByRole('link', { name: 'Back to docs' }).getAttribute('href')).toBe('#/docs');
    fail = false;
    fireEvent.click(main.getByRole('button', { name: 'Try again' }));
    expect(await main.findByRole('heading', { level: 1, name: 'Trip plan: Lisbon' })).toBeTruthy();
  });

  it('exports without a token when the page url has none', async () => {
    stubFetch(seeded.dashboard, { 'GET /api/docs/1': () => tripDetail });
    openApp('#/docs/1');
    await inMain().findByRole('heading', { level: 1, name: 'Trip plan: Lisbon' });
    expect(screen.getByRole('link', { name: 'Export .md' }).getAttribute('href')).toBe('/api/docs/1/export');
  });

  it('passes the text selected inside the article to the comments, and nothing for a selection outside it', async () => {
    stubFetch(seeded.dashboard, { 'GET /api/docs/1': () => tripDetail });
    openApp('#/docs/1');
    const main = inMain();
    const quote = await main.findByText(/Free cancellation until November 10\./);
    const article = document.querySelector('.doc-article') as HTMLElement;
    const select = (node: Node) => {
      const range = document.createRange();
      range.selectNodeContents(node);
      const selection = getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
    };
    select(quote);
    fireEvent.mouseUp(article);
    await waitFor(() => expect(lastComments().selection).toBe(quote.textContent!.trim()));
    // a long selection is cut to the 500 characters that a quote may have.
    select(article);
    fireEvent.keyUp(article);
    await waitFor(() => expect(lastComments().selection!.length).toBe(500));
    select(screen.getByRole('navigation', { name: 'pages' }));
    fireEvent.mouseUp(article);
    await waitFor(() => expect(lastComments().selection).toBe(''));
    getSelection()!.removeAllRanges();
  });

  it('loads the newest version again on a run message, and an old version not', async () => {
    const calls = stubFetch(seeded.dashboard, {
      'GET /api/docs/1': ({ query }) => (query.get('version') === '2' ? tripV2 : tripDetail),
    });
    openApp('#/docs/1');
    await inMain().findByRole('heading', { level: 1, name: 'Trip plan: Lisbon' });
    const before = docCalls(calls);
    FakeEventSource.find('/api/stream')!.emit({ kind: 'run', run: { id: 'run-9' } });
    await waitFor(() => expect(docCalls(calls)).toBe(before + 1));
    // a message of another kind does nothing.
    FakeEventSource.find('/api/stream')!.emit({ kind: 'log', line: { level: 'info', msg: 'x' } });

    location.hash = '#/docs/1?version=2';
    await inMain().findByText('version 2 of 3');
    const old = docCalls(calls);
    FakeEventSource.find('/api/stream')!.emit({ kind: 'run', run: { id: 'run-10' } });
    await new Promise((done) => setTimeout(done, 600));
    expect(docCalls(calls)).toBe(old);
  });

  it('shows that a diff version does not exist', async () => {
    stubFetch(seeded.dashboard, {
      'GET /api/docs/1': () => tripDetail,
      'GET /api/docs/1/diff': () => json({ error: 'version not found' }, 404),
    });
    openApp('#/docs/1?diff=7');
    const main = inMain();
    expect(await main.findByText('That version does not exist.')).toBeTruthy();
    expect(main.getByRole('link', { name: 'Close diff' }).getAttribute('href')).toBe('#/docs/1');
  });

  it('shows a diff error with Try again', async () => {
    let fail = true;
    stubFetch(seeded.dashboard, {
      'GET /api/docs/1': () => tripDetail,
      'GET /api/docs/1/diff': () => (fail ? json({ error: 'diff failed' }, 500) : tripDiff),
    });
    openApp('#/docs/1?diff=2');
    const main = inMain();
    expect(await main.findByText('Could not load the diff: diff failed')).toBeTruthy();
    fail = false;
    fireEvent.click(main.getByRole('button', { name: 'Try again' }));
    expect(await main.findByText('Lines 1–4 → 1–6')).toBeTruthy();
  });

  it('notes a coarse diff, and says when two versions have the same text', async () => {
    let diff = { ...tripDiff, coarse: true };
    stubFetch(seeded.dashboard, {
      'GET /api/docs/1': () => tripDetail,
      'GET /api/docs/1/diff': () => diff,
    });
    openApp('#/docs/1?version=3&diff=2');
    const main = inMain();
    expect(await main.findByText(/too long to compare line by line/)).toBeTruthy();
    diff = { ...tripDiff, from: 3, to: 3, added: 0, removed: 0, hunks: [] };
    location.hash = '#/docs/1?version=3&diff=3';
    expect(await main.findByText('These versions have the same text.')).toBeTruthy();
    const region = within(main.getByRole('region', { name: 'Diff' }));
    expect(region.getByText(/Changes from version 3 to version 3/).textContent).toBe('Changes from version 3 to version 3: +0 −0 lines');
    expect(region.queryByText(/too long/)).toBeNull();
  });
});
