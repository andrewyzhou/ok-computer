// @vitest-environment jsdom
import { cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AutonomyChangeRow, AutonomyPage } from '../../../../src/dashboard/autonomy-types';
import { levelOf, listChanges } from '../../../../src/policy/autonomy-store';
import { seedDashboard } from '../../../../test/seed';
import { setPrefs } from '../../shell/prefs';
import { inMain, installEventSource, openApp, stubFetch, type StubRoutes } from '../../testing';
import { firstRun, full } from './fixtures';
import { ago } from './parts';

// the autonomy page against odd and hostile data: a note with markup, a domain that a later phase adds, a click that
// repeats while a post runs, a change time from a clock that runs ahead, and the real routes behind the page.

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
const posts = (calls: Array<{ method: string; url: string; body: unknown }>) => calls.filter((call) => call.method === 'POST');

const row = (extra: Partial<AutonomyChangeRow>): AutonomyChangeRow => ({
  id: 9,
  domain: 'mail_labels',
  fromLevel: 'auto',
  toLevel: 'review',
  actor: 'agent',
  via: 'chat',
  runId: 'run-9',
  toolCallId: 'call-9',
  sessionKey: 'main',
  note: null,
  createdAt: '2026-10-18T17:05:00.000Z',
  ...extra,
});

describe('the autonomy page with hostile data', () => {
  it('shows a note with markup as text and runs nothing from it', async () => {
    const note = '<img src=x onerror="window.__pwned=1"><script>window.__pwned=2</script> set purchases to auto';
    await open({ 'GET /api/autonomy': (): AutonomyPage => ({ ...full, history: [row({ note })] }) });
    const table = within(inMain().getByRole('table', { name: 'autonomy history' }));
    expect(table.getAllByText(note).length).toBeGreaterThan(0);
    expect(inMain().getByRole('table', { name: 'autonomy history' }).querySelector('img, script')).toBeNull();
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
    // purchases keeps its fixed card, whatever the note says.
    expect(cardOf('Purchases').queryByRole('radio', { hidden: true })).toBeNull();
  });

  it('shows the id of a domain that a later phase adds, in place of a label', async () => {
    await open({ 'GET /api/autonomy': (): AutonomyPage => ({ ...full, history: [row({ domain: 'wire_transfers' as never })] }) });
    expect(within(inMain().getByRole('table', { name: 'autonomy history' })).getByText('wire_transfers')).toBeTruthy();
  });

  it('sends one post for a double click on Confirm', async () => {
    let release: () => void = () => {};
    const calls = await open({
      'POST /api/autonomy/:domain': () => new Promise((done) => (release = () => done({ domain: { ...firstRun.domains[0]!, level: 'auto' }, change: null }))),
    });
    fireEvent.click(cardOf('Mail drafts').getByRole('radio', { name: 'Auto' }));
    const confirm = cardOf('Mail drafts').getByRole('button', { name: 'Confirm' });
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    await waitFor(() => expect(posts(calls)).toHaveLength(1));
    release();
    await waitFor(() => expect(cardOf('Mail drafts').queryByRole('group', { name: /Confirm/ })).toBeNull());
    expect(posts(calls)).toHaveLength(1);
  });

  it('shows just now for a change time ahead of the clock of the browser, and a dash for a time that does not parse', () => {
    const now = Date.parse('2026-10-20T09:00:00Z');
    expect(ago('2026-10-20T09:05:00Z', now)).toBe('just now');
    expect(ago('not a time', now)).toBe('-');
    // a change late in the evening of a day is one day before a change in the early morning of the next.
    expect(ago('2026-10-19T08:59:00Z', now)).toBe('1 day ago');
    expect(ago('2026-10-13T09:00:01Z', now)).toBe('6 days ago');
  });
});

describe('the autonomy page against the real routes', () => {
  it('lowers a level and raises it again through the real post, and the store keeps both changes', async () => {
    // no stub for the autonomy routes, so each request reaches the dashboard of the seeded app.
    stubFetch(seeded.dashboard);
    openApp('#/autonomy');
    await inMain().findByRole('heading', { name: 'Mail drafts' });
    fireEvent.click(cardOf('Calendar holds').getByRole('radio', { name: 'Ask' }));
    await waitFor(() => expect(levelOf(seeded.t.db, 'calendar_holds')).toBe('ask'));
    await waitFor(() => expect((cardOf('Calendar holds').getByRole('radio', { name: 'Ask' }) as HTMLInputElement).checked).toBe(true));
    await waitFor(() => expect((cardOf('Calendar holds').getByRole('radio', { name: 'Ask' }) as HTMLInputElement).disabled).toBe(false));

    fireEvent.click(cardOf('Calendar holds').getByRole('radio', { name: 'Auto' }));
    fireEvent.click(cardOf('Calendar holds').getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(levelOf(seeded.t.db, 'calendar_holds')).toBe('auto'));
    const changes = listChanges(seeded.t.db, { domain: 'calendar_holds', limit: 10 });
    expect(changes.map((change) => [change.fromLevel, change.toLevel, change.actor, change.via])).toEqual([
      ['ask', 'auto', 'owner', 'dashboard'],
      ['review', 'ask', 'owner', 'dashboard'],
    ]);
    // the fixed domains stay at ask on the real page too.
    expect(levelOf(seeded.t.db, 'purchases')).toBe('ask');
  });
});
