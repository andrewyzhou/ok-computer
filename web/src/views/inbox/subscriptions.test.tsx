// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { seedDashboard } from '../../../../test/seed';
import { inMain, installEventSource, json, openApp, stubFetch, type StubRoutes } from '../../testing';
import { setPrefs } from '../../shell/prefs';
import { fiveSubscriptionsPage, subscriptionsPage, googleReady } from './fixtures';

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

async function open(routes: StubRoutes = {}, hash = '#/inbox/subscriptions') {
  // the row that waits for a cancel points at the pending approval of the seeded database.
  const page = {
    ...subscriptionsPage,
    subscriptions: subscriptionsPage.subscriptions.map((row) => (row.approvalId === null ? row : { ...row, approvalId: seeded.pendingApprovalId })),
  };
  const calls = stubFetch(seeded.dashboard, { ...googleReady, 'GET /api/inbox/subscriptions': () => page, ...routes });
  openApp(hash);
  await inMain().findByText('Streamly');
  return calls;
}

const rowOf = (name: string) => within(within(inMain().getByRole('table', { name: 'subscriptions' })).getByText(name).closest('tr')!);

describe('the subscriptions', () => {
  it('shows one monthly total for each currency, and the rows with amount and state', async () => {
    await open();
    const totals = within(document.querySelector<HTMLElement>('main dl[aria-label="monthly totals"]')!);
    expect(totals.getByText('USD')).toBeTruthy();
    expect(totals.getByText('$65.49')).toBeTruthy();
    expect(totals.getByText('EUR')).toBeTruthy();
    expect(totals.getByText('€4.50')).toBeTruthy();
    expect(totals.getAllByText('estimated per month')).toHaveLength(2);
    expect(rowOf('Streamly').getByText('$15.49')).toBeTruthy();
    expect(rowOf('Gym Plus').getByText('cancel pending')).toBeTruthy();
    expect(rowOf('Free Trial').getAllByText('-').length).toBeGreaterThan(0);
  });

  it('offers cancel only for an active subscription and shows the approval card it waits for', async () => {
    const id = seeded.pendingApprovalId;
    const calls = await open({
      'POST /api/inbox/subscriptions/:id/cancel': () => ({ status: 'pending_approval', approvalId: id, message: 'The cancel waits for your approval.' }),
    });
    expect(rowOf('Streamly').queryByRole('button', { name: 'Cancel Streamly' })).toBeTruthy();
    expect(rowOf('Cloud Notes').queryByRole('button', { name: 'Cancel Cloud Notes' })).toBeTruthy();
    expect(rowOf('Gym Plus').queryByRole('button', { name: 'Cancel Gym Plus' })).toBeNull();
    expect(rowOf('News Daily').queryByRole('button', { name: 'Cancel News Daily' })).toBeNull();
    expect(rowOf('Free Trial').queryByRole('button', { name: 'Cancel Free Trial' })).toBeNull();
    fireEvent.click(rowOf('Streamly').getByRole('button', { name: 'Cancel Streamly' }));
    expect(await inMain().findByRole('article', { name: `approval #${id}` })).toBeTruthy();
    expect(inMain().getByText('The cancel waits for your approval.')).toBeTruthy();
    expect(calls.find((call) => call.method === 'POST')).toMatchObject({ url: '/api/inbox/subscriptions/1/cancel', body: {} });
  });

  it('ignores a subscription, and shows a 409 next to its row', async () => {
    const calls = await open({
      'POST /api/inbox/subscriptions/:id/ignore': ({ params }) =>
        params.id === '1' ? { status: 'done', approvalId: null, message: 'The subscription is ignored.' } : json({ error: 'the subscription is not active' }, 409),
    });
    fireEvent.click(rowOf('Streamly').getByRole('button', { name: 'Ignore Streamly' }));
    expect(await rowOf('Streamly').findByText('The subscription is ignored.')).toBeTruthy();
    fireEvent.click(rowOf('Cloud Notes').getByRole('button', { name: 'Ignore Cloud Notes' }));
    expect((await rowOf('Cloud Notes').findByRole('alert')).textContent).toBe('the subscription is not active');
    expect(calls.filter((call) => call.method === 'POST').map((call) => call.url)).toEqual(['/api/inbox/subscriptions/1/ignore', '/api/inbox/subscriptions/2/ignore']);
  });

  it('offers no ignore while a cancel is pending, in the row and in the details', async () => {
    await open();
    expect(rowOf('Gym Plus').queryByRole('button', { name: 'Ignore Gym Plus' })).toBeNull();
    fireEvent.click(rowOf('Gym Plus').getByText('Gym Plus'));
    const panel = within(document.querySelector('.details') as HTMLElement);
    await panel.findByRole('link', { name: 'task-1' });
    expect(panel.queryByRole('button', { name: 'Ignore Gym Plus' })).toBeNull();
  });

  it('keeps the filters in the hash and sends them to the server', async () => {
    const calls = await open();
    fireEvent.change(screen.getByRole('combobox', { name: 'state' }), { target: { value: 'active' } });
    await waitFor(() => expect(location.hash).toBe('#/inbox/subscriptions?state=active'));
    await waitFor(() => expect(calls.some((call) => call.url === '/api/inbox/subscriptions?state=active')).toBe(true));
  });

  it('shows the cancel link, the browser task and the approval of the selected row', async () => {
    await open();
    fireEvent.click(rowOf('Gym Plus').getByText('Gym Plus'));
    const panel = within(document.querySelector('.details') as HTMLElement);
    expect((await panel.findByRole('link', { name: 'task-1' })).getAttribute('href')).toBe('#/browser/task-1');
    expect(panel.getByRole('article', { name: `approval #${seeded.pendingApprovalId}` })).toBeTruthy();
    expect(panel.getByText('r-3')).toBeTruthy();
    fireEvent.click(rowOf('Streamly').getByText('Streamly'));
    const link = await panel.findByRole('link', { name: 'https://streamly.example.com/account/cancel' });
    expect(link.getAttribute('rel')).toBe('noreferrer');
  });

  it('runs the scan now', async () => {
    const calls = await open({ 'POST /api/inbox/run': () => json({ started: true }, 202) });
    fireEvent.click(screen.getByRole('button', { name: 'Scan now' }));
    await waitFor(() => expect(calls.find((call) => call.method === 'POST')).toMatchObject({ url: '/api/inbox/run', body: { job: 'subscriptions' } }));
  });

  describe('with the confidence of phase 6', () => {
    async function openFive() {
      stubFetch(seeded.dashboard, { ...googleReady, 'GET /api/inbox/subscriptions': () => fiveSubscriptionsPage });
      openApp('#/inbox/subscriptions');
      await inMain().findByText('Streamly');
    }

    it('shows the confidence as a word and a percent with the tone of its band', async () => {
      await openFive();
      const badge = (name: string, text: string) => rowOf(name).getAllByText(text)[0]!.closest('.badge')!;
      expect(badge('Gym Plus', 'low 30%').className).toContain('tone-warning');
      expect(badge('Cloud Notes', 'medium 60%').className).toContain('tone-info');
      expect(badge('Streamly', 'high 90%').className).toContain('tone-good');
    });

    it('says where the cadence comes from in words, in the details panel', async () => {
      await openFive();
      const panel = within(document.querySelector('.details') as HTMLElement);
      const cadence = async (name: string) => {
        fireEvent.click(rowOf(name).getByText(name));
        await panel.findByRole('heading', { name });
        return panel.getByText('Cadence').nextElementSibling?.textContent;
      };
      expect(await cadence('Streamly')).toBe('stated and confirmed by the dates');
      expect(await cadence('Cloud Notes')).toBe('stated on the receipt');
      expect(await cadence('Gym Plus')).toBe('from the charge dates');
      fireEvent.click(screen.getByRole('checkbox', { name: /Show rows with no repeating charge/ }));
      expect(await cadence('Campus Store')).toBe('unknown');
    });

    it('lists the reasons in the details panel', async () => {
      await openFive();
      fireEvent.click(rowOf('Cloud Notes').getByText('Cloud Notes'));
      const panel = within(document.querySelector('.details') as HTMLElement);
      const reasons = within(await panel.findByRole('list', { name: 'reasons' }));
      expect(reasons.getAllByRole('listitem').map((item) => item.textContent)).toEqual([
        'The receipt says the plan renews each year.',
        'Only one receipt was found, so the dates cannot confirm it.',
      ]);
      expect(panel.getByText('Cadence').nextElementSibling?.textContent).toBe('stated on the receipt');
      expect(panel.getByText('Confidence').nextElementSibling?.textContent).toBe('medium 60%');
    });

    it('hides the rows with confidence 0 until the toggle is on, and keeps the monthly totals', async () => {
      await openFive();
      const table = within(inMain().getByRole('table', { name: 'subscriptions' }));
      const toggle = screen.getByRole('checkbox', { name: /Show rows with no repeating charge/ }) as HTMLInputElement;
      expect(toggle.checked).toBe(false);
      expect(table.queryByText('Campus Store')).toBeNull();
      expect(table.queryByText('Event Tickets')).toBeNull();
      const totals = within(document.querySelector<HTMLElement>('main dl[aria-label="monthly totals"]')!);
      expect(totals.getByText('$31.49')).toBeTruthy();
      expect(totals.getByText('2 with no repeating charge hidden')).toBeTruthy();
      fireEvent.click(toggle);
      expect(table.getByText('Campus Store')).toBeTruthy();
      expect(table.getByText('Event Tickets')).toBeTruthy();
      expect(rowOf('Campus Store').getAllByText('low 0%').length).toBeGreaterThan(0);
      expect(totals.getByText('$31.49')).toBeTruthy();
      fireEvent.click(toggle);
      expect(table.queryByText('Campus Store')).toBeNull();
    });

    it('explains an empty table when every row has confidence 0', async () => {
      const once = { ...fiveSubscriptionsPage, subscriptions: fiveSubscriptionsPage.subscriptions.filter((row) => row.confidence === 0), monthlyTotals: [] };
      stubFetch(seeded.dashboard, { ...googleReady, 'GET /api/inbox/subscriptions': () => once });
      openApp('#/inbox/subscriptions');
      expect(await inMain().findByText('No repeating charges found.')).toBeTruthy();
      fireEvent.click(screen.getByRole('checkbox', { name: /Show rows with no repeating charge/ }));
      expect(await inMain().findByText('Campus Store')).toBeTruthy();
    });

    it('shows no toggle when no row has confidence 0', async () => {
      await open();
      expect(screen.queryByRole('checkbox', { name: /Show rows with no repeating charge/ })).toBeNull();
    });
  });
});
