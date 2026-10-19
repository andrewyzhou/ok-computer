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
    expect(within(school).getByText('1 calls · 0 errors')).toBeTruthy();
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

  // the tab opens during the click, so a browser does not block it as a popup. the consent page loads in it after.
  it('opens the consent page of an account in a tab of the click and says what to do next', async () => {
    const tab = { opener: {} as unknown, location: { href: '' }, close: vi.fn() };
    const open = vi.fn(() => tab);
    vi.stubGlobal('open', open);
    openApp('#/google');
    const personal = (await inMain().findByText('personal')).closest('tr')!;
    fireEvent.click(within(personal).getByRole('button', { name: 'Connect' }));
    expect(open).toHaveBeenCalledWith('', '_blank');
    expect(await inMain().findByText('Sign in to personal in the new tab, then come back and reload.')).toBeTruthy();
    expect(tab.location.href).toBe('https://accounts.example/consent?alias=personal');
    expect(tab.opener).toBeNull();
    expect(calls.some((call) => call.method === 'POST' && call.url === '/api/google/accounts/personal/connect')).toBe(true);
  });

  it('shows a refused connect in full in the accounts section and closes the empty tab', async () => {
    const error = 'the client secret of the google oauth client is not stored. Upload the client file on the Google page.';
    calls = stubFetch(seeded.dashboard, { 'POST /api/google/accounts/:alias/connect': () => ({ error }) });
    const tab = { opener: {}, location: { href: '' }, close: vi.fn() };
    vi.stubGlobal('open', vi.fn(() => tab));
    openApp('#/google');
    const personal = (await inMain().findByText('personal')).closest('tr')!;
    fireEvent.click(within(personal).getByRole('button', { name: 'Connect' }));
    const notice = await inMain().findByRole('status');
    // the notice shows the whole error as a sentence, so nothing is cut at the edge of the header.
    expect(notice.textContent).toBe(`T${error.slice(1)}`);
    expect(tab.close).toHaveBeenCalled();
  });

  it('asks for the client file first and keeps connect off until it is stored', async () => {
    const page = (await (await seeded.dashboard.request('/api/google')).json()) as { clientStored: boolean };
    expect(page.clientStored).toBe(true);
    calls = stubFetch(seeded.dashboard, { 'GET /api/google': () => ({ ...page, clientStored: false }) });
    openApp('#/google');
    const step = await screen.findByTestId('google-client-step');
    expect(within(step).getByText('First, upload the client file.')).toBeTruthy();
    expect(within(step).getByLabelText(/Upload the client file/)).toBeTruthy();
    const personal = inMain().getByText('personal').closest('tr')!;
    expect((within(personal).getByRole('button', { name: 'Connect' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
