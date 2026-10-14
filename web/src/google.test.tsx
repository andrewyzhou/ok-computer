// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { seedGoogle } from '../../test/seed-google';
import { App } from './App';

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

describe('the run timeline', () => {
  it('opens the http requests of a google tool call', async () => {
    const row = seeded.t.db.prepare("SELECT runId FROM tool_calls WHERE name = 'google__gmail_search'").get()!;
    open(`#/runs/${String(row.runId)}`);
    fireEvent.click(await screen.findByText(/http requests to google/));
    expect(await screen.findAllByText(/\/gmail\/v1\/users\/me\/messages/)).not.toHaveLength(0);
  });

  it('shows the requests of a poll run', async () => {
    const row = seeded.t.db.prepare("SELECT id FROM runs WHERE trigger = 'poll' ORDER BY startedAt LIMIT 1").get()!;
    open(`#/runs/${String(row.id)}`);
    expect(await screen.findByText('Requests of this poll')).toBeTruthy();
    expect(await screen.findAllByText(/\/gmail\/v1\/users\/me\/profile/)).not.toHaveLength(0);
  });
});
