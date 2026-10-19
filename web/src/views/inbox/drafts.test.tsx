// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DraftView } from '../../../../src/dashboard/types';
import { seedDashboard } from '../../../../test/seed';
import { inMain, installEventSource, openApp, stubFetch } from '../../testing';
import { setPrefs } from '../../shell/prefs';
import { draft, drafts } from './fixtures';

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

// a full first page of 50 drafts, then a short second page, so the second page is the last one.
const full: DraftView[] = Array.from({ length: 50 }, (_, index) => draft(200 - index, { subject: `Re: thread ${200 - index}` }));
const older: DraftView[] = [draft(100, { subject: 'Re: the oldest thread' })];

const details = () => within(document.querySelector('.details') as HTMLElement);

describe('the drafts', () => {
  it('lists the drafted replies and switches the tab by state', async () => {
    const calls = stubFetch(seeded.dashboard, {
      'GET /api/inbox/drafts': ({ query }) => (query.get('state') === 'discarded' ? [draft(9, { subject: 'Re: an old question', state: 'discarded' })] : drafts),
    });
    openApp('#/inbox/drafts');
    expect(await inMain().findByText('Re: Dinner next week?')).toBeTruthy();
    expect(inMain().getByText('ta@school.example.edu, staff@school.example.edu')).toBeTruthy();
    const tabs = within(screen.getByRole('tablist', { name: 'draft state' }));
    expect(tabs.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Drafted', 'Discarded', 'Sent by you']);
    fireEvent.click(tabs.getByRole('tab', { name: 'Discarded' }));
    await waitFor(() => expect(location.hash).toBe('#/inbox/drafts?state=discarded'));
    expect(await inMain().findByText('Re: an old question')).toBeTruthy();
    expect(calls.some((call) => call.url === '/api/inbox/drafts?state=discarded&limit=50')).toBe(true);
    expect(calls.some((call) => call.url === '/api/inbox/drafts?state=drafted&limit=50')).toBe(true);
  });

  it('pages with before until a page has fewer rows than the limit', async () => {
    const calls = stubFetch(seeded.dashboard, { 'GET /api/inbox/drafts': ({ query }) => (query.get('before') === '151' ? older : full) });
    openApp('#/inbox/drafts');
    await inMain().findByText('Re: thread 200');
    fireEvent.click(inMain().getByRole('button', { name: 'Load older' }));
    expect(await inMain().findByText('Re: the oldest thread')).toBeTruthy();
    expect(calls.some((call) => call.url === '/api/inbox/drafts?state=drafted&limit=50&before=151')).toBe(true);
    expect(inMain().queryByRole('button', { name: 'Load older' })).toBeNull();
  });

  it('selects the draft of ?id= and shows its body, its run and the note that it is never sent', async () => {
    stubFetch(seeded.dashboard, { 'GET /api/inbox/drafts': () => drafts });
    openApp('#/inbox/drafts?id=41');
    await inMain().findByText('Re: Dinner next week?');
    expect(await details().findByText(/Thursday at 3 pm works for me/)).toBeTruthy();
    expect(details().getByRole('link', { name: 'run run-1' }).getAttribute('href')).toBe('#/runs/run-1');
    expect(details().getByText('ok computer never sends a draft. Open your mail drafts to send it.')).toBeTruthy();
    const row = inMain().getByText('Re: Office hours moved to Thursday').closest('tr')!;
    expect(row.getAttribute('aria-current')).toBe('true');
    fireEvent.click(inMain().getByText('Re: Dinner next week?'));
    await waitFor(() => expect(location.hash).toBe('#/inbox/drafts?id=42'));
    expect(await details().findByText(/Tuesday or Wednesday/)).toBeTruthy();
  });

  it('loads the draft of ?id= by its id when the list does not have it, as for a sent draft that a digest links to', async () => {
    const calls = stubFetch(seeded.dashboard, {
      'GET /api/inbox/drafts': () => drafts,
      'GET /api/inbox/drafts/:id': () => draft(7, { subject: 'Re: an answered question', state: 'sent_by_owner', body: 'I sent this one myself.' }),
    });
    openApp('#/inbox/drafts?id=7');
    await inMain().findByText('Re: Dinner next week?');
    expect(await details().findByText('I sent this one myself.')).toBeTruthy();
    expect(details().getByText('sent by you')).toBeTruthy();
    expect(calls.some((call) => call.url === '/api/inbox/drafts/7')).toBe(true);
  });

  it('says so when no draft has the id of ?id=', async () => {
    stubFetch(seeded.dashboard, { 'GET /api/inbox/drafts': () => drafts });
    openApp('#/inbox/drafts?id=7');
    await inMain().findByText('Re: Dinner next week?');
    expect(await details().findByText('Draft #7 was not found.')).toBeTruthy();
  });

  it('shows an empty state for a tab with no drafts', async () => {
    stubFetch(seeded.dashboard, { 'GET /api/inbox/drafts': () => [] });
    openApp('#/inbox/drafts?state=sent_by_owner');
    expect(await inMain().findByText('No drafts are sent by you.')).toBeTruthy();
  });
});
