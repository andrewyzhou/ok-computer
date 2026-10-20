// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DocDetail } from '../../../../src/dashboard/docs-types';
import { seedDashboard } from '../../../../test/seed';
import { TRIP_V2 } from '../../../../test/docs-seed';
import { inMain, installEventSource, openApp, stubFetch } from '../../testing';
import { setPrefs } from '../../shell/prefs';
import type { DocCommentsProps } from './Comments';
import { taintedDetail, tripDetail, tripDiff, tripVersions } from './fixtures';

// the page url has a token in this file, as it has when DASHBOARD_TOKEN is set, so the export link must carry it. the
// api module reads the token when it loads, so the url changes before the imports.
const spy = vi.hoisted(() => {
  globalThis.history.replaceState(null, '', '/?token=t0k');
  return { comments: [] as unknown[] };
});

// comments.test.tsx checks the inside of DocComments, so this file checks only the props that the page gives it.
vi.mock('./Comments', () => ({
  DocComments: (props: DocCommentsProps) => {
    spy.comments.push(props);
    return <div data-testid="doc-comments">comments of version {props.version}</div>;
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

function stubs() {
  return stubFetch(seeded.dashboard, {
    'GET /api/docs/1': ({ query }) => (query.get('version') === '2' ? tripV2 : tripDetail),
    'GET /api/docs/2': () => taintedDetail,
    'GET /api/docs/1/diff': () => tripDiff,
  });
}

const panel = () => within(document.querySelector('.details') as HTMLElement);
const lastComments = () => spy.comments[spy.comments.length - 1] as DocCommentsProps;

describe('the doc reader', () => {
  it('renders the newest version with its title, kind, version, links and export', async () => {
    const calls = stubs();
    openApp('#/docs/1');
    const main = inMain();
    expect(await main.findByRole('heading', { level: 1, name: 'Trip plan: Lisbon' })).toBeTruthy();
    expect(main.getByText('Plan')).toBeTruthy();
    expect(main.getByText('version 3 of 3')).toBeTruthy();
    expect(main.getByText(/^updated /)).toBeTruthy();
    // the h1 of the doc is an h2, because the page title is the h1.
    expect(main.getByRole('heading', { level: 2, name: 'Trip plan: Lisbon' }).id).toBe('doc-trip-plan-lisbon');
    expect(main.getByRole('heading', { level: 3, name: 'Hotel' })).toBeTruthy();
    expect(main.getByRole('table')).toBeTruthy();
    expect(main.getByText(/<script>alert\("x"\)<\/script>/)).toBeTruthy();
    expect(document.querySelector('main script, main img')).toBeNull();
    expect(main.getByText('link is unsafe').closest('a')).toBeNull();
    expect(main.queryByText('You are reading version', { exact: false })).toBeNull();
    expect(main.queryByText('The agent wrote this after reading outside content.')).toBeNull();
    const links = within(main.getByRole('region', { name: 'Links' }));
    expect(links.getByRole('link', { name: 'The run that wrote it' }).getAttribute('href')).toBe('#/runs/run-1');
    const hotel = links.getByRole('link', { name: /Hotel booking page/ });
    expect([hotel.getAttribute('href'), hotel.getAttribute('target'), hotel.getAttribute('rel')]).toEqual([
      'https://hotel.example.com/alfama',
      '_blank',
      'noopener noreferrer nofollow',
    ]);
    const exported = screen.getByRole('link', { name: 'Export .md' });
    expect(exported.getAttribute('href')).toBe('/api/docs/1/export?token=t0k');
    expect(exported.hasAttribute('download')).toBe(true);
    expect(screen.queryByRole('link', { name: 'Newest version' })).toBeNull();
    expect(main.getByRole('button', { name: 'Versions and comments' })).toBeTruthy();
    expect(calls.find((call) => call.url.startsWith('/api/docs/1?'))?.url).toBe('/api/docs/1?token=t0k');
  });

  it('lists the versions newest first and marks the shown one as current', async () => {
    stubs();
    openApp('#/docs/1');
    await inMain().findByRole('heading', { level: 1, name: 'Trip plan: Lisbon' });
    const versions = within(panel().getByRole('list', { name: 'Versions' }));
    const rows = versions.getAllByRole('listitem');
    expect(rows.map((row) => within(row).getAllByRole('link')[0]!.textContent)).toEqual(['Version 3', 'Version 2', 'Version 1']);
    expect(versions.getByRole('link', { name: 'Version 3' }).getAttribute('aria-current')).toBe('page');
    expect(versions.getByRole('link', { name: 'Version 2' }).getAttribute('aria-current')).toBeNull();
    expect(versions.getByRole('link', { name: 'Version 2' }).getAttribute('href')).toBe('#/docs/1?version=2');
    const newest = within(rows[0]!);
    expect(newest.getByText('moved the hotel to Alfama and added packing')).toBeTruthy();
    expect(newest.getByText('agent')).toBeTruthy();
    expect(newest.getByText(`${tripVersions[0]!.chars.toLocaleString('en-US')} characters`)).toBeTruthy();
    expect(newest.getByRole('link', { name: 'run' }).getAttribute('href')).toBe('#/runs/run-1');
    expect(newest.getByRole('link', { name: 'Compare with previous' }).getAttribute('href')).toBe('#/docs/1?version=3&diff=2');
    expect(within(rows[2]!).queryByRole('link', { name: 'Compare with previous' })).toBeNull();
    expect(rows[0]!.querySelector('.doc-taint-dot')).toBeNull();
  });

  it('compares two versions with the form', async () => {
    stubs();
    openApp('#/docs/1');
    await inMain().findByRole('heading', { level: 1, name: 'Trip plan: Lisbon' });
    const form = within(panel().getByRole('form', { name: 'Compare two versions' }));
    expect((form.getByLabelText('From') as HTMLSelectElement).value).toBe('2');
    expect((form.getByLabelText('To') as HTMLSelectElement).value).toBe('3');
    fireEvent.change(form.getByLabelText('From'), { target: { value: '1' } });
    fireEvent.click(form.getByRole('button', { name: 'Compare' }));
    expect(location.hash).toBe('#/docs/1?version=3&diff=1');
  });

  it('gives the comments panel the doc, the version, the comments and a reload', async () => {
    const calls = stubs();
    openApp('#/docs/1');
    expect(await panel().findByTestId('doc-comments')).toBeTruthy();
    const props = lastComments();
    expect(props.doc).toEqual(tripDetail.doc);
    expect(props.version).toBe(3);
    expect(props.comments).toEqual(tripDetail.comments);
    expect(props.selection).toBe('');
    const before = calls.filter((call) => call.url.startsWith('/api/docs/1?')).length;
    props.onAdded();
    await waitFor(() => expect(calls.filter((call) => call.url.startsWith('/api/docs/1?')).length).toBe(before + 1));
  });

  it('shows an old version with its banner, a link to the newest and the export of that version', async () => {
    const calls = stubs();
    openApp('#/docs/1?version=2');
    const main = inMain();
    expect(await main.findByText('version 2 of 3')).toBeTruthy();
    expect(calls.some((call) => call.url === '/api/docs/1?version=2&token=t0k')).toBe(true);
    const banner = main.getByText(/You are reading version 2 of 3\./).closest('.doc-banner') as HTMLElement;
    expect(within(banner).getByRole('link', { name: 'Read the newest version' }).getAttribute('href')).toBe('#/docs/1');
    expect(screen.getByRole('link', { name: 'Newest version' }).getAttribute('href')).toBe('#/docs/1');
    expect(screen.getByRole('link', { name: 'Export .md' }).getAttribute('href')).toBe('/api/docs/1/export?version=2&token=t0k');
    expect(main.queryByRole('heading', { name: 'Hotel' })).toBeNull();
    expect(main.getByRole('heading', { level: 3, name: 'Flights' })).toBeTruthy();
    const versions = within(panel().getByRole('list', { name: 'Versions' }));
    expect(versions.getByRole('link', { name: 'Version 2' }).getAttribute('aria-current')).toBe('page');
    expect(lastComments().version).toBe(2);
  });

  it('shows the taint banner with the sources as plain text', async () => {
    stubs();
    openApp('#/docs/2');
    const main = inMain();
    expect(await main.findByText('The agent wrote this after reading outside content.')).toBeTruthy();
    expect(main.getByText('web_fetch: https://reviews.example.com/laptops').closest('a')).toBeNull();
    expect(main.getByText('Comparison')).toBeTruthy();
    expect(within(panel().getByRole('list', { name: 'Versions' })).getByRole('img', { name: 'written after reading outside content' })).toBeTruthy();
    // a doc of one version has nothing to compare.
    expect(panel().queryByRole('form', { name: 'Compare two versions' })).toBeNull();
  });

  it('cuts a long list of taint sources at five', async () => {
    const sources = Array.from({ length: 8 }, (_, index) => `web_fetch: https://site${index}.example.com`);
    stubFetch(seeded.dashboard, {
      'GET /api/docs/2': () => ({ ...taintedDetail, version: { ...taintedDetail.version, taint: sources } }),
    });
    openApp('#/docs/2');
    const main = inMain();
    await main.findByText('The agent wrote this after reading outside content.');
    const list = within(main.getByRole('note', { name: '' }).querySelector('ul') as HTMLElement);
    expect(list.getAllByRole('listitem').map((item) => item.textContent)).toEqual(sources.slice(0, 5));
    expect(main.getByText('and 3 more')).toBeTruthy();
  });

  it('goes from compare with previous to the diff, and shows the diff in place of the text', async () => {
    const calls = stubs();
    openApp('#/docs/1');
    await inMain().findByRole('heading', { level: 1, name: 'Trip plan: Lisbon' });
    fireEvent.click(panel().getAllByRole('link', { name: 'Compare with previous' })[0]!);
    await waitFor(() => expect(location.hash).toBe('#/docs/1?version=3&diff=2'));
    const main = inMain();
    const diff = within(await main.findByRole('region', { name: 'Diff' }));
    expect(diff.getByText(/Changes from version 2 to version 3:/).textContent).toBe('Changes from version 2 to version 3: +3 −1 lines');
    const call = calls.find((each) => each.url.startsWith('/api/docs/1/diff'))!;
    const query = new URL(call.url, 'http://localhost').searchParams;
    expect([query.get('from'), query.get('to')]).toEqual(['2', '3']);
    expect(diff.getByText('@@ −1,4 +1,6 @@')).toBeTruthy();
    const rows = [...document.querySelectorAll('.doc-diff-lines tr')];
    expect(rows.map((row) => row.className)).toEqual([
      'doc-line doc-line-same',
      'doc-line doc-line-same',
      'doc-line doc-line-del',
      'doc-line doc-line-add',
      'doc-line doc-line-add',
      'doc-line doc-line-add',
      'doc-line doc-line-same',
    ]);
    expect([...rows[2]!.querySelectorAll('td')].map((cell) => cell.textContent)).toEqual([
      '3',
      '',
      '−',
      'removed: Five days in Lisbon, November 14 to 18. Flights are held, not booked: **nothing is paid yet**.',
    ]);
    expect(rows[3]!.querySelectorAll('td')[2]!.textContent).toBe('+');
    expect(rows[4]!.querySelector('strong, h3, h2')).toBeNull();
    expect(main.queryByRole('heading', { level: 3, name: 'Hotel' })).toBeNull();
    expect(diff.getByRole('link', { name: 'Close diff' }).getAttribute('href')).toBe('#/docs/1?version=3');
  });

  it('shows a title change in the diff', async () => {
    stubFetch(seeded.dashboard, {
      'GET /api/docs/1': () => tripDetail,
      'GET /api/docs/1/diff': () => ({ ...tripDiff, title: { from: 'Lisbon ideas', to: 'Trip plan: Lisbon' } }),
    });
    openApp('#/docs/1?version=3&diff=2');
    expect(await inMain().findByText('Title: Lisbon ideas → Trip plan: Lisbon')).toBeTruthy();
  });
});
