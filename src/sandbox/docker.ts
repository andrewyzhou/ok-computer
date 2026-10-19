import { request as httpRequest, type ClientRequest, type IncomingMessage } from 'node:http';
import type { Socket } from 'node:net';
import { PassThrough } from 'node:stream';
import type { Attached, DockerClient, Waiting } from './types.js';

// the sandbox talks to the docker engine api over its socket with node:http, not through the docker cli. DESIGN-NEXT
// (phase 5, m9) gives the reasons. this file is the only part that knows the http shapes of the api.

// the api version that the client asks for. docker 25 and later answer it, and an older engine answers with an error.
export const API_VERSION = 'v1.44';

// how to reach the engine. socketPath is a unix socket or, on windows, a named pipe. host and port come from a
// DOCKER_HOST of the form tcp://host:port.
export type Endpoint = { socketPath: string } | { host: string; port: number };

export class DockerError extends Error {
  constructor(
    message: string,
    // the http status of the answer, or undefined for a socket error.
    readonly status?: number,
  ) {
    super(message);
  }
}

// endpointOf finds the engine: DOCKER_HOST first (unix://, npipe:// or tcp://; a tcp:// address with tls is refused
// with a reason), then the socket of docker desktop in the home folder on macos, then /var/run/docker.sock, then on
// linux the socket of docker desktop in the home folder and the rootless socket in $XDG_RUNTIME_DIR, and on windows
// the pipe //./pipe/docker_engine. it does not read docker contexts. exists is given, so a test can say which paths
// exist.
export function endpointOf(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  home: string,
  exists: (path: string) => boolean,
): Endpoint | { error: string } {
  const host = env.DOCKER_HOST?.trim();
  if (host) {
    if (host.startsWith('unix://')) {
      const path = host.slice('unix://'.length);
      return path ? { socketPath: path } : { error: `DOCKER_HOST ${host} has no socket path` };
    }
    if (host.startsWith('npipe://')) {
      // npipe:////./pipe/name names the pipe \\.\pipe\name.
      const pipe = host.slice('npipe://'.length).replace(/^\/+/, '').replaceAll('/', '\\');
      return pipe ? { socketPath: `\\\\${pipe}` } : { error: `DOCKER_HOST ${host} has no pipe name` };
    }
    if (host.startsWith('tcp://')) {
      if (env.DOCKER_TLS_VERIFY || env.DOCKER_CERT_PATH) return { error: 'DOCKER_HOST uses tls, which the sandbox does not support. Use the local socket' };
      const match = /^tcp:\/\/(\[[^\]]+\]|[^:/[\]]+):(\d+)\/?$/.exec(host);
      if (!match) return { error: `DOCKER_HOST ${host} is not of the form tcp://host:port` };
      return { host: match[1]!.replace(/^\[|\]$/g, ''), port: Number(match[2]) };
    }
    return { error: `DOCKER_HOST ${host} has a scheme that the sandbox does not support. Use unix://, npipe:// or tcp://` };
  }
  if (platform === 'win32') return { socketPath: '\\\\.\\pipe\\docker_engine' };
  if (platform === 'darwin') {
    const desktop = `${home}/.docker/run/docker.sock`;
    if (exists(desktop)) return { socketPath: desktop };
  }
  if (exists('/var/run/docker.sock')) return { socketPath: '/var/run/docker.sock' };
  if (platform === 'linux') {
    const desktop = `${home}/.docker/desktop/docker.sock`;
    if (exists(desktop)) return { socketPath: desktop };
    const runtime = env.XDG_RUNTIME_DIR?.trim();
    if (runtime && exists(`${runtime}/docker.sock`)) return { socketPath: `${runtime}/docker.sock` };
  }
  return { error: 'no docker socket was found. Install and start Docker, or set DOCKER_HOST' };
}

interface Call {
  // a json body.
  body?: unknown;
  // a raw body, for example a tar. it goes as is with this content type.
  raw?: { bytes: Buffer; type: string };
  headers?: Record<string, string>;
  signal?: AbortSignal | undefined;
}

// the error of an answer that is not 2xx. the engine sends {"message": "..."}.
function errorOf(status: number, body: Buffer): DockerError {
  let message = `docker answered ${status}`;
  try {
    const parsed = JSON.parse(body.toString('utf8')) as { message?: unknown };
    if (typeof parsed.message === 'string' && parsed.message) message = parsed.message;
  } catch {
    // the body is not json, so the status is the message.
  }
  return new DockerError(message, status);
}

const ok = (status: number) => status >= 200 && status < 300;

const readBody = (res: IncomingMessage) =>
  new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    res.on('data', (chunk: Buffer) => chunks.push(chunk));
    res.on('end', () => resolve(Buffer.concat(chunks)));
    res.on('error', (err) => reject(new DockerError(err.message)));
  });

// isLoopback tells if a tcp endpoint stays on this machine. the code and the files of a call go to the engine in
// plain text, so the app warns about any other host.
export const isLoopback = (endpoint: Endpoint) =>
  'socketPath' in endpoint || endpoint.host === 'localhost' || endpoint.host === '::1' || /^127\./.test(endpoint.host);

// the body of an error answer. a body that breaks off still gives the status.
const errorBody = (res: IncomingMessage) => readBody(res).catch(() => Buffer.alloc(0));

export function createDockerClient(endpoint: Endpoint): DockerClient {
  const target = 'socketPath' in endpoint ? { socketPath: endpoint.socketPath } : { host: endpoint.host, port: endpoint.port };

  // open sends one request and gives the request and its answer. the caller reads the body. agent false gives each
  // request its own connection, so an attached stream never shares a socket with another request.
  function open(method: string, path: string, call: Call = {}): { req: ClientRequest; answer: Promise<IncomingMessage> } {
    const headers: Record<string, string> = { ...call.headers };
    let payload: Buffer | undefined;
    if (call.raw) {
      payload = call.raw.bytes;
      headers['content-type'] = call.raw.type;
    } else if (call.body !== undefined) {
      payload = Buffer.from(JSON.stringify(call.body));
      headers['content-type'] = 'application/json';
    }
    if (payload) headers['content-length'] = String(payload.length);
    const req = httpRequest({ ...target, method, path: `/${API_VERSION}${path}`, headers, agent: false, ...(call.signal ? { signal: call.signal } : {}) });
    const answer = new Promise<IncomingMessage>((resolve, reject) => {
      req.on('response', resolve);
      req.on('error', (err) => reject(new DockerError(err.message)));
    });
    // a caller that waits for the upgrade event and not for the answer must not see an unhandled rejection.
    answer.catch(() => {});
    req.end(payload);
    return { req, answer };
  }

  // send sends one request and reads the whole answer. a status in allow is not an error.
  async function send(method: string, path: string, call: Call = {}, allow: number[] = []): Promise<{ status: number; body: Buffer }> {
    const res = await open(method, path, call).answer;
    const body = await readBody(res);
    const status = res.statusCode ?? 0;
    if (!ok(status) && !allow.includes(status)) throw errorOf(status, body);
    return { status, body };
  }

  const json = <T>(body: Buffer) => JSON.parse(body.toString('utf8')) as T;
  const container = (id: string) => `/containers/${encodeURIComponent(id)}`;
  const filters = (label: string) => encodeURIComponent(JSON.stringify({ label: [label] }));
  const archivePath = (id: string, path: string) => `${container(id)}/archive?path=${encodeURIComponent(path)}`;

  // archive streams the tar of a path. keep is false for archiveSize, which only counts the bytes. at the cap the
  // request ends, so a large /work never fills the memory of the app.
  async function archive(id: string, path: string, maxBytes: number, keep: boolean, signal?: AbortSignal): Promise<{ bytes: Buffer; size: number; over: boolean }> {
    const { req, answer } = open('GET', archivePath(id, path), { signal });
    const res = await answer;
    const status = res.statusCode ?? 0;
    if (!ok(status)) throw errorOf(status, await errorBody(res));
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      let done = false;
      res.on('data', (chunk: Buffer) => {
        if (done) return;
        size += chunk.length;
        if (size > maxBytes) {
          done = true;
          req.destroy();
          resolve({ bytes: Buffer.alloc(0), size: maxBytes + 1, over: true });
          return;
        }
        if (keep) chunks.push(chunk);
      });
      res.on('end', () => {
        if (done) return;
        done = true;
        resolve({ bytes: Buffer.concat(chunks), size, over: false });
      });
      res.on('error', (err) => {
        if (done) return;
        done = true;
        reject(new DockerError(err.message));
      });
    });
  }

  return {
    async info(signal) {
      const { body } = await send('GET', '/version', { signal });
      const version = json<{ Version?: string; Os?: string; Arch?: string }>(body);
      const os = version.Os ?? 'unknown';
      const arch = version.Arch ?? 'unknown';
      return { engine: `docker ${version.Version ?? 'unknown'} (${os}/${arch})`, os, arch };
    },
    async imageId(image, signal) {
      const { status, body } = await send('GET', `/images/${encodeURIComponent(image)}/json`, { signal }, [404]);
      return status === 404 ? null : json<{ Id: string }>(body).Id;
    },
    async createContainer(name, spec, signal) {
      const { body } = await send('POST', `/containers/create?name=${encodeURIComponent(name)}`, { body: spec, signal });
      return json<{ Id: string }>(body).Id;
    },
    async putArchive(id, path, tar, signal) {
      await send('PUT', archivePath(id, path), { raw: { bytes: tar, type: 'application/x-tar' }, signal });
    },
    async getArchive(id, path, maxBytes, signal) {
      const got = await archive(id, path, maxBytes, true, signal);
      if (got.over) throw new DockerError(`the files are over ${maxBytes} bytes`, 413);
      return got.bytes;
    },
    async archiveSize(id, path, maxBytes, signal) {
      return (await archive(id, path, maxBytes, false, signal)).size;
    },
    async attach(id, signal) {
      const { req, answer } = open('POST', `${container(id)}/attach?stream=1&stdout=1&stderr=1`, {
        headers: { Connection: 'Upgrade', Upgrade: 'tcp' },
        signal,
      });
      // the engine answers 101 and gives the socket. an engine that does not upgrade answers 200 with a raw stream.
      const raw = await new Promise<{ stream: Socket | IncomingMessage; head: Buffer }>((resolve, reject) => {
        req.on('upgrade', (_res: IncomingMessage, socket: Socket, head: Buffer) => resolve({ stream: socket, head }));
        answer.then(async (res) => {
          const status = res.statusCode ?? 0;
          if (ok(status)) resolve({ stream: res, head: Buffer.alloc(0) });
          else reject(errorOf(status, await errorBody(res)));
        }, reject);
      });
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const demux = createDemuxer((stream, bytes) => (stream === 'stdout' ? stdout : stderr).write(bytes));
      let ended = false;
      const end = () => {
        if (ended) return;
        ended = true;
        stdout.end();
        stderr.end();
      };
      if (raw.head.length) demux(raw.head);
      raw.stream.on('data', (chunk: Buffer) => demux(chunk));
      raw.stream.on('end', end);
      raw.stream.on('close', end);
      // a socket error ends the output. the exit code still comes from wait.
      raw.stream.on('error', end);
      const attached: Attached = {
        stdout,
        stderr,
        close() {
          raw.stream.destroy();
          end();
        },
      };
      return attached;
    },
    async start(id, signal) {
      // 304 is a container that runs already.
      await send('POST', `${container(id)}/start`, { signal }, [304]);
    },
    wait(id, signal) {
      // the engine sends the headers of the answer only after it has registered the waiter. registered resolves
      // then, so the runner starts the container after it, and a short command cannot exit before the wait.
      const answer = open('POST', `${container(id)}/wait?condition=next-exit`, { signal }).answer;
      const exit = answer.then(async (res) => {
        const body = await readBody(res);
        const status = res.statusCode ?? 0;
        if (!ok(status)) throw errorOf(status, body);
        return json<{ StatusCode: number }>(body).StatusCode;
      });
      const registered = answer.then(() => undefined);
      registered.catch(() => {});
      return Object.assign(exit, { registered }) as Waiting;
    },
    async inspect(id, signal) {
      const { body } = await send('GET', `${container(id)}/json`, { signal });
      const found = json<{ Image: string; State?: { Running?: boolean; ExitCode?: number; OOMKilled?: boolean } }>(body);
      return {
        image: found.Image,
        running: found.State?.Running === true,
        exitCode: typeof found.State?.ExitCode === 'number' ? found.State.ExitCode : null,
        oomKilled: found.State?.OOMKilled === true,
      };
    },
    async kill(id, signal) {
      // 404 is a container that is gone, and 409 one that does not run. both are the state that kill wants.
      await send('POST', `${container(id)}/kill`, { signal }, [404, 409]);
    },
    async removeContainer(id, signal) {
      await send('DELETE', `${container(id)}?force=1&v=0`, { signal }, [404]);
    },
    async listContainers(label, signal) {
      const { body } = await send('GET', `/containers/json?all=1&filters=${filters(label)}`, { signal });
      return json<Array<{ Id: string; Labels?: Record<string, string> | null; Created?: number }>>(body).map((found) => ({
        id: found.Id,
        labels: found.Labels ?? {},
        createdAt: new Date((found.Created ?? 0) * 1000).toISOString(),
      }));
    },
    async createVolume(name, labels, signal) {
      await send('POST', '/volumes/create', { body: { Name: name, Labels: labels }, signal });
    },
    async removeVolume(name, signal) {
      // a 409 is a volume that a container still uses, and the caller must know it, so only 404 is allowed.
      await send('DELETE', `/volumes/${encodeURIComponent(name)}`, { signal }, [404]);
    },
    async listVolumes(label, signal) {
      const { body } = await send('GET', `/volumes?filters=${filters(label)}`, { signal });
      const found = json<{ Volumes?: Array<{ Name: string; Labels?: Record<string, string> | null }> | null }>(body);
      return (found.Volumes ?? []).map((volume) => ({ name: volume.Name, labels: volume.Labels ?? {} }));
    },
    async createNetwork(name, options, signal) {
      const { body } = await send('POST', '/networks/create', {
        body: { Name: name, Internal: options.internal, Labels: options.labels, CheckDuplicate: true },
        signal,
      });
      return json<{ Id: string }>(body).Id;
    },
    async removeNetwork(name, signal) {
      await send('DELETE', `/networks/${encodeURIComponent(name)}`, { signal }, [404]);
    },
    async listNetworks(label, signal) {
      const { body } = await send('GET', `/networks?filters=${filters(label)}`, { signal });
      return json<Array<{ Name: string; Labels?: Record<string, string> | null; Created?: string }>>(body).map((network) => ({
        name: network.Name,
        labels: network.Labels ?? {},
        ...(network.Created ? { createdAt: network.Created } : {}),
      }));
    },
  };
}

// the demuxer splits the stream of an attached container without a tty into stdout and stderr. each frame has an
// 8-byte header: the stream (1 stdout, 2 stderr), three zero bytes, and the length as a big-endian 32-bit number. a
// frame can arrive in parts, so the function keeps the rest between chunks. it is exported for the tests.
export function createDemuxer(onFrame: (stream: 'stdout' | 'stderr', bytes: Buffer) => void): (chunk: Buffer) => void {
  let rest: Buffer = Buffer.alloc(0);
  let broken = false;
  return (chunk) => {
    if (broken) return;
    rest = rest.length ? Buffer.concat([rest, chunk]) : chunk;
    while (rest.length >= 8) {
      const stream = rest[0]!;
      // a header that does not fit the format means the stream is not framed, so the parse stops and drops the rest.
      if (stream > 2 || rest[1] !== 0 || rest[2] !== 0 || rest[3] !== 0) {
        broken = true;
        rest = Buffer.alloc(0);
        return;
      }
      const length = rest.readUInt32BE(4);
      if (rest.length < 8 + length) break;
      const bytes = rest.subarray(8, 8 + length);
      rest = rest.subarray(8 + length);
      // stream 0 is stdin, which the sandbox never attaches.
      if (stream === 1) onFrame('stdout', bytes);
      else if (stream === 2) onFrame('stderr', bytes);
    }
  };
}
