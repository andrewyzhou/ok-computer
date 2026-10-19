import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { API_VERSION, createDemuxer, createDockerClient, DockerError, endpointOf } from './docker.js';
import type { ContainerSpec, DockerClient } from './types.js';

describe('endpointOf', () => {
  const none = () => false;
  const all = () => true;

  it('reads a unix DOCKER_HOST', () => {
    expect(endpointOf({ DOCKER_HOST: 'unix:///run/user/1000/docker.sock' }, 'linux', '/home/a', none)).toEqual({ socketPath: '/run/user/1000/docker.sock' });
  });

  it('reads an npipe DOCKER_HOST', () => {
    expect(endpointOf({ DOCKER_HOST: 'npipe:////./pipe/docker_engine_x' }, 'win32', 'C:\\Users\\a', none)).toEqual({ socketPath: '\\\\.\\pipe\\docker_engine_x' });
  });

  it('reads a tcp DOCKER_HOST', () => {
    expect(endpointOf({ DOCKER_HOST: 'tcp://127.0.0.1:2375' }, 'linux', '/home/a', all)).toEqual({ host: '127.0.0.1', port: 2375 });
  });

  it('refuses a tcp DOCKER_HOST with tls', () => {
    const error = { error: 'DOCKER_HOST uses tls, which the sandbox does not support. Use the local socket' };
    expect(endpointOf({ DOCKER_HOST: 'tcp://h:2376', DOCKER_TLS_VERIFY: '1' }, 'linux', '/home/a', all)).toEqual(error);
    expect(endpointOf({ DOCKER_HOST: 'tcp://h:2376', DOCKER_CERT_PATH: '/certs' }, 'linux', '/home/a', all)).toEqual(error);
  });

  it('refuses another scheme and a bad tcp address', () => {
    expect(endpointOf({ DOCKER_HOST: 'ssh://user@host' }, 'linux', '/home/a', all)).toHaveProperty('error');
    expect(endpointOf({ DOCKER_HOST: 'tcp://host' }, 'linux', '/home/a', all)).toHaveProperty('error');
  });

  it('uses the named pipe on windows', () => {
    expect(endpointOf({}, 'win32', 'C:\\Users\\a', none)).toEqual({ socketPath: '\\\\.\\pipe\\docker_engine' });
  });

  it('prefers the socket in the home folder on macos', () => {
    expect(endpointOf({}, 'darwin', '/Users/a', all)).toEqual({ socketPath: '/Users/a/.docker/run/docker.sock' });
    expect(endpointOf({}, 'darwin', '/Users/a', (path) => path === '/var/run/docker.sock')).toEqual({ socketPath: '/var/run/docker.sock' });
  });

  it('does not use the home socket on linux', () => {
    expect(endpointOf({}, 'linux', '/home/a', all)).toEqual({ socketPath: '/var/run/docker.sock' });
  });

  it('gives a reason when no socket exists', () => {
    expect(endpointOf({}, 'linux', '/home/a', none)).toEqual({ error: 'no docker socket was found. Install and start Docker, or set DOCKER_HOST' });
    expect(endpointOf({}, 'darwin', '/Users/a', none)).toHaveProperty('error');
  });
});

const frame = (stream: number, text: string | Buffer) => {
  const body = typeof text === 'string' ? Buffer.from(text) : text;
  const header = Buffer.alloc(8);
  header[0] = stream;
  header.writeUInt32BE(body.length, 4);
  return Buffer.concat([header, body]);
};

describe('createDemuxer', () => {
  const stream = Buffer.concat([frame(1, 'hello '), frame(2, 'oops'), frame(0, 'ignored'), frame(1, ''), frame(1, 'world')]);

  it('splits the frames at every byte offset', () => {
    for (let cut = 0; cut <= stream.length; cut++) {
      const got = { stdout: '', stderr: '' };
      const demux = createDemuxer((name, bytes) => (got[name] += bytes.toString()));
      demux(stream.subarray(0, cut));
      demux(stream.subarray(cut));
      expect(got).toEqual({ stdout: 'hello world', stderr: 'oops' });
    }
  });

  it('reads a stream that comes one byte at a time', () => {
    const got = { stdout: '', stderr: '' };
    const demux = createDemuxer((name, bytes) => (got[name] += bytes.toString()));
    for (const byte of stream) demux(Buffer.from([byte]));
    expect(got).toEqual({ stdout: 'hello world', stderr: 'oops' });
  });

  it('stops quietly at a bad header', () => {
    const got: string[] = [];
    const demux = createDemuxer((_name, bytes) => got.push(bytes.toString()));
    demux(Buffer.concat([frame(1, 'a'), Buffer.from('not a frame header'), frame(1, 'b')]));
    demux(frame(1, 'c'));
    expect(got).toEqual(['a']);
  });
});

interface Seen {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
  body: Buffer;
}

type Handler = (req: Seen, res: ServerResponse) => void;

describe.skipIf(process.platform === 'win32')('createDockerClient with a fake engine', () => {
  let dir: string;
  let server: Server;
  let docker: DockerClient;
  const seen: Seen[] = [];
  const upgraded = new Set<import('node:net').Socket>();
  let handle: Handler = (_req, res) => res.writeHead(404).end();
  let onUpgrade: (req: IncomingMessage, socket: import('node:net').Socket) => void = (_req, socket) => socket.destroy();
  const prefix = `/${API_VERSION}`;

  const reply = (status: number, body?: unknown) => (_req: Seen, res: ServerResponse) => {
    if (body === undefined) res.writeHead(status).end();
    else res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  };

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'okc-docker-'));
    const socketPath = join(dir, 'engine.sock');
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const entry = { method: req.method!, url: req.url!, headers: req.headers, body: Buffer.concat(chunks) };
        seen.push(entry);
        handle(entry, res);
      });
    });
    server.on('upgrade', (req: IncomingMessage, socket: import('node:net').Socket) => {
      upgraded.add(socket);
      seen.push({ method: req.method!, url: req.url!, headers: req.headers, body: Buffer.alloc(0) });
      onUpgrade(req, socket);
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    docker = createDockerClient({ socketPath });
  });

  afterAll(async () => {
    server.closeAllConnections();
    // the server does not track the sockets that it upgraded, so the test ends them.
    for (const socket of upgraded) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(() => {
    seen.length = 0;
  });

  const last = () => seen.at(-1)!;
  const bodyOf = (entry: Seen) => JSON.parse(entry.body.toString()) as unknown;

  it('reads the engine version', async () => {
    handle = reply(200, { Version: '28.3.0', Os: 'linux', Arch: 'arm64' });
    expect(await docker.info()).toEqual({ engine: 'docker 28.3.0 (linux/arm64)', os: 'linux', arch: 'arm64' });
    expect(last()).toMatchObject({ method: 'GET', url: `${prefix}/version` });
  });

  it('gives the image id, and null for a missing image', async () => {
    handle = reply(200, { Id: 'sha256:abc' });
    expect(await docker.imageId('okc-sandbox:1')).toBe('sha256:abc');
    expect(last().url).toBe(`${prefix}/images/okc-sandbox%3A1/json`);
    handle = reply(404, { message: 'No such image: okc-sandbox:1' });
    expect(await docker.imageId('okc-sandbox:1')).toBeNull();
  });

  it('turns the json message of an error into the error text', async () => {
    handle = reply(500, { message: 'the engine is sad' });
    const err = await docker.info().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DockerError);
    expect(err).toMatchObject({ message: 'the engine is sad', status: 500 });
  });

  it('gives the status when the error has no json body', async () => {
    handle = (_req, res) => res.writeHead(502).end('bad gateway');
    await expect(docker.info()).rejects.toMatchObject({ message: 'docker answered 502', status: 502 });
  });

  it('gives a socket error without a status', async () => {
    const lost = createDockerClient({ socketPath: join(dir, 'missing.sock') });
    const err = (await lost.info().catch((e: unknown) => e)) as DockerError;
    expect(err).toBeInstanceOf(DockerError);
    expect(err.status).toBeUndefined();
  });

  it('ends a request when the signal aborts', async () => {
    handle = () => {};
    const controller = new AbortController();
    const pending = docker.info(controller.signal);
    setTimeout(() => controller.abort(), 20);
    await expect(pending).rejects.toBeInstanceOf(DockerError);
  });

  it('creates a container with the spec as the json body', async () => {
    handle = reply(201, { Id: 'c1', Warnings: [] });
    const spec = { Image: 'okc-sandbox:1', Cmd: ['true'] } as unknown as ContainerSpec;
    expect(await docker.createContainer('okc-sandbox-x-1', spec)).toBe('c1');
    expect(last()).toMatchObject({ method: 'POST', url: `${prefix}/containers/create?name=okc-sandbox-x-1` });
    expect(last().headers['content-type']).toBe('application/json');
    expect(bodyOf(last())).toEqual(spec);
  });

  it('puts a tar into a container', async () => {
    handle = reply(200);
    await docker.putArchive('c1', '/work', Buffer.from('tar bytes'));
    expect(last()).toMatchObject({ method: 'PUT', url: `${prefix}/containers/c1/archive?path=%2Fwork` });
    expect(last().headers['content-type']).toBe('application/x-tar');
    expect(last().body.toString()).toBe('tar bytes');
  });

  const streamed: Handler = (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/x-tar' });
    res.write(Buffer.alloc(1000, 1));
    res.write(Buffer.alloc(1000, 2));
    res.end(Buffer.alloc(1000, 3));
  };

  it('reads an archive under the cap', async () => {
    handle = streamed;
    const tar = await docker.getArchive('c1', '/work/out.txt', 5000);
    expect(tar.length).toBe(3000);
    expect(last()).toMatchObject({ method: 'GET', url: `${prefix}/containers/c1/archive?path=%2Fwork%2Fout.txt` });
  });

  it('stops an archive over the cap with a 413', async () => {
    handle = streamed;
    await expect(docker.getArchive('c1', '/work', 1500)).rejects.toMatchObject({ message: 'the files are over 1500 bytes', status: 413 });
  });

  it('gives a 404 for a missing archive path', async () => {
    handle = reply(404, { message: 'Could not find the file /work/x in container c1' });
    await expect(docker.getArchive('c1', '/work/x', 100)).rejects.toMatchObject({ status: 404 });
  });

  it('counts an archive without keeping it', async () => {
    handle = streamed;
    expect(await docker.archiveSize('c1', '/work', 5000)).toBe(3000);
    handle = streamed;
    expect(await docker.archiveSize('c1', '/work', 1500)).toBe(1501);
  });

  it('attaches through the upgrade and splits the streams', async () => {
    onUpgrade = (_req, socket) => {
      socket.write('HTTP/1.1 101 UPGRADED\r\nContent-Type: application/vnd.docker.raw-stream\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n');
      const bytes = Buffer.concat([frame(1, 'out one '), frame(2, 'err one'), frame(1, 'out two')]);
      socket.write(bytes.subarray(0, 11));
      setTimeout(() => socket.end(bytes.subarray(11)), 10);
    };
    const attached = await docker.attach('c1');
    const read = (stream: NodeJS.ReadableStream) =>
      new Promise<string>((resolve) => {
        let text = '';
        stream.on('data', (chunk: Buffer) => (text += chunk.toString()));
        stream.on('end', () => resolve(text));
      });
    const [out, err] = await Promise.all([read(attached.stdout), read(attached.stderr)]);
    expect(out).toBe('out one out two');
    expect(err).toBe('err one');
    const request = last();
    expect(request).toMatchObject({ method: 'POST', url: `${prefix}/containers/c1/attach?stream=1&stdout=1&stderr=1` });
    expect(request.headers.upgrade).toBe('tcp');
    expect(request.headers.connection).toMatch(/upgrade/i);
    attached.close();
  });

  it('closes an attached stream', async () => {
    onUpgrade = (_req, socket) => {
      socket.write('HTTP/1.1 101 UPGRADED\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n');
      socket.write(frame(1, 'part'));
    };
    const attached = await docker.attach('c1');
    const ended = new Promise((resolve) => attached.stdout.on('end', resolve));
    attached.stdout.resume();
    attached.close();
    await ended;
  });

  it('starts a container, and a 304 is ok', async () => {
    handle = reply(204);
    await docker.start('c1');
    expect(last()).toMatchObject({ method: 'POST', url: `${prefix}/containers/c1/start` });
    handle = reply(304);
    await docker.start('c1');
  });

  it('waits for the next exit', async () => {
    handle = reply(200, { StatusCode: 3 });
    expect(await docker.wait('c1')).toBe(3);
    expect(last()).toMatchObject({ method: 'POST', url: `${prefix}/containers/c1/wait?condition=next-exit` });
  });

  it('inspects a container', async () => {
    handle = reply(200, { Image: 'sha256:img', State: { Running: false, ExitCode: 137, OOMKilled: true } });
    expect(await docker.inspect('c1')).toEqual({ image: 'sha256:img', running: false, exitCode: 137, oomKilled: true });
    expect(last()).toMatchObject({ method: 'GET', url: `${prefix}/containers/c1/json` });
  });

  it('kills a container and ignores 404 and 409', async () => {
    handle = reply(204);
    await docker.kill('c1');
    expect(last()).toMatchObject({ method: 'POST', url: `${prefix}/containers/c1/kill` });
    handle = reply(404, { message: 'gone' });
    await docker.kill('c1');
    handle = reply(409, { message: 'not running' });
    await docker.kill('c1');
    handle = reply(500, { message: 'broken' });
    await expect(docker.kill('c1')).rejects.toMatchObject({ status: 500 });
  });

  it('removes a container with force and ignores 404', async () => {
    handle = reply(204);
    await docker.removeContainer('c1');
    expect(last()).toMatchObject({ method: 'DELETE', url: `${prefix}/containers/c1?force=1&v=0` });
    handle = reply(404, { message: 'gone' });
    await docker.removeContainer('c1');
  });

  it('lists the containers of a label', async () => {
    handle = reply(200, [{ Id: 'c1', Labels: { 'okc.exec': '4' }, Created: 1_700_000_000 }]);
    expect(await docker.listContainers('okc.instance=abc')).toEqual([{ id: 'c1', labels: { 'okc.exec': '4' }, createdAt: '2023-11-14T22:13:20.000Z' }]);
    const url = new URL(last().url, 'http://x');
    expect(url.pathname).toBe(`${prefix}/containers/json`);
    expect(url.searchParams.get('all')).toBe('1');
    expect(JSON.parse(url.searchParams.get('filters')!)).toEqual({ label: ['okc.instance=abc'] });
  });

  it('creates, lists and removes volumes', async () => {
    handle = reply(201, { Name: 'v1' });
    await docker.createVolume('v1', { 'okc.sandbox': '1' });
    expect(last()).toMatchObject({ method: 'POST', url: `${prefix}/volumes/create` });
    expect(bodyOf(last())).toEqual({ Name: 'v1', Labels: { 'okc.sandbox': '1' } });

    handle = reply(200, { Volumes: [{ Name: 'v1', Labels: { 'okc.task': 't' } }], Warnings: null });
    expect(await docker.listVolumes('okc.sandbox')).toEqual([{ name: 'v1', labels: { 'okc.task': 't' } }]);
    expect(JSON.parse(new URL(last().url, 'http://x').searchParams.get('filters')!)).toEqual({ label: ['okc.sandbox'] });
    handle = reply(200, { Volumes: null });
    expect(await docker.listVolumes('okc.sandbox')).toEqual([]);

    handle = reply(204);
    await docker.removeVolume('v1');
    expect(last()).toMatchObject({ method: 'DELETE', url: `${prefix}/volumes/v1` });
    handle = reply(404, { message: 'no such volume' });
    await docker.removeVolume('v1');
    handle = reply(409, { message: 'volume is in use' });
    await expect(docker.removeVolume('v1')).rejects.toMatchObject({ message: 'volume is in use', status: 409 });
  });

  it('creates and removes networks', async () => {
    handle = reply(201, { Id: 'n1' });
    expect(await docker.createNetwork('okc-net', { internal: true, labels: { 'okc.sandbox': '1' } })).toBe('n1');
    expect(last()).toMatchObject({ method: 'POST', url: `${prefix}/networks/create` });
    expect(bodyOf(last())).toEqual({ Name: 'okc-net', Internal: true, Labels: { 'okc.sandbox': '1' }, CheckDuplicate: true });
    handle = reply(204);
    await docker.removeNetwork('okc-net');
    expect(last()).toMatchObject({ method: 'DELETE', url: `${prefix}/networks/okc-net` });
    handle = reply(404, { message: 'gone' });
    await docker.removeNetwork('okc-net');
  });
});
