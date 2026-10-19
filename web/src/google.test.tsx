// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
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

describe('the google page', () => {
  it('shows each account with what the owner must do, the last poll and the tools', async () => {
    open('#/google');
    const personal = (await screen.findByText('personal')).closest('tr')!;
    expect(within(personal).getByText('needs_auth')).toBeTruthy();
    expect(within(personal).getByText(/It stopped working: sign-in refused: .*revoked\. Connect it again\./)).toBeTruthy();
    expect(within(personal).getByText(/told you at/)).toBeTruthy();
    expect(within(personal).getByText('Connect')).toBeTruthy();
    const school = screen.getByText('school').closest('tr')!;
    expect(within(school).getByText('ok')).toBeTruthy();
    expect(within(school).getByText('1 calls, 0 errors')).toBeTruthy();
    expect(within(school).getByText('Reconnect')).toBeTruthy();
    expect(screen.getByText(/Last poll/)).toBeTruthy();
    expect(screen.getByText('its requests and labels')).toBeTruthy();
    expect(screen.getByText('write, external with attendees')).toBeTruthy();
  });
});
