// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { seedDashboard } from '../../../../test/seed';
import { setPrefs } from '../../shell/prefs';
import { inMain, installEventSource, json, openApp, stubFetch } from '../../testing';
import { fiveSubscriptionsPage, googleReady, proposal, proposals, sendersPage } from './fixtures';
import { Breakable, minuteTime } from './shared';
import { isStale } from './Subscriptions';

// the first run of the inbox pages, the errors with a way to try again, the rows that the page hides, and the links
// that name only an id. the seeded app has no google integration, so a test without googleReady is a first run.

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

describe('the first run', () => {
  it('asks to connect google on the digest instead of offering a run that fails', async () => {
    stubFetch(seeded.dashboard, {
      'GET /api/inbox/digests/latest': () => json({ error: 'digest not found' }, 404),
      'GET /api/inbox/digests': () => ({ digests: [], nextCursor: null }),
    });
    openApp('#/inbox');
    const main = inMain();
    expect(await main.findByText('Connect a Google account to read your mail.')).toBeTruthy();
    expect(main.getByRole('link', { name: 'Connect Google' }).getAttribute('href')).toBe('#/google');
    expect(main.queryByRole('button', { name: 'Make the digest now' })).toBeNull();
  });

  it('asks to connect google on the drafts and the proposals that have nothing yet', async () => {
    stubFetch(seeded.dashboard, { 'GET /api/inbox/drafts': () => [], 'GET /api/inbox/proposals': () => [] });
    openApp('#/inbox/drafts');
    expect(await inMain().findByText('Connect a Google account to read your mail.')).toBeTruthy();
    expect(inMain().queryByText('No drafts yet.')).toBeNull();
    location.hash = '#/inbox/proposals';
    expect(await inMain().findByText(/The digest proposes a calendar event/)).toBeTruthy();
    expect(inMain().getByRole('link', { name: 'Connect Google' }).getAttribute('href')).toBe('#/google');
    expect(inMain().queryByText('No proposals wait for you.')).toBeNull();
    // another tab is a plain empty list, because it says nothing about the setup.
    location.hash = '#/inbox/proposals?state=declined';
    expect(await inMain().findByText('No declined proposals.')).toBeTruthy();
  });

  it('shows no totals and turns off the scan before the first scan', async () => {
    stubFetch(seeded.dashboard, { 'GET /api/inbox/subscriptions': () => ({ subscriptions: [], monthlyTotals: [], lastScan: null }) });
    openApp('#/inbox/subscriptions');
    const main = inMain();
    expect(await main.findByText('Connect a Google account to read your mail.')).toBeTruthy();
    expect(document.querySelector('main dl[aria-label="monthly totals"]')).toBeNull();
    await waitFor(() => expect((document.querySelector('button[title="Connect a Google account first."]') as HTMLButtonElement | null)?.disabled).toBe(true));
  });

  it('turns the answer 503 of a run into a step with a link', async () => {
    stubFetch(seeded.dashboard, {
      ...googleReady,
      'GET /api/inbox/senders': () => sendersPage,
      'POST /api/inbox/run': () => json({ error: 'the inbox jobs need the google integration' }, 503),
    });
    openApp('#/inbox/newsletters');
    await inMain().findByText('Weekly Deals');
    fireEvent.click(document.querySelector('.inbox-run button') as HTMLButtonElement);
    const alert = await waitFor(() => {
      const found = document.querySelector('.inbox-run [role="alert"]');
      if (!found) throw new Error('no alert yet');
      return found as HTMLElement;
    });
    expect(alert.textContent).toBe('The inbox jobs need a Google account. Connect one first.');
    expect(within(alert).getByRole('link', { name: 'Connect one' }).getAttribute('href')).toBe('#/google');
  });
});

describe('a failed load', () => {
  it('offers a retry that loads the page again', async () => {
    let fail = true;
    stubFetch(seeded.dashboard, {
      ...googleReady,
      'GET /api/inbox/senders': () => (fail ? json({ error: 'the database is busy' }, 500) : sendersPage),
    });
    openApp('#/inbox/newsletters');
    const main = inMain();
    expect(await main.findByText(/Could not load: .*the database is busy/)).toBeTruthy();
    fail = false;
    fireEvent.click(main.getByRole('button', { name: 'Retry' }));
    expect(await main.findByText('Weekly Deals')).toBeTruthy();
  });
});

describe('the rows that the subscriptions page hides', () => {
  it('hides only a stale row, and keeps a doubtful row in view', () => {
    const [streamly, , gym, campus] = fiveSubscriptionsPage.subscriptions;
    expect(isStale(campus!)).toBe(true);
    expect(isStale(gym!)).toBe(false);
    // a row that the finder keeps with many doubts has a low confidence and a known cadence. it is not stale.
    expect(isStale({ ...streamly!, confidence: 0.05, cadenceSource: 'gaps' })).toBe(false);
  });
});

describe('a link that names only an id', () => {
  it('opens the tab of a proposal that the owner already decided', async () => {
    stubFetch(seeded.dashboard, {
      ...googleReady,
      'GET /api/inbox/proposals': ({ query }) => (query.get('state') === 'created' ? [proposal(8, { state: 'created', title: 'Pay the power bill' })] : proposals),
      'GET /api/inbox/proposals/:id': () => proposal(8, { state: 'created', title: 'Pay the power bill' }),
    });
    openApp('#/inbox/proposals?id=8');
    await waitFor(() => expect(location.hash).toBe('#/inbox/proposals?id=8&state=created'));
    expect(await within(inMain().getByRole('list', { name: 'calendar proposals' })).findByText('Pay the power bill')).toBeTruthy();
  });
});

describe('the text helpers', () => {
  it('cuts the seconds off a time', () => {
    expect(minuteTime('2026-10-19T13:00:00.000Z')).not.toMatch(/:\d{2}:\d{2}$/);
    expect(minuteTime(null)).toBe('-');
  });

  it('keeps the whole address in one element and lets it break after its marks', () => {
    const { container } = render(<Breakable text="someone.long@school.example.edu" />);
    const span = container.querySelector('.inbox-breakable')!;
    expect(span.textContent).toBe('someone.long@school.example.edu');
    expect(span.querySelectorAll('wbr').length).toBe(4);
  });
});
