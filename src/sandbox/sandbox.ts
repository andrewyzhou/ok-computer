import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Config } from '../config/schema.js';
import type { SandboxStatus } from '../dashboard/types.js';
import type { Db } from '../db/index.js';
import type { BlobStore } from '../observability/blobs.js';
import { createByteStore } from '../observability/byte-blobs.js';
import type { Logger } from '../observability/logger.js';
import { MAIN_SESSION } from '../sessions/router.js';
import type { Clock } from '../time.js';
import { errorText, type Tool } from '../tools/registry.js';
import { publicEgress, type Egress } from '../web/egress.js';
import { createDockerClient, endpointOf, isLoopback } from './docker.js';
import { DEFAULT_LIMITS, DOCKER_STEP_MS, MAX_LIMITS, PROBE_TIMEOUT_MS, SANDBOX_IMAGE, STALE_MARGIN_MS, STATUS_TTL_MS, SWEEP_MS } from './limits.js';
import { createNetworkGate, sweepNetworks } from './network.js';
import { createRunner, sweepContainers } from './runner.js';
import { createScratch, type Scratch } from './scratch.js';
import { closeStale } from './store.js';
import { createSandboxExecTool, SANDBOX_EXEC } from './tool.js';
import type { DockerClient, NetworkGate, Probe, Runner } from './types.js';

export const SANDBOX_TOOLS: readonly string[] = [SANDBOX_EXEC];

// tests give a fake docker client, a fake runner or a fake network gate. the app finds the docker of the host.
export interface SandboxOptions {
  docker?: DockerClient;
  runner?: Runner;
  network?: NetworkGate;
  scratch?: Scratch;
  image?: string;
}

export interface Sandbox {
  // the tool is in the registry when the sandbox is set up. toolsFor decides which sessions get it.
  tools: Tool[];
  // the main session and automation runs get sandbox_exec when docker answered at the start. the list does not change
  // while the app runs, so the tools parameter of a session stays the same. a start after docker comes up adds it.
  toolsFor(sessionKey: string): readonly string[];
  // the status for the dashboard. it probes docker again after STATUS_TTL_MS.
  status(): Promise<SandboxStatus>;
  // start probes docker, closes the rows of a stopped process, and removes its containers, networks and idle volumes.
  // it runs the same sweep once more after the longest call, for the execs that a stopped process left young.
  start(): Promise<void>;
  // stop ends the execs that run now and waits until their containers are removed.
  stop(): Promise<void>;
}

interface Deps extends SandboxOptions {
  db: Db;
  blobs: BlobStore;
  logger: Logger;
  clock: Clock;
  config: Config;
  egress?: Egress;
  // false when the process did not set the sandbox up, for example in a test. the tool is then off and nothing
  // talks to docker.
  enabled: boolean;
}

const OFF = 'the code sandbox is not set up in this process';

// two installs on one host (a test and the service, for example) have other data folders, so each one sweeps only its
// own containers and volumes. npm run chat and the service share the data folder and so the instance.
export const instanceOf = (dataDir: string) => createHash('sha256').update(resolve(dataDir)).digest('hex').slice(0, 12);

const staleMs = MAX_LIMITS.timeoutMs + STALE_MARGIN_MS;

// stop waits this long for the execs that it ends. the runner kills and removes each container within its step limits.
const STOP_MS = 2 * DOCKER_STEP_MS;

// within resolves when the promise settles, or after ms, so an engine that hangs never holds the start or the stop.
const within = (promise: Promise<unknown>, ms: number) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
    void promise.finally(() => {
      clearTimeout(timer);
      resolve();
    });
  });

export function createSandbox(deps: Deps): Sandbox {
  const { db, logger, clock, config } = deps;
  const image = deps.image ?? SANDBOX_IMAGE;
  const instance = instanceOf(config.paths.data);
  const live = new Set<number>();
  const running = new Map<number, { stop: AbortController; done: Promise<unknown> }>();
  let again: NodeJS.Timeout | undefined;
  let last: Probe = { available: false, reason: OFF, engine: null, imageId: null };
  let lastAt = -Infinity;
  let atStart = false;

  // the parts are made only when the process sets the sandbox up. a part that fails to start turns the sandbox off
  // with the reason, and the rest of the app runs.
  let parts: { docker: DockerClient; network: NetworkGate; scratch: Scratch; tool: Tool } | undefined;
  if (deps.enabled) {
    try {
      const found = deps.docker ? undefined : endpointOf(process.env, process.platform, homedir(), existsSync);
      if (found && 'error' in found) throw new Error(found.error);
      // the code and the files of each call go to the engine in plain text over tcp.
      if (found && !isLoopback(found)) logger.warn('DOCKER_HOST is a tcp address on another host, so the code and the files of each call go to it unencrypted', { host: 'host' in found ? found.host : undefined });
      const docker = deps.docker ?? createDockerClient(found!);
      const network = deps.network ?? createNetworkGate({ docker, egress: deps.egress ?? publicEgress, logger, instance, image });
      const scratch = deps.scratch ?? createScratch({ db, docker, clock, instance });
      const runner = deps.runner ?? createRunner({ docker, logger, instance });
      const stores = { blobs: deps.blobs, bytes: createByteStore(db, join(config.paths.data, 'blobs'), clock) };
      const tool = createSandboxExecTool({ db, stores, runner, scratch, network, logger, clock, image, probe: () => last, live, running });
      parts = { docker, network, scratch, tool };
    } catch (err) {
      last = { ...last, reason: `the code sandbox did not start: ${errorText(err)}` };
      logger.error('sandbox setup failed', { err });
    }
  }

  async function probe(): Promise<Probe> {
    if (!parts) return last;
    const signal = AbortSignal.timeout(PROBE_TIMEOUT_MS);
    try {
      const info = await parts.docker.info(signal);
      if (info.os !== 'linux') {
        last = { available: false, reason: `docker runs ${info.os} containers. Switch Docker Desktop to Linux containers`, engine: info.engine, imageId: null };
        lastAt = performance.now();
        return last;
      }
      const imageId = await parts.docker.imageId(image, signal);
      last = imageId
        ? { available: true, reason: null, engine: info.engine, imageId }
        : { available: false, reason: `the image ${image} is missing. Build it with npm run sandbox:image`, engine: info.engine, imageId: null };
    } catch (err) {
      last = { available: false, reason: `docker does not answer: ${errorText(err)}`, engine: null, imageId: null };
    }
    lastAt = performance.now();
    return last;
  }

  // the rows of a stopped process are closed also when docker is off now, so the trace never shows a command that runs
  // forever. this needs only the database.
  function closeRows() {
    try {
      const closed = closeStale(db, clock(), staleMs, live);
      if (closed.length) logger.warn('closed the sandbox execs of a stopped app', { execs: closed });
    } catch (err) {
      logger.error('sandbox stale sweep failed', { err });
    }
  }

  // sweep removes the containers, networks and volumes of the execs that do not run now. it has a time limit, so an
  // engine that hangs never holds the start of the app.
  async function sweep(found: NonNullable<typeof parts>) {
    const signal = AbortSignal.timeout(SWEEP_MS);
    const work = (async () => {
      const keep = (execId: number) =>
        db.prepare("SELECT 1 AS x FROM sandbox_execs WHERE id = ? AND status = 'running' AND createdAt > ?").get(execId, new Date(clock().getTime() - staleMs).toISOString()) !== undefined;
      // the relay containers of a call with network access go with the other containers, so their networks are free
      // to remove after them.
      const containers = await sweepContainers(found.docker, instance, keep, signal);
      const networks = await sweepNetworks(found.docker, instance, keep, { signal });
      const volumes = await found.scratch.sweep();
      if (containers || networks || volumes) logger.info('sandbox sweep', { containers, networks, volumes });
    })().catch((err: unknown) => logger.error('sandbox sweep failed', { err }));
    await within(work, SWEEP_MS);
  }

  return {
    tools: parts ? [parts.tool] : [],
    toolsFor: (sessionKey) => (atStart && (sessionKey === MAIN_SESSION || sessionKey.startsWith('auto:')) ? SANDBOX_TOOLS : []),
    async status() {
      const current = parts && performance.now() - lastAt > STATUS_TTL_MS ? await probe() : last;
      const network = current.available && parts ? await parts.network.check().catch((err: unknown) => ({ ok: false as const, reason: errorText(err) })) : undefined;
      return {
        available: current.available,
        reason: current.reason,
        engine: current.engine,
        image,
        defaults: DEFAULT_LIMITS,
        network: network?.ok === true,
        networkReason: network === undefined ? current.reason : network.ok ? null : network.reason,
      };
    },
    async start() {
      if (!deps.enabled) return;
      closeRows();
      if (!parts) return;
      const found = await probe();
      atStart = found.available;
      if (!found.available) {
        logger.info('the code sandbox is off', { reason: found.reason });
        return;
      }
      await sweep(parts);
      // a stopped process can leave an exec younger than staleMs, which this sweep keeps. its container ends itself at
      // its wall time, and this second sweep closes its row and removes what is left.
      again = setTimeout(() => {
        again = undefined;
        closeRows();
        if (parts) void sweep(parts);
      }, staleMs);
      again.unref();
    },
    // a run that stops aborts the signal of its tool call, and the runner then kills its container. the stop of the
    // app does the same for each exec that runs now, and waits until the runner has removed its container.
    async stop() {
      if (again) clearTimeout(again);
      again = undefined;
      last = { ...last, available: false, reason: 'the app is stopping' };
      const ending = [...running.values()];
      for (const exec of ending) exec.stop.abort();
      await within(Promise.allSettled(ending.map((exec) => exec.done)), STOP_MS);
    },
  };
}
