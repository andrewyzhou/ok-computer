// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { seedGoogle } from '../../test/seed-google';
import { inMain, installEventSource, openApp as open, stubFetch } from './testing';

installEventSource();

const realFetch = globalThis.fetch;
let seeded: Awaited<ReturnType<typeof seedGoogle>>;

// the seed talks to the fake google server through the real fetch, so the stub comes after it.
beforeEach(async () => {
  vi.stubGlobal('fetch', realFetch);
  seeded = await seedGoogle();
  stubFetch(seeded.dashboard);
});
afterEach(async () => {
  cleanup();
  vi.stubGlobal('fetch', realFetch);
  await seeded.close();
});

const details = () => within(screen.getByRole('complementary', { name: 'details' }));

describe('the signals page', () => {
  it('says what happened to each signal, with the detector, the label and the message the owner got', async () => {
    open('#/signals');
    const essay = (await inMain().findByText(/^from Prof\. Lee/)).closest('tr')!;
    expect(within(essay).getByText('deadline')).toBeTruthy();
    expect(within(essay).getByText(/model call \d+/)).toBeTruthy();
    expect(within(essay).getByText('date_not_on_calendar')).toBeTruthy();
    expect(within(essay).getByText('notified')).toBeTruthy();
    expect(within(essay).getByText('“The essay is due Oct 20, and it is not on your calendar.”')).toBeTruthy();
    const deals = inMain()
      .getByText(/^from News/)
      .closest('tr')!;
    expect(within(deals).getByText('filtered')).toBeTruthy();
    expect(within(deals).getByText(/a quiet label and no detector hit/)).toBeTruthy();
  });

  it('filters the signals by how they were handled', async () => {
    open('#/signals');
    await inMain().findByText(/^from Prof\. Lee/);
    const handled = inMain().getByRole('combobox', { name: 'handled' });
    fireEvent.change(handled, { target: { value: 'filtered' } });
    expect(inMain().queryByText(/^from Prof\. Lee/)).toBeNull();
    expect(inMain().getByText(/^from News/)).toBeTruthy();
    fireEvent.change(handled, { target: { value: 'notified' } });
    expect(inMain().getByText(/^from Prof\. Lee/)).toBeTruthy();
    expect(inMain().queryByText(/^from News/)).toBeNull();
    fireEvent.change(handled, { target: { value: '' } });
    const source = inMain().getByRole('combobox', { name: 'source' });
    fireEvent.change(source, { target: { value: 'gmail' } });
    expect(inMain().getByText(/^from Prof\. Lee/)).toBeTruthy();
    const rows = within(inMain().getByRole('table', { name: 'signals' }))
      .getAllByRole('row')
      .slice(1);
    for (const row of rows) expect(row.querySelectorAll('td')[1]!.textContent).toMatch(/^gmail:/);
  });

  it('opens a signal in the details panel with all its fields', async () => {
    open('#/signals');
    const essay = (await inMain().findByText(/^from Prof\. Lee/)).closest('tr')!;
    fireEvent.click(essay);
    await waitFor(() => expect(details().getByRole('heading', { name: /^Signal #\d+$/ })).toBeTruthy());
    expect(details().getByText(/^from Prof\. Lee/)).toBeTruthy();
    expect(details().getByText('date_not_on_calendar')).toBeTruthy();
    expect(details().getByText('“The essay is due Oct 20, and it is not on your calendar.”')).toBeTruthy();
  });
});
