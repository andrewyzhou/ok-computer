// @vitest-environment jsdom
import { cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SearchHit, SearchResults, SearchScope } from '../../../../src/dashboard/types';
import { seedDashboard } from '../../../../test/seed';
import { setPrefs } from '../../shell/prefs';
import { inMain, installEventSource, json, openApp, stubFetch } from '../../testing';
import { cutQuery, scopeOf, searchHref, toCommandGroups } from './scopes';
import searchShell from './shell';

// the edge cases of the search: text with the characters of a url, snippets with markup and bad offsets, a scope
// from a newer server, and the errors of the contract.

installEventSource();

let seeded: Awaited<ReturnType<typeof seedDashboard>>;

beforeEach(async () => {
  setPrefs({ theme: 'system', devMode: false, detailsHidden: false });
  seeded = await seedDashboard();
});
afterEach(() => cleanup());

function hit(scope: SearchScope, id: string, extra: Partial<SearchHit> = {}): SearchHit {
  return { scope, id, title: `${scope} ${id}`, snippet: 'text', marks: [], sessionKey: null, runId: null, chatKey: null, at: null, href: `runs/${id}`, ...extra };
}

const searches = (calls: Array<{ url: string }>) => calls.filter((call) => call.url.startsWith('/api/search'));

describe('the search helpers', () => {
  it('takes only the scopes of the contract', () => {
    expect(scopeOf('runs')?.id).toBe('runs');
    expect(scopeOf('RUNS')).toBeUndefined();
    expect(scopeOf('constructor')).toBeUndefined();
    expect(scopeOf(null)).toBeUndefined();
  });

  it('builds a hash that keeps every character of the text in the q value', () => {
    for (const text of ['R&D #1?', 'a=b', '100% done', 'naïve 😀', '?scope=runs']) {
      const href = searchHref(text, 'runs');
      expect(href.indexOf('?')).toBe('search'.length);
      expect(href.slice(1 + 'search'.length)).not.toContain('?');
      const query = new URLSearchParams(href.split('?')[1]);
      expect(query.get('q')).toBe(text);
      expect(query.get('scope')).toBe('runs');
    }
    expect(searchHref('')).toBe('search');
  });

  it('leaves out a group of a scope from a newer server', () => {
    const results = { q: 'x', mode: 'fts', groups: [{ scope: 'calendar', hits: [hit('runs', '1')], more: false }] } as unknown as SearchResults;
    expect(toCommandGroups(results, 'x').map((group) => group.id)).toEqual(['search:all']);
  });
});

describe('the search page', () => {
  it('sends the text with url characters to the server as it is', async () => {
    const calls = stubFetch(seeded.dashboard, { 'GET /api/search': ({ query }) => ({ q: query.get('q'), mode: 'fts', groups: [] }) });
    openApp(`#/${searchHref('R&D #1?')}`);
    expect(await inMain().findByText('Nothing matches “R&D #1?”.')).toBeTruthy();
    expect(new URL(searches(calls)[0]!.url, 'http://localhost').searchParams.get('q')).toBe('R&D #1?');
    expect((inMain().getByRole('searchbox', { name: 'Search everything' }) as HTMLInputElement).value).toBe('R&D #1?');
  });

  it('shows markup in a snippet as text, and survives marks outside the snippet', async () => {
    const results: SearchResults = {
      q: 'tag',
      mode: 'fts',
      groups: [
        {
          scope: 'memory',
          hits: [
            hit('memory', 'notes/a.md', { title: '<b>bold</b>', snippet: '<img src=x onerror=alert(1)> tag', marks: [[-3, 2], [30, 33], [100, 120], [5, 5]], href: 'memory' }),
          ],
          more: false,
        },
      ],
    };
    stubFetch(seeded.dashboard, { 'GET /api/search': () => results });
    openApp('#/search?q=tag');
    const link = await inMain().findByRole('link', { name: '<b>bold</b>' });
    expect(link.querySelector('b')).toBeNull();
    const list = inMain().getByRole('list', { name: 'Memory' });
    expect(list.querySelector('img')).toBeNull();
    expect(list.textContent).toContain('<img src=x onerror=alert(1)> tag');
  });

  it('shows every scope for a scope in the hash that is not known', async () => {
    const calls = stubFetch(seeded.dashboard, { 'GET /api/search': ({ query }) => ({ q: query.get('q'), mode: 'fts', groups: [] }) });
    openApp('#/search?q=essay&scope=calendar');
    expect(await inMain().findByText('Nothing matches “essay”.')).toBeTruthy();
    expect(new URL(searches(calls)[0]!.url, 'http://localhost').searchParams.get('scope')).toBeNull();
    const tabs = within(inMain().getByRole('tablist', { name: 'Scope' }));
    expect(tabs.getByRole('tab', { name: 'All' }).getAttribute('aria-selected')).toBe('true');
  });

  it('asks nothing for a text of spaces only', async () => {
    const calls = stubFetch(seeded.dashboard, { 'GET /api/search': () => ({ q: '', mode: 'like', groups: [] }) });
    openApp('#/search?q=%20%20%20');
    expect(await inMain().findByText('Search chats, runs, tool calls, automations, memory and approvals.')).toBeTruthy();
    expect(searches(calls)).toEqual([]);
  });

  it('shows the error sentence of a 400 as an alert', async () => {
    stubFetch(seeded.dashboard, { 'GET /api/search': () => json({ error: 'give q with 1 to 200 characters' }, 400) });
    openApp('#/search?q=x');
    expect((await inMain().findByRole('alert')).textContent).toBe('give q with 1 to 200 characters');
  });

  it('says that a short text is a plain match', async () => {
    stubFetch(seeded.dashboard, { 'GET /api/search': () => ({ q: 'ab', mode: 'like', groups: [{ scope: 'runs', hits: [hit('runs', 'r1')], more: false }] }) });
    openApp('#/search?q=ab');
    expect(await inMain().findByText(/a plain match/)).toBeTruthy();
  });

  it('opens a hit of a message at its chat', async () => {
    stubFetch(seeded.dashboard, {
      'GET /api/search': () => ({
        q: 'essay',
        mode: 'fts',
        groups: [{ scope: 'messages', hits: [hit('messages', '41', { title: 'essay plan', chatKey: 'main@0', href: 'chats/main%400' })], more: false }],
      }),
    });
    openApp('#/search?q=essay');
    const link = await inMain().findByRole('link', { name: 'essay plan' });
    expect(link.getAttribute('href')).toBe('#/chats/main%400');
    fireEvent.click(inMain().getByRole('button', { name: 'Details of essay plan' }));
    await waitFor(() => expect(document.querySelector('a[href="#/chats/main%400"]')).toBeTruthy());
  });

  it('never cuts an emoji in half at the 200 character limit', () => {
    const cut = cutQuery(`${'a'.repeat(199)}😀`);
    expect(cut.length).toBeLessThanOrEqual(200);
    expect(() => encodeURIComponent(cut)).not.toThrow();
  });

  it('searches a long text that ends in an emoji from the hash', async () => {
    stubFetch(seeded.dashboard, { 'GET /api/search': ({ query }) => ({ q: query.get('q'), mode: 'fts', groups: [] }) });
    openApp(`#/search?q=${'a'.repeat(199)}${encodeURIComponent('😀')}`);
    expect(await inMain().findByText(/Nothing matches/)).toBeTruthy();
  });

  it('gives the command menu a promise, not a throw, for an emoji at the cut', async () => {
    stubFetch(seeded.dashboard, { 'GET /api/search': () => ({ q: 'x', mode: 'fts', groups: [] }) });
    let result: Promise<unknown> | undefined;
    expect(() => {
      result = searchShell.commandSources![0]!.search(`${'a'.repeat(199)}😀`, new AbortController().signal);
    }).not.toThrow();
    await expect(result).resolves.toBeDefined();
  });
});
