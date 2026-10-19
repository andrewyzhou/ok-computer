// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
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
