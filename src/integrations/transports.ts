import { execFile } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';
import { promisify } from 'node:util';
import { StreamableHTTPClientTransport, type OAuthClientProvider, type Transport } from '@modelcontextprotocol/client';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import type { Logger } from '../observability/logger.js';
import type { HttpEntry, StdioEntry } from './config.js';
import { STDERR_LINES_PER_MINUTE } from './mcp.js';
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
  const transport = new StdioClientTransport({
    command: entry.command,
    args: entry.args,
    env,
    ...(entry.cwd ? { cwd: entry.cwd } : {}),
    stderr: 'pipe',
  });
  const stderr = transport.stderr as Readable | null;
  if (stderr) {
    let windowStart = now();
    let lines = 0;
    let dropped = 0;
    createInterface({ input: stderr }).on('line', (line) => {
      if (now() - windowStart >= 60_000) {
        if (dropped) logger.warn('mcp server stderr lines dropped', { integration: entry.id, dropped });
        windowStart = now();
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
  if (process.platform === 'win32') killTreeOnClose(transport, entry.id, logger);
  return transport;
}

// on windows, npx runs through cmd.exe, so the server is a grandchild. the close of the sdk ends stdin and then kills
// only the direct child. a server that does not stop at the end of stdin then lives on, and each reconnect leaves one
// more process. so the close takes a list of the descendants first and ends the ones that are still alive after it.
function killTreeOnClose(transport: StdioClientTransport, id: string, logger: Logger) {
  const close = transport.close.bind(transport);
  transport.close = async () => {
    const pid = transport.pid;
    let tree: number[] = [];
    if (pid !== null) {
      try {
        tree = await descendants(pid);
      } catch (err) {
        logger.warn('mcp process list failed', { integration: id, err });
      }
    }
    await close();
    for (const child of tree) {
      try {
        process.kill(child);
        logger.warn('mcp server process ended after the close', { integration: id, pid: child });
      } catch {
        // the process already stopped.
      }
    }
  };
}

export async function descendants(root: number): Promise<number[]> {
  const { stdout } = await run(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', "Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId | ForEach-Object { '{0} {1}' -f $_.ProcessId, $_.ParentProcessId }"],
    { windowsHide: true, timeout: 10_000 },
  );
  const children = new Map<number, number[]>();
  for (const line of stdout.split(/\r?\n/)) {
    const [child, parent] = line.trim().split(' ').map(Number);
    if (!child || parent === undefined) continue;
    children.set(parent, [...(children.get(parent) ?? []), child]);
  }
  const found: number[] = [];
  const queue = [...(children.get(root) ?? [])];
  while (queue.length) {
    const next = queue.shift()!;
    if (found.includes(next)) continue;
    found.push(next);
    queue.push(...(children.get(next) ?? []));
  }
  return found;
}

export async function httpTransport(
  entry: HttpEntry,
  secrets: SecretStore,
  oauth?: { provider: (entry: HttpEntry) => OAuthClientProvider; fetchFor: (entry: HttpEntry) => typeof fetch },
): Promise<Transport> {
  const url = new URL(entry.url);
  if (entry.auth?.type === 'oauth') {
    if (!oauth) throw new Error('oauth is not set up in this process');
    return new StreamableHTTPClientTransport(url, { authProvider: oauth.provider(entry), fetch: oauth.fetchFor(entry) });
  }
  if (entry.auth?.type === 'bearer') {
    const token = await secrets.get(entry.auth.secretRef);
    if (token === undefined) throw new Error(`the secret ${entry.auth.secretRef} is not in the credential manager`);
    return new StreamableHTTPClientTransport(url, { requestInit: { headers: { authorization: `Bearer ${token}` } } });
  }
  return new StreamableHTTPClientTransport(url);
}
