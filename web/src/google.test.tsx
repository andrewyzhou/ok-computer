// @vitest-environment jsdom
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { seedGoogle } from '../../test/seed-google';
import { inMain, installEventSource, openApp, stubFetch } from './testing';

installEventSource();

const realFetch = globalThis.fetch;
let seeded: Awaited<ReturnType<typeof seedGoogle>>;
let calls: ReturnType<typeof stubFetch>;

// the seed talks to the fake google server through the real fetch, so the stub comes after it.
beforeEach(async () => {
  vi.stubGlobal('fetch', realFetch);
  seeded = await seedGoogle();
  calls = stubFetch(seeded.dashboard, {
    'POST /api/google/accounts/:alias/connect': ({ params }) => ({ url: `https://accounts.example/consent?alias=${params.alias}` }),
  });
});
afterEach(async () => {
  cleanup();
  vi.stubGlobal('fetch', realFetch);
  await seeded.close();
});

const details = () => within(screen.getByRole('complementary', { name: 'details' }));

describe('the google page', () => {
  it('shows each account with what the owner must do, the last poll and the tools', async () => {
    openApp('#/google');
    const main = inMain();
    const personal = (await main.findByText('personal')).closest('tr')!;
    expect(within(personal).getByText('needs_auth')).toBeTruthy();
    expect(within(personal).getByText(/It stopped working: sign-in refused: .*revoked\. Connect it again\./)).toBeTruthy();
    expect(within(personal).getByText(/told you at/)).toBeTruthy();
    expect(within(personal).getByText('Connect')).toBeTruthy();
    const school = main.getByText('school').closest('tr')!;
    expect(within(school).getByText('ok')).toBeTruthy();
    expect(within(school).getByText('1 calls, 0 errors')).toBeTruthy();
    expect(within(school).getByText('Reconnect')).toBeTruthy();
    expect(main.getByText(/Last poll/)).toBeTruthy();
    expect(main.getByText('its requests and labels')).toBeTruthy();
    expect(main.getByText('write, external with attendees')).toBeTruthy();
    expect(main.getByLabelText(/Upload the client file/)).toBeTruthy();
  });

  it('shows the selected account in the details panel', async () => {
    openApp('#/google');
    const personal = (await inMain().findByText('personal')).closest('tr')!;
    fireEvent.click(personal);
    expect(await details().findByRole('heading', { name: 'personal' })).toBeTruthy();
    expect(details().getByText('needs_auth')).toBeTruthy();
    expect(details().getByText(/It stopped working: sign-in refused/)).toBeTruthy();
    expect(details().getByText('Told you')).toBeTruthy();
    fireEvent.click(details().getByRole('button', { name: 'Close details' }));
    expect(await details().findByRole('heading', { name: 'Google' })).toBeTruthy();
  });

  it('opens the consent page of an account and says what to do next', async () => {
    const open = vi.fn();
    vi.stubGlobal('open', open);
    openApp('#/google');
    const personal = (await inMain().findByText('personal')).closest('tr')!;
    fireEvent.click(within(personal).getByRole('button', { name: 'Connect' }));
    expect(await screen.findByText('Sign in to personal in the new tab, then come back and reload.')).toBeTruthy();
    expect(open).toHaveBeenCalledWith('https://accounts.example/consent?alias=personal', '_blank', 'noopener');
    expect(calls.some((call) => call.method === 'POST' && call.url === '/api/google/accounts/personal/connect')).toBe(true);
  });
});
