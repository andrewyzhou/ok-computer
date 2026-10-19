import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openDb, type Db } from '../db/index.js';
import { createBlobStore, sha256 } from '../observability/blobs.js';
import { createByteStore } from '../observability/byte-blobs.js';
import { silentLogger } from '../observability/logger.js';
import type { ToolContext } from '../tools/registry.js';
import type { FileStores } from './files.js';
import type { SandboxExecInput } from './input.js';
import { DEFAULT_LIMITS, LABELS, MAX_LIMITS, WORK_DIR } from './limits.js';
import type { Scratch } from './scratch.js';
import { createSandboxExecTool, SANDBOX_EXEC } from './tool.js';
import type { ExecRequest, ExecResult, NetworkGate, NetworkPlan, Probe, Runner } from './types.js';

// files.ts, network.ts and the command of runner.ts belong to other parts of the sandbox. the fakes here keep their
// contracts: a file in gets a row with its blob, and a collected file goes to the text store.
vi.mock('./files.js', () => ({
  checkPath: (path: string) => (path.split('/').includes('..') ? 'a path cannot have a .. segment' : undefined),
  resolveInputs: (files: Array<{ path: string; content?: string; blob?: string }>, stores: FileStores) => {
    if (files.some((file) => file.blob === 'f'.repeat(64))) return { ok: false, reason: 'the blob ffff is not in the store' };
    const resolved = files.map((file) => ({ path: file.path, bytes: Buffer.from(file.content ?? '') }));
    return {
      ok: true,
      files: resolved,
      rows: resolved.map((file) => ({ direction: 'in', path: file.path, blob: stores.blobs.put(file.bytes.toString()), size: file.bytes.length, mime: 'text/plain' })),
    };
  },
  storeOutputs: (files: Array<{ path: string; bytes: Buffer }>, stores: FileStores) =>
    files.map((file) => ({ direction: 'out', path: file.path, blob: stores.blobs.put(file.bytes.toString()), size: file.bytes.length, mime: 'text/csv' })),
}));
vi.mock('./network.js', () => ({
  checkAllowlist: (allow: string[]) => (allow.includes('com') ? 'com is too broad' : undefined),
}));
vi.mock('./runner.js', () => ({
  commandFor: (language: string, code: string) => (language === 'python' ? ['python3', '-c', code] : language === 'node' ? ['node', '-e', code] : ['bash', '-c', code]),
}));

const now = new Date('2026-10-18T10:00:00Z');
const clock = () => now;

const result = (over: Partial<ExecResult> = {}): ExecResult => ({
  status: 'ok',
  exitCode: 0,
  stdout: Buffer.from('hello\n'),
  stderr: Buffer.alloc(0),
  stdoutBytes: 6,
  stderrBytes: 0,
  truncated: false,
  collected: [],
  notCollected: [],
  containerId: 'cafe',
  imageId: 'sha256:img',
  durationMs: 1234,
  error: null,
  scratchBytes: 4096,
  ...over,
});

interface Setup {
  db: Db;
  stores: FileStores;
  runner: Runner & { run: ReturnType<typeof vi.fn> };
  scratch: Scratch & { afterExec: ReturnType<typeof vi.fn>; sweep: ReturnType<typeof vi.fn> };
  plan: NetworkPlan & { close: ReturnType<typeof vi.fn> };
  network: NetworkGate & { check: ReturnType<typeof vi.fn>; open: ReturnType<typeof vi.fn> };
  probe: { current: Probe };
  live: Set<number>;
  tool: ReturnType<typeof createSandboxExecTool>;
}

let t: Setup;

function setup(run: (request: ExecRequest) => Promise<ExecResult> = async () => result()): Setup {
  const db = openDb(':memory:');
  const dir = mkdtempSync(join(tmpdir(), 'okc-sandbox-tool-'));
  const stores = { blobs: createBlobStore(db, join(dir, 'blobs'), clock), bytes: createByteStore(db, join(dir, 'blobs'), clock) };
  const runner = { run: vi.fn(run) };
  const scratch = {
    volumeFor: vi.fn(async () => ({ taskId: 'task-1', volume: 'okc-scratch-task-1' })),
    afterExec: vi.fn(async () => ({ reset: false })),
    sweep: vi.fn(async () => 0),
  };
  const plan = {
    networkMode: 'okc-net-1',
    env: ['HTTP_PROXY=http://okc-proxy:3128', 'HTTPS_PROXY=http://okc-proxy:3128'],
    extraHosts: ['okc-proxy:10.0.0.2'],
    passed: () => ['pypi.org', 'files.pythonhosted.org'],
    refused: () => [{ target: 'evil.example:443', reason: 'not in the allowlist' }],
    close: vi.fn(async () => {}),
  };
  const network = { check: vi.fn(async () => ({ ok: true as const })), open: vi.fn(async () => plan) };
  const probe = { current: { available: true, reason: null, engine: 'docker 28.3.0 (linux/arm64)', imageId: 'sha256:img' } as Probe };
  const live = new Set<number>();
  const tool = createSandboxExecTool({
    db,
    stores,
    runner,
    scratch,
    network,
    logger: silentLogger,
    clock,
    image: 'okc-sandbox:1',
    probe: () => probe.current,
    live,
  });
  return { db, stores, runner, scratch, plan, network, probe, live, tool };
}

const ctx = (signal = new AbortController().signal): ToolContext => ({ runId: 'run-1', sessionKey: 'main', timeZone: 'UTC', clock, signal, toolCallId: 'c1' });
const run = (input: SandboxExecInput, context = ctx()) => t.tool.run(t.tool.input.parse(input), context);
const execs = () => t.db.prepare('SELECT * FROM sandbox_execs ORDER BY id').all();

beforeEach(() => {
  t = setup();
});

describe('sandbox_exec', () => {
  it('has the name, the risk, the source and a description with the limits', () => {
    expect(t.tool.name).toBe(SANDBOX_EXEC);
    expect(t.tool.risk).toBe('exec');
    expect(t.tool.source).toBe('sandbox');
    expect(t.tool.fullFields).toBeUndefined();
    const parse = (input: unknown) => t.tool.input.parse(input);
    expect(t.tool.riskFor?.(parse({ language: 'bash', code: 'ls' }))).toBe('exec');
    expect(t.tool.riskFor?.(parse({ language: 'bash', code: 'pip download x', network: { allow: ['pypi.org'] } }))).toBe('external');
    for (const part of ['fresh Linux container', 'python3', 'node', 'bash', '/new', 'network.allow', 'approves', 'blob', 'collect']) {
      expect(t.tool.description).toContain(part);
    }
    expect(t.tool.description).toContain(`${DEFAULT_LIMITS.memoryMb} MB`);
    expect(t.tool.description).toContain(`${MAX_LIMITS.memoryMb} MB`);
    expect(t.tool.description).toContain(`${MAX_LIMITS.timeoutMs / 1000} s`);
  });

  it('gives an error with effect none when docker is off', async () => {
    t.probe.current = { available: false, reason: 'docker does not answer: connect ENOENT', engine: null, imageId: null };
    expect(await run({ language: 'bash', code: 'ls' })).toEqual({
      content: 'The code sandbox is off: docker does not answer: connect ENOENT',
      isError: true,
      effect: 'none',
    });
    expect(t.runner.run).not.toHaveBeenCalled();
    expect(execs()).toEqual([]);
  });

  it('runs at most two commands at the same time', async () => {
    const gates: Array<() => void> = [];
    t = setup(
      (request) =>
        new Promise((resolve) => {
          gates.push(() => resolve(result({ stdout: Buffer.from(`exec ${request.execId}`), stdoutBytes: 6 })));
        }),
    );
    const one = run({ language: 'bash', code: 'sleep 1' });
    const two = run({ language: 'bash', code: 'sleep 1' });
    // the third call starts before the first two reach the runner, and the limit still holds.
    expect(await run({ language: 'bash', code: 'sleep 1' })).toEqual({
      content: 'Two sandbox commands run now. Wait for a result, then try again.',
      isError: true,
      effect: 'none',
    });
    await vi.waitFor(() => expect(gates).toHaveLength(2));
    expect(t.live.size).toBe(2);
    for (const open of gates) open();
    await Promise.all([one, two]);
    expect(t.live.size).toBe(0);
    // the refused call has no row, and the two others ended.
    expect(execs().map((row) => (row as { status: string }).status)).toEqual(['ok', 'ok']);
  });

  it('runs a command and keeps the row, the blobs, the files and the text', async () => {
    t = setup(async () =>
      result({
        stdout: Buffer.from('rows: 2\n'),
        stdoutBytes: 8,
        stderr: Buffer.from('warning: old pandas\n'),
        stderrBytes: 20,
        collected: [{ path: 'out/sum.csv', bytes: Buffer.from('a,b\n1,2\n') }],
        notCollected: [{ path: 'missing.txt', reason: 'it does not exist' }],
      }),
    );
    const output = await run({
      language: 'python',
      code: 'import pandas',
      files: [{ path: 'data/in.csv', content: 'a,b\n1,2\n' }],
      collect: ['out/sum.csv', 'missing.txt'],
      timeoutMs: 120_000,
    });
    const request = t.runner.run.mock.calls[0]![0] as ExecRequest;
    expect(request).toMatchObject({
      execId: 1,
      image: 'okc-sandbox:1',
      argv: ['python3', '-c', 'import pandas'],
      env: [],
      limits: { ...DEFAULT_LIMITS, timeoutMs: 120_000 },
      volume: 'okc-scratch-task-1',
      files: [{ path: 'data/in.csv', bytes: Buffer.from('a,b\n1,2\n') }],
      collect: ['out/sum.csv', 'missing.txt'],
      labels: { [LABELS.task]: 'task-1' },
    });
    expect(request.network).toBeUndefined();
    expect(t.scratch.volumeFor).toHaveBeenCalledWith('main');
    expect(t.scratch.afterExec).toHaveBeenCalledWith('task-1', 4096);

    const csv = sha256('a,b\n1,2\n');
    expect(output).toEqual({
      content: [
        'Exit code 0 (ok) in 1.2 s. Sandbox exec 1.',
        'stdout (8 bytes):',
        'rows: 2\n',
        'stderr (20 bytes):',
        'warning: old pandas\n',
        'Files:',
        `- out/sum.csv (text/csv, 8 bytes): blob ${csv}`,
        'Not collected:',
        '- missing.txt: it does not exist',
      ].join('\n'),
    });

    expect(execs()).toEqual([
      expect.objectContaining({
        id: 1,
        runId: 'run-1',
        toolCallId: 'c1',
        sessionKey: 'main',
        taskId: 'task-1',
        language: 'python',
        command: 'import pandas',
        image: 'okc-sandbox:1',
        imageId: 'sha256:img',
        cwd: WORK_DIR,
        network: 'none',
        allowlist: '[]',
        status: 'ok',
        exitCode: 0,
        containerId: 'cafe',
        stdoutBlob: sha256('rows: 2\n'),
        stderrBlob: sha256('warning: old pandas\n'),
        stdoutBytes: 8,
        stderrBytes: 20,
        truncated: 0,
        error: null,
        durationMs: 1234,
        endedAt: now.toISOString(),
      }),
    ]);
    expect(JSON.parse(String((execs()[0] as { limits: string }).limits))).toEqual({ ...DEFAULT_LIMITS, timeoutMs: 120_000 });
    expect(t.stores.blobs.read(sha256('rows: 2\n'))).toBe('rows: 2\n');
    expect(t.db.prepare('SELECT direction, path, blob, size FROM sandbox_files ORDER BY id').all()).toEqual([
      { direction: 'in', path: 'data/in.csv', blob: csv, size: 8 },
      { direction: 'out', path: 'out/sum.csv', blob: csv, size: 8 },
    ]);
    expect(t.live.size).toBe(0);
  });

  it('keeps no blob for an empty stream and says when the output was cut or /work was reset', async () => {
    t = setup(async () => result({ stdout: Buffer.from('x'.repeat(10)), stdoutBytes: 5_000, truncated: true, exitCode: 3, status: 'failed' }));
    t.scratch.afterExec.mockResolvedValueOnce({ reset: true });
    const output = await run({ language: 'bash', code: 'yes x' });
    expect(output.isError).toBe(true);
    expect(output.effect).toBeUndefined();
    expect(output.content.split('\n')).toEqual([
      'Exit code 3 (failed) in 1.2 s. Sandbox exec 1.',
      'stdout (5000 bytes, cut to 10):',
      'x'.repeat(10),
      'stderr (0 bytes).',
      '/work was over 256 MB, so it is empty again.',
    ]);
    expect(execs()[0]).toMatchObject({ status: 'failed', exitCode: 3, stderrBlob: null, truncated: 1, stdoutBytes: 5000 });
  });

  it('says why a command timed out or ran out of memory', async () => {
    t = setup(async () => result({ status: 'timeout', exitCode: null, stdout: Buffer.alloc(0), stdoutBytes: 0, error: 'the command ran longer than 60 s', durationMs: 60_000 }));
    const slow = await run({ language: 'bash', code: 'sleep 100' });
    expect(slow.isError).toBe(true);
    expect(slow.effect).toBeUndefined();
    expect(slow.content.split('\n')[0]).toBe('Timeout after 60.0 s: the command ran longer than 60 s. Sandbox exec 1.');
    expect(execs()[0]).toMatchObject({ status: 'timeout', exitCode: null, error: 'the command ran longer than 60 s' });

    t = setup(async () =>
      result({ status: 'killed', exitCode: 137, stdout: Buffer.alloc(0), stdoutBytes: 0, error: 'the command used more than its 512 MB of memory', durationMs: 800 }),
    );
    const big = await run({ language: 'python', code: 'x = bytearray(10**10)' });
    expect(big.isError).toBe(true);
    expect(big.content.split('\n')[0]).toBe('Killed after 0.8 s: the command used more than its 512 MB of memory. Sandbox exec 1.');
  });

  it('gives effect none when docker never ran the command', async () => {
    t = setup(async () =>
      result({ status: 'error', exitCode: null, containerId: null, imageId: null, stdout: Buffer.alloc(0), stdoutBytes: 0, error: 'no such image: okc-sandbox:1' }),
    );
    const output = await run({ language: 'node', code: 'console.log(1)' });
    expect(output).toMatchObject({ isError: true, effect: 'none' });
    expect(output.content.split('\n')[0]).toBe('Error after 1.2 s: no such image: okc-sandbox:1. Sandbox exec 1.');
    expect(execs()[0]).toMatchObject({ status: 'error', containerId: null, error: 'no such image: okc-sandbox:1' });
  });

  it('closes the row when the runner throws', async () => {
    t = setup(async () => {
      throw new Error('socket hang up');
    });
    const output = await run({ language: 'bash', code: 'ls' });
    expect(output).toEqual({ content: 'sandbox_exec failed while it ran: socket hang up. Sandbox exec 1.', isError: true, effect: 'unknown' });
    expect(execs()[0]).toMatchObject({ status: 'error', error: 'socket hang up' });
    expect(t.live.size).toBe(0);
  });

  it('refuses bad files, collect paths and allowlists before it writes a row', async () => {
    expect(await run({ language: 'bash', code: 'ls', files: [{ path: 'a.bin', blob: 'f'.repeat(64) }] })).toMatchObject({
      content: expect.stringContaining('the blob ffff is not in the store'),
      effect: 'none',
    });
    expect(await run({ language: 'bash', code: 'ls', collect: ['a/../../etc'] })).toMatchObject({ content: expect.stringContaining('..'), effect: 'none' });
    expect(await run({ language: 'bash', code: 'ls', network: { allow: ['com'] } })).toMatchObject({ content: expect.stringContaining('too broad'), effect: 'none' });
    t.network.check.mockResolvedValueOnce({ ok: false, reason: 'the proxy is not running' });
    expect(await run({ language: 'bash', code: 'ls', network: { allow: ['pypi.org'] } })).toMatchObject({
      content: expect.stringContaining('the proxy is not running'),
      effect: 'none',
    });
    expect(execs()).toEqual([]);
    expect(t.runner.run).not.toHaveBeenCalled();
  });

  it('marks a call with network as outside text and closes its plan', async () => {
    const output = await run({ language: 'bash', code: 'pip download requests', network: { allow: ['pypi.org', 'files.pythonhosted.org'] } });
    expect(output.untrustedSource).toBe('sandbox:network (pypi.org, files.pythonhosted.org)');
    expect(output.content).toContain('Network: reached pypi.org, files.pythonhosted.org; refused evil.example:443 (not in the allowlist).');
    expect(t.network.open).toHaveBeenCalledWith(1, ['pypi.org', 'files.pythonhosted.org']);
    const request = t.runner.run.mock.calls[0]![0] as ExecRequest;
    expect(request.network).toBe(t.plan);
    expect(request.env).toEqual(t.plan.env);
    expect(t.plan.close).toHaveBeenCalledOnce();
    expect(execs()[0]).toMatchObject({ network: 'allowlist', allowlist: '["pypi.org","files.pythonhosted.org"]' });

    // a call without network is not outside text.
    expect((await run({ language: 'bash', code: 'ls' })).untrustedSource).toBeUndefined();
  });

  it('closes the plan also when the runner throws', async () => {
    t = setup(async () => {
      throw new Error('boom');
    });
    const output = await run({ language: 'bash', code: 'curl x', network: { allow: ['pypi.org'] } });
    expect(output.isError).toBe(true);
    expect(output.untrustedSource).toBe('sandbox:network (pypi.org)');
    expect(t.plan.close).toHaveBeenCalledOnce();
  });

  it('gives the abort to the runner, which kills the container', async () => {
    t = setup(
      (request) =>
        new Promise((resolve) => {
          request.signal.addEventListener('abort', () =>
            resolve(result({ status: 'killed', exitCode: null, stdout: Buffer.alloc(0), stdoutBytes: 0, error: 'the run stopped, so the container was killed' })),
          );
        }),
    );
    const stop = new AbortController();
    const pending = run({ language: 'bash', code: 'sleep 1000' }, ctx(stop.signal));
    await vi.waitFor(() => expect(t.runner.run).toHaveBeenCalled());
    expect(execs()[0]).toMatchObject({ status: 'running' });
    stop.abort();
    const output = await pending;
    expect(output.isError).toBe(true);
    expect(output.content.split('\n')[0]).toBe('Killed after 1.2 s: the run stopped, so the container was killed. Sandbox exec 1.');
    expect(execs()[0]).toMatchObject({ status: 'killed' });
    expect(t.live.size).toBe(0);
  });
});
