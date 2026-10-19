import type { SandboxLimits } from '../dashboard/types.js';
import type { Db } from '../db/index.js';
import type { Logger } from '../observability/logger.js';
import type { Clock } from '../time.js';
import { defineTool, errorText, type Tool, type ToolContext, type ToolOutput } from '../tools/registry.js';
import { checkPath, resolveInputs, storeOutputs, type BlobOrigin, type FileStores } from './files.js';
import { sandboxExecInput, type SandboxExecInput } from './input.js';
import { DEFAULT_LIMITS, LABELS, limitsFor, MAX_LIMITS, MAX_RUNNING, SCRATCH_BYTES, WORK_DIR } from './limits.js';
import { checkAllowlist } from './network.js';
import { commandFor } from './runner.js';
import type { Scratch } from './scratch.js';
import { addFiles, finishExec, startExec } from './store.js';
import type { ExecResult, FileIn, FileRow, NetworkGate, NetworkPlan, Probe, Runner } from './types.js';

export const SANDBOX_EXEC = 'sandbox_exec';

export interface SandboxToolDeps {
  db: Db;
  stores: FileStores;
  runner: Runner;
  scratch: Scratch;
  network: NetworkGate;
  logger: Logger;
  clock: Clock;
  image: string;
  // the last probe. the tool gives an error with effect none when docker does not answer.
  probe: () => Probe;
  // the ids of the execs that run now in this process. the tool adds and removes its own id.
  live: Set<number>;
  // the execs that run now, with a way to stop each one and the promise of its end. stop() of the sandbox uses it, so
  // the containers are removed before the process exits.
  running?: Map<number, { stop: AbortController; done: Promise<unknown> }>;
}

// the start of the app sweeps the idle scratch volumes. a process that runs for days also sweeps them after a call,
// at most once in this time, so no timer is needed.
export const SCRATCH_SWEEP_MS = 60 * 60_000;

// the network part of the result names at most this many hosts and refusals of each kind.
const NETWORK_NAMES = 8;

const mb = (bytes: number) => Math.round(bytes / (1024 * 1024));
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
const sentence = (text: string) => (/[.!?]$/.test(text.trim()) ? text.trim() : `${text.trim()}.`);

const DESCRIPTION =
  'Run code in the code sandbox: a fresh Linux container for each call, with python3, node and bash and common data tools. ' +
  'The code is one program: bash runs it with bash -c, python with python3 -c, node with node -e. ' +
  `The working directory is ${WORK_DIR}. It is kept for this task (until the owner starts a new chat with /new), so a later call can use the files of an earlier call. ` +
  `It is emptied when it grows over ${mb(SCRATCH_BYTES)} MB. ` +
  'The container has no network, unless network.allow names the hosts that the code may reach through a proxy. The owner then approves each such call. ' +
  'Put files into /work with files: give content for a text file, or blob for the hash of a file from an earlier sandbox_exec result. ' +
  'collect names files or folders under /work to return after the code ends, and each returned file gets a blob hash. ' +
  'A text file is stored with secrets (keys, tokens) masked, so a text blob passed back in holds the masked text. To keep exact bytes across calls, leave the file in /work. ' +
  `Default limits: ${DEFAULT_LIMITS.cpus} cpu, ${DEFAULT_LIMITS.memoryMb} MB of memory, ${DEFAULT_LIMITS.timeoutMs / 1000} s of wall time, ` +
  `${DEFAULT_LIMITS.pids} processes, and ${mb(DEFAULT_LIMITS.outputBytes)} MB each of stdout and stderr. ` +
  `A call can ask for up to ${MAX_LIMITS.memoryMb} MB with memoryMb, up to ${MAX_LIMITS.cpus} cpus with cpus, and up to ${MAX_LIMITS.timeoutMs / 1000} s with timeoutMs. ` +
  `At most ${MAX_RUNNING} calls run at the same time.`;

const BUSY = `${['No', 'One', 'Two', 'Three', 'Four'][MAX_RUNNING] ?? MAX_RUNNING} sandbox commands run now. Wait for a result, then try again.`;

const refuse = (content: string): ToolOutput => ({ content, isError: true, effect: 'none' });

// sandbox_exec runs code in a fresh container (see docs/PHASE5-API.md, M9). risk exec goes to the reviewer. a call
// with network access is external, so the owner approves it.
export function createSandboxExecTool(deps: SandboxToolDeps): Tool {
  const { db, stores, runner, scratch, network, logger, clock, live } = deps;
  const running = deps.running ?? new Map<number, { stop: AbortController; done: Promise<unknown> }>();

  // a call reads only a blob that the sandbox knows: an output of any exec, or a file of an exec of the same session.
  // a hash of a screenshot or a payload of another session is refused. an output of a call with network access holds
  // text from outside.
  const originOf =
    (sessionKey: string) =>
    (hash: string): BlobOrigin => {
      const rows = db
        .prepare(
          `SELECT e.network AS network FROM sandbox_files f JOIN sandbox_execs e ON e.id = f.execId
           WHERE f.blob = ? AND (f.direction = 'out' OR e.sessionKey = ?)`,
        )
        .all(hash, sessionKey);
      if (!rows.length) return 'unknown';
      return rows.some((row) => row.network === 'allowlist') ? 'outside' : 'sandbox';
    };
  // a slot is taken before the first await, so two calls that start at the same time cannot both pass the limit.
  let starting = 0;
  let lastSweep = clock().getTime();

  const sweepScratch = () => {
    const now = clock().getTime();
    if (now - lastSweep < SCRATCH_SWEEP_MS) return;
    lastSweep = now;
    void scratch
      .sweep()
      .then((removed) => removed && logger.info('sandbox scratch sweep', { volumes: removed }))
      .catch((err: unknown) => logger.error('sandbox scratch sweep failed', { err }));
  };

  return defineTool<SandboxExecInput>({
    name: SANDBOX_EXEC,
    description: DESCRIPTION,
    input: sandboxExecInput,
    risk: 'exec',
    riskFor: (input) => (input.network ? 'external' : 'exec'),
    source: 'sandbox',
    async run(input, ctx) {
      const probe = deps.probe();
      if (!probe.available) return refuse(`The code sandbox is off: ${probe.reason ?? 'docker does not answer'}`);
      if (live.size + starting >= MAX_RUNNING) return refuse(BUSY);
      starting++;
      let slot = true;
      const release = () => {
        if (slot) starting--;
        slot = false;
      };
      try {
        const allow = input.network?.allow ?? [];
        if (input.network) {
          const broad = checkAllowlist(allow);
          if (broad) return refuse(`sandbox_exec did not run: ${broad}`);
          const ready = await network.check();
          if (!ready.ok) return refuse(`sandbox_exec did not run, because the network mode does not work here: ${ready.reason}`);
        }
        const inputs = resolveInputs(input.files ?? [], stores, originOf(ctx.sessionKey));
        if (!inputs.ok) return refuse(`sandbox_exec did not run: ${inputs.reason}`);
        const collect = input.collect ?? [];
        for (const path of collect) {
          const reason = checkPath(path);
          if (reason) return refuse(`sandbox_exec did not run: collect ${path}: ${reason}`);
        }
        const limits = limitsFor(input);
        let task: { taskId: string; volume: string };
        try {
          task = await scratch.volumeFor(ctx.sessionKey);
        } catch (err) {
          logger.error('sandbox scratch volume failed', { runId: ctx.runId, toolCallId: ctx.toolCallId, err });
          return refuse(`sandbox_exec did not run, because its ${WORK_DIR} volume could not be made: ${errorText(err)}`);
        }

        const execId = startExec(
          db,
          {
            runId: ctx.runId,
            toolCallId: ctx.toolCallId ?? null,
            sessionKey: ctx.sessionKey,
            taskId: task.taskId,
            language: input.language,
            command: input.code,
            image: deps.image,
            cwd: WORK_DIR,
            network: input.network ? 'allowlist' : 'none',
            allowlist: allow,
            limits,
          },
          clock(),
        );
        live.add(execId);
        release();
        // the stop of the app ends the exec as the stop of its run does.
        const stop = new AbortController();
        const done = runExec(input, { ...ctx, signal: AbortSignal.any([ctx.signal, stop.signal]) }, {
          execId,
          allow,
          limits,
          collect,
          files: inputs.files,
          rows: inputs.rows,
          untrusted: inputs.untrusted,
          ...task,
        });
        running.set(execId, { stop, done });
        try {
          return await done;
        } finally {
          running.delete(execId);
        }
      } finally {
        release();
      }
    },
  });

  async function runExec(
    input: SandboxExecInput,
    ctx: ToolContext,
    exec: {
      execId: number;
      allow: string[];
      limits: SandboxLimits;
      collect: string[];
      files: FileIn[];
      rows: FileRow[];
      untrusted: boolean;
      taskId: string;
      volume: string;
    },
  ): Promise<ToolOutput> {
    const { execId, allow, limits, collect, taskId, volume } = exec;
    const started = performance.now();
    // the code and its output come from the model and the session. only what the network brings in is outside text,
    // also when it comes in as a file that an earlier call with network access collected.
    const outside = input.network
      ? { untrustedSource: `sandbox:network (${allow.join(', ')})` }
      : exec.untrusted
        ? { untrustedSource: 'sandbox:file (an output of a call with network access)' }
        : {};
    let stage: 'before' | 'running' | 'after' = 'before';
    let plan: NetworkPlan | undefined;
    try {
      let result: ExecResult;
      try {
        // the rows of the files in are written inside the try, so a failed write still frees the slot of the exec.
        addFiles(db, execId, exec.rows, clock());
        plan = input.network ? await network.open(execId, allow) : undefined;
        stage = 'running';
        result = await runner.run({
          execId,
          image: deps.image,
          argv: commandFor(input.language, input.code),
          env: [...(plan?.env ?? [])],
          limits,
          volume,
          files: exec.files,
          collect,
          ...(plan ? { network: plan } : {}),
          labels: { [LABELS.task]: taskId },
          signal: ctx.signal,
        });
        stage = 'after';
      } finally {
        live.delete(execId);
        await plan?.close().catch((err: unknown) => logger.error('sandbox network close failed', { runId: ctx.runId, execId, err }));
      }

      const stdout = result.stdout.toString('utf8');
      const stderr = result.stderr.toString('utf8');
      const stdoutBlob = stdout ? stores.blobs.put(stdout) : null;
      const stderrBlob = stderr ? stores.blobs.put(stderr) : null;
      const outRows = storeOutputs(result.collected, stores);
      addFiles(db, execId, outRows, clock());
      finishExec(
        db,
        execId,
        {
          status: result.status,
          exitCode: result.exitCode,
          imageId: result.imageId,
          containerId: result.containerId,
          stdoutBlob,
          stderrBlob,
          stdoutBytes: result.stdoutBytes,
          stderrBytes: result.stderrBytes,
          truncated: result.truncated,
          error: result.error,
          durationMs: result.durationMs,
          egress: plan ? { passed: plan.passed(), refused: plan.refused() } : null,
          notCollected: result.notCollected,
        },
        clock(),
      );
      // a failed size check or removal must not hide the result of a command that ran.
      let reset = false;
      try {
        reset = (await scratch.afterExec(taskId, result.scratchBytes)).reset;
      } catch (err) {
        logger.error('sandbox scratch check failed', { runId: ctx.runId, execId, err });
      }
      sweepScratch();

      const content = [
        headOf(execId, result, limits.timeoutMs),
        ...stream('stdout', stdout, result.stdoutBytes, result.stdout.length),
        ...stream('stderr', stderr, result.stderrBytes, result.stderr.length),
        ...(outRows.length ? ['Files:', ...outRows.map((row) => `- ${row.path} (${row.mime}, ${row.size} bytes): blob ${row.blob}`)] : []),
        ...(result.notCollected.length ? ['Not collected:', ...result.notCollected.map((miss) => `- ${miss.path}: ${miss.reason}`)] : []),
        ...(plan ? [networkLine(plan)] : []),
        ...(reset ? [`${WORK_DIR} was over ${mb(SCRATCH_BYTES)} MB, so it is empty again.`] : []),
      ].join('\n');
      const isError = result.status !== 'ok';
      return {
        content,
        ...(isError ? { isError: true } : {}),
        ...(result.status === 'error' && result.containerId === null ? { effect: 'none' as const } : {}),
        ...outside,
      };
    } catch (err) {
      // a run never leaves a running row in this process. the row gets the error, and the model gets it too.
      logger.error('sandbox exec failed', { runId: ctx.runId, toolCallId: ctx.toolCallId, execId, err });
      const text = errorText(err);
      try {
        finishExec(
          db,
          execId,
          {
            status: 'error',
            exitCode: null,
            imageId: null,
            containerId: null,
            stdoutBlob: null,
            stderrBlob: null,
            stdoutBytes: 0,
            stderrBytes: 0,
            truncated: false,
            error: text,
            durationMs: performance.now() - started,
            egress: plan ? { passed: plan.passed(), refused: plan.refused() } : null,
          },
          clock(),
        );
      } catch (writeErr) {
        logger.error('sandbox exec trace write failed', { runId: ctx.runId, execId, err: writeErr });
      }
      // before the runner, docker did nothing. a runner that throws can have started the container, so the effect is
      // unknown. after the runner, the command ran, and only the record of its output failed.
      const effect = stage === 'before' ? { effect: 'none' as const } : stage === 'running' ? { effect: 'unknown' as const } : {};
      const what = stage === 'after' ? 'ran, but its result could not be stored' : stage === 'running' ? 'failed while it ran' : 'did not run';
      return { content: `sandbox_exec ${what}: ${text}. Sandbox exec ${execId}.`, isError: true, ...effect, ...(stage === 'before' ? {} : outside) };
    }
  }
}

function headOf(execId: number, result: ExecResult, timeoutMs: number): string {
  const time = seconds(result.durationMs);
  if (result.status === 'ok' || result.status === 'failed') {
    return `Exit code ${result.exitCode ?? 'unknown'} (${result.status}) in ${time}. Sandbox exec ${execId}.`;
  }
  const fallback = {
    timeout: `the command ran longer than ${timeoutMs / 1000} s, so it was stopped`,
    killed: 'the command was stopped',
    error: 'docker could not run the command',
  }[result.status];
  const label = { timeout: 'Timeout', killed: 'Killed', error: 'Error' }[result.status];
  return `${label} after ${time}: ${sentence(result.error ?? fallback)} Sandbox exec ${execId}.`;
}

function stream(name: string, text: string, total: number, kept: number): string[] {
  const cut = total > kept ? `, cut to ${kept}` : '';
  if (!text) return [`${name} (${total} bytes${cut}).`];
  return [`${name} (${total} bytes${cut}):`, text];
}

function networkLine(plan: NetworkPlan): string {
  const list = (items: string[]) =>
    items.length > NETWORK_NAMES ? `${items.slice(0, NETWORK_NAMES).join(', ')} and ${items.length - NETWORK_NAMES} more` : items.join(', ');
  const passed = plan.passed();
  const refused = plan.refused().map((each) => `${each.target} (${each.reason})`);
  return `Network: reached ${passed.length ? list(passed) : 'nothing'}; refused ${refused.length ? list(refused) : 'nothing'}.`;
}
