import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { openDb } from '../db/index.js';
import { normalizeSchema } from '../models/schema.js';
import { createBlobStore } from '../observability/blobs.js';
import { createByteStore } from '../observability/byte-blobs.js';
import { createLogger } from '../observability/logger.js';
import { DockerError, endpointOf } from './docker.js';
import { checkPath, mimeOf, resolveInputs, storeOutputs } from './files.js';
import { sandboxExecInput } from './input.js';
import { CODE_BYTES, DEFAULT_LIMITS, FILE_LIMITS, limitsFor, MAX_LIMITS, SCRATCH_BYTES, SCRATCH_IDLE_MS } from './limits.js';
import { checkAllowlist, proxyPathFor } from './network.js';
import { createRunner } from './runner.js';
import { createScratch } from './scratch.js';
import { closeStale, finishExec, startExec } from './store.js';
import { packTar, unpackTar } from './tar.js';
import type { ContainerState, DockerClient, ExecRequest, NewExec } from './types.js';

// edge cases of the parts of the sandbox that need no docker: the input, the paths and the archive, the allowlist, the
// way to the engine, the limits, the scratch volumes and the trace rows.

const clock = () => new Date('2026-10-18T10:00:00Z');

function stores() {
  const db = openDb(':memory:');
  const dir = mkdtempSync(join(tmpdir(), 'okc-sandbox-edge-'));
  return { db, stores: { blobs: createBlobStore(db, join(dir, 'blobs'), clock), bytes: createByteStore(db, join(dir, 'blobs'), clock) } };
}

describe('the input of sandbox_exec', () => {
  const parse = (input: unknown) => sandboxExecInput.safeParse(input);

  it('refuses an unknown language, an empty code, an unknown key and a bad limit', () => {
    expect(parse({ language: 'ruby', code: 'puts 1' }).success).toBe(false);
    expect(parse({ language: 'bash', code: '' }).success).toBe(false);
    expect(parse({ language: 'bash', code: 'ls', shell: true }).success).toBe(false);
    expect(parse({ language: 'bash', code: 'ls', timeoutMs: 999 }).success).toBe(false);
    expect(parse({ language: 'bash', code: 'ls', timeoutMs: MAX_LIMITS.timeoutMs + 1 }).success).toBe(false);
    expect(parse({ language: 'bash', code: 'ls', timeoutMs: 1500.5 }).success).toBe(false);
    expect(parse({ language: 'bash', code: 'ls', memoryMb: 63 }).success).toBe(false);
    expect(parse({ language: 'bash', code: 'ls', memoryMb: MAX_LIMITS.memoryMb + 1 }).success).toBe(false);
    // a call cannot ask for more cpus, processes or output, because the input has no such field.
    expect(parse({ language: 'bash', code: 'ls', cpus: 8 }).success).toBe(false);
    expect(parse({ language: 'bash', code: 'ls', pids: 4096 }).success).toBe(false);
    expect(parse({ language: 'bash', code: 'ls', outputBytes: 1e9 }).success).toBe(false);
  });

  it('counts the code limit in bytes and not in characters', () => {
    expect(parse({ language: 'python', code: 'a'.repeat(CODE_BYTES) }).success).toBe(true);
    expect(parse({ language: 'python', code: 'a'.repeat(CODE_BYTES + 1) }).success).toBe(false);
    // each é is two bytes in utf-8, so half the characters already fill the limit.
    expect(parse({ language: 'python', code: 'é'.repeat(CODE_BYTES / 2) }).success).toBe(true);
    expect(parse({ language: 'python', code: 'é'.repeat(CODE_BYTES / 2 + 1) }).success).toBe(false);
  });

  it('refuses a network block without hosts, with too many hosts, or with a scheme', () => {
    expect(parse({ language: 'bash', code: 'ls', network: {} }).success).toBe(false);
    expect(parse({ language: 'bash', code: 'ls', network: { allow: [] } }).success).toBe(false);
    expect(parse({ language: 'bash', code: 'ls', network: { allow: Array.from({ length: 11 }, (_, i) => `h${i}.example.org`) } }).success).toBe(false);
    expect(parse({ language: 'bash', code: 'ls', network: { allow: ['https://pypi.org'] } }).success).toBe(false);
    expect(parse({ language: 'bash', code: 'ls', network: { allow: ['pypi.org:443'] } }).success).toBe(false);
    expect(parse({ language: 'bash', code: 'ls', network: { allow: ['pypi.org/simple'] } }).success).toBe(false);
  });

  it('refuses an absolute path, a blob that is not a hash, and too many files', () => {
    expect(parse({ language: 'bash', code: 'ls', files: [{ path: '/etc/passwd', content: 'x' }] }).success).toBe(false);
    expect(parse({ language: 'bash', code: 'ls', files: [{ path: '\\x', content: 'x' }] }).success).toBe(false);
    expect(parse({ language: 'bash', code: 'ls', files: [{ path: 'a', blob: 'ABC' }] }).success).toBe(false);
    expect(parse({ language: 'bash', code: 'ls', files: [{ path: 'a', blob: 'A'.repeat(64) }] }).success).toBe(false);
    const many = Array.from({ length: FILE_LIMITS.count + 1 }, (_, i) => ({ path: `f${i}`, content: '' }));
    expect(parse({ language: 'bash', code: 'ls', files: many }).success).toBe(false);
    expect(parse({ language: 'bash', code: 'ls', collect: Array.from({ length: FILE_LIMITS.count + 1 }, (_, i) => `f${i}`) }).success).toBe(false);
  });

  it('gives a json schema that each model dialect takes, with only language and code required', () => {
    const schema = z.toJSONSchema(sandboxExecInput, { io: 'input' }) as Record<string, unknown>;
    expect(schema.type).toBe('object');
    expect(schema.required).toEqual(['language', 'code']);
    expect(schema.additionalProperties).toBe(false);
    for (const dialect of ['anthropic', 'openai-compat'] as const) {
      const normalized = normalizeSchema(schema, dialect);
      expect(JSON.stringify(normalized)).not.toContain('$ref');
      expect((normalized.properties as Record<string, { enum?: string[] }>).language?.enum).toEqual(['bash', 'python', 'node']);
    }
  });
});

describe('limitsFor', () => {
  it('gives the defaults, clamps to the maximum and never goes below zero', () => {
    expect(limitsFor({})).toEqual(DEFAULT_LIMITS);
    expect(limitsFor({ timeoutMs: 10 ** 9, memoryMb: 10 ** 9, cpus: 99 })).toEqual({ ...MAX_LIMITS, outputBytes: DEFAULT_LIMITS.outputBytes, pids: DEFAULT_LIMITS.pids });
    expect(limitsFor({ timeoutMs: -5, memoryMb: -5, cpus: -1 })).toMatchObject({ timeoutMs: 0, memoryMb: 0, cpus: 0 });
    // a call can never raise the output or the process limit.
    expect(limitsFor({ timeoutMs: 1_000 }).outputBytes).toBe(DEFAULT_LIMITS.outputBytes);
    expect(limitsFor({ timeoutMs: 1_000 }).pids).toBe(DEFAULT_LIMITS.pids);
    expect(MAX_LIMITS.outputBytes).toBe(DEFAULT_LIMITS.outputBytes);
    expect(MAX_LIMITS.pids).toBe(DEFAULT_LIMITS.pids);
  });
});

describe('paths and archives together', () => {
  it('refuses a path with a dot segment in any place, also at the end', () => {
    for (const path of ['a/.', 'a/..', './a', '../a', 'a/./b', 'a/../b', '..', '.']) expect(checkPath(path), path).toBeDefined();
    // a name that only starts or ends with dots is a normal name.
    for (const path of ['..a', 'a..', '.hidden', 'a/...', 'dir.d/file.tar.gz']) expect(checkPath(path), path).toBeUndefined();
  });

  it('refuses the reserved folder only as the first segment', () => {
    expect(checkPath('.okc')).toBeDefined();
    expect(checkPath('.okc/x')).toBeDefined();
    expect(checkPath('data/.okc/x')).toBeUndefined();
    expect(checkPath('.okcx')).toBeUndefined();
  });

  it('round trips a deep path of the longest length that the input takes', () => {
    // 200 characters split by slashes into short segments fits the ustar prefix and name fields.
    const path = Array.from({ length: 40 }, () => 'abcd').join('/').slice(0, FILE_LIMITS.pathChars - 2) + '.x';
    expect(path.length).toBeLessThanOrEqual(FILE_LIMITS.pathChars);
    expect(checkPath(path)).toBeUndefined();
    const tar = packTar([{ path, bytes: Buffer.from('deep') }], new Date(0));
    const back = unpackTar(tar, { strip: '', prefix: '', maxFiles: 10, maxFileBytes: 100, maxTotalBytes: 100 });
    expect(back.files.map((file) => file.path)).toEqual([path]);
  });

  it('round trips an empty file and a file of exactly one block', () => {
    const tar = packTar(
      [
        { path: 'empty', bytes: Buffer.alloc(0) },
        { path: 'block', bytes: Buffer.alloc(512, 7) },
      ],
      new Date(0),
    );
    expect(tar.length % 512).toBe(0);
    const back = unpackTar(tar, { strip: '', prefix: '', maxFiles: 10, maxFileBytes: 1024, maxTotalBytes: 1024 });
    expect(back.files.map((file) => [file.path, file.bytes.length])).toEqual([
      ['empty', 0],
      ['block', 512],
    ]);
    expect(back.skipped).toEqual([]);
  });

  it('never gives a path outside /work for a hostile entry name', () => {
    const entry = (name: string) => {
      const tar = packTar([{ path: 'x', bytes: Buffer.from('1') }], new Date(0));
      // the name field is rewritten and the checksum fixed, as a hostile engine could send it.
      const header = Buffer.from(tar.subarray(0, 512));
      header.fill(0, 0, 100);
      Buffer.from(name).copy(header, 0);
      header.fill(0x20, 148, 156);
      let sum = 0;
      for (const byte of header) sum += byte;
      Buffer.from(`${sum.toString(8).padStart(6, '0')}\0 `).copy(header, 148);
      return Buffer.concat([header, tar.subarray(512)]);
    };
    for (const name of ['../etc/passwd', '/etc/passwd', 'out/../../x', 'out/../x']) {
      const back = unpackTar(entry(name), { strip: 'out', prefix: 'out', maxFiles: 10, maxFileBytes: 10, maxTotalBytes: 10 });
      expect(back.files, name).toEqual([]);
      expect(back.skipped[0]?.reason, name).toBe('unsafe path');
    }
  });

  it('keeps the bytes of an input file and gives it a mime by its first bytes', () => {
    const { stores: both } = stores();
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1, 2]);
    const hash = both.bytes.put(png, 'image/png');
    const inputs = resolveInputs([{ path: 'pic', blob: hash }], both);
    expect(inputs.ok).toBe(true);
    if (!inputs.ok) return;
    expect(inputs.files[0]!.bytes.equals(png)).toBe(true);
    expect(inputs.rows[0]).toMatchObject({ direction: 'in', path: 'pic', blob: hash, size: png.length, mime: 'image/png' });
  });

  it('takes an empty text file in and out', () => {
    const { stores: both } = stores();
    const inputs = resolveInputs([{ path: 'empty.txt', content: '' }], both);
    expect(inputs.ok).toBe(true);
    if (!inputs.ok) return;
    expect(inputs.rows[0]).toMatchObject({ size: 0, mime: 'text/plain; charset=utf-8' });
    const out = storeOutputs([{ path: 'out.txt', bytes: Buffer.alloc(0) }], both);
    expect(out[0]).toMatchObject({ direction: 'out', size: 0 });
    expect(both.blobs.read(out[0]!.blob)).toBe('');
  });

  it('refuses a file that is also the folder of another file in either order', () => {
    const { stores: both } = stores();
    expect(resolveInputs([{ path: 'a', content: '1' }, { path: 'a/b', content: '2' }], both).ok).toBe(false);
    expect(resolveInputs([{ path: 'a/b/c', content: '1' }, { path: 'a/b', content: '2' }], both).ok).toBe(false);
    expect(resolveInputs([{ path: 'a/b', content: '1' }, { path: 'a/c', content: '2' }], both).ok).toBe(true);
  });

  it('stores a collected file with a nul byte or bad utf-8 as bytes, and keeps its bytes', () => {
    const { stores: both } = stores();
    const odd = Buffer.from([0x61, 0x00, 0x62]);
    const bad = Buffer.from([0xc3, 0x28]);
    const rows = storeOutputs(
      [
        { path: 'nul.txt', bytes: odd },
        { path: 'bad', bytes: bad },
      ],
      both,
    );
    expect(both.bytes.read(rows[0]!.blob)?.bytes.equals(odd)).toBe(true);
    expect(rows[1]!.mime).toBe('application/octet-stream');
    expect(both.bytes.read(rows[1]!.blob)?.bytes.equals(bad)).toBe(true);
  });

  it('reads the extension in any case, and a dot file has no extension', () => {
    expect(mimeOf('DATA.CSV', Buffer.from('a,b'))).toBe('text/csv; charset=utf-8');
    expect(mimeOf('out/Plot.PNG', Buffer.alloc(0))).toBe('image/png');
    expect(mimeOf('.csv', Buffer.from('x'))).toBe('text/plain; charset=utf-8');
    expect(mimeOf('dir.png/readme', Buffer.from('x'))).toBe('text/plain; charset=utf-8');
  });
});

describe('checkAllowlist', () => {
  it('refuses addresses, wildcards, public suffixes and names that are not host names', () => {
    for (const entry of ['127.0.0.1', '[::1]', '::1', '10.0.0.1', '1.2.3', '0x7f.1', 'com', 'co.uk', 'org', 'localhost', '*.pypi.org', 'a..b', '-a.org', 'a-.org', 'pypi_org.com', '.org']) {
      expect(checkAllowlist([entry]), entry).toBeDefined();
    }
  });

  it('takes a site in any case, with a trailing dot, and a punycode name', () => {
    expect(checkAllowlist(['PyPI.org', 'files.pythonhosted.org.', 'xn--bcher-kva.example'])).toBeUndefined();
  });

  it('refuses the whole list when one entry is bad', () => {
    expect(checkAllowlist(['pypi.org', 'com'])).toBeDefined();
    expect(checkAllowlist([])).toBeDefined();
  });
});

describe('proxyPathFor', () => {
  it('refuses a linux host whose docker0 bridge has only an ipv6 address', () => {
    const interfaces = { docker0: [{ address: 'fe80::1', family: 'IPv6' }] } as unknown as Parameters<typeof proxyPathFor>[0]['interfaces'];
    expect(proxyPathFor({ platform: 'linux', inContainer: false, interfaces }).ok).toBe(false);
  });

  it('uses host.docker.internal on windows and refuses another system', () => {
    expect(proxyPathFor({ platform: 'win32', inContainer: false, interfaces: {} })).toMatchObject({ ok: true, listen: '127.0.0.1', proxyHost: 'host.docker.internal' });
    expect(proxyPathFor({ platform: 'freebsd', inContainer: false, interfaces: {} }).ok).toBe(false);
    // in a container the answer is no on every system.
    for (const platform of ['darwin', 'win32', 'linux'] as const) expect(proxyPathFor({ platform, inContainer: true, interfaces: {} }).ok).toBe(false);
  });
});

describe('endpointOf', () => {
  const none = () => false;

  it('reads an ipv6 tcp host, a trailing slash, and ignores a blank DOCKER_HOST', () => {
    expect(endpointOf({ DOCKER_HOST: 'tcp://[::1]:2375' }, 'linux', '/h', none)).toEqual({ host: '::1', port: 2375 });
    expect(endpointOf({ DOCKER_HOST: 'tcp://10.0.0.5:2375/' }, 'linux', '/h', none)).toEqual({ host: '10.0.0.5', port: 2375 });
    expect(endpointOf({ DOCKER_HOST: '   ' }, 'linux', '/h', (path) => path === '/var/run/docker.sock')).toEqual({ socketPath: '/var/run/docker.sock' });
  });

  it('refuses a tcp host without a port, an ssh host and an empty unix path', () => {
    for (const host of ['tcp://10.0.0.5', 'ssh://user@host', 'unix://', 'http://localhost:2375']) {
      expect(endpointOf({ DOCKER_HOST: host }, 'linux', '/h', none), host).toHaveProperty('error');
    }
  });

  it('falls back to /var/run/docker.sock on macos without the desktop socket', () => {
    expect(endpointOf({}, 'darwin', '/Users/me', (path) => path === '/var/run/docker.sock')).toEqual({ socketPath: '/var/run/docker.sock' });
    expect(endpointOf({}, 'darwin', '/Users/me', none)).toHaveProperty('error');
  });
});

describe('the trace rows', () => {
  const exec: NewExec = {
    runId: 'run-1',
    toolCallId: 'c1',
    sessionKey: 'main',
    taskId: 't1',
    language: 'bash',
    command: "echo 'quoted' \"and\" `ticks` $HOME é \u{1f600}",
    image: 'okc-sandbox:1',
    cwd: '/work',
    network: 'none',
    allowlist: [],
    limits: DEFAULT_LIMITS,
  };

  it('keeps the command byte for byte, also quotes and characters outside ascii', () => {
    const db = openDb(':memory:');
    const id = startExec(db, exec, clock());
    expect(db.prepare('SELECT command FROM sandbox_execs WHERE id = ?').get(id)).toEqual({ command: exec.command });
  });

  it('rounds a fractional duration and does not close a fresh row or a live one', () => {
    const db = openDb(':memory:');
    const id = startExec(db, exec, clock());
    expect(closeStale(db, clock(), 1_000, new Set())).toEqual([]);
    const later = new Date(clock().getTime() + 10_000);
    expect(closeStale(db, later, 1_000, new Set([id]))).toEqual([]);
    finishExec(
      db,
      id,
      { status: 'ok', exitCode: 0, imageId: null, containerId: null, stdoutBlob: null, stderrBlob: null, stdoutBytes: 0, stderrBytes: 0, truncated: false, error: null, durationMs: 12.6 },
      later,
    );
    expect(db.prepare('SELECT durationMs, status FROM sandbox_execs WHERE id = ?').get(id)).toEqual({ durationMs: 13, status: 'ok' });
    // a closed row is never closed again.
    expect(closeStale(db, new Date(later.getTime() + 10_000_000), 1_000, new Set())).toEqual([]);
  });

  it('refuses a file row of an exec that does not exist', () => {
    const db = openDb(':memory:');
    expect(() =>
      db.prepare("INSERT INTO sandbox_files (execId, direction, path, blob, size, mime, createdAt) VALUES (999, 'in', 'a', 'b', 1, 'text/plain', 'x')").run(),
    ).toThrow();
  });
});

describe('scratch edges', () => {
  function docker(fail?: (name: string) => Error | undefined) {
    const volumes = new Set<string>();
    const removed: string[] = [];
    const client = {
      async createVolume(name: string) {
        volumes.add(name);
      },
      async removeVolume(name: string) {
        const err = fail?.(name);
        if (err) throw err;
        volumes.delete(name);
        removed.push(name);
      },
      async listVolumes() {
        return [...volumes].map((name) => ({ name, labels: {} }));
      },
    } as Partial<DockerClient> as DockerClient;
    return { client, removed };
  }

  it('resets /work only above the size limit', async () => {
    const db = openDb(':memory:');
    const fake = docker();
    const scratch = createScratch({ db, docker: fake.client, clock, instance: 'i' });
    const { taskId } = await scratch.volumeFor('main');
    expect(await scratch.afterExec(taskId, SCRATCH_BYTES)).toEqual({ reset: false });
    expect(await scratch.afterExec(taskId, undefined)).toEqual({ reset: false });
    expect(await scratch.afterExec('no-such-task', SCRATCH_BYTES + 1)).toEqual({ reset: false });
    expect(await scratch.afterExec(taskId, SCRATCH_BYTES + 1)).toEqual({ reset: true });
    expect(fake.removed).toHaveLength(1);
  });

  it('gives two sessions two volumes, and one session one volume for two calls at once', async () => {
    const db = openDb(':memory:');
    const fake = docker();
    const scratch = createScratch({ db, docker: fake.client, clock, instance: 'i' });
    const [a, b, c] = await Promise.all([scratch.volumeFor('main'), scratch.volumeFor('main'), scratch.volumeFor('auto:7')]);
    expect(a).toEqual(b);
    expect(c.volume).not.toBe(a.volume);
    expect(db.prepare('SELECT COUNT(*) AS n FROM sandbox_scratch').get()).toEqual({ n: 2 });
  });

  it('keeps an idle volume that is in use for the next sweep', async () => {
    const db = openDb(':memory:');
    let now = new Date('2026-10-01T00:00:00Z');
    const fake = docker(() => new DockerError('in use', 409));
    const scratch = createScratch({ db, docker: fake.client, clock: () => now, instance: 'i' });
    await scratch.volumeFor('main');
    now = new Date(now.getTime() + SCRATCH_IDLE_MS + 1);
    expect(await scratch.sweep()).toBe(0);
    expect(db.prepare('SELECT removedAt FROM sandbox_scratch').get()).toEqual({ removedAt: null });
  });
});

describe('the runner on the edges', () => {
  const logger = createLogger({ consoleLevel: 'off' });

  function docker(over: Partial<DockerClient> = {}) {
    const calls: string[] = [];
    let exit: (code: number) => void = () => {};
    const base: DockerClient = {
      info: async () => ({ engine: 'docker 28', os: 'linux', arch: 'arm64' }),
      imageId: async () => 'sha256:img',
      createContainer: async () => {
        calls.push('create');
        return 'c1';
      },
      putArchive: async () => {
        calls.push('put');
      },
      getArchive: async () => {
        throw new DockerError('none', 404);
      },
      archiveSize: async () => 0,
      attach: async () => {
        calls.push('attach');
        const { PassThrough } = await import('node:stream');
        const stdout = new PassThrough();
        const stderr = new PassThrough();
        stdout.end();
        stderr.end();
        return { stdout, stderr, close: () => undefined };
      },
      start: async () => {
        calls.push('start');
        exit(0);
      },
      wait: () => new Promise<number>((resolve) => (exit = resolve)),
      inspect: async (): Promise<ContainerState> => ({ image: 'sha256:img', running: false, exitCode: 0, oomKilled: false }),
      kill: async () => {
        calls.push('kill');
        exit(137);
      },
      removeContainer: async () => {
        calls.push('remove');
      },
      listContainers: async () => [],
      createVolume: async () => {},
      removeVolume: async () => {},
      listVolumes: async () => [],
      createNetwork: async () => 'n',
      removeNetwork: async () => {},
      listNetworks: async () => [],
      ...over,
    };
    return { client: base, calls };
  }

  const request = (over: Partial<ExecRequest> = {}): ExecRequest => ({
    execId: 1,
    image: 'okc-sandbox:1',
    argv: ['bash', '-c', 'true'],
    env: [],
    limits: DEFAULT_LIMITS,
    volume: 'v',
    files: [],
    collect: [],
    labels: {},
    signal: new AbortController().signal,
    ...over,
  });

  it('removes the container when the put of the files fails, and gives the reason', async () => {
    const fake = docker({
      putArchive: async () => {
        throw new DockerError('no space left on device', 500);
      },
    });
    const result = await createRunner({ docker: fake.client, logger, instance: 'i' }).run(request({ files: [{ path: 'a.txt', bytes: Buffer.from('x') }] }));
    expect(result.status).toBe('error');
    expect(result.error).toContain('no space left on device');
    expect(fake.calls).not.toContain('start');
    expect(fake.calls.at(-1)).toBe('remove');
  });

  it('removes the container when the attach fails', async () => {
    const fake = docker({
      attach: async () => {
        throw new DockerError('attach refused', 500);
      },
    });
    const result = await createRunner({ docker: fake.client, logger, instance: 'i' }).run(request());
    expect(result).toMatchObject({ status: 'error', containerId: 'c1' });
    expect(fake.calls).toEqual(['create', 'remove']);
  });

  it('gives error when wait fails, and still removes the container', async () => {
    const fake = docker({ wait: () => Promise.reject(new DockerError('wait broke', 500)) });
    const result = await createRunner({ docker: fake.client, logger, instance: 'i' }).run(request());
    expect(result).toMatchObject({ status: 'error', error: 'wait broke' });
    expect(fake.calls.at(-1)).toBe('remove');
  });

  it('takes the exit code from inspect when the wait after a kill does not come', async () => {
    let calls = 0;
    const fake = docker({
      start: async () => undefined,
      kill: async () => undefined,
      wait: () => new Promise<number>(() => undefined),
      inspect: async () => {
        calls += 1;
        return { image: 'sha256:img', running: false, exitCode: 137, oomKilled: false };
      },
    });
    const result = await createRunner({ docker: fake.client, logger, instance: 'i' }).run(request({ limits: { ...DEFAULT_LIMITS, timeoutMs: 20 } }));
    expect(result.status).toBe('timeout');
    expect(result.exitCode).toBe(137);
    expect(calls).toBe(1);
  }, 15_000);
});
