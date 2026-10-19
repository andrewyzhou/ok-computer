// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { seedGoogle } from '../../test/seed-google';
import { App } from './App';
import './testing';

vi.stubGlobal(
  'EventSource',
  class {
    onmessage = null;
  },
);

const realFetch = globalThis.fetch;
let seeded: Awaited<ReturnType<typeof seedGoogle>>;

// the seed talks to the fake google server through the real fetch, so the stub comes after it.
beforeEach(async () => {
  vi.stubGlobal('fetch', realFetch);
  seeded = await seedGoogle();
  const dashboard = seeded.dashboard;
  vi.stubGlobal('fetch', (input: string, init?: RequestInit) => dashboard.request(String(input), init));
});
afterEach(async () => {
  cleanup();
  vi.stubGlobal('fetch', realFetch);
  await seeded.close();
});

function open(hash: string) {
  location.hash = hash;
  return render(<App />);
}

describe('the signals page', () => {
  it('says what happened to each signal, with the detector, the label and the message the owner got', async () => {
    open('#/signals');
    const essay = (await screen.findByText(/^from Prof\. Lee/)).closest('tr')!;
    expect(within(essay).getByText('deadline')).toBeTruthy();
    expect(within(essay).getByText(/model call \d+/)).toBeTruthy();
    expect(within(essay).getByText('date_not_on_calendar')).toBeTruthy();
    expect(within(essay).getByText('notified')).toBeTruthy();
    expect(within(essay).getByText('“The essay is due Oct 20, and it is not on your calendar.”')).toBeTruthy();
    const deals = screen.getByText(/^from News/).closest('tr')!;
    expect(within(deals).getByText('filtered')).toBeTruthy();
    expect(within(deals).getByText(/a quiet label and no detector hit/)).toBeTruthy();
  });
});
