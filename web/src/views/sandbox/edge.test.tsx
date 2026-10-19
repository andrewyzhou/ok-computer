// @vitest-environment jsdom
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BrowserLive, SandboxExecRow, SandboxStatus } from '../../../../src/dashboard/types';
import { seedDashboard } from '../../../../test/seed';
import { setPrefs } from '../../shell/prefs';
import { inMain, installEventSource, json, openApp, stubFetch, type StubRoutes } from '../../testing';

// the edge cases of the sandbox views: a live task with no step yet, an older page that fails, the views outside
// developer mode, and errors of the server.

installEventSource();

let seeded: Awaited<ReturnType<typeof seedDashboard>>;

const LIMITS = { cpus: 1, memoryMb: 512, timeoutMs: 30_000, outputBytes: 65_536, pids: 128 };
const STATUS: SandboxStatus = { available: true, reason: null, engine: 'engine 27.1', image: 'okc-sandbox:1', defaults: LIMITS };

function exec(id: number, extra: Partial<SandboxExecRow> = {}): SandboxExecRow {
  return {
    id,
    runId: null,
    toolCallId: null,
    sessionKey: null,
    command: `echo ${id}`,
    image: 'okc-sandbox:1',
    network: 'allowlist',
    allowlist: ['pypi.org'],
    limits: LIMITS,
    status: 'running',
    exitCode: null,
    durationMs: 0,
    stdoutBytes: 0,
    stderrBytes: 0,
    truncated: false,
    fileCount: 0,
    createdAt: '2026-10-13T01:00:00.000Z',
    ...extra,
  };
}

function open(routes: StubRoutes, hash: string) {
  const calls = stubFetch(seeded.dashboard, routes);
  openApp(hash);
  return calls;
}

beforeEach(async () => {
  setPrefs({ theme: 'system', devMode: true, detailsHidden: false });
  seeded = await seedDashboard();
});
afterEach(() => cleanup());

describe('the sandbox edge cases', () => {
  it('shows a live task with no step yet and no run', async () => {
    const live: BrowserLive = {
      tasks: [{ id: 'abcdefghijkl', kind: 'search', sessionKey: 'main', runId: null, allowlist: [], startedAt: '2026-10-13T01:00:00.000Z', steps: 0, latest: null }],
    };
    open({ 'GET /api/browser/live': () => live }, '#/sandbox');
    const card = within(await inMain().findByRole('article', { name: 'browser task abcdefghijkl' }));
    expect(card.getByText('no screenshot yet')).toBeTruthy();
    expect(card.getByText('none yet')).toBeTruthy();
    expect(card.getByText('Search abcdefgh')).toBeTruthy();
    expect(card.queryByText(/trace of run/)).toBeNull();
  });

  it('shows the error of the live endpoint', async () => {
    open({ 'GET /api/browser/live': () => json({ error: 'the browser is not running' }, 503) }, '#/sandbox');
    expect(await inMain().findByText(/the browser is not running/)).toBeTruthy();
  });

  it('keeps the rows and shows the error when an older page fails, then loads it on the next try', async () => {
    let fail = true;
    const calls = open(
      {
        'GET /api/sandbox': ({ query }) => {
          if (!query.get('before')) return { status: STATUS, execs: [exec(3), exec(2)], before: 2 };
          return fail ? json({ error: 'the sandbox table is locked' }, 500) : { status: STATUS, execs: [exec(1)], before: null };
        },
      },
      '#/sandbox?tab=code',
    );
    const table = within(await inMain().findByRole('table', { name: 'code runs' }));
    fireEvent.click(inMain().getByRole('button', { name: 'Load older' }));
    expect(await inMain().findByText('the sandbox table is locked')).toBeTruthy();
    expect(table.getByText('#3')).toBeTruthy();
    fail = false;
    fireEvent.click(inMain().getByRole('button', { name: 'Load older' }));
    expect(await table.findByText('#1')).toBeTruthy();
    expect(inMain().queryByText('the sandbox table is locked')).toBeNull();
    expect(calls.filter((call) => call.url === '/api/sandbox?limit=50&before=2')).toHaveLength(2);
  });

  it('shows the network allowlist and a running exec with no exit code', async () => {
    open({ 'GET /api/sandbox': () => ({ status: STATUS, execs: [exec(7)], before: null }) }, '#/sandbox?tab=code');
    const row = within((await inMain().findByText('#7')).closest('tr')!);
    expect(row.getByText('running')).toBeTruthy();
    expect(row.getByText('-')).toBeTruthy();
  });

  it('opens a sandbox page by its hash outside developer mode', async () => {
    setPrefs({ devMode: false });
    open({ 'GET /api/sandbox': () => ({ status: STATUS, execs: [], before: null }) }, '#/sandbox?tab=code');
    expect(await inMain().findByText('No code ran in the sandbox yet.')).toBeTruthy();
    expect(within(screen.getByRole('navigation', { name: 'pages' })).queryByRole('link', { name: 'Sandbox' })).toBeNull();
  });

  it('says when a code run id is not a number', async () => {
    const calls = open({ 'GET /api/sandbox/execs/:id': () => json({ error: 'sandbox exec not found' }, 404) }, '#/sandbox/code/not%2Fa%20number');
    expect(await inMain().findByText('Not found: sandbox exec not found')).toBeTruthy();
    expect(calls.some((call) => call.url === '/api/sandbox/execs/not%2Fa%20number')).toBe(true);
  });
});
