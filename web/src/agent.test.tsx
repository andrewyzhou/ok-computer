// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { seedDashboard } from '../../test/seed';
import { inMain, installEventSource, openApp as open, stubFetch } from './testing';

installEventSource();

let seeded: Awaited<ReturnType<typeof seedDashboard>>;

beforeEach(async () => {
  seeded = await seedDashboard();
  stubFetch(seeded.dashboard);
});
afterEach(() => cleanup());

const details = () => within(screen.getByRole('complementary', { name: 'details' }));

describe('the agent pages load against the seeded database', () => {
  it('lists automations and turns one off', async () => {
    open('#/automations');
    const name = await inMain().findByText('goals: ask');
    const row = name.closest('tr')!;
    fireEvent.click(within(row).getByText('Turn off'));
    expect(await screen.findByText('goals: ask is off.')).toBeTruthy();
    expect(seeded.t.rows("SELECT enabled FROM automations WHERE name = 'goals: ask'")).toEqual([{ enabled: 0 }]);
    expect(inMain().getByRole('textbox', { name: 'heartbeat checklist' })).toBeTruthy();
  });

  it('opens an automation in the details panel with its history', async () => {
    open('#/automations');
    const row = (await inMain().findByText('goals: ask')).closest('tr')!;
    fireEvent.click(within(row).getByText('goals: ask'));
    await waitFor(() => expect(details().getByRole('heading', { name: 'goals: ask' })).toBeTruthy());
    expect(details().getByRole('heading', { name: 'History' })).toBeTruthy();
    // the history loads by itself, and an automation of the seed may have no run yet.
    await waitFor(() => expect(details().queryByText('Loading…')).toBeNull());
    expect(row.getAttribute('aria-current')).toBe('true');
  });

  it('shows goals with stats and charts', async () => {
    open('#/goals');
    expect(await inMain().findByText('Hit rate, 7 days')).toBeTruthy();
    expect(screen.getAllByText('63%')).toHaveLength(2);
    expect(document.querySelectorAll('svg.chart')).toHaveLength(2);
    expect(screen.getByText('2026-10-11')).toBeTruthy();
  });

  it('opens a goal in the details panel', async () => {
    open('#/goals');
    const list = await inMain().findByRole('list', {
      name: 'goals of 2026-10-11',
    });
    const first = within(list).getAllByRole('button')[0]!;
    const title = first.querySelector('.goals-title')!.textContent!;
    fireEvent.click(first);
    await waitFor(() => expect(details().getByRole('heading', { name: title })).toBeTruthy());
    expect(details().getByText('Completed')).toBeTruthy();
    expect(first.getAttribute('aria-pressed')).toBe('true');
  });

  it('browses memory files', async () => {
    open('#/memory');
    expect(await screen.findByText(/the owner writes essays in the evening/)).toBeTruthy();
    fireEvent.click(inMain().getByText('consolidation-log.md'));
    expect(await screen.findByText(/weekly trends saved/)).toBeTruthy();
    expect(details().getByRole('heading', { name: 'consolidation-log.md' })).toBeTruthy();
  });

  it('opens the file of the path in the hash, as a memory hit of the search links it, and keeps a pick in the hash', async () => {
    open('#/memory?path=weekly%2F2026-W42.md');
    await waitFor(() => expect(details().getByRole('heading', { name: 'weekly/2026-W42.md' })).toBeTruthy());
    const row = inMain().getByText('weekly/2026-W42.md').closest('tr')!;
    expect(row.getAttribute('aria-current')).toBe('true');
    fireEvent.click(inMain().getByText('consolidation-log.md'));
    expect(location.hash).toBe('#/memory?path=consolidation-log.md');
    await waitFor(() => expect(details().getByRole('heading', { name: 'consolidation-log.md' })).toBeTruthy());
    expect(await screen.findByText(/weekly trends saved/)).toBeTruthy();
  });

  it('filters the memory files', async () => {
    open('#/memory');
    await inMain().findByText('consolidation-log.md');
    fireEvent.change(inMain().getByRole('searchbox', { name: 'filter files' }), { target: { value: 'weekly' } });
    expect(inMain().queryByText('consolidation-log.md')).toBeNull();
    expect(inMain().getByText('weekly/2026-W42.md')).toBeTruthy();
    fireEvent.change(inMain().getByRole('searchbox', { name: 'filter files' }), { target: { value: 'nothing-like-this' } });
    expect(inMain().getByText('No file matches “nothing-like-this”.')).toBeTruthy();
  });

  it('approves a pending approval', async () => {
    open('#/approvals');
    fireEvent.click(await inMain().findByText('Approve'));
    expect(await screen.findByText(/^Approved #1\./)).toBeTruthy();
    expect(await inMain().findByText('Nothing waits for your approval.')).toBeTruthy();
  });

  it('switches to the history tab and opens an approval in the details panel', async () => {
    open('#/approvals');
    await inMain().findByText('Approve');
    fireEvent.click(screen.getByRole('tab', { name: 'History' }));
    const table = await inMain().findByRole('table', {
      name: 'resolved approvals',
    });
    expect(location.hash).toBe('#/approvals?tab=history');
    expect(screen.getByRole('tab', { name: 'History' }).getAttribute('aria-selected')).toBe('true');
    const row = within(table).getByText('now {"again":true}').closest('tr')!;
    expect(within(row).getByText('denied')).toBeTruthy();
    expect(within(row).getByText('by command')).toBeTruthy();
    fireEvent.click(row);
    await waitFor(() => expect(details().getByRole('heading', { name: 'Approval #2' })).toBeTruthy());
    fireEvent.click(details().getByText(/full input/));
    expect(details().getByRole('link', { name: /Open run run-1/ })).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: /Pending/ }));
    expect(await inMain().findByText('Approve')).toBeTruthy();
    expect(location.hash).toBe('#/approvals');
  });
});
