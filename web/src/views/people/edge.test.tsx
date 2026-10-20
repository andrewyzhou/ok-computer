// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { seedDashboard } from '../../../../test/seed';
import { setPrefs } from '../../shell/prefs';
import { inMain, installEventSource, json, openApp, stubFetch, type StubRoutes } from '../../testing';
import { emptyPage, maya, mayaProfile, noName, peoplePage, statusDone, statusFirstRun, statusNoGoogle } from './fixtures';
import { clearPersonLookups, initialsOf, PersonChip } from './PersonChip';
import { ago } from './when';

// the states of the people page that are not the full list, the text of outside names, and the person chip.

installEventSource();

let seeded: Awaited<ReturnType<typeof seedDashboard>>;

beforeEach(async () => {
  setPrefs({ theme: 'system', devMode: false, detailsHidden: false });
  clearPersonLookups();
  seeded = await seedDashboard();
});
afterEach(async () => {
  cleanup();
  await seeded.t.app.stop();
});

function open(routes: StubRoutes, hash = '#/people') {
  const calls = stubFetch(seeded.dashboard, routes);
  openApp(hash);
  return calls;
}

describe('the states of the people page', () => {
  it('asks to connect google when no account is set up', async () => {
    open({ 'GET /api/people': () => emptyPage, 'GET /api/people/status': () => statusNoGoogle });
    expect(await inMain().findByText('Connect Google to fill People')).toBeTruthy();
    expect(inMain().getByRole('link', { name: 'Set up Google' }).getAttribute('href')).toBe('#/google');
  });

  it('shows the backfill of each account on the first run', async () => {
    open({
      'GET /api/people': () => emptyPage,
      'GET /api/people/status': () => ({ ...statusFirstRun, accounts: [statusFirstRun.accounts[0], { ...statusFirstRun.accounts[1]!, backfill: 'running', backfillMessages: 120 }] }),
    });
    expect(await inMain().findByText('Reading your recent mail and calendar')).toBeTruthy();
    const progress = within(inMain().getByRole('list', { name: 'backfill progress' }));
    expect(progress.getByText('personal')).toBeTruthy();
    expect(progress.getByText('waiting to start')).toBeTruthy();
    expect(progress.getByText('reading, 120 messages and 0 events so far')).toBeTruthy();
  });

  it('names the query when nothing matches, and clears it', async () => {
    open({ 'GET /api/people': ({ query }) => (query.get('q') ? emptyPage : peoplePage), 'GET /api/people/status': () => statusDone }, '#/people?q=zzz');
    expect(await inMain().findByText('No one matches “zzz”.')).toBeTruthy();
    fireEvent.click(inMain().getByRole('button', { name: 'Clear search' }));
    await waitFor(() => expect(location.hash).toBe('#/people'));
    expect(await inMain().findByRole('table', { name: 'people' })).toBeTruthy();
    expect((inMain().getByRole('searchbox', { name: 'Search people' }) as HTMLInputElement).value).toBe('');
  });

  it('shows the sentence of the server when the list fails', async () => {
    open({ 'GET /api/people': () => json({ error: 'the people store is busy' }, 500), 'GET /api/people/status': () => statusDone });
    expect((await inMain().findByRole('alert')).textContent).toBe('Could not load people: the people store is busy');
  });

  it('tries the list again with the button under the error', async () => {
    let fail = true;
    open({ 'GET /api/people': () => (fail ? json({ error: 'the people store is busy' }, 500) : peoplePage), 'GET /api/people/status': () => statusDone });
    await inMain().findByRole('alert');
    fail = false;
    fireEvent.click(inMain().getByRole('button', { name: 'Try again' }));
    expect(await inMain().findByRole('table', { name: 'people' })).toBeTruthy();
  });

  it('shows a failed first read with its error and a way to reconnect, above the list and in place of the empty text', async () => {
    const error = 'scope: 403: Request had insufficient authentication scopes.';
    const status = { ...statusDone, accounts: [statusDone.accounts[0]!, { ...statusDone.accounts[1]!, backfill: 'failed' as const, error }] };
    open({ 'GET /api/people': () => peoplePage, 'GET /api/people/status': () => status });
    const box = within(await inMain().findByRole('alert'));
    expect(box.getByText('The first read of school failed.', { exact: false })).toBeTruthy();
    expect(box.getByText(error)).toBeTruthy();
    expect(box.getByRole('link', { name: 'Reconnect Google' }).getAttribute('href')).toBe('#/google');
    expect(inMain().getByRole('table', { name: 'people' })).toBeTruthy();
    cleanup();

    open({ 'GET /api/people': () => emptyPage, 'GET /api/people/status': () => ({ ...status, people: 0 }) });
    expect(await inMain().findByText(error)).toBeTruthy();
    expect(inMain().queryByText('People show up here after the next mail or calendar poll.')).toBeNull();
  });

  it('says so in a short line when the status cannot be read', async () => {
    open({ 'GET /api/people': () => peoplePage, 'GET /api/people/status': () => json({ error: 'the status is busy' }, 500) });
    expect(await inMain().findByText('Could not read the state of the first read of your accounts: the status is busy')).toBeTruthy();
    expect(inMain().getByRole('table', { name: 'people' })).toBeTruthy();
  });

  it('merges a duplicate that the owner names by an address, after a confirm', async () => {
    let merged: unknown;
    open(
      {
        'GET /api/people': () => peoplePage,
        'GET /api/people/status': () => statusDone,
        'GET /api/people/lookup': () => noName,
        'GET /api/people/:id': () => mayaProfile,
        'POST /api/people/:id/merge': ({ body }) => ((merged = body), mayaProfile),
      },
      '#/people/1',
    );
    const form = within(await screen.findByRole('form', { name: 'merge a duplicate' }));
    fireEvent.change(form.getByRole('textbox'), { target: { value: 'k.osei@fabrikam.example' } });
    fireEvent.click(form.getByRole('button', { name: 'Find' }));
    expect(await form.findByText('k.osei@fabrikam.example')).toBeTruthy();
    expect(merged).toBeUndefined();
    fireEvent.click(form.getByRole('button', { name: 'Merge' }));
    await waitFor(() => expect(merged).toEqual({ otherId: 4 }));
  });

  it('says so when the answer has no people list', async () => {
    open({ 'GET /api/people': () => ({ total: 3 }), 'GET /api/people/status': () => statusDone });
    expect((await inMain().findByRole('alert')).textContent).toMatch(/shape that this page does not know/);
  });

  it('shows not found in the panel for a missing person and keeps the list', async () => {
    open({ 'GET /api/people': () => peoplePage, 'GET /api/people/status': () => statusDone, 'GET /api/people/:id': () => json({ error: 'person not found' }, 404) }, '#/people/999');
    expect(await screen.findByText('This person does not exist.')).toBeTruthy();
    expect(await inMain().findByRole('table', { name: 'people' })).toBeTruthy();
  });

  it('shows not found for an id that is not a number, with no request', async () => {
    const calls = open({ 'GET /api/people': () => peoplePage, 'GET /api/people/status': () => statusDone }, '#/people/abc');
    expect(await screen.findByText('This person does not exist.')).toBeTruthy();
    expect(calls.some((call) => call.url.startsWith('/api/people/abc'))).toBe(false);
  });

  it('shows the error of a profile that fails to load', async () => {
    open({ 'GET /api/people': () => peoplePage, 'GET /api/people/status': () => statusDone, 'GET /api/people/:id': () => json({ error: 'the database is locked' }, 500) }, '#/people/1');
    expect(await screen.findByText('Could not load this person: the database is locked')).toBeTruthy();
  });

  it('shows html in a name, a subject and a note as plain text', async () => {
    const bad = '<img src=x onerror="alert(1)">Eve';
    const profile = {
      ...mayaProfile,
      name: bad,
      displayName: bad,
      openThreads: [{ account: 'personal', threadId: 't-9', subject: '<b>urgent</b>', lastAt: '2026-10-17T16:00:00.000Z', messages: 1 }],
      notes: [{ id: 9, kind: 'note' as const, text: '<script>x()</script>', author: 'owner' as const, runId: null, createdAt: '2026-10-17T16:00:00.000Z' }],
    };
    open(
      {
        'GET /api/people': () => ({ ...peoplePage, people: [{ ...maya, name: bad, displayName: bad }] }),
        'GET /api/people/status': () => statusDone,
        'GET /api/people/:id': () => profile,
      },
      '#/people/1',
    );
    expect(await screen.findByText('<b>urgent</b>')).toBeTruthy();
    expect(screen.getByText('<script>x()</script>')).toBeTruthy();
    expect(screen.getAllByText(bad).length).toBeGreaterThan(0);
    expect(document.querySelector('img[src="x"]')).toBeNull();
    expect(document.querySelector('main b')).toBeNull();
  });
});

describe('the person chip', () => {
  it('links to the profile with the id and asks nothing', () => {
    const calls = stubFetch(null);
    render(<PersonChip email="maya@northwind.example" name="Maya Lindqvist" personId={1} />);
    const link = screen.getByRole('link', { name: 'Open Maya Lindqvist' });
    expect(link.getAttribute('href')).toBe('#/people/1');
    expect(link.textContent).toBe('MLMaya Lindqvist');
    expect(calls).toHaveLength(0);
  });

  it('looks an address up once for many chips, and then links to the person', async () => {
    const calls = stubFetch(null, { 'GET /api/people/lookup': () => maya });
    render(
      <div>
        {Array.from({ length: 20 }, (_, index) => (
          <PersonChip key={index} email="Maya@Northwind.example" />
        ))}
      </div>,
    );
    const links = await screen.findAllByRole('link', { name: 'Open Maya Lindqvist' });
    expect(links).toHaveLength(20);
    expect(links[0]!.getAttribute('href')).toBe('#/people/1');
    expect(links[0]!.getAttribute('title')).toBe('maya@northwind.example · Northwind');
    expect(calls.map((call) => call.url)).toEqual(['/api/people/lookup?email=maya%40northwind.example']);
  });

  it('asks again for an address that was no person, when it shows again', async () => {
    let found = false;
    const calls = stubFetch(null, { 'GET /api/people/lookup': () => (found ? maya : json({ error: 'person not found' }, 404)) });
    const first = render(<PersonChip email="maya@northwind.example" />);
    await waitFor(() => expect(calls).toHaveLength(1));
    await new Promise((done) => setTimeout(done, 20));
    first.unmount();
    found = true;
    render(<PersonChip email="maya@northwind.example" />);
    expect(await screen.findByRole('link', { name: 'Open Maya Lindqvist' })).toBeTruthy();
    expect(calls).toHaveLength(2);
  });

  it('stays plain text for an address that is no person', async () => {
    const calls = stubFetch(null, { 'GET /api/people/lookup': () => json({ error: 'person not found' }, 404) });
    const { container } = render(<PersonChip email="noreply@shop.example" name="Shop" />);
    await waitFor(() => expect(calls).toHaveLength(1));
    await new Promise((done) => setTimeout(done, 20));
    expect(screen.queryByRole('link')).toBeNull();
    expect(container.textContent).toBe('SShop');
    expect(container.querySelector('.person-chip')).toBeTruthy();
  });

  it('shows the address of a person without a name', async () => {
    stubFetch(null, { 'GET /api/people/lookup': () => noName });
    render(<PersonChip email="k.osei@fabrikam.example" size="md" />);
    const link = await screen.findByRole('link', { name: 'Open k.osei@fabrikam.example' });
    expect(link.getAttribute('href')).toBe('#/people/4');
    expect(link.className).toContain('person-chip-md');
  });
});

describe('initialsOf', () => {
  it.each([
    ['Maya Lindqvist', 'ML'],
    ['k.osei@fabrikam.example', 'K'],
    ['', '?'],
    ['   ', '?'],
    ['Priya', 'P'],
    ['Maya L.', 'ML'],
    ['ana maría de la cruz', 'AC'],
    ['élodie', 'É'],
    ['— ?', '?'],
  ])('%j gives %j', (text, initials) => {
    expect(initialsOf(text)).toBe(initials);
  });
});

describe('ago', () => {
  const now = Date.parse('2026-10-18T16:00:00.000Z');
  it.each([
    ['2026-10-18T15:59:40.000Z', 'just now'],
    ['2026-10-18T15:30:00.000Z', '30 min ago'],
    ['2026-10-18T13:00:00.000Z', '3 h ago'],
    ['2026-10-17T15:00:00.000Z', 'yesterday'],
    ['2026-10-14T16:00:00.000Z', '4 days ago'],
    ['2026-10-21T17:00:00.000Z', 'in 3 days'],
    ['2026-08-01T12:00:00.000Z', 'Aug 1'],
  ])('%s gives %s', (iso, text) => {
    expect(ago(iso, now)).toBe(text);
  });
});
