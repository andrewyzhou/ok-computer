// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AutonomyDomainView, AutonomyPage, AutonomySetRequest, AutonomySetResponse } from '../../../../src/dashboard/autonomy-types';
import { seedDashboard } from '../../../../test/seed';
import { setPrefs } from '../../shell/prefs';
import { inMain, installEventSource, openApp, stubFetch, type StubRoutes } from '../../testing';
import { DEFAULT_DOMAINS, firstRun, full } from './fixtures';

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

// the card of one domain, found by its title.
const cardOf = (label: string) => within(inMain().getByRole('heading', { level: 3, name: label }).closest('li')!);

// the answer of a post that sets the level of a domain of the first run.
function answer(id: string, body: AutonomySetRequest): AutonomySetResponse {
  const domain: AutonomyDomainView = { ...DEFAULT_DOMAINS.find((each) => each.id === id)!, level: body.level, updatedAt: '2026-10-19T12:00:00.000Z', changeId: 9 };
  return {
    domain,
    change: {
      id: 9,
      domain: domain.id,
      fromLevel: body.from,
      toLevel: body.level,
      actor: 'owner',
      via: 'dashboard',
      runId: null,
      toolCallId: null,
      sessionKey: null,
      note: null,
      taint: [],
      createdAt: '2026-10-19T12:00:00.000Z',
    },
  };
}

const posts = (calls: ReturnType<typeof stubFetch>) => calls.filter((call) => call.method === 'POST');

describe('the autonomy page', () => {
  it('lists the eight domains of the first run, the fixed three without a control, and the empty history', async () => {
    await open();
    expect(screen.getByRole('heading', { level: 1, name: 'Autonomy' })).toBeTruthy();
    expect(inMain().getByText(/Only you can give it more freedom, here\./)).toBeTruthy();
    const titles = inMain()
      .getAllByRole('heading', { level: 3 })
      .map((heading) => heading.textContent);
    expect(titles).toEqual(DEFAULT_DOMAINS.map((each) => each.label));
    for (const label of ['Calendar events with guests', 'Unsubscribes', 'Purchases']) {
      expect(cardOf(label).getByText('Always ask')).toBeTruthy();
      expect(cardOf(label).queryByRole('radiogroup')).toBeNull();
      expect(cardOf(label).queryByRole('radio')).toBeNull();
    }
    expect(cardOf('Purchases').getByText('Money leaves your account, so you approve each payment.')).toBeTruthy();
    expect(inMain().getAllByRole('radiogroup')).toHaveLength(5);
    // every domain is at its default level on a first run. a domain that can change says so, and a fixed one shows its
    // level as a pill and no radio.
    expect(inMain().getAllByText('Default level')).toHaveLength(5);
    expect(cardOf('Purchases').queryByText('Default level')).toBeNull();
    expect(cardOf('Purchases').getByText('ask')).toBeTruthy();
    // a domain that can change shows its level once, in the radios.
    expect(cardOf('Mail drafts').queryByText('review')).toBeNull();
    expect(inMain().getAllByText('Never changed')).toHaveLength(8);
    const legend = within(document.querySelector<HTMLElement>('main dl[aria-label="levels"]')!);
    expect(legend.getByText('You approve each action before it happens.')).toBeTruthy();
    expect(inMain().getByText('No changes yet')).toBeTruthy();
    expect(inMain().getByText('Every domain is at its default level.')).toBeTruthy();
    expect(inMain().queryByRole('table', { name: 'autonomy history' })).toBeNull();
  });

  it('offers browser submits only ask and review, with a hint about the most', async () => {
    await open();
    const group = within(cardOf('Browser form submits').getByRole('radiogroup', { name: 'Browser form submits level' }));
    expect(group.getAllByRole('radio').map((radio) => (radio as HTMLInputElement).value)).toEqual(['ask', 'review']);
    expect((group.getByRole('radio', { name: 'Ask' }) as HTMLInputElement).checked).toBe(true);
    expect(cardOf('Browser form submits').getByText('Can go up to review')).toBeTruthy();
    expect(cardOf('Mail drafts').queryByText(/Can go up to/)).toBeNull();
  });

  it('asks before a raise, and Confirm posts the level with the shown level', async () => {
    // the server keeps the level, so the load after the change gives the new level and the new row of the history.
    let page: AutonomyPage = firstRun;
    const calls = await open({
      'GET /api/autonomy': () => page,
      'POST /api/autonomy/:domain': ({ params, body }) => {
        const set = answer(params.domain!, body as AutonomySetRequest);
        page = { ...page, domains: page.domains.map((each) => (each.id === set.domain.id ? set.domain : each)), history: [set.change!] };
        return set;
      },
    });
    fireEvent.click(cardOf('Mail drafts').getByRole('radio', { name: 'Auto' }));
    const confirm = cardOf('Mail drafts').getByRole('group', { name: 'Confirm Mail drafts at auto' });
    expect(confirm.textContent).toContain('Set Mail drafts to auto? The agent acts on its own.');
    expect(posts(calls)).toHaveLength(0);
    fireEvent.click(within(confirm).getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(cardOf('Mail drafts').queryByRole('group', { name: /Confirm/ })).toBeNull());
    expect(posts(calls)).toEqual([{ method: 'POST', url: '/api/autonomy/mail_drafts', body: { level: 'auto', from: 'review' } }]);
    await waitFor(() => expect((cardOf('Mail drafts').getByRole('radio', { name: 'Auto' }) as HTMLInputElement).checked).toBe(true));
    expect(cardOf('Mail drafts').queryByText('Default level')).toBeNull();
    expect(cardOf('Mail drafts').getByText('Default: review')).toBeTruthy();
    // the history loads again after the change.
    await waitFor(() => expect(calls.filter((call) => call.method === 'GET' && call.url === '/api/autonomy')).toHaveLength(2));
    const table = within(await inMain().findByRole('table', { name: 'autonomy history' }));
    expect(table.getAllByText('You, on the dashboard').length).toBeGreaterThan(0);
    expect(table.getByText('Mail drafts')).toBeTruthy();
  });

  it('posts nothing when the raise is cancelled', async () => {
    const calls = await open({ 'POST /api/autonomy/:domain': ({ params, body }) => answer(params.domain!, body as AutonomySetRequest) });
    fireEvent.click(cardOf('Calendar holds').getByRole('radio', { name: 'Auto' }));
    fireEvent.click(cardOf('Calendar holds').getByRole('button', { name: 'Cancel' }));
    expect(cardOf('Calendar holds').queryByRole('group', { name: /Confirm/ })).toBeNull();
    expect((cardOf('Calendar holds').getByRole('radio', { name: 'Review' }) as HTMLInputElement).checked).toBe(true);
    expect(posts(calls)).toHaveLength(0);
  });

  it('sends a lower at once and disables the group while it is sent', async () => {
    let release: () => void = () => {};
    const calls = await open({
      'POST /api/autonomy/:domain': ({ params, body }) => new Promise((done) => (release = () => done(answer(params.domain!, body as AutonomySetRequest)))),
    });
    fireEvent.click(cardOf('Mail labels and archive').getByRole('radio', { name: 'Ask' }));
    expect(cardOf('Mail labels and archive').queryByRole('group', { name: /Confirm/ })).toBeNull();
    await waitFor(() => expect(posts(calls)).toEqual([{ method: 'POST', url: '/api/autonomy/mail_labels', body: { level: 'ask', from: 'review' } }]));
    for (const radio of cardOf('Mail labels and archive').getAllByRole('radio')) expect((radio as HTMLInputElement).disabled).toBe(true);
    release();
    await waitFor(() => expect((cardOf('Mail labels and archive').getByRole('radio', { name: 'Ask' }) as HTMLInputElement).checked).toBe(true));
    for (const radio of cardOf('Mail labels and archive').getAllByRole('radio')) expect((radio as HTMLInputElement).disabled).toBe(false);
  });

  it('renders the full history with the change from chat and its note', async () => {
    await open({ 'GET /api/autonomy': () => full });
    const table = within(inMain().getByRole('table', { name: 'autonomy history' }));
    const rows = table.getAllByRole('row').slice(1);
    expect(rows).toHaveLength(3);
    const agent = within(rows[0]!);
    expect(agent.getByText('Mail labels and archive')).toBeTruthy();
    expect(agent.getAllByText('The agent, in chat')).toHaveLength(2);
    expect(agent.getAllByText('The owner asked to check labels again after a wrong archive.')).toHaveLength(2);
    expect(rows[0]!.textContent).toContain('auto → review');
    expect(within(rows[2]!).getAllByText('You, on the dashboard')).toHaveLength(2);
    expect(within(rows[2]!).getByText('Mail drafts')).toBeTruthy();
    // the time of a change has the full time as its title.
    expect(rows[0]!.querySelector('time')?.getAttribute('title')).toBeTruthy();
    // the run link is for developer mode only.
    expect(table.queryByRole('link', { name: /run/ })).toBeNull();
    expect(cardOf('Mail drafts').queryByText('Default level')).toBeNull();
    expect(cardOf('Mail drafts').getByText('Default: review')).toBeTruthy();
    expect(cardOf('Mail drafts').getByText(/Changed/)).toBeTruthy();
    expect(inMain().queryByRole('button', { name: 'Show older' })).toBeNull();
  });

  it('loads older changes with before while there are more', async () => {
    const [newest, ...rest] = full.history;
    const calls = await open({
      'GET /api/autonomy': () => ({ ...full, history: [newest], before: newest!.id }),
      'GET /api/autonomy/history': ({ query }) =>
        query.get('before') === '3' ? { changes: [rest[0]], before: 2 } : { changes: [rest[1]], before: null },
    });
    const table = () => within(inMain().getByRole('table', { name: 'autonomy history' }));
    expect(table().getAllByRole('row')).toHaveLength(2);
    fireEvent.click(inMain().getByRole('button', { name: 'Show older' }));
    await waitFor(() => expect(table().getAllByRole('row')).toHaveLength(3));
    fireEvent.click(inMain().getByRole('button', { name: 'Show older' }));
    await waitFor(() => expect(table().getAllByRole('row')).toHaveLength(4));
    expect(inMain().queryByRole('button', { name: 'Show older' })).toBeNull();
    expect(calls.filter((call) => call.url.startsWith('/api/autonomy/history')).map((call) => call.url)).toEqual([
      '/api/autonomy/history?before=3',
      '/api/autonomy/history?before=2',
    ]);
  });

  it('shows Autonomy in the agent group of the nav', async () => {
    await open();
    const nav = within(screen.getByRole('navigation', { name: 'pages' }));
    const group = within(nav.getByRole('region', { name: 'Agent' }));
    expect(group.getAllByRole('link').map((link) => link.textContent).at(-1)).toBe('Autonomy');
    expect(nav.getByRole('link', { name: 'Autonomy' }).getAttribute('aria-current')).toBe('page');
  });
});
