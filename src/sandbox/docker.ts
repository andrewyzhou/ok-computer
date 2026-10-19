import type { DockerClient } from './types.js';

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

// endpointOf finds the engine: DOCKER_HOST first (unix:// or tcp://; a tcp:// address with tls is refused with a
// reason), then the socket of docker desktop in the home folder on macos, then /var/run/docker.sock, and on windows
// the pipe //./pipe/docker_engine. exists is given, so a test can say which paths exist.
export function endpointOf(
  _env: NodeJS.ProcessEnv,
  _platform: NodeJS.Platform,
  _home: string,
  _exists: (path: string) => boolean,
): Endpoint | { error: string } {
  throw new Error('not built: endpointOf');
}

export function createDockerClient(_endpoint: Endpoint): DockerClient {
  throw new Error('not built: createDockerClient');
}

// the demuxer splits the stream of an attached container without a tty into stdout and stderr. each frame has an
// 8-byte header: the stream (1 stdout, 2 stderr), three zero bytes, and the length as a big-endian 32-bit number. a
// frame can arrive in parts, so the function keeps the rest between chunks. it is exported for the tests.
export function createDemuxer(_onFrame: (stream: 'stdout' | 'stderr', bytes: Buffer) => void): (chunk: Buffer) => void {
  throw new Error('not built: createDemuxer');
}
