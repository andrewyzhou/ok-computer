import type { SandboxLimits } from '../dashboard/types.js';

// the fixed values of the code sandbox. they are constants and not config, as for the reviewer (DESIGN-NEXT 5.5): a
// wrong value only makes the sandbox weaker or less useful, and the tests check these values.

// the default image. sandbox/Dockerfile defines it, and npm run sandbox:image builds it with this tag. a new image
// definition gets a new tag, so an old image is never used by mistake.
export const SANDBOX_IMAGE = 'okc-sandbox:1';

// the user of the image (sandbox/Dockerfile makes it). the container never runs as root.
export const SANDBOX_USER = '1000:1000';

// the scratch volume is mounted here, read and write. it is also the working directory and the home folder.
export const WORK_DIR = '/work';

// the root filesystem is read only, so /tmp is a small tmpfs. noexec keeps a downloaded program from running there.
export const TMP_MOUNT = { path: '/tmp', options: 'rw,noexec,nosuid,nodev,size=64m' } as const;

export const DEFAULT_LIMITS: SandboxLimits = {
  cpus: 1,
  memoryMb: 512,
  timeoutMs: 60_000,
  outputBytes: 1_000_000,
  pids: 128,
};

// a call can ask for more time or memory up to these values. it cannot ask for more output or more processes.
export const MAX_LIMITS: SandboxLimits = {
  cpus: 2,
  memoryMb: 2_048,
  timeoutMs: 300_000,
  outputBytes: 1_000_000,
  pids: 128,
};

// limitsFor gives the limits of one call. a value over the maximum becomes the maximum, so the call still runs.
export function limitsFor(asked: { timeoutMs?: number | undefined; memoryMb?: number | undefined; cpus?: number | undefined }): SandboxLimits {
  const clamp = (value: number | undefined, fallback: number, max: number) => (value === undefined ? fallback : Math.min(Math.max(value, 0), max));
  return {
    cpus: clamp(asked.cpus, DEFAULT_LIMITS.cpus, MAX_LIMITS.cpus),
    memoryMb: Math.round(clamp(asked.memoryMb, DEFAULT_LIMITS.memoryMb, MAX_LIMITS.memoryMb)),
    timeoutMs: Math.round(clamp(asked.timeoutMs, DEFAULT_LIMITS.timeoutMs, MAX_LIMITS.timeoutMs)),
    outputBytes: DEFAULT_LIMITS.outputBytes,
    pids: DEFAULT_LIMITS.pids,
  };
}

// the files of one call. a file in counts against the input limits, and a collected file against the output limits.
export const FILE_LIMITS = {
  count: 20,
  fileBytes: 10 * 1024 * 1024,
  totalBytes: 20 * 1024 * 1024,
  // the longest path under /work that a call can name.
  pathChars: 200,
} as const;

// the code goes to the interpreter as one argument. linux refuses an argument over 128 kb, so the limit is lower.
export const CODE_BYTES = 100_000;

// a scratch volume that no call used for this time is removed. a volume over the size limit after a call is removed
// too, and the result says so.
export const SCRATCH_IDLE_MS = 24 * 60 * 60_000;
export const SCRATCH_BYTES = 256 * 1024 * 1024;

// the execs that one process runs at the same time. a further call gets an error at once.
export const MAX_RUNNING = 2;

// the dashboard detail shows this much of stdout and of stderr. the blob holds the full kept text.
export const DETAIL_TEXT_BYTES = 64 * 1024;

// the probe of the docker daemon must not hold the start of the app.
export const PROBE_TIMEOUT_MS = 3_000;
// the dashboard asks for the status often, so the answer is kept for this time.
export const STATUS_TTL_MS = 30_000;

// a running row older than the longest call and this margin belongs to a process that stopped.
export const STALE_MARGIN_MS = 60_000;

// the container also ends itself: the command runs under timeout -s KILL with the wall time and this margin, so a
// container that the app left behind in a crash stops on its own. the app kills it first in the normal case.
export const WALL_MARGIN_S = 5;

// each docker call of an exec, apart from the wait, ends after this time, so an engine that hangs never holds a call.
export const DOCKER_STEP_MS = 30_000;
// the whole exec ends after its wall time and this margin, which covers the steps before and after the command.
export const EXEC_MARGIN_MS = 120_000;
// the start sweep ends after this time, so an engine that hangs never holds the start of the app.
export const SWEEP_MS = 30_000;

// while a command runs, the runner measures /work this often and kills a command that wrote more than SCRATCH_BYTES.
export const DISK_POLL_MS = 5_000;

// every container, volume and network of the sandbox has these labels, so a sweep never touches other docker objects
// or the objects of another install. sandbox has the value "1", instance the value of instanceOf (sandbox.ts), exec the
// id of the sandbox_execs row, and task the id of the scratch task.
export const LABELS = {
  sandbox: 'okc.sandbox',
  instance: 'okc.instance',
  exec: 'okc.exec',
  task: 'okc.task',
} as const;
