import { execFile } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';
import { promisify } from 'node:util';
import { STDIO_DEFAULT_MAX_BUFFER_SIZE, StreamableHTTPClientTransport, type OAuthClientProvider, type Transport } from '@modelcontextprotocol/client';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import type { Logger } from '../observability/logger.js';
import type { HttpEntry, StdioEntry } from './config.js';
import { STDERR_LINES_PER_MINUTE } from './mcp.js';
import { groupStdioTransport } from './process-group.js';
import type { SecretStore } from './secrets.js';

const run = promisify(execFile);
// a stderr line can be a whole json document. the log keeps the start of it.
const STDERR_LINE_LIMIT = 2_000;

// the child process gets the safe default variables and the variables of its entry. it does not get the secrets of
// this process, for example the api keys in .env.
export async function stdioTransport(entry: StdioEntry, secrets: SecretStore, logger: Logger, now = () => Date.now()): Promise<Transport> {
  const env: Record<string, string> = getDefaultEnvironment();
  for (const [name, value] of Object.entries(entry.env)) {
    if (typeof value === 'string') {
      env[name] = value;
      continue;
    }
    const secret = await secrets.get(value.secretRef);
    if (secret === undefined) throw new Error(`the secret ${value.secretRef} for ${name} is not in the credential manager`);
    env[name] = secret;
  }
  // on macos and linux the server leads its own process group, and the close ends the whole group. windows has no
  // process groups of this kind, so there the close ends the process tree from a process list.
  const transport =
    process.platform === 'win32'
      ? new StdioClientTransport({
          command: entry.command,
          args: entry.args,
          env,
          ...(entry.cwd ? { cwd: entry.cwd } : {}),
          stderr: 'pipe',
        })
      : groupStdioTransport({ command: entry.command, args: entry.args, env, ...(entry.cwd ? { cwd: entry.cwd } : {}) }, entry.id, logger);
  const stderr = transport.stderr as Readable | null;
  if (stderr) {
    let windowStart = now();
    let lines = 0;
    let dropped = 0;
    createInterface({ input: stderr }).on('line', (line) => {
      // a clock that moves back would keep the old window open for the length of the jump.
      const at = now();
      if (at - windowStart >= 60_000 || at < windowStart) {
        if (dropped) logger.warn('mcp server stderr lines dropped', { integration: entry.id, dropped });
        windowStart = at;
        lines = 0;
        dropped = 0;
      }
      if (++lines > STDERR_LINES_PER_MINUTE) {
        dropped++;
        return;
      }
      logger.info('mcp server stderr', { integration: entry.id, line: line.length > STDERR_LINE_LIMIT ? `${line.slice(0, STDERR_LINE_LIMIT)}…` : line });
    });
  }
  if (transport instanceof StdioClientTransport) killTreeOnClose(transport, entry.id, logger);
  return transport;
}

// on windows, npx runs through cmd.exe, so the server is a grandchild. the close of the sdk ends stdin and then kills
// only the direct child. a server that does not stop at the end of stdin then lives on, and each reconnect leaves one
// more process. so the close takes a list of the descendants first and ends the ones that are still alive after it.
function killTreeOnClose(transport: StdioClientTransport, id: string, logger: Logger) {
  const start = transport.start.bind(transport);
  const close = transport.close.bind(transport);
  // every process of the server starts after this time.
  let startedAt = Date.now();
  transport.start = async () => {
    startedAt = Date.now();
    return start();
  };
  transport.close = async () => {
    const pid = transport.pid;
    let tree: ProcessRow[] = [];
    if (pid !== null) {
      try {
        tree = descendants(await processList(), pid, startedAt);
      } catch (err) {
        logger.warn('mcp process list failed', { integration: id, err });
      }
    }
    await close();
    if (!tree.length) return;
    // a process of the list can end during the close, and windows can give its pid to a new process. so only a pid
    // that still has the same start time is ended.
    let alive: ProcessRow[];
    try {
      alive = sameProcesses(tree, await processList());
    } catch (err) {
      logger.warn('mcp process list failed', { integration: id, err });
      return;
    }
    for (const child of alive) {
      try {
        process.kill(child.pid);
        logger.warn('mcp server process ended after the close', { integration: id, pid: child.pid });
      } catch {
        // the process already stopped.
      }
    }
  };
}

// created is the start time of the process in milliseconds since 1970.
export interface ProcessRow {
  pid: number;
  parent: number;
  created: number;
}

export async function processList(): Promise<ProcessRow[]> {
  const { stdout } = await run(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      "Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate | ForEach-Object { '{0} {1} {2}' -f $_.ProcessId, $_.ParentProcessId, $(if ($_.CreationDate) { ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() } else { 0 }) }",
    ],
    { windowsHide: true, timeout: 10_000 },
  );
  const rows: ProcessRow[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const [pid, parent, created] = line.trim().split(' ').map(Number);
    if (pid && parent !== undefined && created !== undefined && Number.isFinite(created)) rows.push({ pid, parent, created });
  }
  return rows;
}

// the clocks of node and of windows are the same, but the start time of a process can be a little earlier than the
// time that node reads just before the spawn.
const START_SLACK_MS = 1_000;

// descendants gives the processes under root that the server started. a pid and a parent pid alone can name the wrong
// process: windows keeps the parent pid of a process after its parent ends, and it gives the freed pid to new
// processes. so a process that started before the server, or before its own parent, is not a descendant, also when
// its parent pid matches. a root that this process did not start is not the server.
export function descendants(rows: readonly ProcessRow[], root: number, startedAt: number, owner = process.pid): ProcessRow[] {
  const top = rows.find((row) => row.pid === root);
  if (top && (top.parent !== owner || top.created < startedAt - START_SLACK_MS)) return [];
  const children = new Map<number, ProcessRow[]>();
  for (const row of rows) children.set(row.parent, [...(children.get(row.parent) ?? []), row]);
  const found: ProcessRow[] = [];
  const queue: Array<{ pid: number; created: number }> = [{ pid: root, created: top?.created ?? startedAt - START_SLACK_MS }];
  while (queue.length) {
    const parent = queue.shift()!;
    for (const child of children.get(parent.pid) ?? []) {
      if (child.pid === root || found.includes(child) || child.created < parent.created || child.created < startedAt - START_SLACK_MS) continue;
      found.push(child);
      queue.push(child);
    }
  }
  return found;
}

// sameProcesses keeps each process of the list that still runs with the same start time.
export function sameProcesses(listed: readonly ProcessRow[], now: readonly ProcessRow[]): ProcessRow[] {
  return listed.filter((row) => now.some((each) => each.pid === row.pid && each.created === row.created));
}

export async function httpTransport(
  entry: HttpEntry,
  secrets: SecretStore,
  oauth?: { provider: (entry: HttpEntry) => OAuthClientProvider; fetchFor: (entry: HttpEntry) => typeof fetch },
): Promise<Transport> {
  const url = new URL(entry.url);
  // an answer over the limit closes the connection, as a long line does on stdio. the close fails the call, and the
  // backoff starts.
  let transport: Transport | undefined;
  const limited = (base: typeof fetch) => limitBody(base, MESSAGE_LIMIT, () => void transport?.close().catch(() => {}));
  if (entry.auth?.type === 'oauth') {
    if (!oauth) throw new Error('oauth is not set up in this process');
    transport = new StreamableHTTPClientTransport(url, { authProvider: oauth.provider(entry), fetch: limited(oauth.fetchFor(entry)) });
  } else if (entry.auth?.type === 'bearer') {
    const token = await secrets.get(entry.auth.secretRef);
    if (token === undefined) throw new Error(`the secret ${entry.auth.secretRef} is not in the credential manager`);
    transport = new StreamableHTTPClientTransport(url, { requestInit: { headers: { authorization: `Bearer ${token}` } }, fetch: limited(fetch) });
  } else {
    transport = new StreamableHTTPClientTransport(url, { fetch: limited(fetch) });
  }
  return transport;
}

// the stdio transport of the sdk refuses a message over 10 mb. the http transport had no limit: one large result held
// the event loop for seconds, and the trace and the raw result stored it twice.
export const MESSAGE_LIMIT = STDIO_DEFAULT_MAX_BUFFER_SIZE;

// limitBody stops the body of an answer at the limit. an event stream can stay open for a long time, so there the
// limit applies to each event, and a blank line ends an event. every other body counts as one message.
export function limitBody(base: typeof fetch, limit: number, onOver: () => void): typeof fetch {
  return async (input, init) => {
    const response = await base(input, init);
    if (!response.body) return response;
    const events = (response.headers.get('content-type') ?? '').toLowerCase().includes('text/event-stream');
    let size = 0;
    let line = 0;
    let previous = 0;
    const body = response.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          let from = 0;
          for (;;) {
            const at = events ? chunk.indexOf(10, from) : -1;
            const piece = (at === -1 ? chunk.length : at) - from;
            size += piece;
            line += piece;
            if (size > limit) {
              controller.error(new Error(`the answer of the server is larger than ${limit} bytes`));
              onOver();
              return;
            }
            if (at === -1) break;
            // a line with nothing, or with only a carriage return, ends the event.
            const before = at > 0 ? chunk[at - 1] : previous;
            if (line === 0 || (line === 1 && before === 13)) size = 0;
            line = 0;
            from = at + 1;
          }
          if (chunk.length) previous = chunk[chunk.length - 1]!;
          controller.enqueue(chunk);
        },
      }),
    );
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
}
