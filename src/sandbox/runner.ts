import { posix } from 'node:path';
import type { Readable } from 'node:stream';
import type { SandboxLanguage } from '../dashboard/types.js';
import type { Logger } from '../observability/logger.js';
import { errorText } from '../tools/registry.js';
import { DockerError } from './docker.js';
import { DISK_POLL_MS, DOCKER_STEP_MS, EXEC_MARGIN_MS, FILE_LIMITS, LABELS, SANDBOX_USER, SCRATCH_BYTES, TMP_MOUNT, WALL_MARGIN_S, WORK_DIR } from './limits.js';
import { packTar, unpackTar } from './tar.js';
import type { Attached, ContainerSpec, DockerClient, ExecRequest, ExecResult, FileOut, Runner } from './types.js';

// the runner runs one exec in a fresh container: create, put the files in, attach, start, wait with the wall time
// limit and the size limit of /work, read the collect paths, and remove the container in every case.

// commandFor gives the argv of the code. the code is one argument, so no shell quoting is needed.
export function commandFor(language: SandboxLanguage, code: string): string[] {
  switch (language) {
    case 'bash':
      return ['bash', '-c', code];
    case 'python':
      return ['python3', '-c', code];
    case 'node':
      return ['node', '-e', code];
  }
}

// containerSpec gives the body of the create request, with the labels of the instance and the exec. it is a pure
// function, so a test checks each limit and each security setting without docker. the command runs under timeout, so
// the wall time holds also when the app that started it is gone.
export function containerSpec(request: ExecRequest, instance: string): ContainerSpec {
  const { limits } = request;
  const memory = limits.memoryMb * 1024 * 1024;
  return {
    Image: request.image,
    Entrypoint: [''],
    Cmd: ['timeout', '-s', 'KILL', String(Math.ceil(limits.timeoutMs / 1000) + WALL_MARGIN_S), ...request.argv],
    Env: ['HOME=/work', 'LANG=C.UTF-8', 'TMPDIR=/tmp', ...request.env],
    WorkingDir: WORK_DIR,
    User: SANDBOX_USER,
    Labels: { [LABELS.sandbox]: '1', [LABELS.instance]: instance, [LABELS.exec]: String(request.execId), ...request.labels },
    AttachStdout: true,
    AttachStderr: true,
    AttachStdin: false,
    Tty: false,
    OpenStdin: false,
    NetworkDisabled: !request.network,
    HostConfig: {
      NetworkMode: request.network?.networkMode ?? 'none',
      ReadonlyRootfs: true,
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges:true'],
      Privileged: false,
      NanoCpus: Math.round(limits.cpus * 1e9),
      Memory: memory,
      MemorySwap: memory,
      PidsLimit: limits.pids,
      Ulimits: [{ Name: 'fsize', Soft: SCRATCH_BYTES, Hard: SCRATCH_BYTES }],
      Tmpfs: { [TMP_MOUNT.path]: TMP_MOUNT.options },
      Mounts: [{ Type: 'volume', Source: request.volume, Target: WORK_DIR, ReadOnly: false }],
      ExtraHosts: request.network?.extraHosts ?? [],
      Init: true,
      AutoRemove: false,
    },
  };
}

// the name of the container of an exec. a sweep finds it by its labels, not by the name.
export const containerName = (instance: string, execId: number) => `okc-sandbox-${instance}-${execId}`;

// after the exit the engine ends the attached streams. the runner waits this long for the last bytes, and after a
// kill this long for the exit, so a stuck engine never holds the call.
const DRAIN_MS = 5_000;

// the tar functions of the runner. a test can give its own.
export interface TarParts {
  pack: typeof packTar;
  unpack: typeof unpackTar;
}

// sink reads one stream to its end. it counts every byte and keeps the first cap bytes. it reads on after the cap, so
// the container never blocks on a full pipe.
function sink(stream: Readable, cap: number) {
  const chunks: Buffer[] = [];
  let kept = 0;
  let total = 0;
  stream.on('data', (chunk: Buffer) => {
    total += chunk.length;
    if (kept < cap) {
      const part = chunk.subarray(0, cap - kept);
      chunks.push(part);
      kept += part.length;
    }
  });
  const ended = new Promise<void>((resolve) => {
    stream.once('end', resolve);
    stream.once('close', resolve);
    stream.once('error', () => resolve());
  });
  return {
    ended,
    bytes: () => Buffer.concat(chunks),
    total: () => total,
  };
}

// within resolves with the value of the promise, or with undefined after ms.
function within<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(undefined);
      },
    );
  });
}

// bounded resolves with the promise, or rejects when the signal ends first. it ends a wait for a step of an engine that
// does not answer.
function bounded<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error(abortText(signal)));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error(abortText(signal)));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (err: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      },
    );
  });
}

const abortText = (signal: AbortSignal) =>
  signal.reason instanceof Error && signal.reason.name === 'TimeoutError' ? 'docker did not answer in time' : 'the request was stopped';

type Outcome = { kind: 'exit'; code: number } | { kind: 'timeout' } | { kind: 'abort' } | { kind: 'disk' } | { kind: 'error'; err: unknown };

export interface RunnerDeps {
  docker: DockerClient;
  logger: Logger;
  instance: string;
  now?: () => number;
  tar?: TarParts;
  // how often the runner measures /work while the command runs. a test gives a short time.
  diskPollMs?: number;
  // the limit of each docker step. a test gives a short time.
  stepMs?: number;
}

export function createRunner(deps: RunnerDeps): Runner {
  const { docker, logger, instance } = deps;
  const now = deps.now ?? (() => performance.now());
  const tar = deps.tar ?? { pack: packTar, unpack: unpackTar };
  const diskPollMs = deps.diskPollMs ?? DISK_POLL_MS;
  const stepMs = deps.stepMs ?? DOCKER_STEP_MS;

  // collect reads each collect path after the end. the limits count over all paths of the call, and a file that two
  // paths name (a folder and a file in it, or one path twice) comes back once.
  async function collect(id: string, paths: string[], signal: () => AbortSignal): Promise<Pick<ExecResult, 'collected' | 'notCollected'>> {
    const collected: FileOut[] = [];
    const notCollected: ExecResult['notCollected'] = [];
    const seen = new Set<string>();
    let total = 0;
    for (const path of paths) {
      const remaining = FILE_LIMITS.totalBytes - total;
      const filesLeft = FILE_LIMITS.count - collected.length;
      if (remaining <= 0) {
        notCollected.push({ path, reason: `the collected files are over ${FILE_LIMITS.totalBytes} bytes in all` });
        continue;
      }
      if (filesLeft <= 0) {
        notCollected.push({ path, reason: `the call collected ${FILE_LIMITS.count} files already` });
        continue;
      }
      try {
        const bytes = await docker.getArchive(id, `${WORK_DIR}/${path}`, remaining, signal());
        // the engine names the entries under the base name of the path, so strip takes it off and prefix puts the
        // whole path back. a file gives the path itself, and a folder gives the path and the names under it.
        const unpacked = tar.unpack(bytes, {
          strip: posix.basename(path),
          prefix: path,
          maxFiles: filesLeft,
          maxFileBytes: FILE_LIMITS.fileBytes,
          maxTotalBytes: remaining,
        });
        for (const file of unpacked.files) {
          if (seen.has(file.path)) continue;
          seen.add(file.path);
          collected.push(file);
          total += file.bytes.length;
        }
        notCollected.push(...unpacked.skipped);
      } catch (err) {
        const status = err instanceof DockerError ? err.status : undefined;
        const reason =
          status === 404
            ? 'no such file in /work'
            : status === 413
              ? `the collected files are over ${FILE_LIMITS.totalBytes} bytes in all`
              : `the file was not read: ${errorText(err)}`;
        notCollected.push({ path, reason });
      }
    }
    return { collected, notCollected };
  }

  return {
    async run(request) {
      const { limits, signal } = request;
      const result: ExecResult = {
        status: 'error',
        exitCode: null,
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
        stdoutBytes: 0,
        stderrBytes: 0,
        truncated: false,
        collected: [],
        notCollected: [],
        containerId: null,
        imageId: null,
        durationMs: 0,
        error: null,
        scratchBytes: undefined,
      };
      // each docker step has its own limit, and the whole exec has one too. the steps before the command also end
      // when the run stops. the steps after it do not, so the trace still gets the image and the exit code.
      const deadline = AbortSignal.timeout(limits.timeoutMs + EXEC_MARGIN_MS);
      const before = () => AbortSignal.any([signal, deadline, AbortSignal.timeout(stepMs)]);
      const after = () => AbortSignal.any([deadline, AbortSignal.timeout(stepMs)]);
      // the wait has no step limit. it ends when the exec ends.
      const waitStop = new AbortController();
      let attached: Attached | undefined;
      let out: { stdout: ReturnType<typeof sink>; stderr: ReturnType<typeof sink> } | undefined;
      let orphan: string | undefined;
      const takeOutput = () => {
        if (!out) return;
        result.stdout = out.stdout.bytes();
        result.stderr = out.stderr.bytes();
        result.stdoutBytes = out.stdout.total();
        result.stderrBytes = out.stderr.total();
        result.truncated = result.stdoutBytes > limits.outputBytes || result.stderrBytes > limits.outputBytes;
      };
      const stopped = () => {
        result.status = 'killed';
        result.error = 'the run stopped, so the command was ended';
      };

      try {
        let id: string;
        const name = containerName(instance, request.execId);
        // the create does not end with the run. a stopped run still gets its container removed below, by its id.
        const createSignal = after();
        try {
          id = await bounded(docker.createContainer(name, containerSpec(request, instance), createSignal), createSignal);
        } catch (err) {
          // a create that was cut off can still make the container, so the cleanup removes it by its name.
          if (createSignal.aborted) orphan = name;
          result.error = `docker did not create the container: ${errorText(err)}`;
          return result;
        }
        result.containerId = id;

        if (request.files.length) {
          const putSignal = before();
          await bounded(docker.putArchive(id, WORK_DIR, tar.pack(request.files, new Date()), putSignal), putSignal);
        }
        const attachSignal = before();
        attached = await bounded(docker.attach(id, attachSignal), attachSignal);
        out = { stdout: sink(attached.stdout, limits.outputBytes), stderr: sink(attached.stderr, limits.outputBytes) };
        // wait goes out before start, and the start waits until the engine has registered the waiter, so the exit
        // cannot come before the runner listens for it.
        const waiting = docker.wait(id, waitStop.signal);
        waiting.catch(() => {});
        if (waiting.registered) await bounded(waiting.registered, before());
        const startSignal = before();
        const startedAt = now();
        await bounded(docker.start(id, startSignal), startSignal);

        let timer: NodeJS.Timeout | undefined;
        let poll: NodeJS.Timeout | undefined;
        let onAbort: (() => void) | undefined;
        const outcome = await new Promise<Outcome>((resolve) => {
          timer = setTimeout(() => resolve({ kind: 'timeout' }), limits.timeoutMs);
          // the size check after the end comes too late for a command that fills the disk, so /work is measured
          // while it runs too.
          let measuring = false;
          poll = setInterval(() => {
            if (measuring) return;
            measuring = true;
            docker
              .archiveSize(id, WORK_DIR, SCRATCH_BYTES, after())
              .then((size) => {
                if (size > SCRATCH_BYTES) resolve({ kind: 'disk' });
              })
              .catch((err: unknown) => logger.warn('sandbox scratch size failed', { execId: request.execId, err }))
              .finally(() => (measuring = false));
          }, diskPollMs);
          onAbort = () => resolve({ kind: 'abort' });
          if (signal.aborted) onAbort();
          else signal.addEventListener('abort', onAbort, { once: true });
          waiting.then(
            (code) => resolve({ kind: 'exit', code }),
            (err: unknown) => resolve({ kind: 'error', err }),
          );
        }).finally(() => {
          clearTimeout(timer);
          clearInterval(poll);
          if (onAbort) signal.removeEventListener('abort', onAbort);
        });
        result.durationMs = Math.max(0, Math.round(now() - startedAt));

        if (outcome.kind === 'error') throw outcome.err;
        if (outcome.kind === 'exit') {
          result.exitCode = outcome.code;
        } else {
          await docker.kill(id, after()).catch((err: unknown) => logger.warn('sandbox kill failed', { execId: request.execId, err }));
          const code = await within(waiting, DRAIN_MS);
          if (code !== undefined) result.exitCode = code;
        }

        // the engine ends the streams after the exit. a stream that does not end is cut, and the bytes so far count.
        await within(Promise.all([out.stdout.ended, out.stderr.ended]), DRAIN_MS);
        takeOutput();

        const state = await docker.inspect(id, after()).catch((err: unknown) => {
          logger.warn('sandbox inspect failed', { execId: request.execId, err });
          return undefined;
        });
        if (state) {
          result.imageId = state.image;
          if (result.exitCode === null && state.exitCode !== null && !state.running) result.exitCode = state.exitCode;
        }

        if (outcome.kind === 'timeout') {
          result.status = 'timeout';
          result.error = `the command ran longer than ${limits.timeoutMs / 1000} s`;
        } else if (outcome.kind === 'abort') {
          stopped();
        } else if (outcome.kind === 'disk') {
          result.status = 'killed';
          result.error = `the command wrote more than ${Math.round(SCRATCH_BYTES / (1024 * 1024))} MB to ${WORK_DIR}`;
        } else if (state?.oomKilled) {
          result.status = 'killed';
          result.error = `the command used more than ${limits.memoryMb} MB of memory`;
        } else {
          result.status = outcome.code === 0 ? 'ok' : 'failed';
        }

        if (request.collect.length) Object.assign(result, await collect(id, request.collect, after));
        // a command that went over the size of /work needs no second measure: the tool empties /work after it.
        result.scratchBytes =
          outcome.kind === 'disk'
            ? SCRATCH_BYTES + 1
            : await docker.archiveSize(id, WORK_DIR, SCRATCH_BYTES, after()).catch((err: unknown) => {
                logger.warn('sandbox scratch size failed', { execId: request.execId, err });
                return undefined;
              });
        return result;
      } catch (err) {
        takeOutput();
        if (signal.aborted) stopped();
        else {
          result.status = 'error';
          result.error = errorText(err);
        }
        return result;
      } finally {
        waitStop.abort();
        attached?.close();
        const remove = result.containerId ?? orphan;
        if (remove) {
          await docker.removeContainer(remove, AbortSignal.timeout(stepMs)).catch((err: unknown) =>
            logger.error('sandbox container remove failed', { execId: request.execId, containerId: remove, err }),
          );
        }
      }
    },
  };
}

// sweepContainers removes the sandbox containers of this instance whose exec does not run now, for example after a
// crash. npm run chat and the service share an instance, so keep reads the trace row and not a set of this process:
// it is true for a running row that is not stale. the function gives the number of containers that it removed.
export async function sweepContainers(docker: DockerClient, instance: string, keep: (execId: number) => boolean, signal?: AbortSignal): Promise<number> {
  const found = await docker.listContainers(`${LABELS.instance}=${instance}`, signal);
  let removed = 0;
  for (const container of found) {
    const exec = container.labels[LABELS.exec];
    if (exec !== undefined && exec !== '' && keep(Number(exec))) continue;
    await docker.removeContainer(container.id, signal);
    removed += 1;
  }
  return removed;
}
