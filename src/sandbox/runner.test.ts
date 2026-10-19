import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createLogger } from '../observability/logger.js';
import { DockerError } from './docker.js';
import { DEFAULT_LIMITS, FILE_LIMITS, LABELS, SANDBOX_USER, SCRATCH_BYTES, TMP_MOUNT, WORK_DIR } from './limits.js';
import { packTar } from './tar.js';
import { commandFor, containerName, containerSpec, createRunner, sweepContainers, type TarParts } from './runner.js';
import type { ContainerSpec, ContainerState, DockerClient, ExecRequest, FileIn, NetworkPlan } from './types.js';

const logger = createLogger({ consoleLevel: 'off' });

function request(over: Partial<ExecRequest> = {}): ExecRequest {
  return {
    execId: 7,
    image: 'okc-sandbox:1',
    argv: ['python3', '-c', 'print(1)'],
    env: [],
    limits: DEFAULT_LIMITS,
    volume: 'okc-work-inst-task',
    files: [],
    collect: [],
    labels: {},
    signal: new AbortController().signal,
    ...over,
  };
}

const plan: NetworkPlan = {
  networkMode: 'okc-net-7',
  env: ['HTTP_PROXY=http://okc-proxy:8080'],
  extraHosts: ['okc-proxy:172.18.0.1'],
  passed: () => [],
  refused: () => [],
  close: async () => {},
};

describe('commandFor', () => {
  it('gives the code as one argument', () => {
    expect(commandFor('bash', 'echo "a b"')).toEqual(['bash', '-c', 'echo "a b"']);
    expect(commandFor('python', 'print(1)')).toEqual(['python3', '-c', 'print(1)']);
    expect(commandFor('node', 'console.log(1)')).toEqual(['node', '-e', 'console.log(1)']);
  });
});

describe('containerSpec', () => {
  it('sets every security setting and limit', () => {
    const spec = containerSpec(request({ limits: { cpus: 1.5, memoryMb: 256, timeoutMs: 1000, outputBytes: 10, pids: 64 }, env: ['A=1'], labels: { extra: 'x' } }), 'inst');
    expect(spec).toEqual({
      Image: 'okc-sandbox:1',
      Cmd: ['python3', '-c', 'print(1)'],
      Env: ['HOME=/work', 'LANG=C.UTF-8', 'TMPDIR=/tmp', 'A=1'],
      WorkingDir: WORK_DIR,
      User: SANDBOX_USER,
      Labels: { [LABELS.sandbox]: '1', [LABELS.instance]: 'inst', [LABELS.exec]: '7', extra: 'x' },
      AttachStdout: true,
      AttachStderr: true,
      AttachStdin: false,
      Tty: false,
      OpenStdin: false,
      NetworkDisabled: true,
      HostConfig: {
        NetworkMode: 'none',
        ReadonlyRootfs: true,
        CapDrop: ['ALL'],
        SecurityOpt: ['no-new-privileges:true'],
        Privileged: false,
        NanoCpus: 1_500_000_000,
        Memory: 256 * 1024 * 1024,
        MemorySwap: 256 * 1024 * 1024,
        PidsLimit: 64,
        Tmpfs: { [TMP_MOUNT.path]: TMP_MOUNT.options },
        Mounts: [{ Type: 'volume', Source: 'okc-work-inst-task', Target: WORK_DIR, ReadOnly: false }],
        ExtraHosts: [],
        Init: true,
        AutoRemove: false,
      },
    } satisfies ContainerSpec);
    expect(SANDBOX_USER.startsWith('0')).toBe(false);
  });

  it('rounds the nano cpus', () => {
    expect(containerSpec(request({ limits: { ...DEFAULT_LIMITS, cpus: 0.3333333333 } }), 'i').HostConfig.NanoCpus).toBe(333_333_333);
  });

  it('uses the network of a plan', () => {
    const spec = containerSpec(request({ network: plan, env: plan.env }), 'inst');
    expect(spec.NetworkDisabled).toBe(false);
    expect(spec.HostConfig.NetworkMode).toBe('okc-net-7');
    expect(spec.HostConfig.ExtraHosts).toEqual(['okc-proxy:172.18.0.1']);
    expect(spec.Env).toContain('HTTP_PROXY=http://okc-proxy:8080');
  });
});

// the script of a fake container. it writes to the streams and calls exit, or never exits.
type Script = (io: { stdout: PassThrough; stderr: PassThrough; exit: (code: number) => void }) => void;

interface FakeOptions {
  script?: Script;
  oom?: boolean;
  createError?: Error;
  startError?: Error;
  archives?: Record<string, Buffer | DockerError>;
  scratchSize?: number | Error;
}

function fakeDocker(options: FakeOptions = {}) {
  const calls: string[] = [];
  const specs: Array<{ name: string; spec: ContainerSpec }> = [];
  const puts: Array<{ path: string; tar: Buffer }> = [];
  const archiveCalls: Array<{ path: string; maxBytes: number }> = [];
  const removed: string[] = [];
  let stdout = new PassThrough();
  let stderr = new PassThrough();
  let exitWith: (code: number) => void = () => {};
  let exited = false;
  const exit = (code: number) => {
    if (exited) return;
    exited = true;
    stdout.end();
    stderr.end();
    exitWith(code);
  };

  const docker: DockerClient = {
    info: async () => ({ engine: 'docker 28 (linux/arm64)', os: 'linux', arch: 'arm64' }),
    imageId: async () => 'sha256:img',
    async createContainer(name, spec) {
      calls.push('create');
      if (options.createError) throw options.createError;
      specs.push({ name, spec });
      return 'c1';
    },
    async putArchive(_id, path, tar) {
      calls.push('put');
      puts.push({ path, tar });
    },
    async getArchive(_id, path, maxBytes) {
      calls.push('get');
      archiveCalls.push({ path, maxBytes });
      const found = options.archives?.[path];
      if (found === undefined) throw new DockerError('no such path', 404);
      if (found instanceof Error) throw found;
      return found;
    },
    async archiveSize() {
      calls.push('size');
      const size = options.scratchSize ?? 1234;
      if (size instanceof Error) throw size;
      return size;
    },
    async attach() {
      calls.push('attach');
      stdout = new PassThrough();
      stderr = new PassThrough();
      return { stdout, stderr, close: () => calls.push('close') };
    },
    async start() {
      calls.push('start');
      if (options.startError) throw options.startError;
      (options.script ?? (({ exit }) => exit(0)))({ stdout, stderr, exit });
    },
    wait() {
      calls.push('wait');
      return new Promise<number>((resolve) => (exitWith = resolve));
    },
    async inspect(): Promise<ContainerState> {
      calls.push('inspect');
      return { image: 'sha256:img', running: false, exitCode: null, oomKilled: options.oom === true };
    },
    async kill() {
      calls.push('kill');
      exit(137);
    },
    async removeContainer(id) {
      calls.push('remove');
      removed.push(id);
    },
    listContainers: async () => [],
    createVolume: async () => {},
    removeVolume: async () => {},
    listVolumes: async () => [],
    createNetwork: async () => 'n1',
    removeNetwork: async () => {},
    listNetworks: async () => [],
  };
  return { docker, calls, specs, puts, archiveCalls, removed };
}

// a fake tar: pack keeps the paths as json, and unpack reads a json list of files.
const unpackCalls: unknown[] = [];
const tar: TarParts = {
  pack: (files: FileIn[]) => Buffer.from(JSON.stringify(files.map((file) => file.path))),
  unpack: (bytes, options) => {
    unpackCalls.push(options);
    const parsed = JSON.parse(bytes.toString()) as { files: Array<{ path: string; text: string }>; skipped?: Array<{ path: string; reason: string }> };
    return { files: parsed.files.map((file) => ({ path: file.path, bytes: Buffer.from(file.text) })), skipped: parsed.skipped ?? [] };
  },
};

const runnerOf = (docker: DockerClient, now?: () => number) => createRunner({ docker, logger, instance: 'inst', tar, ...(now ? { now } : {}) });

describe('createRunner', () => {
  it('runs a command that ends with 0', async () => {
    const fake = fakeDocker({
      script: ({ stdout, stderr, exit }) => {
        stdout.write('hello ');
        stderr.write('warn');
        stdout.write('world');
        setTimeout(() => exit(0), 5);
      },
    });
    let clock = 1000;
    const result = await runnerOf(fake.docker, () => (clock += 250)).run(request());
    expect(result).toMatchObject({
      status: 'ok',
      exitCode: 0,
      stdoutBytes: 11,
      stderrBytes: 4,
      truncated: false,
      containerId: 'c1',
      imageId: 'sha256:img',
      error: null,
      scratchBytes: 1234,
      collected: [],
      notCollected: [],
    });
    expect(result.stdout.toString()).toBe('hello world');
    expect(result.stderr.toString()).toBe('warn');
    expect(result.durationMs).toBe(250);
    expect(fake.specs[0]!.name).toBe(containerName('inst', 7));
    // wait goes out before start, so the exit is never missed.
    expect(fake.calls.indexOf('wait')).toBeLessThan(fake.calls.indexOf('start'));
    expect(fake.calls.indexOf('attach')).toBeLessThan(fake.calls.indexOf('start'));
    expect(fake.calls.at(-1)).toBe('remove');
    expect(fake.removed).toEqual(['c1']);
  });

  it('gives failed for another exit code', async () => {
    const fake = fakeDocker({ script: ({ stderr, exit }) => (stderr.write('Traceback'), exit(1)) });
    const result = await runnerOf(fake.docker).run(request());
    expect(result).toMatchObject({ status: 'failed', exitCode: 1, error: null });
    expect(result.stderr.toString()).toBe('Traceback');
    expect(fake.removed).toEqual(['c1']);
  });

  it('kills a command over the wall time', async () => {
    const fake = fakeDocker({ script: ({ stdout }) => stdout.write('started') });
    const result = await runnerOf(fake.docker).run(request({ limits: { ...DEFAULT_LIMITS, timeoutMs: 30 } }));
    expect(result).toMatchObject({ status: 'timeout', exitCode: 137, error: 'the command ran longer than 0.03 s' });
    expect(result.stdout.toString()).toBe('started');
    expect(fake.calls).toContain('kill');
    expect(fake.removed).toEqual(['c1']);
  });

  it('kills a command when the run stops', async () => {
    const fake = fakeDocker({ script: () => {} });
    const controller = new AbortController();
    const pending = runnerOf(fake.docker).run(request({ signal: controller.signal }));
    setTimeout(() => controller.abort(), 10);
    const result = await pending;
    expect(result).toMatchObject({ status: 'killed', error: 'the run stopped, so the command was ended', exitCode: 137 });
    expect(fake.calls).toContain('kill');
    expect(fake.removed).toEqual(['c1']);
  });

  it('kills at once when the signal stopped before the start', async () => {
    const fake = fakeDocker({ script: () => {} });
    const controller = new AbortController();
    controller.abort();
    const result = await runnerOf(fake.docker).run(request({ signal: controller.signal }));
    expect(result.status).toBe('killed');
    expect(fake.removed).toEqual(['c1']);
  });

  it('maps an oom kill to killed', async () => {
    const fake = fakeDocker({ oom: true, script: ({ exit }) => exit(137) });
    const result = await runnerOf(fake.docker).run(request({ limits: { ...DEFAULT_LIMITS, memoryMb: 128 } }));
    expect(result).toMatchObject({ status: 'killed', exitCode: 137, error: 'the command used more than 128 MB of memory' });
  });

  it('keeps the first bytes, counts all, and drains after the cap', async () => {
    let wrote = 0;
    const fake = fakeDocker({
      script: ({ stdout, stderr, exit }) => {
        // a pipe that nobody reads would stop the writes at the high water mark, so the many writes show the drain.
        for (let i = 0; i < 200; i++) {
          stdout.write(Buffer.alloc(1000, 'a'));
          wrote += 1000;
        }
        stderr.write('short');
        setTimeout(() => exit(0), 5);
      },
    });
    const result = await runnerOf(fake.docker).run(request({ limits: { ...DEFAULT_LIMITS, outputBytes: 2500 } }));
    expect(result.status).toBe('ok');
    expect(result.stdout.length).toBe(2500);
    expect(result.stdoutBytes).toBe(wrote);
    expect(result.stderr.toString()).toBe('short');
    expect(result.stderrBytes).toBe(5);
    expect(result.truncated).toBe(true);
  });

  it('is not truncated at exactly the cap', async () => {
    const fake = fakeDocker({ script: ({ stdout, exit }) => (stdout.write('12345'), exit(0)) });
    const result = await runnerOf(fake.docker).run(request({ limits: { ...DEFAULT_LIMITS, outputBytes: 5 } }));
    expect(result.truncated).toBe(false);
    expect(result.stdout.toString()).toBe('12345');
  });

  it('puts the files in before the start', async () => {
    const fake = fakeDocker();
    await runnerOf(fake.docker).run(request({ files: [{ path: 'data/in.csv', bytes: Buffer.from('a,b') }] }));
    expect(fake.puts).toEqual([{ path: WORK_DIR, tar: Buffer.from('["data/in.csv"]') }]);
    expect(fake.calls.indexOf('put')).toBeLessThan(fake.calls.indexOf('start'));
  });

  it('collects the files, a missing path, and a path over the limit', async () => {
    const tarOf = (files: Array<{ path: string; text: string }>, skipped: Array<{ path: string; reason: string }> = []) => Buffer.from(JSON.stringify({ files, skipped }));
    const fake = fakeDocker({
      archives: {
        '/work/out/report.txt': tarOf([{ path: 'out/report.txt', text: 'done' }]),
        '/work/plots': tarOf([{ path: 'plots/a.png', text: 'png' }], [{ path: 'plots/link', reason: 'a link is not a file' }]),
        '/work/huge.bin': new DockerError('the files are over 1 bytes', 413),
      },
    });
    unpackCalls.length = 0;
    const result = await runnerOf(fake.docker).run(request({ collect: ['out/report.txt', 'missing.txt', 'plots', 'huge.bin'] }));
    expect(result.status).toBe('ok');
    expect(result.collected.map((file) => [file.path, file.bytes.toString()])).toEqual([
      ['out/report.txt', 'done'],
      ['plots/a.png', 'png'],
    ]);
    expect(result.notCollected).toEqual([
      { path: 'missing.txt', reason: 'no such file in /work' },
      { path: 'plots/link', reason: 'a link is not a file' },
      { path: 'huge.bin', reason: `the collected files are over ${FILE_LIMITS.totalBytes} bytes in all` },
    ]);
    expect(unpackCalls[0]).toEqual({ strip: 'report.txt', prefix: 'out/report.txt', maxFiles: FILE_LIMITS.count, maxFileBytes: FILE_LIMITS.fileBytes, maxTotalBytes: FILE_LIMITS.totalBytes });
    expect(unpackCalls[1]).toMatchObject({ strip: 'plots', prefix: 'plots', maxFiles: FILE_LIMITS.count - 1, maxTotalBytes: FILE_LIMITS.totalBytes - 4 });
    // the second read may only use what is left of the total.
    expect(fake.archiveCalls[0]).toEqual({ path: '/work/out/report.txt', maxBytes: FILE_LIMITS.totalBytes });
    expect(fake.archiveCalls.find((call) => call.path === '/work/plots')!.maxBytes).toBe(FILE_LIMITS.totalBytes - 4);
  });

  it('gives the paths under /work with the real tar, as the engine names the entries', async () => {
    // the engine names the entry of a file by its base name, and the entries of a folder under the folder name.
    const fake = fakeDocker({
      archives: {
        '/work/out/report.txt': packTar([{ path: 'report.txt', bytes: Buffer.from('done') }], new Date(0)),
        '/work/plots': packTar([{ path: 'plots/a.png', bytes: Buffer.from('png') }], new Date(0)),
      },
    });
    const result = await createRunner({ docker: fake.docker, logger, instance: 'inst' }).run(request({ collect: ['out/report.txt', 'plots'] }));
    expect(result.collected.map((file) => [file.path, file.bytes.toString()])).toEqual([
      ['out/report.txt', 'done'],
      ['plots/a.png', 'png'],
    ]);
  });

  it('collects after a failed command and after a timeout', async () => {
    const archives = { '/work/log.txt': Buffer.from(JSON.stringify({ files: [{ path: 'log.txt', text: 'x' }] })) };
    const failed = await runnerOf(fakeDocker({ archives, script: ({ exit }) => exit(2) }).docker).run(request({ collect: ['log.txt'] }));
    expect(failed.status).toBe('failed');
    expect(failed.collected).toHaveLength(1);
    const timedOut = await runnerOf(fakeDocker({ archives, script: () => {} }).docker).run(request({ collect: ['log.txt'], limits: { ...DEFAULT_LIMITS, timeoutMs: 20 } }));
    expect(timedOut.status).toBe('timeout');
    expect(timedOut.collected).toHaveLength(1);
  });

  it('measures the scratch size, and leaves it undefined on a failure', async () => {
    const big = await runnerOf(fakeDocker({ scratchSize: SCRATCH_BYTES + 1 }).docker).run(request());
    expect(big.scratchBytes).toBe(SCRATCH_BYTES + 1);
    const lost = await runnerOf(fakeDocker({ scratchSize: new Error('engine gone') }).docker).run(request());
    expect(lost.status).toBe('ok');
    expect(lost.scratchBytes).toBeUndefined();
  });

  it('gives error when the create fails, with no container to remove', async () => {
    const fake = fakeDocker({ createError: new DockerError('No such image: okc-sandbox:1', 404) });
    const result = await runnerOf(fake.docker).run(request({ collect: ['x'] }));
    expect(result).toMatchObject({ status: 'error', containerId: null, error: 'docker did not create the container: No such image: okc-sandbox:1' });
    expect(fake.calls).not.toContain('get');
    expect(fake.removed).toEqual([]);
  });

  it('gives error and removes the container when the start fails', async () => {
    const fake = fakeDocker({ startError: new DockerError('cannot start', 500) });
    const result = await runnerOf(fake.docker).run(request({ collect: ['x'] }));
    expect(result).toMatchObject({ status: 'error', containerId: 'c1', error: 'cannot start' });
    expect(fake.calls).not.toContain('get');
    expect(fake.calls).toContain('close');
    expect(fake.removed).toEqual(['c1']);
  });

  it('does not reject when the remove fails', async () => {
    const fake = fakeDocker();
    fake.docker.removeContainer = async () => {
      throw new Error('engine gone');
    };
    expect((await runnerOf(fake.docker).run(request())).status).toBe('ok');
  });
});

describe('sweepContainers', () => {
  it('keeps the live execs and removes the rest', async () => {
    const fake = fakeDocker();
    const labels: string[] = [];
    fake.docker.listContainers = async (label): ReturnType<DockerClient['listContainers']> => {
      labels.push(label);
      return [
        { id: 'live', labels: { [LABELS.exec]: '1' }, createdAt: '' },
        { id: 'stale', labels: { [LABELS.exec]: '2' }, createdAt: '' },
        { id: 'nolabel', labels: {}, createdAt: '' },
      ];
    };
    expect(await sweepContainers(fake.docker, 'inst', (execId) => execId === 1)).toBe(2);
    expect(labels).toEqual([`${LABELS.instance}=inst`]);
    expect(fake.removed).toEqual(['stale', 'nolabel']);
  });
});
