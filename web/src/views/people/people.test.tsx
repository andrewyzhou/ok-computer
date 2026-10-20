// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PersonNoteView, PersonProfile } from '../../../../src/dashboard/people-types';
import { seedDashboard } from '../../../../test/seed';
import { setPrefs } from '../../shell/prefs';
import { inMain, installEventSource, json, openApp, stubFetch, type StubRoutes } from '../../testing';
import { mayaProfile, peoplePage, statusDone, tomasProfile } from './fixtures';

// the people list and the profile in the details panel, against the answers of fixtures.ts.

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

const profiles: Record<string, PersonProfile> = { '1': mayaProfile, '2': tomasProfile };

const people: StubRoutes = {
  'GET /api/people': () => peoplePage,
  'GET /api/people/status': () => statusDone,
  'GET /api/people/:id': ({ params }) => profiles[params.id!] ?? json({ error: 'person not found' }, 404),
};

async function open(routes: StubRoutes = {}, hash = '#/people') {
  const calls = stubFetch(seeded.dashboard, { ...people, ...routes });
  openApp(hash);
  await inMain().findByRole('table', { name: 'people' });
  return calls;
}

const table = () => within(inMain().getByRole('table', { name: 'people' }));
const rows = () => table().getAllByRole('row').slice(1);
const listCalls = (calls: Array<{ method: string; url: string }>) => calls.filter((call) => call.method === 'GET' && call.url.startsWith('/api/people?'));

describe('the people list', () => {
  it('lists the five people in the order of the server, with a name guessed from the address of a person without one', async () => {
    const calls = await open();
    expect(rows().map((row) => row.querySelector('.people-name-main')?.textContent)).toEqual([
      'Maya Lindqvist',
      'Tomas Okafor',
      'Priya',
      'K Osei (guessed)',
      'Jonas Weber',
    ]);
    expect(within(rows()[0]!).getByText('maya@northwind.example')).toBeTruthy();
    // the row without a name shows the guessed name, marked as a guess, and the address once under it.
    expect(within(rows()[3]!).getAllByText('k.osei@fabrikam.example')).toHaveLength(1);
    expect(within(rows()[4]!).getByText('none yet')).toBeTruthy();
    expect(inMain().getByText('5 people')).toBeTruthy();
    expect(listCalls(calls).map((call) => call.url)).toEqual(['/api/people?sort=recent&limit=50']);
  });

  it('puts the search in the hash after the typing stops, and asks the server with q', async () => {
    const calls = await open();
    fireEvent.change(inMain().getByRole('searchbox', { name: 'Search people' }), { target: { value: 'maya' } });
    expect(location.hash).toBe('#/people');
    await waitFor(() => expect(location.hash).toBe('#/people?q=maya'));
    await waitFor(() => expect(listCalls(calls).some((call) => call.url === '/api/people?q=maya&sort=recent&limit=50')).toBe(true));
  });

  it('sends the sort to the server', async () => {
    const calls = await open();
    fireEvent.click(inMain().getByRole('button', { name: 'Frequent' }));
    await waitFor(() => expect(location.hash).toBe('#/people?sort=frequent'));
    await waitFor(() => expect(listCalls(calls).some((call) => call.url === '/api/people?sort=frequent&limit=50')).toBe(true));
    expect(inMain().getByRole('button', { name: 'Frequent' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('opens a profile from a row and keeps the query', async () => {
    await open({}, '#/people?q=a');
    fireEvent.click(within(rows()[0]!).getByText('Maya Lindqvist'));
    await waitFor(() => expect(location.hash).toBe('#/people/1?q=a'));
    expect(await screen.findByText('maya.lindqvist@gmail.com')).toBeTruthy();
    expect(screen.getAllByText('maya@northwind.example').length).toBeGreaterThan(0);
    expect(screen.getByText('primary')).toBeTruthy();
    expect(screen.getByText('prefers meetings before 11:00')).toBeTruthy();
    expect(screen.queryByText('prefers afternoons')).toBeNull();
    expect(screen.getByText('Design review')).toBeTruthy();
    expect(screen.getByText('Roadmap sync')).toBeTruthy();
    expect(screen.getByText('met at the design offsite')).toBeTruthy();
    expect(screen.getByText('Maya L.')).toBeTruthy();
    expect(rows()[0]!.getAttribute('aria-current')).toBe('true');
    // the list stays mounted under the profile.
    expect(rows()).toHaveLength(5);
    fireEvent.click(screen.getByRole('button', { name: 'Close details' }));
    await waitFor(() => expect(location.hash).toBe('#/people?q=a'));
  });

  it('shows the open thread of a profile as text with no link to the mail', async () => {
    await open({}, '#/people/2');
    const subject = await screen.findByText('Re: Lease for the new place');
    expect(subject.closest('a')).toBeNull();
    expect(screen.getByText(/personal · 2 messages/)).toBeTruthy();
  });

  it('links an agent note to its run only in developer mode', async () => {
    await open({}, '#/people/1');
    await screen.findByText('prefers meetings before 11:00');
    const runLinks = () => [...document.querySelectorAll<HTMLAnchorElement>('a[href^="#/runs/"]')];
    expect(runLinks()).toHaveLength(0);
    expect([...document.querySelectorAll('.people-author')].map((each) => each.textContent)).toEqual(['Agent', 'You']);
    act(() => setPrefs({ devMode: true }));
    expect(runLinks().map((link) => [link.textContent, link.getAttribute('href')])).toEqual([['Agent', '#/runs/run-people-2']]);
  });

  it('follows the cursor with show more', async () => {
    const calls = await open({
      'GET /api/people': ({ query }) =>
        query.get('cursor') === 'c2' ? { people: [{ ...peoplePage.people[0]!, id: 9, displayName: 'Later Person', name: 'Later Person' }], next: null, total: 6 } : { ...peoplePage, next: 'c2', total: 6 },
    });
    fireEvent.click(inMain().getByRole('button', { name: 'Show more' }));
    expect(await inMain().findByText('Later Person')).toBeTruthy();
    expect(listCalls(calls).some((call) => call.url === '/api/people?sort=recent&limit=50&cursor=c2')).toBe(true);
    expect(inMain().queryByRole('button', { name: 'Show more' })).toBeNull();
  });
});

describe('the note form', () => {
  it('posts the kind and the text, and shows the new note after the profile loads again', async () => {
    let profile = mayaProfile;
    const calls = await open(
      {
        'GET /api/people/:id': () => profile,
        'POST /api/people/:id/notes': ({ body }) => {
          const input = body as { kind: 'note' | 'preference'; text: string };
          const note: PersonNoteView = { id: 10, kind: input.kind, text: input.text, author: 'owner', runId: null, createdAt: '2026-10-18T16:00:00.000Z' };
          profile = { ...profile, preferences: [note, ...profile.preferences] };
          return note;
        },
      },
      '#/people/1',
    );
    await screen.findByText('Design review');
    const save = screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(screen.getByRole('textbox', { name: 'Add a note' }), { target: { value: '   ' } });
    expect(save.disabled).toBe(true);
    fireEvent.change(screen.getByRole('textbox', { name: 'Add a note' }), { target: { value: ' likes tea ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Preference' }));
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    expect(await screen.findByText('likes tea')).toBeTruthy();
    expect(calls.find((call) => call.method === 'POST')).toEqual({ method: 'POST', url: '/api/people/1/notes', body: { kind: 'preference', text: 'likes tea' } });
    expect((screen.getByRole('textbox', { name: 'Add a note' }) as HTMLTextAreaElement).value).toBe('');
  });

  it('shows the error of the server inline', async () => {
    await open({ 'POST /api/people/:id/notes': () => json({ error: 'text must be 1 to 2000 characters' }, 400) }, '#/people/1');
    await screen.findByText('Design review');
    fireEvent.change(screen.getByRole('textbox', { name: 'Add a note' }), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect((await screen.findByRole('alert')).textContent).toBe('text must be 1 to 2000 characters');
    expect((screen.getByRole('textbox', { name: 'Add a note' }) as HTMLTextAreaElement).value).toBe('x');
  });
});
