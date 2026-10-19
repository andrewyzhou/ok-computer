import type { Readable } from 'node:stream';
import type { SandboxEgress, SandboxExecStatus, SandboxLanguage, SandboxLimits } from '../dashboard/types.js';

// the shapes that the parts of the sandbox share. each part has its own file (see docs/API.md, M9), and this
// file has no code, so a test can fake any part.

// --- the docker engine api (docker.ts) ---

// the body of POST /containers/create, with only the fields that the sandbox sets. runner.ts builds it, and a test
// reads it to check each security setting.
export interface ContainerSpec {
  Image: string;
  // [""] resets the entrypoint of the base image, so Cmd runs as it is and no script of the base sits before it.
  Entrypoint: [''];
  Cmd: string[];
  Env: string[];
  WorkingDir: string;
  User: string;
  Labels: Record<string, string>;
  AttachStdout: true;
  AttachStderr: true;
  AttachStdin: false;
  Tty: false;
  OpenStdin: false;
  NetworkDisabled: boolean;
  HostConfig: {
    NetworkMode: string;
    ReadonlyRootfs: true;
    CapDrop: ['ALL'];
    SecurityOpt: string[];
    Privileged: false;
    // nano cpus: 1e9 is one cpu.
    NanoCpus: number;
    Memory: number;
    // the same as Memory, so the container gets no swap.
    MemorySwap: number;
    PidsLimit: number;
    // fsize keeps one file below the size limit of /work, so a single write cannot fill the disk of the host.
    Ulimits: Array<{ Name: string; Soft: number; Hard: number }>;
    Tmpfs: Record<string, string>;
    Mounts: Array<{ Type: 'volume'; Source: string; Target: string; ReadOnly: false }>;
    ExtraHosts: string[];
    Init: true;
    AutoRemove: false;
  };
}

export interface ContainerState {
  // the image id (sha256:...) that the container runs.
  image: string;
  running: boolean;
  exitCode: number | null;
  oomKilled: boolean;
}

// the two streams of an attached container. the engine sends one stream with an 8-byte header per frame when the
// container has no tty, and the client splits it.
export interface Attached {
  stdout: Readable;
  stderr: Readable;
  close(): void;
}

export interface EngineInfo {
  // for example "docker 28.3.0 (linux/arm64)".
  engine: string;
  os: string;
  arch: string;
}

// the promise of a wait. registered resolves when the engine has registered the waiter, that is when it sent the
// headers of the answer, so a start after it cannot be missed. a fake client can leave it out.
export type Waiting = Promise<number> & { registered?: Promise<void> };

// a typed client for the parts of the engine api that the sandbox uses. each method throws a DockerError on an answer
// that is not 2xx, and on a socket error. the signal ends the request.
export interface DockerClient {
  info(signal?: AbortSignal): Promise<EngineInfo>;
  // the image id (sha256:...) of a local image, or null when the image is not on the host.
  imageId(image: string, signal?: AbortSignal): Promise<string | null>;
  createContainer(name: string, spec: ContainerSpec, signal?: AbortSignal): Promise<string>;
  // the tar goes into the container at path. the container can be created and not started.
  putArchive(id: string, path: string, tar: Buffer, signal?: AbortSignal): Promise<void>;
  // the tar of path. the client stops and throws when the tar is longer than maxBytes.
  getArchive(id: string, path: string, maxBytes: number, signal?: AbortSignal): Promise<Buffer>;
  // the length of the tar of path, counted while it streams and not kept. it stops at maxBytes and gives maxBytes + 1.
  archiveSize(id: string, path: string, maxBytes: number, signal?: AbortSignal): Promise<number>;
  attach(id: string, signal?: AbortSignal): Promise<Attached>;
  start(id: string, signal?: AbortSignal): Promise<void>;
  // wait ends when the container stops and gives its exit code.
  wait(id: string, signal?: AbortSignal): Waiting;
  inspect(id: string, signal?: AbortSignal): Promise<ContainerState>;
  kill(id: string, signal?: AbortSignal): Promise<void>;
  // remove also removes a running container. a missing container is not an error. id can also be the name.
  removeContainer(id: string, signal?: AbortSignal): Promise<void>;
  listContainers(label: string, signal?: AbortSignal): Promise<Array<{ id: string; labels: Record<string, string>; createdAt: string }>>;
  createVolume(name: string, labels: Record<string, string>, signal?: AbortSignal): Promise<void>;
  // a missing volume is not an error.
  removeVolume(name: string, signal?: AbortSignal): Promise<void>;
  listVolumes(label: string, signal?: AbortSignal): Promise<Array<{ name: string; labels: Record<string, string> }>>;
  createNetwork(name: string, options: { internal: boolean; labels: Record<string, string> }, signal?: AbortSignal): Promise<string>;
  // a missing network is not an error.
  removeNetwork(name: string, signal?: AbortSignal): Promise<void>;
  // createdAt is the time that the engine made the network, when it says so.
  listNetworks(label: string, signal?: AbortSignal): Promise<Array<{ name: string; labels: Record<string, string>; createdAt?: string }>>;
}

// --- one exec (runner.ts) ---

export interface FileIn {
  // relative to /work.
  path: string;
  bytes: Buffer;
}

export interface FileOut {
  path: string;
  bytes: Buffer;
}

// the plan of a call with network access. network.ts makes it and closes it after the call.
export interface NetworkPlan {
  // the docker network of the container. it reaches only the proxy.
  networkMode: string;
  // the proxy variables (HTTP_PROXY, HTTPS_PROXY, NO_PROXY, and the lower-case forms).
  env: string[];
  // entries for HostConfig.ExtraHosts, for example the name of the proxy.
  extraHosts: string[];
  // the hosts that the proxy let through, and the requests that it refused, for the result and the trace.
  passed(): string[];
  refused(): Array<{ target: string; reason: string }>;
  close(): Promise<void>;
}

export interface ExecRequest {
  execId: number;
  image: string;
  // for example ["python3", "-c", code]. see commandFor in runner.ts.
  argv: string[];
  env: string[];
  limits: SandboxLimits;
  // the scratch volume, mounted at /work.
  volume: string;
  files: FileIn[];
  // paths under /work that the runner reads after the end.
  collect: string[];
  network?: NetworkPlan;
  labels: Record<string, string>;
  // the run of the call stops: the runner kills the container and gives status killed.
  signal: AbortSignal;
}

export interface ExecResult {
  status: Exclude<SandboxExecStatus, 'running'>;
  exitCode: number | null;
  // at most limits.outputBytes each.
  stdout: Buffer;
  stderr: Buffer;
  // every byte that the command wrote, also the bytes after the cut.
  stdoutBytes: number;
  stderrBytes: number;
  truncated: boolean;
  collected: FileOut[];
  // a collect path that did not exist or was over a limit, with the reason.
  notCollected: Array<{ path: string; reason: string }>;
  containerId: string | null;
  imageId: string | null;
  durationMs: number;
  // the reason of status error, or of killed and timeout.
  error: string | null;
  // the size of /work after the call, or undefined when the runner could not measure it. a size over SCRATCH_BYTES is
  // given as SCRATCH_BYTES + 1.
  scratchBytes: number | undefined;
}

export interface Runner {
  run(request: ExecRequest): Promise<ExecResult>;
}

// --- availability (sandbox.ts) ---

export interface Probe {
  available: boolean;
  reason: string | null;
  engine: string | null;
  imageId: string | null;
}

// --- the network gate (network.ts) ---

export interface NetworkGate {
  // ok is false when the allowlist mode cannot work on this docker host.
  check(): Promise<{ ok: true } | { ok: false; reason: string }>;
  open(execId: number, allowlist: string[]): Promise<NetworkPlan>;
}

// --- the trace (store.ts) ---

export interface NewExec {
  runId: string | null;
  toolCallId: string | null;
  sessionKey: string | null;
  taskId: string | null;
  language: SandboxLanguage;
  command: string;
  image: string;
  cwd: string;
  network: 'none' | 'allowlist';
  allowlist: string[];
  limits: SandboxLimits;
}

export interface ExecEnd {
  status: Exclude<SandboxExecStatus, 'running'>;
  exitCode: number | null;
  imageId: string | null;
  containerId: string | null;
  stdoutBlob: string | null;
  stderrBlob: string | null;
  stdoutBytes: number;
  stderrBytes: number;
  truncated: boolean;
  error: string | null;
  durationMs: number;
  // the hosts that the proxy let through and the requests that it refused, for a call with network access.
  egress?: SandboxEgress | null;
  // the collect paths that did not come back, with the reason.
  notCollected?: Array<{ path: string; reason: string }>;
}

export interface FileRow {
  direction: 'in' | 'out';
  path: string;
  blob: string;
  size: number;
  mime: string;
}
