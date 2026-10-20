// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { seedDashboard } from '../../../../test/seed';
import { FakeEventSource, inMain, installEventSource, json, openApp, stubFetch } from '../../testing';
import { setPrefs } from '../../shell/prefs';
import { digest, digests, fiveDigest, olderDigests } from './fixtures';

installEventSource();

let seeded: Awaited<ReturnType<typeof seedDashboard>>;

beforeEach(async () => {
  setPrefs({ theme: 'system', devMode: false, detailsHidden: false });
  seeded = await seedDashboard();
});
afterEach(async () => {
  cleanup();
  await seeded.t.app.stop();
});

const pastDigests = {
  'GET /api/inbox/digests': ({ query }: { query: URLSearchParams }) => (query.get('cursor') === 'c2' ? olderDigests : digests),
};

describe('the inbox digest', () => {
  it('lists the inbox group in the nav with its five pages in order', async () => {
    stubFetch(seeded.dashboard, { 'GET /api/inbox/digests/latest': () => digest, ...pastDigests });
    openApp('#/inbox');
    await inMain().findByText('Office hours moved to Thursday');
    const nav = within(screen.getByRole('navigation', { name: 'pages' }));
    const group = nav.getByRole('region', { name: 'Inbox' });
    expect(within(group).getAllByRole('link').map((link) => link.textContent)).toEqual(['Digest', 'Newsletters', 'Subscriptions', 'Drafts', 'Proposals']);
    expect(nav.getByRole('link', { name: 'Digest' }).getAttribute('aria-current')).toBe('page');
  });

  it('shows the sections of the latest digest with their counts, the links and the short text', async () => {
    stubFetch(seeded.dashboard, { 'GET /api/inbox/digests/latest': () => digest, ...pastDigests });
    openApp('#/inbox');
    const main = inMain();
    await main.findByText('Office hours moved to Thursday');
    expect(screen.getByRole('heading', { level: 1, name: 'Digest' })).toBeTruthy();
    expect(main.getByText(/Sunday, October 18/)).toBeTruthy();
    const titles = main.getAllByRole('heading', { level: 2 }).map((heading) => heading.textContent);
    expect(titles).toEqual(['Needs a reply 2', 'Deadlines 1', 'Bills 1', 'Packages 1', 'Message sent to the phone']);
    const replies = within(main.getByRole('list', { name: 'Needs a reply' }));
    expect(replies.getAllByRole('link', { name: 'draft' }).map((link) => link.getAttribute('href'))).toEqual(['#/inbox/drafts?id=41', '#/inbox/drafts?id=42']);
    const bills = within(main.getByRole('list', { name: 'Bills' }));
    expect(bills.getByText('$84.20')).toBeTruthy();
    expect(bills.getByRole('link', { name: 'calendar proposal' }).getAttribute('href')).toBe('#/inbox/proposals?id=13');
    expect(main.getByText(/Drafts are ready for the replies/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open the run' }).getAttribute('href')).toBe('#/runs/run-1');
  });

  it('lists the past digests in the details panel and loads the next page with the cursor', async () => {
    const calls = stubFetch(seeded.dashboard, { 'GET /api/inbox/digests/latest': () => digest, ...pastDigests });
    openApp('#/inbox');
    await inMain().findByText('Office hours moved to Thursday');
    const panel = within(document.querySelector('.details') as HTMLElement);
    expect((await panel.findByRole('link', { name: 'Saturday, October 17' })).getAttribute('href')).toBe('#/inbox/digests/6');
    expect(panel.getByRole('link', { name: 'Sunday, October 18' }).getAttribute('aria-current')).toBe('page');
    fireEvent.click(panel.getByRole('button', { name: 'Load more' }));
    expect(await panel.findByRole('link', { name: 'Friday, October 16' })).toBeTruthy();
    expect(calls.some((call) => call.url === '/api/inbox/digests?cursor=c2')).toBe(true);
    expect(panel.queryByRole('button', { name: 'Load more' })).toBeNull();
  });

  it('shows an empty state when there is no digest yet, and runs the digest job now', async () => {
    const calls = stubFetch(seeded.dashboard, {
      'GET /api/inbox/digests/latest': () => json({ error: 'digest not found' }, 404),
      'GET /api/inbox/digests': () => ({ digests: [], nextCursor: null }),
      'POST /api/inbox/run': () => json({ started: true }, 202),
    });
    openApp('#/inbox');
    const main = inMain();
    expect(await main.findByText('No digest yet.')).toBeTruthy();
    fireEvent.click(main.getByRole('button', { name: 'Make the digest now' }));
    expect(await main.findByText('Started. The digest shows here when it is ready.')).toBeTruthy();
    expect(calls.find((call) => call.method === 'POST')).toMatchObject({ url: '/api/inbox/run', body: { job: 'digest' } });
  });

  it('loads the page again when a run ends', async () => {
    let made = false;
    stubFetch(seeded.dashboard, {
      'GET /api/inbox/digests/latest': () => (made ? digest : json({ error: 'digest not found' }, 404)),
      ...pastDigests,
    });
    openApp('#/inbox');
    await inMain().findByText('No digest yet.');
    made = true;
    FakeEventSource.find('/api/stream')!.emit({ kind: 'run', run: { id: 'run-9' } });
    expect(await inMain().findByText('Office hours moved to Thursday')).toBeTruthy();
  });

  it('shows a past digest by its id with a crumb to the latest, and an empty state for an unknown id', async () => {
    stubFetch(seeded.dashboard, {
      'GET /api/inbox/digests/:id': ({ params }) => (params.id === '7' ? digest : json({ error: 'digest not found' }, 404)),
      ...pastDigests,
    });
    openApp('#/inbox/digests/7');
    await inMain().findByText('Office hours moved to Thursday');
    const crumbs = within(screen.getByRole('navigation', { name: 'breadcrumb' }));
    expect(crumbs.getByRole('link', { name: 'Digest' }).getAttribute('href')).toBe('#/inbox');
    location.hash = '#/inbox/digests/99';
    expect(await inMain().findByText('This digest does not exist.')).toBeTruthy();
    await waitFor(() => expect(inMain().queryByRole('button', { name: 'Make the digest now' })).toBeNull());
  });

  it('shows the coverage of each account: read, hidden, the capped warning and the account it could not read', async () => {
    stubFetch(seeded.dashboard, { 'GET /api/inbox/digests/latest': () => fiveDigest, ...pastDigests });
    openApp('#/inbox');
    const main = inMain();
    const strip = within(await main.findByRole('list', { name: 'accounts in this digest' }));
    expect(strip.getAllByRole('listitem').map((item) => item.querySelector('.inbox-account')?.textContent)).toEqual(['a06', 'yurun', 'a581', 'school', 'hkn']);
    const a06 = within(main.getByTestId('coverage-a06'));
    expect(a06.getByText('64 read')).toBeTruthy();
    expect(a06.getByText('58 hidden')).toBeTruthy();
    expect(a06.queryByText('more mail than the limit')).toBeNull();
    const school = within(main.getByTestId('coverage-school'));
    expect(school.getByText('100 of 240 read')).toBeTruthy();
    expect(school.getByText('more mail than the limit').getAttribute('title')).toBe('The digest read only the newest 100 of 240 messages.');
    const hkn = within(main.getByTestId('coverage-hkn'));
    expect(hkn.getByText('Not read: the sign-in of this account has expired')).toBeTruthy();
    expect(hkn.queryByText(/read$/)).toBeNull();
    // 58 + 9 + 7 + 80 + 0.
    expect(main.getByText('154 automated or list mails hidden')).toBeTruthy();
    // the mail that needs a reply stays the first section, under the strip.
    expect(main.getAllByRole('heading', { level: 2 })[0]!.textContent).toBe('Needs a reply 2');
  });

  it('says one mail in the hidden line when one mail is hidden', async () => {
    const one = { ...fiveDigest, stats: { accounts: [{ ...fiveDigest.stats!.accounts[0]!, hidden: 1 }], droppedDates: 0 } };
    stubFetch(seeded.dashboard, { 'GET /api/inbox/digests/latest': () => one, ...pastDigests });
    openApp('#/inbox');
    expect(await inMain().findByText('1 automated or list mail hidden')).toBeTruthy();
  });

  it('shows no coverage and no error for a digest of phase 5 without stats', async () => {
    stubFetch(seeded.dashboard, { 'GET /api/inbox/digests/latest': () => digest, ...pastDigests });
    openApp('#/inbox');
    const main = inMain();
    await main.findByText('Office hours moved to Thursday');
    expect(main.queryByRole('list', { name: 'accounts in this digest' })).toBeNull();
    expect(main.queryByText(/automated or list mail/)).toBeNull();
    expect(main.queryByText(/Not read/)).toBeNull();
    expect(main.queryByText('automated')).toBeNull();
  });

  it('marks an automated deadline, bill or package, and never a mail that needs a reply', async () => {
    const replyFromMachine = { ...fiveDigest, items: [{ ...fiveDigest.items[0]!, mail: 'automated' as const }, ...fiveDigest.items.slice(1)] };
    stubFetch(seeded.dashboard, { 'GET /api/inbox/digests/latest': () => replyFromMachine, ...pastDigests });
    openApp('#/inbox');
    const main = inMain();
    await main.findByText('Dues for the fall term');
    expect(within(main.getByRole('list', { name: 'Needs a reply' })).queryByText('automated')).toBeNull();
    const deadlines = within(main.getByRole('list', { name: 'Deadlines' }));
    expect(within(deadlines.getByText('Course site').closest('li')!).getByText('automated')).toBeTruthy();
    expect(within(deadlines.getByText('Club treasurer').closest('li')!).queryByText('automated')).toBeNull();
    expect(within(main.getByRole('list', { name: 'Bills' })).getByText('automated')).toBeTruthy();
    expect(within(main.getByRole('list', { name: 'Packages' })).getByText('automated')).toBeTruthy();
  });
});
