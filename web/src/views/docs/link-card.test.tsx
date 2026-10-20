// @vitest-environment jsdom
import { act, cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DocDetail } from '../../../../src/dashboard/docs-types';
import { seedDashboard } from '../../../../test/seed';
import { applyTurnAction } from '../../chat-stream';
import { setPrefs } from '../../shell/prefs';
import { inMain, installEventSource, json, openApp, stubFetch, type StubRoutes } from '../../testing';
import { chatRow, message } from '../chats/testdata';
import { DocLinkCards, docLinksIn } from './DocLinkCard';
import { docSummary, taintedDetail, tripDetail, tripVersion, versionMeta } from './fixtures';

installEventSource();

afterEach(() => cleanup());

const detail = (id: number, title: string): DocDetail => ({
  doc: docSummary(id, { title }),
  version: { ...versionMeta(1, { title }), body: 'text', links: [] },
  versions: [versionMeta(1, { title })],
  comments: [],
});

// the docs of the stubs: the trip plan, the tainted comparison, and three short docs.
const DOCS: Record<string, DocDetail> = {
  '1': tripDetail,
  '2': taintedDetail,
  '3': detail(3, 'Prep: 1:1 with Dana'),
  '4': detail(4, 'Morning brief, October 12'),
  '5': detail(5, 'Notes on the essay'),
};

const docRoutes = (extra: StubRoutes = {}): StubRoutes => ({
  ...extra,
  'GET /api/docs/:id': ({ params }) => DOCS[params.id!] ?? json({ error: 'doc not found' }, 404),
});

const cards = () => [...document.querySelectorAll('.doc-cards > li')] as HTMLElement[];

describe('the doc links of a text', () => {
  it('finds the links with or without an origin and a version, once each and in order', () => {
    const text = 'Plan: http://127.0.0.1:4317/#/docs/12 and #/docs/3?version=2, again https://okc.example.com/#/docs/12?version=1 and #/docs/7.';
    expect(docLinksIn(text)).toEqual([{ id: 12 }, { id: 3, version: 2 }, { id: 7 }]);
  });

  it('ignores the list, a zero or a leading zero, and a hash that goes on', () => {
    expect(docLinksIn('see #/docs and #/docs?q=trip, #/docs/0, #/docs/01, #/docs/12x, #/docs/4/edit, #/docs/-1')).toEqual([]);
    expect(docLinksIn('no link here')).toEqual([]);
  });

  it('renders nothing for a text without a link', () => {
    stubFetch(null);
    const { container } = render(<DocLinkCards text="Your plan is in the docs." />);
    expect(container.innerHTML).toBe('');
  });
});

describe('the doc link card', () => {
  it('shows the card of a linked doc with its title, kind and version', async () => {
    const calls = stubFetch(null, docRoutes());
    render(<DocLinkCards text="Your trip plan is ready: http://127.0.0.1:4317/#/docs/1" />);
    const link = await screen.findByRole('link', { name: /Trip plan: Lisbon/ });
    expect(link.getAttribute('href')).toBe('#/docs/1');
    expect(within(link).getByText('Plan')).toBeTruthy();
    expect(within(link).getByText(/^version 3 · /)).toBeTruthy();
    expect(link.querySelector('.doc-card-taint')).toBeNull();
    expect(calls.map((call) => call.url)).toEqual(['/api/docs/1']);
  });

  it('shows one card for two links to the same doc, and at most three cards', async () => {
    stubFetch(null, docRoutes());
    const { unmount } = render(<DocLinkCards text="#/docs/1 and again http://127.0.0.1:4317/#/docs/1" />);
    await screen.findByText('Trip plan: Lisbon');
    expect(cards()).toHaveLength(1);
    unmount();

    render(<DocLinkCards text="#/docs/3 #/docs/4 #/docs/5 #/docs/1" />);
    await screen.findByText('Notes on the essay');
    expect(cards().map((each) => each.querySelector('.doc-card-title')?.textContent)).toEqual(['Prep: 1:1 with Dana', 'Morning brief, October 12', 'Notes on the essay']);
    expect(screen.queryByText('Trip plan: Lisbon')).toBeNull();
  });

  it('marks a doc that was written after reading outside content', async () => {
    stubFetch(null, docRoutes());
    render(<DocLinkCards text="#/docs/2" />);
    const link = await screen.findByRole('link', { name: /Laptop comparison/ });
    expect(within(link).getByText('outside text')).toBeTruthy();
  });

  it('loads the version of a version link and opens it', async () => {
    const calls = stubFetch(null, {
      'GET /api/docs/:id': () => ({ ...tripDetail, version: { ...tripVersion, ...versionMeta(2, { createdAt: '2026-10-10T17:30:00.000Z' }) } }),
    });
    render(<DocLinkCards text="the old plan: #/docs/1?version=2" />);
    const link = await screen.findByRole('link', { name: /Trip plan: Lisbon/ });
    expect(link.getAttribute('href')).toBe('#/docs/1?version=2');
    expect(within(link).getByText(/^version 2 of 3 · /)).toBeTruthy();
    expect(calls.map((call) => call.url)).toEqual(['/api/docs/1?version=2']);
  });

  it('shows a skeleton of the same card while the doc loads', () => {
    stubFetch(null, { 'GET /api/docs/:id': () => new Promise(() => {}) });
    render(<DocLinkCards text="#/docs/1" />);
    const card = cards()[0]!.firstElementChild!;
    expect(card.className).toBe('doc-card is-loading');
    expect(card.getAttribute('aria-busy')).toBe('true');
    expect(screen.getByText('Loading doc #1…')).toBeTruthy();
  });

  it('shows a muted card for a doc that does not exist, and a plain link when the doc cannot load', async () => {
    stubFetch(null, docRoutes({ 'GET /api/docs/9': () => json({ error: 'the database is busy' }, 500) }));
    render(<DocLinkCards text="#/docs/8 and #/docs/9" />);
    expect(await screen.findByText('Doc #8 does not exist.')).toBeTruthy();
    expect(screen.getByText('Doc #8 does not exist.').closest('a')).toBeNull();
    const plain = await screen.findByRole('link', { name: 'Open doc #9' });
    expect(plain.getAttribute('href')).toBe('#/docs/9');
  });

  it('opens the local hash for a link of another host, and finds no doc in a javascript: link that it does not show', async () => {
    stubFetch(null, docRoutes());
    render(<DocLinkCards text="[plan](javascript:alert(1)//#/docs/1) and https://evil.example/#/docs/3 and data:text/html,#/docs/4" />);
    await screen.findByText('Morning brief, October 12');
    const hrefs = screen.getAllByRole('link').map((link) => link.getAttribute('href'));
    expect(hrefs).toEqual(['#/docs/1', '#/docs/3', '#/docs/4']);
    for (const link of screen.getAllByRole('link')) expect(link.getAttribute('href')!.startsWith('#/docs/')).toBe(true);
  });
});

describe('the card in a chat transcript', () => {
  let seeded: Awaited<ReturnType<typeof seedDashboard>>;
  beforeEach(async () => {
    setPrefs({ theme: 'system', devMode: false, detailsHidden: false });
    seeded = await seedDashboard();
    act(() => applyTurnAction({ kind: 'snapshot', turns: [] }));
  });
  afterEach(async () => {
    await seeded.t.app.stop();
  });

  it('renders the card under an agent message and not under the owner message', async () => {
    const chat = chatRow();
    stubFetch(
      seeded.dashboard,
      docRoutes({
        'GET /api/chats': () => ({ chats: [chat], nextCursor: null }),
        'GET /api/chats/:key/messages': () => ({
          chat,
          messages: [
            message({ role: 'owner', text: 'plan my trip, like #/docs/3', createdAt: '2026-10-13T01:00:00.000Z' }),
            message({ role: 'agent', text: 'Your trip plan is ready: http://127.0.0.1:4317/#/docs/1', createdAt: '2026-10-13T01:01:00.000Z' }),
          ],
          before: null,
        }),
      }),
    );
    openApp('#/chats/main%400');
    const link = await inMain().findByRole('link', { name: /Trip plan: Lisbon/ });
    expect(link.getAttribute('href')).toBe('#/docs/1');
    expect(inMain().getAllByRole('list', { name: 'linked doc' })).toHaveLength(1);
    expect(inMain().queryByText('Prep: 1:1 with Dana')).toBeNull();
  });
});
