// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { seedDashboard } from '../../../../test/seed';
import { setPrefs } from '../../shell/prefs';
import { inMain, installEventSource, json, openApp, stubFetch, type StubRoutes } from '../../testing';
import { sendersPage, sendersPage2 } from './fixtures';
import { unsubscribeBlock } from './Newsletters';
import { money, withQuery } from './shared';

// the edge cases of the inbox views: the bounds of the archive form, an action that the server refuses, a list that
// fails to load, and the helpers of the shared file.

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

async function open(routes: StubRoutes = {}) {
  const calls = stubFetch(seeded.dashboard, { ...senders, ...routes });
  openApp('#/inbox/newsletters');
  await inMain().findByText('Weekly Deals');
  return calls;
}

const rowOf = (name: string) => within(within(inMain().getByRole('table', { name: 'newsletter senders' })).getByText(name).closest('tr')!);

describe('the archive form', () => {
  it('takes only a whole number from 0 to 3650', async () => {
    await open();
    fireEvent.click(rowOf('Weekly Deals').getByRole('button', { name: 'Archive the mail of Weekly Deals' }));
    const drawer = within(await screen.findByRole('dialog', { name: 'Archive mail' }));
    const days = drawer.getByRole('spinbutton', { name: /Older than/ });
    const archive = drawer.getByRole('button', { name: 'Archive' }) as HTMLButtonElement;
    for (const bad of ['', '-1', '2.5', '3651']) {
      fireEvent.change(days, { target: { value: bad } });
      expect(archive.disabled, bad).toBe(true);
      expect(days.getAttribute('aria-invalid'), bad).toBe('true');
    }
    for (const good of ['0', '3650', '1']) {
      fireEvent.change(days, { target: { value: good } });
      expect(archive.disabled, good).toBe(false);
    }
  });

  it('sends 0 days with no label when the label is only spaces', async () => {
    const calls = await open({
      'POST /api/inbox/senders/:id/archive': () => ({ status: 'pending_approval', approvalId: seeded.pendingApprovalId, message: 'The archive waits for your approval.' }),
    });
    fireEvent.click(rowOf('Weekly Deals').getByRole('button', { name: 'Archive the mail of Weekly Deals' }));
    const drawer = within(await screen.findByRole('dialog', { name: 'Archive mail' }));
    fireEvent.change(drawer.getByRole('spinbutton', { name: /Older than/ }), { target: { value: '0' } });
    fireEvent.change(drawer.getByRole('textbox', { name: /Label/ }), { target: { value: '   ' } });
    fireEvent.click(drawer.getByRole('button', { name: 'Archive' }));
    await waitFor(() => expect(calls.some((call) => call.method === 'POST')).toBe(true));
    expect(calls.find((call) => call.method === 'POST')!.body).toEqual({ olderThanDays: 0 });
  });

  it('keeps the form open with the error when the server refuses the archive', async () => {
    await open({ 'POST /api/inbox/senders/:id/archive': () => json({ error: 'the sender has no mail to archive' }, 409) });
    fireEvent.click(rowOf('Weekly Deals').getByRole('button', { name: 'Archive the mail of Weekly Deals' }));
    const dialog = await screen.findByRole('dialog', { name: 'Archive mail' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Archive' }));
    expect((await within(dialog).findByRole('alert')).textContent).toBe('the sender has no mail to archive');
    expect(screen.getByRole('dialog', { name: 'Archive mail' })).toBeTruthy();
  });
});

describe('a list that fails', () => {
  it('shows the error of the server when the senders do not load', async () => {
    stubFetch(seeded.dashboard, { 'GET /api/inbox/senders': () => json({ error: 'the inbox tables are missing' }, 500) });
    openApp('#/inbox/newsletters');
    expect(await inMain().findByText(/the inbox tables are missing/)).toBeTruthy();
  });

  it('shows the error of the server when the subscriptions do not load', async () => {
    stubFetch(seeded.dashboard, { 'GET /api/inbox/subscriptions': () => json({ error: 'the subscription scan failed' }, 500) });
    openApp('#/inbox/subscriptions');
    expect(await inMain().findByText(/the subscription scan failed/)).toBeTruthy();
  });

  it('shows the error of the server when the drafts do not load', async () => {
    stubFetch(seeded.dashboard, { 'GET /api/inbox/drafts': () => json({ error: 'gmail did not answer' }, 503) });
    openApp('#/inbox/drafts');
    expect(await inMain().findByText(/gmail did not answer/)).toBeTruthy();
  });
});

describe('the helpers of the inbox', () => {
  it('formats money in its currency, and a code the browser does not know as the number and the code', () => {
    expect(money(null, 'USD')).toBe('-');
    expect(money(12.99, 'USD')).toBe('$12.99');
    expect(money(0, 'EUR')).toBe('€0.00');
    expect(money(5, null)).toBe('5');
    expect(money(5, 'not a code')).toBe('5 not a code');
  });

  it('leaves the empty values out of a query and encodes the rest', () => {
    expect(withQuery('/api/inbox/senders', { account: '', state: null, sort: undefined })).toBe('/api/inbox/senders');
    expect(withQuery('/api/inbox/senders', { account: 'me+work@x.com', limit: 0 })).toBe('/api/inbox/senders?account=me%2Bwork%40x.com&limit=0');
  });

  it('turns unsubscribe off for each state and method of the contract that a 409 would refuse', () => {
    const base = sendersPage.senders[0]!;
    expect(unsubscribeBlock({ ...base, state: 'unsubscribed' })).toMatch(/already/);
    expect(unsubscribeBlock({ ...base, state: 'unsubscribe_pending' })).toMatch(/approval/);
    expect(unsubscribeBlock({ ...base, state: 'active', unsubscribe: { ...base.unsubscribe, method: 'none' } })).toMatch(/no unsubscribe/);
    expect(unsubscribeBlock({ ...base, state: 'active', unsubscribe: { ...base.unsubscribe, method: 'one_click' } })).toBeNull();
  });
});
