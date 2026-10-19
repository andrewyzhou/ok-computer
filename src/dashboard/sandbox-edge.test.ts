import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseConfig } from '../config/load.js';
import { openDb } from '../db/index.js';
import { createBlobStore } from '../observability/blobs.js';
import { silentLogger } from '../observability/logger.js';
import { DEFAULT_LIMITS, DETAIL_TEXT_BYTES, SANDBOX_IMAGE } from '../sandbox/limits.js';
import { addFiles, finishExec, startExec } from '../sandbox/store.js';
import { parseSandboxQuery } from './sandbox.js';
import { createDashboard, type DashboardDeps } from './server.js';
import type { SandboxExecDetail, SandboxExecRow, SandboxPage, SandboxStatus } from './types.js';

// the routes of the code sandbox against docs/PHASE5-API.md (M9): the exact keys of each shape, the query rules of
// section 1, and the rows that the sandbox itself writes, also a row that still runs.

const NOW = new Date('2026-10-18T12:00:00.000Z');

const ON: SandboxStatus = { available: true, reason: null, engine: 'docker 28', image: SANDBOX_IMAGE, defaults: DEFAULT_LIMITS, network: false, networkReason: 'no bridge' };

const ROW_KEYS: Array<keyof SandboxExecRow> = [
  'id',
  'runId',
  'toolCallId',
  'sessionKey',
  'language',
  'command',
  'image',
  'network',
  'allowlist',
  'limits',
  'status',
  'exitCode',
  'durationMs',
  'stdoutBytes',
  'stderrBytes',
  'truncated',
  'fileCount',
  'createdAt',
];
const DETAIL_KEYS: Array<keyof SandboxExecDetail> = [
  ...ROW_KEYS,
  'cwd',
  'imageId',
  'containerId',
  'stdout',
  'stderr',
  'stdoutBlob',
  'stderrBlob',
  'error',
  'files',
  'policy',
  'endedAt',
];

function setup(status: () => Promise<SandboxStatus> = async () => ON) {
  const workspace = mkdtempSync(join(tmpdir(), 'okc-sandbox-dash-edge-'));
  const dataDir = join(workspace, 'data');
  const parsed = parseConfig({ paths: { workspace, data: dataDir } });
  if (!parsed.ok) throw new Error(parsed.error);
  const db = openDb(':memory:');
  const clock = () => NOW;
  const blobs = createBlobStore(db, join(dataDir, 'blobs'), clock);
  const app = { sandbox: { status } } as unknown as DashboardDeps['app'];
  const dashboard = createDashboard({ db, config: parsed.value, clock, logger: silentLogger, app, webDir: join(dataDir, 'no-web') });
  const exec = (over: { runId?: string | null; toolCallId?: string | null; command?: string } = {}) =>
    startExec(
      db,
      {
        runId: over.runId === undefined ? 'run-1' : over.runId,
        toolCallId: over.toolCallId === undefined ? 'c1' : over.toolCallId,
        sessionKey: 'main',
        taskId: 't',
        language: 'python',
        command: over.command ?? 'print(1)',
        image: SANDBOX_IMAGE,
        cwd: '/work',
        network: 'none',
        allowlist: [],
        limits: DEFAULT_LIMITS,
      },
      NOW,
    );
  return { db, blobs, dashboard, exec };
}

const get = async <T>(dashboard: { request: (path: string) => Response | Promise<Response> }, path: string, status = 200) => {
  const response = await dashboard.request(path);
  expect(response.status, path).toBe(status);
  return (await response.json()) as T;
};

describe('the sandbox routes against the contract', () => {
  it('gives exactly the keys of SandboxPage, SandboxStatus and SandboxExecRow', async () => {
    const t = setup();
    t.exec();
    const page = await get<SandboxPage>(t.dashboard, '/api/sandbox');
    expect(Object.keys(page).sort()).toEqual(['before', 'execs', 'status']);
    expect(Object.keys(page.status).sort()).toEqual(Object.keys(ON).sort());
    expect(page.status).toEqual(ON);
    expect(Object.keys(page.execs[0]!).sort()).toEqual([...ROW_KEYS].sort());
  });

  it('gives exactly the keys of SandboxExecDetail for a running row, with the nulls of a row that did not end', async () => {
    const t = setup();
    const id = t.exec({ toolCallId: null });
    const detail = await get<SandboxExecDetail>(t.dashboard, `/api/sandbox/execs/${id}`);
    expect(Object.keys(detail).sort()).toEqual([...DETAIL_KEYS].sort());
    expect(detail).toMatchObject({
      id,
      status: 'running',
      exitCode: null,
      endedAt: null,
      stdout: null,
      stderr: null,
      stdoutBlob: null,
      stderrBlob: null,
      imageId: null,
      containerId: null,
      error: null,
      policy: null,
      files: [],
      fileCount: 0,
      truncated: false,
      allowlist: [],
      limits: DEFAULT_LIMITS,
      cwd: '/work',
    });
  });

  it('shows a row that the sandbox wrote and finished, with its files, its cut text and its counts', async () => {
    const t = setup();
    const id = t.exec();
    const long = 'é'.repeat(DETAIL_TEXT_BYTES);
    const stdoutBlob = t.blobs.put('out');
    const stderrBlob = t.blobs.put(long);
    addFiles(t.db, id, [{ direction: 'in', path: 'a.csv', blob: t.blobs.put('a'), size: 1, mime: 'text/csv' }], NOW);
    addFiles(t.db, id, [{ direction: 'out', path: 'b.csv', blob: t.blobs.put('b'), size: 1, mime: 'text/csv' }], NOW);
    finishExec(
      t.db,
      id,
      { status: 'failed', exitCode: 2, imageId: 'sha256:i', containerId: 'c', stdoutBlob, stderrBlob, stdoutBytes: 3, stderrBytes: 999, truncated: true, error: null, durationMs: 5 },
      NOW,
    );
    const detail = await get<SandboxExecDetail>(t.dashboard, `/api/sandbox/execs/${id}`);
    expect(detail).toMatchObject({ status: 'failed', exitCode: 2, stdout: 'out', stdoutBlob, stderrBlob, truncated: true, fileCount: 2, endedAt: NOW.toISOString() });
    expect(Buffer.byteLength(detail.stderr!)).toBe(DETAIL_TEXT_BYTES);
    expect(detail.files.map((file) => [file.direction, file.path])).toEqual([
      ['in', 'a.csv'],
      ['out', 'b.csv'],
    ]);
  });

  it('pages through every row once, newest first', async () => {
    const t = setup();
    const ids = Array.from({ length: 7 }, () => t.exec());
    const seen: number[] = [];
    let before: number | null = null;
    let pages = 0;
    do {
      const page: SandboxPage = await get<SandboxPage>(t.dashboard, `/api/sandbox?limit=3${before === null ? '' : `&before=${before}`}`);
      seen.push(...page.execs.map((row) => row.id));
      before = page.before;
      pages += 1;
    } while (before !== null && pages < 10);
    expect(seen).toEqual([...ids].reverse());
    expect(pages).toBe(3);
  });

  it('gives before null when the page holds exactly the last rows', async () => {
    const t = setup();
    t.exec();
    t.exec();
    expect((await get<SandboxPage>(t.dashboard, '/api/sandbox?limit=2')).before).toBeNull();
    expect((await get<SandboxPage>(t.dashboard, '/api/sandbox?limit=1')).before).not.toBeNull();
  });

  it('matches a run id exactly, also one with sql wildcards', async () => {
    const t = setup();
    t.exec({ runId: 'run_1' });
    t.exec({ runId: 'runX1' });
    const page = await get<SandboxPage>(t.dashboard, `/api/sandbox?runId=${encodeURIComponent('run_1')}`);
    expect(page.execs.map((row) => row.runId)).toEqual(['run_1']);
    expect((await get<SandboxPage>(t.dashboard, '/api/sandbox?runId=%25')).execs).toEqual([]);
  });

  it('answers 500 with one error sentence for a damaged row, and not a crash', async () => {
    const t = setup();
    const id = t.exec();
    t.db.prepare("UPDATE sandbox_execs SET allowlist = 'not json' WHERE id = ?").run(id);
    const list = await get<{ error: string }>(t.dashboard, '/api/sandbox', 500);
    expect(typeof list.error).toBe('string');
    const detail = await get<{ error: string }>(t.dashboard, `/api/sandbox/execs/${id}`, 500);
    expect(typeof detail.error).toBe('string');
  });

  it('answers 404 with the contract text for each id that is not a row', async () => {
    const t = setup();
    t.exec();
    for (const id of ['0', '-1', '1.0', '1e0', '01', '2', '99999999999999999999', '%201', 'abc']) {
      expect(await get(t.dashboard, `/api/sandbox/execs/${id}`, 404), id).toEqual({ error: 'sandbox exec not found' });
    }
  });

  it('keeps the list when the status check never says docker is there', async () => {
    const t = setup(async () => ({ ...ON, available: false, reason: 'docker does not answer', engine: null, network: false, networkReason: 'docker does not answer' }));
    t.exec();
    const page = await get<SandboxPage>(t.dashboard, '/api/sandbox');
    expect(page.status.available).toBe(false);
    expect(page.execs).toHaveLength(1);
  });
});

describe('parseSandboxQuery on the edges', () => {
  const limit = (value: string) => {
    const parsed = parseSandboxQuery({ limit: value });
    return parsed.ok ? parsed.value.limit : undefined;
  };

  it('clamps and truncates each numeric limit, and a limit that is not a number gives the default', () => {
    expect(limit('1e3')).toBe(200);
    expect(limit('-3')).toBe(1);
    expect(limit('0')).toBe(1);
    expect(limit('2.9')).toBe(2);
    expect(limit('abc')).toBe(50);
    expect(limit('Infinity')).toBe(50);
    expect(limit('200')).toBe(200);
    expect(limit('201')).toBe(200);
  });

  it('refuses each before that is not an exec id, and an unknown status in another case', () => {
    for (const before of ['0', '-1', '1.5', '01', '1e3', '9007199254740993', ' 1']) {
      expect(parseSandboxQuery({ before }).ok, before).toBe(false);
    }
    expect(parseSandboxQuery({ status: 'RUNNING' }).ok).toBe(false);
    for (const status of ['running', 'ok', 'failed', 'timeout', 'killed', 'error']) expect(parseSandboxQuery({ status }).ok, status).toBe(true);
  });

  it('takes a run id of 200 characters and refuses 201', () => {
    expect(parseSandboxQuery({ runId: 'r'.repeat(200) }).ok).toBe(true);
    expect(parseSandboxQuery({ runId: 'r'.repeat(201) }).ok).toBe(false);
  });

  it('treats empty values as not given', () => {
    expect(parseSandboxQuery({ runId: '', status: '', before: '', limit: '' })).toEqual({ ok: true, value: { limit: 50 } });
  });
});
