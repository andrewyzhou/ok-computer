import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseConfig } from '../config/load.js';
import { openDb, type Db } from '../db/index.js';
import { createBlobStore } from '../observability/blobs.js';
import { silentLogger } from '../observability/logger.js';
import { DEFAULT_LIMITS, MAX_LIMITS, SANDBOX_IMAGE, STALE_MARGIN_MS, STATUS_TTL_MS } from './limits.js';
import { createSandbox, instanceOf, SANDBOX_TOOLS } from './sandbox.js';
import { STALE_ERROR, startExec } from './store.js';
import { SANDBOX_EXEC } from './tool.js';
import type { DockerClient, NetworkGate } from './types.js';

// the container sweep belongs to runner.ts and the network sweep to network.ts. the fakes record their calls, so a
// test sees that the start sweeps, and in which order.
const sweeps = vi.hoisted(() => ({ containers: [] as string[], networks: [] as string[], order: [] as string[] }));
vi.mock('./runner.js', async (original) => ({
  ...(await original<typeof import('./runner.js')>()),
  sweepContainers: async (_docker: unknown, instance: string) => {
    sweeps.containers.push(instance);
    sweeps.order.push('containers');
    return 0;
  },
}));
vi.mock('./network.js', async (original) => ({
  ...(await original<typeof import('./network.js')>()),
  sweepNetworks: async (_docker: unknown, instance: string) => {
    sweeps.networks.push(instance);
    sweeps.order.push('networks');
    return 0;
  },
}));

const start = new Date('2026-10-18T10:00:00Z');
const clock = () => start;

afterEach(() => {
  vi.restoreAllMocks();
  sweeps.containers.length = 0;
  sweeps.networks.length = 0;
  sweeps.order.length = 0;
});

// only info and imageId matter for the probe. the other methods throw, so a test sees an unexpected call.
function fakeDocker(state: { up: boolean; image: string | null }) {
  const calls = { info: 0 };
  const unexpected = () => {
    throw new Error('not expected in this test');
  };
  const docker = new Proxy({} as DockerClient, {
    get(_target, key) {
      if (key === 'info')
        return async () => {
          calls.info++;
          if (!state.up) throw new Error('connect ENOENT /var/run/docker.sock');
          return { engine: 'docker 28.3.0 (linux/arm64)', os: 'linux', arch: 'arm64' };
        };
      if (key === 'imageId') return async () => state.image;
      if (key === 'then') return undefined;
      return unexpected;
    },
  });
  return { docker, calls };
}

function setup(state: { up: boolean; image: string | null }, options: { enabled?: boolean; db?: Db } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'okc-sandbox-'));
  const parsed = parseConfig({ paths: { workspace: dir, data: join(dir, 'data') } });
  if (!parsed.ok) throw new Error(parsed.error);
  const db = options.db ?? openDb(':memory:');
  const { docker, calls } = fakeDocker(state);
  const network: NetworkGate = { check: async () => ({ ok: false, reason: 'the proxy is off' }), open: async () => Promise.reject(new Error('no network')) };
  const scratch = { volumeFor: vi.fn(), afterExec: vi.fn(), sweep: vi.fn(async () => 0) };
  const sandbox = createSandbox({
    db,
    blobs: createBlobStore(db, join(dir, 'data', 'blobs'), clock),
    logger: silentLogger,
    clock,
    config: parsed.value,
    enabled: options.enabled ?? true,
    docker,
    runner: { run: vi.fn() },
    network,
    scratch,
  });
  return { sandbox, calls, db, scratch, instance: instanceOf(parsed.value.paths.data) };
}

describe('the code sandbox', () => {
  it('has no tool and is off when the process did not set it up', async () => {
    const { sandbox, calls } = setup({ up: true, image: 'sha256:img' }, { enabled: false });
    expect(sandbox.tools).toEqual([]);
    await sandbox.start();
    expect(sandbox.toolsFor('main')).toEqual([]);
    expect(await sandbox.status()).toEqual({
      available: false,
      reason: 'the code sandbox is not set up in this process',
      engine: null,
      image: SANDBOX_IMAGE,
      defaults: DEFAULT_LIMITS,
      network: false,
      networkReason: 'the code sandbox is not set up in this process',
    });
    expect(calls.info).toBe(0);
  });

  it('is off with the reason when the image is missing', async () => {
    const { sandbox, scratch } = setup({ up: true, image: null });
    expect(sandbox.tools.map((tool) => tool.name)).toEqual([SANDBOX_EXEC]);
    await sandbox.start();
    expect(sandbox.toolsFor('main')).toEqual([]);
    const status = await sandbox.status();
    expect(status).toMatchObject({ available: false, engine: 'docker 28.3.0 (linux/arm64)', network: false });
    expect(status.reason).toBe(`the image ${SANDBOX_IMAGE} is missing. Build it with npm run sandbox:image`);
    // nothing is swept while docker cannot run the tool.
    expect(scratch.sweep).not.toHaveBeenCalled();
    expect(sweeps.containers).toEqual([]);
    expect(sweeps.networks).toEqual([]);
  });

  it('is off with the reason when docker does not answer', async () => {
    const { sandbox } = setup({ up: false, image: 'sha256:img' });
    await sandbox.start();
    expect(sandbox.toolsFor('main')).toEqual([]);
    expect(await sandbox.status()).toMatchObject({ available: false, engine: null, reason: 'docker does not answer: connect ENOENT /var/run/docker.sock' });
  });

  it('is on for the main session and automations when docker and the image answer', async () => {
    const { sandbox, scratch, instance } = setup({ up: true, image: 'sha256:img' });
    await sandbox.start();
    expect(sandbox.toolsFor('main')).toEqual(SANDBOX_TOOLS);
    expect(sandbox.toolsFor('auto:goals')).toEqual(SANDBOX_TOOLS);
    expect(sandbox.toolsFor('sub:inbox:run-1')).toEqual([]);
    expect(sandbox.toolsFor('telegram:42')).toEqual([]);
    expect(await sandbox.status()).toEqual({
      available: true,
      reason: null,
      engine: 'docker 28.3.0 (linux/arm64)',
      image: SANDBOX_IMAGE,
      defaults: DEFAULT_LIMITS,
      network: false,
      networkReason: 'the proxy is off',
    });
    expect(scratch.sweep).toHaveBeenCalledOnce();
    expect(sweeps.containers).toEqual([instance]);
    // the relay containers go first, so their networks are free to remove.
    expect(sweeps.networks).toEqual([instance]);
    expect(sweeps.order).toEqual(['containers', 'networks']);
  });

  it('keeps the tool list of the start, and probes again only after the status ttl', async () => {
    let at = 1_000;
    vi.spyOn(performance, 'now').mockImplementation(() => at);
    const state = { up: true, image: 'sha256:img' as string | null };
    const { sandbox, calls } = setup(state);
    await sandbox.start();
    expect(calls.info).toBe(1);

    // docker goes down. the status keeps the last answer until the ttl ends.
    state.up = false;
    at += STATUS_TTL_MS - 1;
    expect((await sandbox.status()).available).toBe(true);
    expect(calls.info).toBe(1);
    at += 2;
    expect((await sandbox.status()).available).toBe(false);
    expect(calls.info).toBe(2);
    // the tools parameter of a session does not change while the app runs.
    expect(sandbox.toolsFor('main')).toEqual(SANDBOX_TOOLS);

    // the tool sees the new probe and refuses with effect none.
    const output = await sandbox.tools[0]!.run(
      { language: 'bash', code: 'ls' },
      { runId: 'r', sessionKey: 'main', timeZone: 'UTC', clock, signal: new AbortController().signal },
    );
    expect(output).toMatchObject({ isError: true, effect: 'none', content: expect.stringContaining('The code sandbox is off: docker does not answer') });
  });

  it('does not add the tool when docker comes up after the start', async () => {
    let at = 1_000;
    vi.spyOn(performance, 'now').mockImplementation(() => at);
    const state = { up: false, image: 'sha256:img' as string | null };
    const { sandbox } = setup(state);
    await sandbox.start();
    state.up = true;
    at += STATUS_TTL_MS + 1;
    expect((await sandbox.status()).available).toBe(true);
    expect(sandbox.toolsFor('main')).toEqual([]);
  });

  it('closes the running rows of a stopped app at the start, also when docker is off', async () => {
    const db = openDb(':memory:');
    const exec = {
      runId: 'run-0',
      toolCallId: 'c0',
      sessionKey: 'main',
      taskId: 't',
      language: 'bash' as const,
      command: 'sleep 1000',
      image: SANDBOX_IMAGE,
      cwd: '/work',
      network: 'none' as const,
      allowlist: [],
      limits: DEFAULT_LIMITS,
    };
    const old = startExec(db, exec, new Date(start.getTime() - MAX_LIMITS.timeoutMs - STALE_MARGIN_MS - 1));
    // a row of another process that may still run (npm run chat next to the service) is kept.
    const recent = startExec(db, exec, new Date(start.getTime() - 1_000));
    const { sandbox } = setup({ up: false, image: null }, { db });
    await sandbox.start();
    expect(db.prepare('SELECT id, status, error FROM sandbox_execs ORDER BY id').all()).toEqual([
      { id: old, status: 'error', error: STALE_ERROR },
      { id: recent, status: 'running', error: null },
    ]);
  });
});
