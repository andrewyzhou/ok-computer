import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { PassThrough, type Readable } from 'node:stream';
import {
  ReadBuffer,
  SdkError,
  SdkErrorCode,
  serializeMessage,
  STDIO_DEFAULT_MAX_BUFFER_SIZE,
  type JSONRPCMessage,
  type Transport,
} from '@modelcontextprotocol/client';
import type { Logger } from '../observability/logger.js';

// the parameters of a stdio server on macos and linux. they are the same as the parameters that transports.ts gives
// the stdio transport of the sdk on windows.
export interface GroupStdioParams {
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd?: string;
}

// a stdio transport whose server leads its own process group. stderr is a stream from the start, so the caller can
// read the first lines, and pid is the pid of the server, which is also the id of its group.
export type GroupStdioTransport = Transport & { readonly stderr: Readable; readonly pid: number | null };

// the close waits this long for the server to end after the end of stdin, as the close of the sdk does.
const EXIT_WAIT_MS = 2_000;
// killProcessGroup checks this often whether the group has ended.
const POLL_MS = 50;

// the groups of the servers that still run. the exit handler ends them, because a detached group does not end with
// this process: a forced stop of the agent, or a stop that signals only the pid of the agent, would leave them.
const liveGroups = new Set<number>();
let exitHandler = false;

function watchExit() {
  if (exitHandler) return;
  exitHandler = true;
  process.on('exit', () => {
    for (const pgid of liveGroups) {
      if (!safeGroup(pgid)) continue;
      try {
        process.kill(-pgid, 'SIGKILL');
      } catch {
        // the group already ended.
      }
    }
    liveGroups.clear();
  });
}

// node does not give the process group of this process, so ps gives it once. when ps fails, only the pid of this
// process is known, and a group with that id is still refused.
let ownGroup: number | undefined;
function ownProcessGroup(): number {
  if (ownGroup !== undefined) return ownGroup;
  ownGroup = process.pid;
  try {
    const found = Number(execFileSync('ps', ['-o', 'pgid=', '-p', String(process.pid)], { encoding: 'utf8', timeout: 5_000 }).trim());
    if (Number.isInteger(found) && found > 1) ownGroup = found;
  } catch {
    // the pid of this process stays the guard.
  }
  return ownGroup;
}

// a group id of 0 or 1, or the group of this process, would signal this process or the whole system. a spawn that was
// not detached by mistake could lead there, so such an id is never signalled.
function safeGroup(pgid: number): boolean {
  return Number.isInteger(pgid) && pgid > 1 && pgid !== process.pid && pgid !== ownProcessGroup();
}

function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (err) {
    // a group that this process may not signal still exists.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function signalGroup(pgid: number, signal: NodeJS.Signals) {
  try {
    process.kill(-pgid, signal);
  } catch {
    // the group ended in the meantime, or it belongs to another user.
  }
}

class ProcessGroupTransport implements GroupStdioTransport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: Transport['onmessage'];
  readonly stderr = new PassThrough();
  private child: ChildProcessWithoutNullStreams | undefined;
  private group: number | undefined;
  private readonly readBuffer = new ReadBuffer({ maxBufferSize: STDIO_DEFAULT_MAX_BUFFER_SIZE });
  private started = false;
  private running = false;
  private closed = false;
  private exited: Promise<void> = Promise.resolve();
  private ended: Promise<void> | undefined;

  constructor(
    private readonly params: GroupStdioParams,
    private readonly id: string,
    private readonly logger: Logger,
  ) {}

  get pid(): number | null {
    return this.child?.pid ?? null;
  }

  async start(): Promise<void> {
    if (this.started) throw new Error('the stdio transport is already started. the connect of the client starts it.');
    this.started = true;
    watchExit();
    // ps runs here, before the first signal, so the exit handler never has to start a process.
    ownProcessGroup();
    return new Promise((resolve, reject) => {
      // detached makes the server the leader of a new process group whose id is its pid, so the close can end what
      // the server started, for example the real server behind npx or a shell.
      const child = spawn(this.params.command, this.params.args, {
        env: this.params.env,
        ...(this.params.cwd ? { cwd: this.params.cwd } : {}),
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: false,
        detached: true,
      });
      this.child = child;
      // the pid is known as soon as the system started the process, before the spawn event. a close during the start
      // then still finds the group.
      this.group = child.pid;
      if (this.group !== undefined) liveGroups.add(this.group);
      let exitedNow: () => void = () => {};
      this.exited = new Promise((done) => (exitedNow = done));
      child.on('error', (error) => {
        // a spawn that failed never runs, so there is no group to end.
        if (child.pid === undefined) exitedNow();
        reject(error);
        this.onerror?.(error);
      });
      child.on('spawn', () => {
        this.running = !this.closed;
        resolve();
      });
      child.on('exit', () => {
        this.running = false;
        exitedNow();
        // a server that ended by itself can leave processes in its group. they have no use without the server.
        if (!this.closed) void this.endGroup();
      });
      child.on('close', () => {
        this.running = false;
        this.child = undefined;
        this.readBuffer.clear();
        this.onclose?.();
      });
      child.stdin.on('error', (error) => this.onerror?.(error));
      child.stdout.on('error', (error) => this.onerror?.(error));
      child.stdout.on('data', (chunk: Buffer) => {
        try {
          this.readBuffer.append(chunk);
        } catch (error) {
          // a message over the limit closes the connection, as in the transport of the sdk.
          this.onerror?.(error as Error);
          void this.close().catch(() => {});
          return;
        }
        this.readMessages();
      });
      child.stderr.pipe(this.stderr);
    });
  }

  private readMessages() {
    for (;;) {
      let message: JSONRPCMessage | null;
      try {
        message = this.readBuffer.readMessage();
      } catch (error) {
        this.onerror?.(error as Error);
        continue;
      }
      if (message === null) return;
      this.onmessage?.(message);
    }
  }

  send(message: JSONRPCMessage): Promise<void> {
    return new Promise((resolve) => {
      const stdin = this.child?.stdin;
      if (!this.running || !stdin) throw new SdkError(SdkErrorCode.NotConnected, 'Not connected');
      if (stdin.write(serializeMessage(message))) resolve();
      else stdin.once('drain', resolve);
    });
  }

  // close ends stdin, waits for the server, and then ends its group. it ends the group also when the server already
  // ended, because a process that the server started can still run.
  async close(): Promise<void> {
    if (!this.closed) {
      this.closed = true;
      this.running = false;
      const child = this.child;
      if (child) {
        try {
          child.stdin.end();
        } catch {
          // stdin is already closed.
        }
        let timer: NodeJS.Timeout | undefined;
        await Promise.race([this.exited, new Promise((resolve) => (timer = setTimeout(resolve, EXIT_WAIT_MS)))]);
        clearTimeout(timer);
      }
    }
    await this.endGroup();
    this.readBuffer.clear();
  }

  // endGroup runs once, for a close or for the end of the server, and a later call waits for the same run.
  private endGroup(): Promise<void> {
    this.ended ??= (async () => {
      const pgid = this.group;
      if (pgid === undefined || !safeGroup(pgid)) return;
      try {
        if (await killProcessGroup(pgid)) this.logger.warn('mcp server process group ended after the close', { integration: this.id, pid: pgid });
      } finally {
        liveGroups.delete(pgid);
      }
      // a process of the group can hold the pipes of the server. after the group ended, the pipes close soon, and
      // they are closed here when they do not, so onclose fires.
      const child = this.child;
      if (child) {
        let timer: NodeJS.Timeout | undefined;
        const closed = new Promise((resolve) => child.once('close', resolve));
        await Promise.race([closed, new Promise((resolve) => (timer = setTimeout(resolve, 1_000)))]);
        clearTimeout(timer);
        if (this.child === child) {
          child.stdin.destroy();
          child.stdout.destroy();
          child.stderr.destroy();
        }
      }
    })();
    return this.ended;
  }
}

// groupStdioTransport starts the server detached on macos and linux, so it leads a new process group. its close ends
// stdin, then sends SIGTERM and later SIGKILL to the whole group, so a server that npx or a shell started does not live
// on after a stop.
export function groupStdioTransport(params: GroupStdioParams, id: string, logger: Logger): GroupStdioTransport {
  return new ProcessGroupTransport(params, id, logger);
}

// killProcessGroup sends SIGTERM to the group, waits up to graceMs for it to end, and then sends SIGKILL. it gives
// true when a process of the group was still alive at the first signal.
export async function killProcessGroup(pgid: number, graceMs = 2_000): Promise<boolean> {
  if (!safeGroup(pgid) || !groupAlive(pgid)) return false;
  signalGroup(pgid, 'SIGTERM');
  const until = Date.now() + graceMs;
  while (Date.now() < until) {
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    if (!groupAlive(pgid)) return true;
  }
  signalGroup(pgid, 'SIGKILL');
  return true;
}
