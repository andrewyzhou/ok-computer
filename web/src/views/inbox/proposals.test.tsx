// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { seedDashboard } from '../../../../test/seed';
import { inMain, installEventSource, openApp, stubFetch } from '../../testing';
import { setPrefs } from '../../shell/prefs';
import { proposal, proposals } from './fixtures';

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

// the proposal that waits points at the pending approval of the seeded database.
const waiting = () => proposals.map((each) => (each.approvalId === null ? each : { ...each, approvalId: seeded.pendingApprovalId }));

describe('the calendar proposals', () => {
  it('shows the proposed events first, with their time, kind, source and approval card', async () => {
    const calls = stubFetch(seeded.dashboard, { 'GET /api/inbox/proposals': () => waiting() });
    openApp('#/inbox/proposals');
    const item = within(await inMain().findByTestId('proposal-12'));
    expect(item.getByText('Homework 6 due')).toBeTruthy();
    expect(item.getByText('course')).toBeTruthy();
    expect(item.getByText('proposed')).toBeTruthy();
    expect(item.getByText(/Homework 6 released/)).toBeTruthy();
    const card = item.getByRole('article', { name: `approval #${seeded.pendingApprovalId}` });
    expect(within(card).getByRole('button', { name: 'Approve' })).toBeTruthy();
    const bill = within(inMain().getByTestId('proposal-13'));
    expect(bill.getByText('Wednesday, October 28')).toBeTruthy();
    expect(bill.queryByRole('article')).toBeNull();
    const tabs = within(screen.getByRole('tablist', { name: 'proposal state' }));
    expect(tabs.getAllByRole('tab')[0]!.textContent).toBe('Proposed');
    expect(tabs.getByRole('tab', { name: 'Proposed' }).getAttribute('aria-selected')).toBe('true');
    expect(calls.some((call) => call.url === '/api/inbox/proposals?state=proposed&limit=50')).toBe(true);
  });

  it('approves a proposal through the approvals route', async () => {
    const calls = stubFetch(seeded.dashboard, { 'GET /api/inbox/proposals': () => waiting() });
    openApp('#/inbox/proposals');
    const item = within(await inMain().findByTestId('proposal-12'));
    fireEvent.click(item.getByRole('button', { name: 'Approve' }));
    await waitFor(() =>
      expect(calls.find((call) => call.method === 'POST')).toMatchObject({ url: `/api/approvals/${seeded.pendingApprovalId}`, body: { decision: 'approve' } }),
    );
  });

  it('switches to the created tab and shows the event id and the error of a failed one', async () => {
    const calls = stubFetch(seeded.dashboard, {
      'GET /api/inbox/proposals': ({ query }) =>
        query.get('state') === 'created'
          ? [proposal(20, { title: 'Midterm', state: 'created', eventId: 'evt-77' })]
          : query.get('state') === 'failed'
            ? [proposal(21, { title: 'Lab report', state: 'failed', error: 'the calendar refused the event' })]
            : waiting(),
    });
    openApp('#/inbox/proposals');
    await inMain().findByTestId('proposal-12');
    fireEvent.click(screen.getByRole('tab', { name: 'Created' }));
    await waitFor(() => expect(location.hash).toBe('#/inbox/proposals?state=created'));
    expect(await inMain().findByText('event evt-77')).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: 'Failed' }));
    expect(await inMain().findByText('the calendar refused the event')).toBeTruthy();
    expect(calls.some((call) => call.url === '/api/inbox/proposals?state=created&limit=50')).toBe(true);
  });

  it('selects the proposal of ?id= into the details panel', async () => {
    stubFetch(seeded.dashboard, { 'GET /api/inbox/proposals': () => waiting() });
    openApp('#/inbox/proposals?id=12');
    await inMain().findByTestId('proposal-12');
    const panel = within(document.querySelector('.details') as HTMLElement);
    expect(await panel.findByText('Submit on the course site before 11:59 pm.')).toBeTruthy();
    expect(panel.getByText('primary')).toBeTruthy();
    fireEvent.click(inMain().getByRole('button', { name: 'Pay City Power ($84.20)' }));
    await waitFor(() => expect(location.hash).toBe('#/inbox/proposals?id=13'));
    expect(await panel.findByText('Your October statement')).toBeTruthy();
  });

  it('loads the proposal of ?id= by its id when it is in another tab, as for a link from a digest', async () => {
    const calls = stubFetch(seeded.dashboard, {
      'GET /api/inbox/proposals': () => waiting(),
      'GET /api/inbox/proposals/:id': () => proposal(30, { title: 'Pay the water bill', state: 'declined', description: 'The owner said no.' }),
    });
    openApp('#/inbox/proposals?id=30');
    await inMain().findByTestId('proposal-12');
    const panel = within(document.querySelector('.details') as HTMLElement);
    expect(await panel.findByText('The owner said no.')).toBeTruthy();
    expect(calls.some((call) => call.url === '/api/inbox/proposals/30')).toBe(true);
  });

  it('says so when no proposal has the id of ?id=', async () => {
    stubFetch(seeded.dashboard, { 'GET /api/inbox/proposals': () => waiting() });
    openApp('#/inbox/proposals?id=99');
    await inMain().findByTestId('proposal-12');
    const panel = within(document.querySelector('.details') as HTMLElement);
    expect(await panel.findByText('Proposal #99 was not found.')).toBeTruthy();
  });

  it('shows an empty state when no proposal waits', async () => {
    stubFetch(seeded.dashboard, { 'GET /api/inbox/proposals': () => [] });
    openApp('#/inbox/proposals');
    expect(await inMain().findByText('No proposals wait for you.')).toBeTruthy();
  });

  it('shows the words of the mail that give the date in the details, and nothing when there are none', async () => {
    const withText = [proposal(31, { title: 'Homework 6 due', dueText: 'due on Friday, October 24 at 11:59 pm' }), proposal(32, { title: 'Club dues' })];
    stubFetch(seeded.dashboard, { 'GET /api/inbox/proposals': () => withText });
    openApp('#/inbox/proposals?id=31');
    const panel = within(document.querySelector('.details') as HTMLElement);
    expect(await panel.findByText('The mail says: “due on Friday, October 24 at 11:59 pm”')).toBeTruthy();
    location.hash = '#/inbox/proposals?id=32';
    await panel.findByRole('heading', { name: 'Club dues' });
    expect(panel.queryByText(/The mail says/)).toBeNull();
  });
});
