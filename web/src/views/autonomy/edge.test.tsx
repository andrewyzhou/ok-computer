// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AutonomyPage } from '../../../../src/dashboard/autonomy-types';
import { seedDashboard } from '../../../../test/seed';
import { setPrefs } from '../../shell/prefs';
import { inMain, installEventSource, json, openApp, stubFetch, type StubRoutes } from '../../testing';
import { firstRun, full } from './fixtures';

// the edge cases of the autonomy page: a 409 from another tab, a failed load, a failed older page and developer mode.

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

async function open(routes: StubRoutes = {}) {
  const calls = stubFetch(seeded.dashboard, { 'GET /api/autonomy': () => firstRun, ...routes });
  openApp('#/autonomy');
  await inMain().findByRole('heading', { name: 'Mail drafts' });
  return calls;
}

const cardOf = (label: string) => within(inMain().getByRole('heading', { level: 3, name: label }).closest('li')!);

describe('the edges of the autonomy page', () => {
  it('shows the text of a 409 next to its card and loads the levels again', async () => {
    // another tab raised mail drafts in the meantime, so the next load shows auto.
    let page: AutonomyPage = firstRun;
    const calls = await open({
      'GET /api/autonomy': () => page,
      'POST /api/autonomy/:domain': () => {
        page = full;
        return json({ error: 'the level changed in the meantime, it is auto now' }, 409);
      },
    });
    fireEvent.click(cardOf('Mail drafts').getByRole('radio', { name: 'Ask' }));
    // the page adds the final period that the server text lacks.
    expect((await cardOf('Mail drafts').findByRole('alert')).textContent).toBe('the level changed in the meantime, it is auto now.');
    await waitFor(() => expect((cardOf('Mail drafts').getByRole('radio', { name: 'Auto' }) as HTMLInputElement).checked).toBe(true));
    expect(calls.filter((call) => call.method === 'GET' && call.url === '/api/autonomy')).toHaveLength(2);
    // the error stays near its card after the load, and the other cards show none.
    expect(cardOf('Mail drafts').getByRole('alert')).toBeTruthy();
    expect(cardOf('Calendar holds').queryByRole('alert')).toBeNull();
  });

  it('shows the error of a failed load', async () => {
    stubFetch(seeded.dashboard, { 'GET /api/autonomy': () => json({ error: 'a row could not be read' }, 500) });
    openApp('#/autonomy');
    expect(await inMain().findByText('Could not load: a row could not be read')).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1, name: 'Autonomy' })).toBeTruthy();
    expect(inMain().queryByRole('radiogroup')).toBeNull();
  });

  it('loads the page again with Try again after a failed load', async () => {
    let fail = true;
    const calls = stubFetch(seeded.dashboard, { 'GET /api/autonomy': () => (fail ? json({ error: 'a row could not be read' }, 500) : firstRun) });
    openApp('#/autonomy');
    await inMain().findByText('Could not load: a row could not be read');
    fail = false;
    fireEvent.click(inMain().getByRole('button', { name: 'Try again' }));
    expect(await inMain().findByRole('heading', { level: 3, name: 'Mail drafts' })).toBeTruthy();
    expect(calls.filter((call) => call.url === '/api/autonomy')).toHaveLength(2);
  });

  it('says that the level changed elsewhere for a stale level, and asks to choose again', async () => {
    await open({ 'POST /api/autonomy/:domain': () => json({ error: 'Mail drafts is at auto now, not at review. Read the level again, then choose again.' }, 409) });
    fireEvent.click(cardOf('Mail drafts').getByRole('radio', { name: 'Ask' }));
    expect((await cardOf('Mail drafts').findByRole('alert')).textContent).toBe('The level changed in another tab or in chat. It is now auto. Choose again.');
  });

  it('names an allow rule that lets a domain skip the review', async () => {
    await open({
      'GET /api/autonomy': () => ({ ...firstRun, domains: firstRun.domains.map((each) => (each.id === 'mail_drafts' ? { ...each, overriddenBy: 'okc.policy.json#2' } : each)) }),
    });
    expect(cardOf('Mail drafts').getByRole('note').textContent).toBe(
      'The allow rule okc.policy.json#2 in okc.policy.json lets these actions run without the review. Remove the rule to make the level count.',
    );
    expect(cardOf('Mail labels and archive').queryByRole('note')).toBeNull();
  });

  it('marks a change from a chat that had read untrusted content', async () => {
    const tainted = { ...full.history[0]!, taint: ['gmail:eve@evil.example'] };
    await open({ 'GET /api/autonomy': () => ({ ...full, history: [tainted, ...full.history.slice(1)] }) });
    const table = within(inMain().getByRole('table', { name: 'autonomy history' }));
    expect(table.getAllByText('The agent, in chat, after it read untrusted content').length).toBeGreaterThan(0);
    expect(table.getAllByText('The chat had read: gmail:eve@evil.example. The reason may come from that text and not from you.').length).toBeGreaterThan(0);
  });

  it('shows a skeleton while the page loads', async () => {
    stubFetch(seeded.dashboard, { 'GET /api/autonomy': () => new Promise(() => {}) });
    openApp('#/autonomy');
    await waitFor(() => expect(document.querySelector('main .skeleton[aria-busy="true"]')).toBeTruthy());
  });

  it('keeps the rows and shows the error when an older page fails', async () => {
    await open({
      'GET /api/autonomy': () => ({ ...full, before: 1 }),
      'GET /api/autonomy/history': () => json({ error: 'the history could not be read' }, 500),
    });
    fireEvent.click(inMain().getByRole('button', { name: 'Show older' }));
    expect((await inMain().findByText(/Could not load older changes/)).textContent).toBe('Could not load older changes. Try again. The server said: the history could not be read');
    expect(within(inMain().getByRole('table', { name: 'autonomy history' })).getAllByRole('row')).toHaveLength(4);
  });

  it('shows the tools of each domain and the run of a change from chat in developer mode', async () => {
    setPrefs({ devMode: true });
    await open({ 'GET /api/autonomy': () => full });
    expect(within(cardOf('Mail drafts').getByLabelText('tools')).getByText('google__gmail_draft')).toBeTruthy();
    expect(cardOf('Mail drafts').getByText('inbox_draft_reply')).toBeTruthy();
    expect(cardOf('Purchases').getByText('browser_submit')).toBeTruthy();
    // the link shows in the who column, and on a phone under the domain.
    const links = within(inMain().getByRole('table', { name: 'autonomy history' })).getAllByRole('link', { name: 'run run-12' });
    expect(links.map((link) => link.getAttribute('href'))).toEqual(['#/runs/run-12', '#/runs/run-12']);
  });

  it('hides the tools outside developer mode', async () => {
    await open();
    expect(inMain().queryByText('google__gmail_draft')).toBeNull();
  });

  it('a fixed domain has no control at all, also no disabled one', async () => {
    await open();
    for (const label of ['Calendar events with guests', 'Unsubscribes', 'Purchases']) {
      expect(cardOf(label).queryByRole('radio', { hidden: true })).toBeNull();
      expect(cardOf(label).queryByRole('button')).toBeNull();
    }
  });
});
