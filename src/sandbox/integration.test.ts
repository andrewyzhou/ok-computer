import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { afterAll, describe, expect, it } from 'vitest';
import type { SandboxLanguage, SandboxLimits } from '../dashboard/types.js';
import { createLogger } from '../observability/logger.js';
import { createDockerClient, endpointOf } from './docker.js';
import { DEFAULT_LIMITS, LABELS, SANDBOX_IMAGE } from './limits.js';
import { commandFor, createRunner } from './runner.js';
import type { DockerClient, ExecRequest, ExecResult } from './types.js';

// this is the only test that talks to a real docker daemon. it runs when a daemon answers and the image is built (npm
// run sandbox:image), and it skips with the reason otherwise, so it never fails on a machine without docker.

async function probe(): Promise<{ docker: DockerClient; reason: null } | { docker: null; reason: string }> {
  const found = endpointOf(process.env, process.platform, homedir(), existsSync);
  if ('error' in found) return { docker: null, reason: found.error };
  const docker = createDockerClient(found);
  try {
    await docker.info(AbortSignal.timeout(2000));
    const image = await docker.imageId(SANDBOX_IMAGE, AbortSignal.timeout(2000));
    if (!image) return { docker: null, reason: `the image ${SANDBOX_IMAGE} is missing. Build it with npm run sandbox:image` };
    return { docker, reason: null };
  } catch (err) {
    return { docker: null, reason: `docker does not answer: ${err instanceof Error ? err.message : String(err)}` };
  }
}

const found = await probe();
const title = found.reason === null ? 'the sandbox with a real docker daemon' : `the sandbox with a real docker daemon (skipped: ${found.reason})`;

describe.skipIf(found.docker === null)(title, () => {
  const docker = found.docker!;
  // a fresh instance per test run, so the cleanup touches only the objects of this run.
  const instance = `test-${randomBytes(4).toString('hex')}`;
  const volume = `okc-work-${instance}-shared`;
  const runner = createRunner({ docker, logger: createLogger({ consoleLevel: 'off' }), instance });
  let execId = 0;
  let volumeMade = false;

  async function run(language: SandboxLanguage, code: string, over: Partial<Omit<ExecRequest, 'limits'>> & { limits?: Partial<SandboxLimits> } = {}): Promise<ExecResult> {
    if (!volumeMade) {
      await docker.createVolume(volume, { [LABELS.sandbox]: '1', [LABELS.instance]: instance });
      volumeMade = true;
    }
    const { limits, ...rest } = over;
    return runner.run({
      execId: ++execId,
      image: SANDBOX_IMAGE,
      argv: commandFor(language, code),
      env: [],
      volume,
      files: [],
      collect: [],
      labels: {},
      signal: new AbortController().signal,
      ...rest,
      limits: { ...DEFAULT_LIMITS, timeoutMs: 20_000, ...limits },
    });
  }

  afterAll(async () => {
    for (const container of await docker.listContainers(`${LABELS.instance}=${instance}`)) await docker.removeContainer(container.id);
    for (const left of await docker.listVolumes(`${LABELS.instance}=${instance}`)) await docker.removeVolume(left.name);
  });

  it('runs python and node with stdout and stderr', { timeout: 60_000 }, async () => {
    const python = await run('python', 'import sys\nprint("py out")\nprint("py err", file=sys.stderr)');
    expect(python).toMatchObject({ status: 'ok', exitCode: 0 });
    expect(python.stdout.toString()).toBe('py out\n');
    expect(python.stderr.toString()).toBe('py err\n');
    expect(python.imageId).toMatch(/^sha256:/);

    const node = await run('node', 'console.log("js out"); console.error("js err")');
    expect(node).toMatchObject({ status: 'ok', exitCode: 0 });
    expect(node.stdout.toString()).toBe('js out\n');
    expect(node.stderr.toString()).toBe('js err\n');
  });

  it('runs as a user that is not root', { timeout: 60_000 }, async () => {
    const result = await run('bash', 'id -u');
    expect(result.status).toBe('ok');
    expect(result.stdout.toString().trim()).not.toBe('0');
  });

  it('has a read-only root filesystem', { timeout: 60_000 }, async () => {
    const result = await run('bash', 'touch /should-not-exist');
    expect(result.status).toBe('failed');
    expect(result.stderr.toString()).toMatch(/read-only/i);
  });

  it('has no network', { timeout: 60_000 }, async () => {
    const code = [
      'import socket',
      'try:',
      "    socket.create_connection(('1.1.1.1', 443), timeout=3)",
      "    print('connected')",
      'except OSError:',
      "    print('blocked')",
    ].join('\n');
    const result = await run('python', code);
    expect(result.status).toBe('ok');
    expect(result.stdout.toString().trim()).toBe('blocked');
  });

  it('stops a fork bomb at the pids limit', { timeout: 60_000 }, async () => {
    const code = [
      'import os, time',
      'for i in range(1000):',
      '    try:',
      '        pid = os.fork()',
      '    except OSError:',
      "        print('fork failed')",
      '        break',
      '    if pid == 0:',
      '        time.sleep(30)',
      '        os._exit(0)',
    ].join('\n');
    const started = Date.now();
    const result = await run('python', code, { limits: { timeoutMs: 15_000 } });
    expect(result.status).toBe('ok');
    expect(result.stdout.toString()).toContain('fork failed');
    expect(Date.now() - started).toBeLessThan(15_000);
  });

  it('kills a command over the memory limit', { timeout: 60_000 }, async () => {
    const result = await run('python', "chunks = []\nwhile True:\n    chunks.append(b'x' * 10_000_000)", { limits: { memoryMb: 64 } });
    expect(result.status).toBe('killed');
    expect(result.error).toBe('the command used more than 64 MB of memory');
  });

  it('ends a command over the wall time and removes its container', { timeout: 60_000 }, async () => {
    const result = await run('bash', 'sleep 30', { limits: { timeoutMs: 1500 } });
    expect(result.status).toBe('timeout');
    expect(result.durationMs).toBeLessThan(10_000);
    const left = await docker.listContainers(`${LABELS.exec}=${execId}`);
    expect(left.filter((container) => container.labels[LABELS.instance] === instance)).toEqual([]);
  });

  it('keeps /work between calls with the same volume', { timeout: 60_000 }, async () => {
    expect((await run('bash', 'echo kept > /work/note.txt')).status).toBe('ok');
    const second = await run('bash', 'cat note.txt');
    expect(second.status).toBe('ok');
    expect(second.stdout.toString()).toBe('kept\n');
    expect(second.scratchBytes).toBeGreaterThan(0);
  });

  it('collects a file', { timeout: 60_000 }, async () => {
    const result = await run('python', "import os\nos.makedirs('out', exist_ok=True)\nopen('out/result.txt', 'w').write('42')", { collect: ['out/result.txt', 'out/missing.txt'] });
    expect(result.status).toBe('ok');
    expect(result.collected.map((file) => [file.path, file.bytes.toString()])).toEqual([['out/result.txt', '42']]);
    expect(result.notCollected).toEqual([{ path: 'out/missing.txt', reason: 'no such file in /work' }]);
  });
});
