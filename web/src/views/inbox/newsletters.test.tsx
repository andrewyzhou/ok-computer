// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { seedDashboard } from '../../../../test/seed';
import { inMain, installEventSource, json, openApp, stubFetch, type StubRoutes } from '../../testing';
import { setPrefs } from '../../shell/prefs';
import { sendersPage, sendersPage2 } from './fixtures';

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

const senders: StubRoutes = {
  'GET /api/inbox/senders': ({ query }) => (query.get('cursor') === 'n2' ? sendersPage2 : sendersPage),
};

async function open(routes: StubRoutes = {}, hash = '#/inbox/newsletters') {
  const calls = stubFetch(seeded.dashboard, { ...senders, ...routes });
  openApp(hash);
  await inMain().findByText('Weekly Deals');
  return calls;
}

const table = () => within(inMain().getByRole('table', { name: 'newsletter senders' }));
const rowOf = (name: string) => within(table().getByText(name).closest('tr')!);

describe('the newsletter senders', () => {
  it('lists the senders with their read rate, method and state, and the last sweep', async () => {
    await open();
    const deals = rowOf('Weekly Deals');
    expect(deals.getByText('48')).toBeTruthy();
    expect(deals.getByText('2%')).toBeTruthy();
    expect(deals.getByText('list-1.example.com')).toBeTruthy();
    expect(deals.getByText('unsubscribe: one click')).toBeTruthy();
    expect(rowOf('Daily Brief').getByText('kept')).toBeTruthy();
    expect(rowOf('promo@shop.example.com').getByText('unsubscribed')).toBeTruthy();
    expect(inMain().getByText(/Last sweep/)).toBeTruthy();
    expect(inMain().getByRole('link', { name: 'run run-1' }).getAttribute('href')).toBe('#/runs/run-1');
  });

  it('keeps the filters in the hash, sends them to the server, and pages with the cursor', async () => {
    const calls = await open();
    fireEvent.change(screen.getByRole('combobox', { name: 'state' }), { target: { value: 'kept' } });
    await waitFor(() => expect(location.hash).toBe('#/inbox/newsletters?state=kept'));
    fireEvent.change(screen.getByRole('combobox', { name: 'sort' }), { target: { value: 'readRate' } });
    await waitFor(() => expect(location.hash).toBe('#/inbox/newsletters?state=kept&sort=readRate'));
    fireEvent.change(screen.getByRole('combobox', { name: 'account' }), { target: { value: 'owner@school.example.edu' } });
    await waitFor(() => expect(calls.some((call) => call.url === '/api/inbox/senders?account=owner%40school.example.edu&state=kept&sort=readRate')).toBe(true));
    await inMain().findByText('Weekly Deals');
    fireEvent.click(inMain().getByRole('button', { name: 'Load more' }));
    expect(await inMain().findByText('Travel Offers')).toBeTruthy();
    expect(calls.some((call) => call.url === '/api/inbox/senders?account=owner%40school.example.edu&state=kept&sort=readRate&cursor=n2')).toBe(true);
    expect(inMain().queryByRole('button', { name: 'Load more' })).toBeNull();
  });

  it('reads the filters from the hash of a link', async () => {
    const calls = await open({}, '#/inbox/newsletters?state=failed&sort=lastAt');
    expect((screen.getByRole('combobox', { name: 'state' }) as HTMLSelectElement).value).toBe('failed');
    expect(calls.some((call) => call.url === '/api/inbox/senders?state=failed&sort=lastAt')).toBe(true);
  });

  it('asks for approval on unsubscribe and shows the approval card on the page', async () => {
    const id = seeded.pendingApprovalId;
    const calls = await open({
      'POST /api/inbox/senders/:id/unsubscribe': () => ({ status: 'pending_approval', approvalId: id, message: 'The unsubscribe waits for your approval.' }),
    });
    fireEvent.click(rowOf('Weekly Deals').getByRole('button', { name: 'Unsubscribe from Weekly Deals' }));
    const card = await inMain().findByRole('article', { name: `approval #${id}` });
    expect(within(card).getByRole('button', { name: 'Approve' })).toBeTruthy();
    expect(inMain().getByText('The unsubscribe waits for your approval.')).toBeTruthy();
    expect(calls.find((call) => call.method === 'POST')).toMatchObject({ url: '/api/inbox/senders/1/unsubscribe', body: {} });
  });

  it('shows the error of a 409 next to the row', async () => {
    await open({ 'POST /api/inbox/senders/:id/unsubscribe': () => json({ error: 'the sender is already unsubscribed' }, 409) });
    fireEvent.click(rowOf('Weekly Deals').getByRole('button', { name: 'Unsubscribe from Weekly Deals' }));
    expect(await rowOf('Weekly Deals').findByRole('alert')).toHaveProperty('textContent', 'the sender is already unsubscribed');
  });

  it('turns unsubscribe off with a reason when the sender has no method or is already done', async () => {
    await open();
    const none = rowOf('Campus Events').getByRole('button', { name: 'Unsubscribe from Campus Events' }) as HTMLButtonElement;
    expect(none.disabled).toBe(true);
    expect(none.title).toBe('The mail of this sender has no unsubscribe link.');
    const done = rowOf('promo@shop.example.com').getByRole('button', { name: 'Unsubscribe from promo@shop.example.com' }) as HTMLButtonElement;
    expect(done.disabled).toBe(true);
    expect(done.title).toBe('This sender is already unsubscribed.');
    expect((rowOf('Weekly Deals').getByRole('button', { name: 'Unsubscribe from Weekly Deals' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('archives the old mail of a sender from the drawer form', async () => {
    const calls = await open({
      'POST /api/inbox/senders/:id/archive': () => ({ status: 'pending_approval', approvalId: seeded.pendingApprovalId, message: 'The archive waits for your approval.' }),
    });
    fireEvent.click(rowOf('Weekly Deals').getByRole('button', { name: 'Archive the mail of Weekly Deals' }));
    const drawer = within(await screen.findByRole('dialog', { name: 'Archive mail' }));
    const days = drawer.getByRole('spinbutton', { name: /Older than/ }) as HTMLInputElement;
    expect(days.value).toBe('30');
    fireEvent.change(days, { target: { value: '5000' } });
    expect((drawer.getByRole('button', { name: 'Archive' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(days, { target: { value: '90' } });
    fireEvent.change(drawer.getByRole('textbox', { name: /Label/ }), { target: { value: 'old news' } });
    fireEvent.click(drawer.getByRole('button', { name: 'Archive' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Archive mail' })).toBeNull());
    expect(calls.find((call) => call.method === 'POST')).toMatchObject({ url: '/api/inbox/senders/1/archive', body: { olderThanDays: 90, label: 'old news' } });
    expect(await inMain().findByText('The archive waits for your approval.')).toBeTruthy();
  });

  it('keeps a sender and loads the list again', async () => {
    const calls = await open({ 'POST /api/inbox/senders/:id/keep': () => ({ status: 'done', approvalId: null, message: 'The sender is kept.' }) });
    const before = calls.filter((call) => call.url.startsWith('/api/inbox/senders?') || call.url === '/api/inbox/senders').length;
    fireEvent.click(rowOf('Weekly Deals').getByRole('button', { name: 'Keep Weekly Deals' }));
    expect(await rowOf('Weekly Deals').findByText('The sender is kept.')).toBeTruthy();
    expect(calls.find((call) => call.method === 'POST')).toMatchObject({ url: '/api/inbox/senders/1/keep', body: {} });
    await waitFor(() => expect(calls.filter((call) => call.method === 'GET' && call.url === '/api/inbox/senders').length).toBeGreaterThan(before));
    expect((rowOf('Daily Brief').getByRole('button', { name: 'Keep Daily Brief' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows the facts of the selected sender in the details panel', async () => {
    await open();
    fireEvent.click(rowOf('Weekly Deals').getByText('Weekly Deals'));
    const panel = within(document.querySelector('.details') as HTMLElement);
    expect(await panel.findByText('news@list-1.example.com')).toBeTruthy();
    const link = panel.getByRole('link', { name: 'https://list-1.example.com/unsubscribe' });
    expect(link.getAttribute('rel')).toBe('noreferrer');
    expect(link.getAttribute('target')).toBe('_blank');
  });

  it('runs the sweep now', async () => {
    const calls = await open({ 'POST /api/inbox/run': () => json({ started: true }, 202) });
    fireEvent.click(screen.getByRole('button', { name: 'Sweep now' }));
    await waitFor(() => expect(calls.find((call) => call.method === 'POST')).toMatchObject({ url: '/api/inbox/run', body: { job: 'newsletters' } }));
  });

  it('shows an empty state when the sweep found no senders', async () => {
    stubFetch(seeded.dashboard, { 'GET /api/inbox/senders': () => ({ accounts: [], senders: [], nextCursor: null, lastSweep: null }) });
    openApp('#/inbox/newsletters');
    expect(await inMain().findByText('No newsletters found yet.')).toBeTruthy();
    expect(inMain().getByText('No sweep yet.')).toBeTruthy();
  });
});
