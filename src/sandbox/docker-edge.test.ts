import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { API_VERSION, createDemuxer, createDockerClient, DockerError } from './docker.js';
import type { DockerClient } from './types.js';

// the engine client on the edges of the api: a stream that the engine does not upgrade, an archive of exactly the cap,
// null labels, and error bodies that are not json.

const frame = (stream: number, text: string) => {
  const body = Buffer.from(text);
  const header = Buffer.alloc(8);
  header[0] = stream;
  header.writeUInt32BE(body.length, 4);
  return Buffer.concat([header, body]);
};

describe('createDemuxer on the edges', () => {
  it('passes an empty frame and drops a stdin frame', () => {
    const got: string[] = [];
    const demux = createDemuxer((stream, bytes) => got.push(`${stream}:${bytes.toString()}`));
    demux(Buffer.concat([frame(1, ''), frame(0, 'in'), frame(2, 'err'), frame(1, 'out')]));
    expect(got).toEqual(['stdout:', 'stderr:err', 'stdout:out']);
  });

  it('keeps a frame header that is split from its body', () => {
    const got: string[] = [];
    const demux = createDemuxer((stream, bytes) => got.push(`${stream}:${bytes.toString()}`));
    const whole = frame(2, 'abcdef');
    demux(whole.subarray(0, 3));
    demux(whole.subarray(3, 9));
    demux(whole.subarray(9));
    expect(got.every((each) => each.startsWith('stderr:'))).toBe(true);
    expect(got.map((each) => each.replace(/^stderr:/, '')).join('')).toBe('abcdef');
  });
});

describe.skipIf(process.platform === 'win32')('createDockerClient on the edges', () => {
  let dir: string;
  let server: Server;
  let docker: DockerClient;
  let handle: (req: IncomingMessage, res: ServerResponse) => void = (_req, res) => res.writeHead(404).end();
  const prefix = `/${API_VERSION}`;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'okc-de-'));
    const socketPath = join(dir, 'e.sock');
    server = createServer((req, res) => {
      req.resume();
      req.on('end', () => handle(req, res));
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    docker = createDockerClient({ socketPath });
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  });

  it('splits the raw stream of an engine that answers the attach with 200', async () => {
    handle = (req, res) => {
      expect(req.url).toBe(`${prefix}/containers/c1/attach?stream=1&stdout=1&stderr=1`);
      res.writeHead(200, { 'content-type': 'application/vnd.docker.raw-stream' });
      res.write(frame(1, 'hello '));
      res.end(Buffer.concat([frame(2, 'oops'), frame(1, 'world')]));
    };
    const attached = await docker.attach('c1');
    const read = (stream: NodeJS.ReadableStream) =>
      new Promise<string>((resolve) => {
        const chunks: Buffer[] = [];
        stream.on('data', (chunk: Buffer) => chunks.push(chunk));
        stream.on('end', () => resolve(Buffer.concat(chunks).toString()));
      });
    const [out, err] = await Promise.all([read(attached.stdout), read(attached.stderr)]);
    expect(out).toBe('hello world');
    expect(err).toBe('oops');
    attached.close();
  });

  it('gives the error of an attach that the engine refuses', async () => {
    handle = (_req, res) => res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ message: 'No such container: c9' }));
    await expect(docker.attach('c9')).rejects.toMatchObject({ status: 404, message: 'No such container: c9' });
  });

  it('reads an archive of exactly the cap and refuses one byte more', async () => {
    const body = Buffer.alloc(2048, 1);
    handle = (_req, res) => res.writeHead(200, { 'content-type': 'application/x-tar' }).end(body);
    expect((await docker.getArchive('c1', '/work/a', 2048)).length).toBe(2048);
    await expect(docker.getArchive('c1', '/work/a', 2047)).rejects.toMatchObject({ status: 413 });
    expect(await docker.archiveSize('c1', '/work', 2048)).toBe(2048);
    expect(await docker.archiveSize('c1', '/work', 100)).toBe(101);
  });

  it('escapes the archive path in the query', async () => {
    let url = '';
    handle = (req, res) => {
      url = req.url ?? '';
      res.writeHead(200).end(Buffer.alloc(0));
    };
    await docker.getArchive('c1', '/work/a b&c=d?.csv', 10);
    expect(url).toBe(`${prefix}/containers/c1/archive?path=${encodeURIComponent('/work/a b&c=d?.csv')}`);
  });

  it('gives empty labels for null labels and no volumes for a null list', async () => {
    handle = (req, res) => {
      if (req.url?.startsWith(`${prefix}/containers/json`)) return void res.writeHead(200).end(JSON.stringify([{ Id: 'x', Labels: null }]));
      if (req.url?.startsWith(`${prefix}/volumes`)) return void res.writeHead(200).end(JSON.stringify({ Volumes: null }));
      if (req.url?.startsWith(`${prefix}/networks`)) return void res.writeHead(200).end(JSON.stringify([{ Name: 'n', Labels: null }]));
      res.writeHead(404).end();
    };
    expect(await docker.listContainers('a=b')).toEqual([{ id: 'x', labels: {}, createdAt: new Date(0).toISOString() }]);
    expect(await docker.listVolumes('a=b')).toEqual([]);
    expect(await docker.listNetworks('a=b')).toEqual([{ name: 'n', labels: {} }]);
  });

  it('gives the status as the text of an html error, and the 409 of a volume in use', async () => {
    handle = (req, res) => {
      if (req.method === 'DELETE') return void res.writeHead(409, { 'content-type': 'application/json' }).end(JSON.stringify({ message: 'volume is in use' }));
      res.writeHead(502, { 'content-type': 'text/html' }).end('<html>bad gateway</html>');
    };
    await expect(docker.info()).rejects.toMatchObject({ status: 502, message: 'docker answered 502' });
    const err = await docker.removeVolume('v').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DockerError);
    expect(err).toMatchObject({ status: 409 });
  });

  it('gives the exit code of a command that a signal ended', async () => {
    handle = (_req, res) => res.writeHead(200).end(JSON.stringify({ StatusCode: 137, Error: null }));
    expect(await docker.wait('c1')).toBe(137);
  });
});
