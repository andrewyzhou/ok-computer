import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseConfig } from '../config/load.js';
import { openDb } from '../db/index.js';
import { createBlobStore } from '../observability/blobs.js';
import { silentLogger } from '../observability/logger.js';
import { DEFAULT_LIMITS, LABELS, MAX_LIMITS, PROBE_TIMEOUT_MS, SANDBOX_IMAGE, STALE_MARGIN_MS } from './limits.js';
import { createSandbox, instanceOf } from './sandbox.js';
import { STALE_ERROR, startExec } from './store.js';
import type { DockerClient, NetworkGate } from './types.js';

// the start of the sandbox with the real sweeps of runner.ts and network.ts, a docker that hangs, and a docker host
// that the sandbox cannot use. in each case the rest of the app must go on.

const now = new Date('2026-10-18T10:00:00Z');
const clock = () => now;
const savedHost = process.env.DOCKER_HOST;

afterEach(() => {
  if (savedHost === undefined) delete process.env.DOCKER_HOST;
  else process.env.DOCKER_HOST = savedHost;
});

function config() {
  const dir = mkdtempSync(join(tmpdir(), 'okc-sandbox-edge-'));
  const parsed = parseConfig({ paths: { workspace: dir, data: join(dir, 'data') } });
  if (!parsed.ok) throw new Error(parsed.error);
  return { dir, config: parsed.value };
}

const network: NetworkGate = { check: async () => ({ ok: true }), open: async () => Promise.reject(new Error('no network')) };

describe('the start sweep with the real sweeps', () => {
  it('keeps the container and network of a fresh running exec, and removes the rest of this instance', async () => {
    const { dir, config: cfg } = config();
    const db = openDb(':memory:');
    const instance = instanceOf(cfg.paths.data);
    const base = { runId: 'r', toolCallId: 'c', sessionKey: 'main', taskId: 't', language: 'bash' as const, command: 'sleep 9', image: SANDBOX_IMAGE, cwd: '/work', network: 'none' as const, allowlist: [], limits: DEFAULT_LIMITS };
    const stale = startExec(db, base, new Date(now.getTime() - MAX_LIMITS.timeoutMs - STALE_MARGIN_MS - 1_000));
    const fresh = startExec(db, base, new Date(now.getTime() - 1_000));
    const removedContainers: string[] = [];
    const removedNetworks: string[] = [];
    const labels = (exec: string) => ({ [LABELS.sandbox]: '1', [LABELS.instance]: instance, [LABELS.exec]: exec });
    const docker = {
      info: async () => ({ engine: 'docker 28.3.0 (linux/arm64)', os: 'linux', arch: 'arm64' }),
      imageId: async () => 'sha256:img',
      listContainers: async () => [
        { id: 'fresh', labels: labels(String(fresh)), createdAt: '' },
        { id: 'stale', labels: labels(String(stale)), createdAt: '' },
        { id: 'unlabelled', labels: { [LABELS.sandbox]: '1', [LABELS.instance]: instance }, createdAt: '' },
      ],
      removeContainer: async (id: string) => void removedContainers.push(id),
      listNetworks: async () => [
        { name: 'net-fresh', labels: labels(String(fresh)) },
        { name: 'net-stale', labels: labels(String(stale)) },
        { name: 'net-probe', labels: labels('probe') },
        { name: 'net-other', labels: { ...labels(String(fresh)), [LABELS.instance]: 'someone-else' } },
      ],
      removeNetwork: async (name: string) => void removedNetworks.push(name),
    } as unknown as DockerClient;
    const sandbox = createSandbox({
      db,
      blobs: createBlobStore(db, join(dir, 'blobs'), clock),
      logger: silentLogger,
      clock,
      config: cfg,
      enabled: true,
      docker,
      network,
      runner: { run: async () => Promise.reject(new Error('not expected')) },
      scratch: { volumeFor: async () => ({ taskId: 't', volume: 'v' }), afterExec: async () => ({ reset: false }), sweep: async () => 0 },
    });
    await sandbox.start();
    expect(removedContainers.sort()).toEqual(['stale', 'unlabelled']);
    expect(removedNetworks.sort()).toEqual(['net-probe', 'net-stale']);
    const rows = db.prepare('SELECT id, status, error FROM sandbox_execs ORDER BY id').all();
    expect(rows).toEqual([
      { id: stale, status: 'error', error: STALE_ERROR },
      { id: fresh, status: 'running', error: null },
    ]);
    expect(sandbox.toolsFor('main')).toEqual(['sandbox_exec']);
  });

  it('does not throw when the sweep fails, and keeps the tool on', async () => {
    const { dir, config: cfg } = config();
    const db = openDb(':memory:');
    const docker = {
      info: async () => ({ engine: 'docker 28', os: 'linux', arch: 'arm64' }),
      imageId: async () => 'sha256:img',
      listContainers: async () => Promise.reject(new Error('list broke')),
    } as unknown as DockerClient;
    const sandbox = createSandbox({
      db,
      blobs: createBlobStore(db, join(dir, 'blobs'), clock),
      logger: silentLogger,
      clock,
      config: cfg,
      enabled: true,
      docker,
      network,
      runner: { run: async () => Promise.reject(new Error('not expected')) },
      scratch: { volumeFor: async () => ({ taskId: 't', volume: 'v' }), afterExec: async () => ({ reset: false }), sweep: async () => 0 },
    });
    await expect(sandbox.start()).resolves.toBeUndefined();
    expect(sandbox.toolsFor('main')).toEqual(['sandbox_exec']);
    expect(sandbox.toolsFor('sub:research:run-2')).toEqual([]);
  });
});

describe('a docker that the sandbox cannot use', () => {
  it('turns the tool off with the reason for a DOCKER_HOST it cannot use, and still answers the status', async () => {
    process.env.DOCKER_HOST = 'ssh://someone@far.example';
    const { dir, config: cfg } = config();
    const db = openDb(':memory:');
    const sandbox = createSandbox({ db, blobs: createBlobStore(db, join(dir, 'blobs'), clock), logger: silentLogger, clock, config: cfg, enabled: true });
    expect(sandbox.tools).toEqual([]);
    await sandbox.start();
    expect(sandbox.toolsFor('main')).toEqual([]);
    const status = await sandbox.status();
    expect(status.available).toBe(false);
    expect(status.reason).toContain('DOCKER_HOST');
    expect(status.network).toBe(false);
    expect(status.image).toBe(SANDBOX_IMAGE);
    expect(status.defaults).toEqual(DEFAULT_LIMITS);
  });

  it('ends the probe of a docker that never answers within the probe time', async () => {
    const { dir, config: cfg } = config();
    const db = openDb(':memory:');
    const docker = {
      info: (signal?: AbortSignal) => new Promise((_, reject) => signal?.addEventListener('abort', () => reject(new Error('the probe timed out')))),
      imageId: async () => 'sha256:img',
    } as unknown as DockerClient;
    const sandbox = createSandbox({
      db,
      blobs: createBlobStore(db, join(dir, 'blobs'), clock),
      logger: silentLogger,
      clock,
      config: cfg,
      enabled: true,
      docker,
      network,
      runner: { run: async () => Promise.reject(new Error('not expected')) },
      scratch: { volumeFor: async () => ({ taskId: 't', volume: 'v' }), afterExec: async () => ({ reset: false }), sweep: async () => 0 },
    });
    const started = performance.now();
    await sandbox.start();
    expect(performance.now() - started).toBeLessThan(PROBE_TIMEOUT_MS + 2_000);
    expect(sandbox.toolsFor('main')).toEqual([]);
    expect((await sandbox.status()).reason).toContain('docker does not answer');
  }, 15_000);
});
