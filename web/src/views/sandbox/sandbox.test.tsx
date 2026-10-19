// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { seedDashboard } from '../../../../test/seed';
import type { BrowserTaskDetail } from '../../../../src/dashboard/browser-types';
import type { BrowserLive, SandboxExecDetail, SandboxExecRow, SandboxPage, SandboxStatus } from '../../../../src/dashboard/types';
import { setPrefs } from '../../shell/prefs';
import { inMain, installEventSource, json, openApp, stubFetch, type StubRoutes } from '../../testing';

installEventSource();

let seeded: Awaited<ReturnType<typeof seedDashboard>>;

const LIMITS = { cpus: 1, memoryMb: 512, timeoutMs: 30_000, outputBytes: 65_536, pids: 128 };
const STATUS: SandboxStatus = { available: true, reason: null, engine: 'engine 27.1', image: 'okc-sandbox:1', defaults: LIMITS, network: true, networkReason: null };

function exec(id: number, extra: Partial<SandboxExecRow> = {}): SandboxExecRow {
  return {
    id,
    runId: 'run-1',
    toolCallId: `call-${id}`,
    sessionKey: 'main',
    language: 'bash',
    command: `sh -c "echo ${id}"`,
    image: 'okc-sandbox:1',
    network: 'none',
    allowlist: [],
    limits: LIMITS,
    status: 'ok',
    exitCode: 0,
    durationMs: 1200,
    stdoutBytes: 2,
    stderrBytes: 0,
    truncated: false,
    fileCount: 0,
    createdAt: '2026-10-13T01:00:00.000Z',
    ...extra,
  };
}

const DETAIL: SandboxExecDetail = {
  ...exec(1, { truncated: true, stdoutBytes: 70_000, fileCount: 1 }),
  cwd: '/work',
  stdout: 'line 1\nline 2',
  stderr: null,
  stdoutBlob: 'b'.repeat(64),
  stderrBlob: null,
  error: null,
  files: [{ path: 'out/result.txt', direction: 'out', blob: 'c'.repeat(64), size: 12, mime: 'text/plain' }],
  imageId: null,
  containerId: null,
  egress: null,
  notCollected: [],
  policy: null,
  endedAt: '2026-10-13T01:00:01.200Z',
};

const step = (id: number, action: string) => ({
  id,
  runId: 'run-1',
  toolCallId: 'call-b',
  action,
  target: null,
  urlBefore: 'https://example.org/',
  urlAfter: `https://example.org/${action}`,
  snapshotBlob: null,
  screenshotBlob: `${id}`.repeat(64).slice(0, 64),
  consoleErrors: id === 2 ? ['a script failed'] : [],
  blockedRequests: [],
  sent: [],
  offsiteHosts: [],
  error: null,
  durationMs: 300,
  createdAt: '2026-10-13T01:00:00.000Z',
  risk: 'read',
  decision: 'allow',
  rule: 'risk:read',
  approvalId: null,
});

const TASK: BrowserTaskDetail = {
  task: {
    id: 'task-live',
    kind: 'task',
    sessionKey: 'main',
    runId: 'run-1',
    allowlist: ['example.org'],
    status: 'closed',
    endReason: 'done',
    hasTrace: true,
    traceBytes: 2048,
    traceError: null,
    startedAt: '2026-10-13T01:00:00.000Z',
    endedAt: '2026-10-13T01:01:00.000Z',
    steps: 3,
    blocked: 0,
    sent: 0,
  },
  steps: [step(1, 'open'), step(2, 'click'), step(3, 'read')],
};

let live: BrowserLive;
let pages: Record<string, SandboxPage>;

const routes = (extra: StubRoutes = {}): StubRoutes => ({
  'GET /api/browser/live': () => live,
  'GET /api/sandbox': ({ query }) => pages[query.get('before') ?? 'first'] ?? { status: STATUS, execs: [], before: null },
  'GET /api/sandbox/execs/:id': ({ params }) => (params.id === '1' ? DETAIL : json({ error: 'sandbox exec not found' }, 404)),
  'GET /api/browser/tasks/:id': ({ params }) => (params.id === 'task-live' ? TASK : json({ error: 'browser task not found' }, 404)),
  'GET /api/blobs/:hash': ({ params }) => ({ hash: params.hash, size: 9, mime: 'text/plain', createdAt: '2026-10-13T01:00:00.000Z', text: `the full text of ${(params.hash ?? '').slice(0, 1)}` }),
  ...extra,
});

let calls: ReturnType<typeof stubFetch>;

beforeEach(async () => {
  setPrefs({ theme: 'system', devMode: true, detailsHidden: false });
  live = { tasks: [] };
  pages = { first: { status: STATUS, execs: [exec(5), exec(4, { status: 'failed', exitCode: 1 }), exec(3, { status: 'timeout', exitCode: null })], before: 3 } };
  seeded = await seedDashboard();
  calls = stubFetch(seeded.dashboard, routes());
});
afterEach(() => cleanup());

const nav = () => within(screen.getByRole('navigation', { name: 'pages' }));

describe('the sandbox views', () => {
  it('lists Sandbox in the nav only in developer mode', async () => {
    setPrefs({ devMode: false });
    openApp('#/sandbox');
    expect(await inMain().findByText('No browser task is open.')).toBeTruthy();
    expect(nav().queryByRole('link', { name: /^Sandbox/ })).toBeNull();
    act(() => setPrefs({ devMode: true }));
    expect(nav().getByRole('link', { name: /^Sandbox/ }).getAttribute('href')).toBe('#/sandbox');
  });

  it('shows the open browser tasks as cards that link to the live task', async () => {
    live = {
      tasks: [
        {
          id: 'task-live',
          kind: 'task',
          sessionKey: 'main',
          runId: 'run-1',
          allowlist: ['example.org'],
          startedAt: '2026-10-13T01:00:00.000Z',
          steps: 3,
          latest: { id: 3, action: 'read', target: null, urlAfter: 'https://example.org/read', screenshotBlob: 'f'.repeat(64), error: null, durationMs: 200, createdAt: '2026-10-13T01:00:00.000Z' },
        },
      ],
    };
    openApp('#/sandbox');
    const card = await inMain().findByRole('article', { name: 'browser task task-live' });
    expect(within(card).getByRole('link', { name: 'Task task-liv' }).getAttribute('href')).toBe('#/sandbox/browser/task-live');
    expect(within(card).getByText('https://example.org/read')).toBeTruthy();
    expect(within(card).getByText('example.org')).toBeTruthy();
    expect(within(card).getByRole('link', { name: /trace of run/ }).getAttribute('href')).toBe('#/trace/run-1');
  });

  it('points to the browser history when no task is open', async () => {
    openApp('#/sandbox');
    expect(await inMain().findByText('No browser task is open.')).toBeTruthy();
    expect(inMain().getByRole('link', { name: 'Browser history' }).getAttribute('href')).toBe('#/browser');
  });

  it('lists the code runs with their status words, loads older pages and opens a run in the details panel', async () => {
    openApp('#/sandbox?tab=code');
    const table = within(await inMain().findByRole('table', { name: 'code runs' }));
    expect(table.getByText('#5')).toBeTruthy();
    expect(table.getByText('failed').className).toContain('tone-critical');
    expect(table.getByText('timeout').className).toContain('tone-warning');
    expect(inMain().getByText('engine 27.1')).toBeTruthy();
    expect(inMain().getByText('512 MB')).toBeTruthy();
    pages['3'] = { status: STATUS, execs: [exec(2), exec(1)], before: null };
    fireEvent.click(inMain().getByRole('button', { name: 'Load older' }));
    expect(await table.findByText('#1')).toBeTruthy();
    expect(calls.some((call) => call.url === '/api/sandbox?limit=50&before=3')).toBe(true);
    expect(inMain().getByText('That is all.')).toBeTruthy();
    fireEvent.click(table.getByText('#4').closest('tr')!);
    const link = await screen.findByRole('link', { name: 'Open the code run' });
    expect(link.getAttribute('href')).toBe('#/sandbox/code/4');
  });

  it('filters the code runs by status and run from the query', async () => {
    openApp('#/sandbox?tab=code&runId=run-1');
    await inMain().findByRole('table', { name: 'code runs' });
    expect(calls.some((call) => call.url === '/api/sandbox?runId=run-1&limit=50')).toBe(true);
    fireEvent.change(inMain().getByLabelText('status'), { target: { value: 'failed' } });
    await waitFor(() => expect(calls.some((call) => call.url === '/api/sandbox?status=failed&runId=run-1&limit=50')).toBe(true));
    fireEvent.click(inMain().getByRole('button', { name: 'run run-1' }));
    await waitFor(() => expect(location.hash).toBe('#/sandbox?tab=code&status=failed'));
  });

  it('says why the code sandbox is off, and that it is not an error', async () => {
    pages = { first: { status: { ...STATUS, available: false, reason: 'the container engine is not running', engine: null }, execs: [], before: null } };
    openApp('#/sandbox?tab=code');
    expect(await inMain().findByText('The code sandbox is off.')).toBeTruthy();
    expect(inMain().getByText(/the container engine is not running/)).toBeTruthy();
    expect(inMain().queryByText(/Could not load/)).toBeNull();
  });

  it('shows a code run with its output, the cut note, the full blob and the files', async () => {
    openApp('#/sandbox/code/1');
    expect(await inMain().findByText(/line 1\s+line 2/)).toBeTruthy();
    expect(inMain().getByText('stderr: no output.')).toBeTruthy();
    expect(inMain().getByRole('note').textContent).toMatch(/cut to 64.0 KB per stream/);
    expect(inMain().getByText('/work')).toBeTruthy();
    fireEvent.click(inMain().getByRole('button', { name: 'Load the full stdout' }));
    expect(await inMain().findByText('the full text of b')).toBeTruthy();
    expect(inMain().getByText('out/result.txt')).toBeTruthy();
    fireEvent.click(within(inMain().getByRole('table', { name: 'files out' })).getByRole('button', { name: 'Load' }));
    expect(await inMain().findByText('the full text of c')).toBeTruthy();
    expect(inMain().getByRole('link', { name: 'its trace' }).getAttribute('href')).toBe('#/trace/run-1');
  });

  it('shows the policy, the egress, the files that did not come back, and an image file from the sandbox route', async () => {
    const image = 'd'.repeat(64);
    calls = stubFetch(
      seeded.dashboard,
      routes({
        'GET /api/sandbox/execs/:id': () => ({
          ...DETAIL,
          language: 'python',
          network: 'allowlist',
          allowlist: ['pypi.org'],
          files: [...DETAIL.files, { path: 'out/chart.png', direction: 'out', blob: image, size: 2048, mime: 'image/png' }],
          egress: { passed: ['pypi.org'], refused: [{ target: 'evil.example:443', reason: 'not on the allowlist' }] },
          notCollected: [{ path: 'out/missing.csv', reason: 'no such file' }],
          policy: {
            decisionId: 4,
            decision: 'approve',
            rule: 'risk:external',
            reason: 'network access',
            reviewerVerdict: null,
            reviewerReason: null,
            reviewerModelCallId: null,
            approvalId: 3,
            approvalStatus: 'approved',
          },
        }),
      }),
    );
    openApp('#/sandbox/code/1');
    expect(await inMain().findByText('risk:external')).toBeTruthy();
    expect(inMain().getByText('evil.example:443')).toBeTruthy();
    expect(inMain().getByText('out/missing.csv')).toBeTruthy();
    const img = inMain().getByRole('img', { name: 'out/chart.png' });
    expect(img.getAttribute('src')).toContain(`/api/sandbox/files/${image}`);
  });

  it('says when a code run or a browser task is not found', async () => {
    openApp('#/sandbox/code/9');
    expect(await inMain().findByText('Not found: sandbox exec not found')).toBeTruthy();
    cleanup();
    openApp('#/sandbox/browser/task-gone');
    expect(await inMain().findByText('Not found: browser task not found')).toBeTruthy();
  });

  it('shows the filmstrip of a browser task, moves with the arrow keys and links the trace zip', async () => {
    openApp('#/sandbox/browser/task-live');
    const strip = await inMain().findByRole('listbox', { name: 'steps' });
    const options = within(strip).getAllByRole('option');
    expect(options.map((option) => option.getAttribute('aria-selected'))).toEqual(['false', 'false', 'true']);
    expect(inMain().getByAltText('page after step 3')).toBeTruthy();
    fireEvent.keyDown(options[2]!, { key: 'ArrowLeft' });
    expect(inMain().getByAltText('page after step 2')).toBeTruthy();
    expect(inMain().getByText('a script failed')).toBeTruthy();
    fireEvent.click(options[0]!);
    expect(inMain().getByAltText('page after step 1')).toBeTruthy();
    expect(within(strip).getAllByRole('option')[0]!.getAttribute('aria-selected')).toBe('true');
    const zip = inMain().getByRole('link', { name: /trace zip/ });
    expect(zip.getAttribute('href')).toBe('/api/browser/tasks/task-live/trace');
  });
});
