// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SearchHit, SearchResults, SearchScope } from '../../../../src/dashboard/types';
import { seedDashboard } from '../../../../test/seed';
import { setPrefs } from '../../shell/prefs';
import { inMain, installEventSource, json, openApp, stubFetch, type StubRequest } from '../../testing';
import { SCOPES, toCommandGroups } from './scopes';

installEventSource();

// the search endpoint is built in parallel, so these tests answer it with a fixture and the seeded database answers
// the rest of the shell.

function hit(scope: SearchScope, id: string, extra: Partial<SearchHit> = {}): SearchHit {
  return {
    scope,
    id,
    title: `${scope} ${id}`,
    snippet: 'the essay is due friday',
    marks: [[4, 9]],
    sessionKey: null,
    runId: null,
    chatKey: null,
    at: null,
    href: `runs/${id}`,
    ...extra,
  };
}

function fixture(q: string, scope?: SearchScope): SearchResults {
  const groups: SearchResults['groups'] = [
    {
      scope: 'messages',
      hits: [
        hit('messages', '41', {
          title: 'essay plan',
          sessionKey: 'main',
          runId: 'run-1',
          chatKey: 'main@0',
          at: '2026-10-17T09:30:00.000Z',
          href: 'chats/main@0',
        }),
      ],
      more: false,
    },
    { scope: 'runs', hits: [hit('runs', 'run-1', { title: 'finish the essay' }), hit('runs', 'run-2', { title: 'essay outline' })], more: true },
    { scope: 'tools', hits: [], more: false },
    // the second mark overlaps the first, and the page skips it.
    { scope: 'automations', hits: [hit('automations', 'a1', { title: 'check-in: finish essay', marks: [[4, 9], [6, 12]], href: 'automations' })], more: false },
    { scope: 'memory', hits: [], more: false },
    { scope: 'approvals', hits: [], more: false },
  ];
  return { q, mode: q.length < 3 ? 'like' : 'fts', groups: scope ? groups.filter((group) => group.scope === scope) : groups };
}

const answer = ({ query }: StubRequest) => fixture(query.get('q') ?? '', (query.get('scope') as SearchScope | null) ?? undefined);

let seeded: Awaited<ReturnType<typeof seedDashboard>>;

beforeEach(async () => {
  setPrefs({ theme: 'system', devMode: false, detailsHidden: false });
  seeded = await seedDashboard();
});
afterEach(() => cleanup());

const searches = (calls: Array<{ url: string }>) => calls.filter((call) => call.url.startsWith('/api/search'));

describe('toCommandGroups', () => {
  it('maps each scope with hits to a group and ends with a link to all results', () => {
    const groups = toCommandGroups(fixture('essay'), 'essay');
    expect(groups.map((group) => group.label)).toEqual(['Messages', 'Runs', 'Automations', 'Search']);
    const [messages, runs, , all] = groups;
    expect(messages!.id).toBe('search:messages');
    expect(messages!.items[0]).toEqual({
      id: 'messages:41',
      label: 'essay plan',
      detail: { text: 'the essay is due friday', marks: [[4, 9]] },
      icon: 'chat',
      href: 'chats/main@0',
    });
    expect(messages!.more).toBeUndefined();
    expect(runs!.items.map((item) => item.icon)).toEqual(['run', 'run']);
    expect(runs!.more).toEqual({ label: 'All runs for “essay”', href: 'search?q=essay&scope=runs' });
    expect(all).toEqual({
      id: 'search:all',
      label: 'Search',
      items: [{ id: 'search:all', label: 'All results for “essay”', icon: 'search', href: 'search?q=essay' }],
    });
  });

  it('keeps the scopes in the order of SearchScope with their icons, and encodes the text of the links', () => {
    expect(SCOPES.map((scope) => [scope.id, scope.label, scope.icon])).toEqual([
      ['messages', 'Messages', 'chat'],
      ['runs', 'Runs', 'run'],
      ['tools', 'Tool calls', 'integration'],
      ['automations', 'Automations', 'automation'],
      ['memory', 'Memory', 'memory'],
      ['approvals', 'Approvals', 'approval'],
    ]);
    const groups = toCommandGroups(fixture('a "b" & c#'), 'a "b" & c#');
    const href = groups.at(-1)!.items[0]!.href!;
    expect(new URLSearchParams(href.split('?')[1]).get('q')).toBe('a "b" & c#');
    expect(href).not.toContain('#');
    expect(toCommandGroups({ q: 'zz', mode: 'like', groups: [] }, 'zz').map((group) => group.label)).toEqual(['Search']);
  });
});

describe('the command menu search', () => {
  it('shows grouped hits after typing, and opens a hit or all results', async () => {
    const calls = stubFetch(seeded.dashboard, { 'GET /api/search': answer });
    openApp('#/');
    await inMain().findByText('Cost today');
    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    const menu = await screen.findByRole('dialog', { name: 'Command menu' });
    const input = within(menu).getByRole('combobox');
    fireEvent.change(input, { target: { value: 'essay' } });
    const messages = await within(menu).findByRole('group', { name: 'Messages' });
    expect(within(messages).getByText('essay', { selector: 'mark' })).toBeTruthy();
    expect(within(menu).getByRole('group', { name: 'Runs' })).toBeTruthy();
    expect(within(menu).getByRole('option', { name: /All runs for “essay”/ })).toBeTruthy();
    const query = new URL(searches(calls)[0]!.url, 'http://localhost').searchParams;
    expect(query.get('q')).toBe('essay');
    expect(query.get('limit')).toBe('5');

    // the hits come after the local groups, so the arrow keys reach the message hit.
    const options = within(menu).getAllByRole('option');
    const at = options.findIndex((option) => option.textContent?.includes('essay plan'));
    for (let i = 0; i < at; i += 1) fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(location.hash).toBe('#/chats/main@0'));

    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    const again = await screen.findByRole('dialog', { name: 'Command menu' });
    fireEvent.change(within(again).getByRole('combobox'), { target: { value: 'essay' } });
    fireEvent.click(await within(again).findByRole('option', { name: /All results for “essay”/ }));
    await waitFor(() => expect(location.hash).toBe('#/search?q=essay'));
    expect(await inMain().findByRole('link', { name: 'essay plan' })).toBeTruthy();
  });

  it('cuts a long text to 200 characters and shows an error of the server in the menu', async () => {
    const calls = stubFetch(seeded.dashboard, { 'GET /api/search': () => json({ error: 'the search index is not ready' }, 500) });
    openApp('#/');
    await inMain().findByText('Cost today');
    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    const menu = await screen.findByRole('dialog', { name: 'Command menu' });
    fireEvent.change(within(menu).getByRole('combobox'), { target: { value: 'x'.repeat(250) } });
    expect(await within(menu).findByText(/Search: the search index is not ready/)).toBeTruthy();
    expect(new URL(searches(calls)[0]!.url, 'http://localhost').searchParams.get('q')).toBe('x'.repeat(200));
  });
});

describe('the search page', () => {
  it('reads the text and scope from the hash, marks the snippets, and changes the request with the tabs', async () => {
    const calls = stubFetch(seeded.dashboard, { 'GET /api/search': answer });
    openApp('#/search?q=essay');
    const main = inMain();
    expect(await main.findByRole('link', { name: 'essay plan' })).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1, name: 'Search' })).toBeTruthy();
    expect((main.getByRole('searchbox', { name: 'Search everything' }) as HTMLInputElement).value).toBe('essay');
    expect(main.getByRole('link', { name: 'essay plan' }).getAttribute('href')).toBe('#/chats/main@0');
    expect(main.getAllByText('essay', { selector: 'mark' }).length).toBeGreaterThan(0);
    // the overlapping second mark is skipped, so the automation snippet has one mark.
    const automation = main.getByRole('list', { name: 'Automations' });
    expect(within(automation).getAllByText(/./, { selector: 'mark' }).map((mark) => mark.textContent)).toEqual(['essay']);
    expect(main.getByText('session main')).toBeTruthy();
    expect(main.getByText('run run-1')).toBeTruthy();
    expect(main.queryByText(/Short text/)).toBeNull();
    expect(new URL(searches(calls)[0]!.url, 'http://localhost').searchParams.get('scope')).toBeNull();

    // the tabs show the counts of the answer for every scope, with a plus when the scope has more.
    const tabs = within(screen.getByRole('tablist', { name: 'Scope' }));
    expect(tabs.getByRole('tab', { name: /^Runs 2\+/ })).toBeTruthy();
    expect(tabs.getByRole('tab', { name: /^Messages/ }).textContent).toBe('Messages1');

    fireEvent.click(main.getByRole('button', { name: 'Show all runs' }));
    await waitFor(() => expect(location.hash).toBe('#/search?q=essay&scope=runs'));
    await waitFor(() => expect(main.queryByRole('link', { name: 'essay plan' })).toBeNull());
    expect(await main.findByRole('link', { name: 'essay outline' })).toBeTruthy();
    expect(new URL(searches(calls).at(-1)!.url, 'http://localhost').searchParams.get('scope')).toBe('runs');
    expect(tabs.getByRole('tab', { name: /^Runs/ }).getAttribute('aria-selected')).toBe('true');

    fireEvent.click(tabs.getByRole('tab', { name: 'All' }));
    await waitFor(() => expect(location.hash).toBe('#/search?q=essay'));
    expect(await main.findByRole('link', { name: 'essay plan' })).toBeTruthy();
  });

  it('updates the hash in place after typing, and Enter searches at once', async () => {
    const calls = stubFetch(seeded.dashboard, { 'GET /api/search': answer });
    openApp('#/search');
    const main = inMain();
    expect(await main.findByText('Search chats, runs, tool calls, automations, memory and approvals.')).toBeTruthy();
    expect(searches(calls)).toEqual([]);
    const field = main.getByRole('searchbox', { name: 'Search everything' });
    const before = history.length;
    fireEvent.change(field, { target: { value: 'es' } });
    fireEvent.change(field, { target: { value: 'ess' } });
    fireEvent.change(field, { target: { value: 'essay' } });
    await waitFor(() => expect(location.hash).toBe('#/search?q=essay'));
    expect(history.length).toBe(before);
    expect(await main.findByRole('link', { name: 'essay plan' })).toBeTruthy();
    expect(searches(calls).map((call) => new URL(call.url, 'http://localhost').searchParams.get('q'))).toEqual(['essay']);

    // the field keeps its node, because the page is not mounted again.
    expect(main.getByRole('searchbox', { name: 'Search everything' })).toBe(field);
    fireEvent.change(field, { target: { value: 'say "hi" & go' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(location.hash).toBe('#/search?q=say+%22hi%22+%26+go');
    await waitFor(() => expect(searches(calls).length).toBe(2));
    expect(new URL(searches(calls)[1]!.url, 'http://localhost').searchParams.get('q')).toBe('say "hi" & go');

    // the down arrow moves from the field into the results, and on through the links.
    await main.findByRole('link', { name: 'essay plan' });
    fireEvent.keyDown(field, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(main.getByRole('link', { name: 'essay plan' }));
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(main.getByRole('link', { name: 'finish the essay' }));
  });

  it('notes a short text, and shows the facts of a hit in the details panel', async () => {
    stubFetch(seeded.dashboard, { 'GET /api/search': answer });
    openApp('#/search?q=es&scope=nowhere');
    const main = inMain();
    expect(await main.findByText('Short text: a plain match, not the full-text index.')).toBeTruthy();
    // a scope that is not a scope shows every scope.
    expect(screen.getByRole('tab', { name: 'All' }).getAttribute('aria-selected')).toBe('true');
    fireEvent.click(main.getByRole('button', { name: 'Details of essay plan' }));
    const details = within(screen.getByRole('complementary', { name: 'details' }));
    expect(details.getByRole('heading', { name: 'essay plan' })).toBeTruthy();
    expect(details.getByRole('link', { name: 'run-1' }).getAttribute('href')).toBe('#/runs/run-1');
    expect(details.getByRole('link', { name: 'main' }).getAttribute('href')).toBe('#/sessions/main');
    expect(details.getByRole('link', { name: 'main@0' }).getAttribute('href')).toBe('#/chats/main%400');
    expect(details.getByRole('link', { name: /Open/ }).getAttribute('href')).toBe('#/chats/main@0');
    // a hit with no time, session or run has no meta line.
    fireEvent.click(main.getByRole('button', { name: 'Details of essay outline' }));
    expect(details.getByRole('heading', { name: 'essay outline' })).toBeTruthy();
    expect(details.queryByText('Session')).toBeNull();
  });

  it('says when nothing matches, and shows the error of a bad request', async () => {
    stubFetch(seeded.dashboard, {
      'GET /api/search': ({ query }) =>
        query.get('q') === 'bad' ? json({ error: 'q must have 1 to 200 characters' }, 400) : { q: query.get('q'), mode: 'fts', groups: [] },
    });
    openApp('#/search?q=zebra');
    expect(await inMain().findByText('Nothing matches “zebra”.')).toBeTruthy();
    await act(async () => {
      location.hash = '#/search?q=bad';
    });
    expect(await inMain().findByText('q must have 1 to 200 characters')).toBeTruthy();
    expect((inMain().getByRole('searchbox', { name: 'Search everything' }) as HTMLInputElement).value).toBe('bad');
  });
});
