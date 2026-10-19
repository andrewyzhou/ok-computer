// @vitest-environment jsdom
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { seedDashboard } from '../../test/seed';
import { installEventSource, openApp as open, stubFetch } from './testing';

installEventSource();

let seeded: Awaited<ReturnType<typeof seedDashboard>>;

beforeEach(async () => {
  seeded = await seedDashboard();
  stubFetch(seeded.dashboard);
});
afterEach(() => cleanup());

describe('the agent pages load against the seeded database', () => {
  it('lists automations and turns one off', async () => {
    open('#/automations');
    const name = await screen.findByText('goals: ask');
    const row = name.closest('tr')!;
    fireEvent.click(within(row).getByText('Turn off'));
    expect(await screen.findByText('goals: ask is off.')).toBeTruthy();
    expect(seeded.t.rows("SELECT enabled FROM automations WHERE name = 'goals: ask'")).toEqual([{ enabled: 0 }]);
    expect(screen.getByLabelText('heartbeat checklist')).toBeTruthy();
  });

  it('shows goals with stats and charts', async () => {
    open('#/goals');
    expect(await screen.findByText('Hit rate, 7 days')).toBeTruthy();
    expect(screen.getAllByText('63%')).toHaveLength(2);
    expect(document.querySelectorAll('svg.chart')).toHaveLength(2);
    expect(screen.getByText('2026-10-11')).toBeTruthy();
  });

  it('browses memory files', async () => {
    open('#/memory');
    expect(await screen.findByText(/the owner writes essays in the evening/)).toBeTruthy();
    fireEvent.click(screen.getByText('consolidation-log.md'));
    expect(await screen.findByText(/weekly trends saved/)).toBeTruthy();
  });

  it('approves a pending approval', async () => {
    open('#/approvals');
    fireEvent.click(await screen.findByText('Approve'));
    expect(await screen.findByText(/^Approved #1\./)).toBeTruthy();
    expect(await screen.findByText('Nothing waits for your approval.')).toBeTruthy();
  });
});
