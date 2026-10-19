import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { getDefaultEnvironment } from '@modelcontextprotocol/client/stdio';
import { describe, expect, it } from 'vitest';
import { silentLogger, type Logger } from '../observability/logger.js';
import { parseIntegrations, type StdioEntry } from './config.js';
import { groupStdioTransport } from './process-group.js';
import { createMemorySecretStore } from './secrets.js';
import { stdioTransport } from './transports.js';

// these cases try the edges of the process group transport: a shell wrapper with a child in the background, the
// order of a close and a send, a bad line on stdout, and the values that stdioTransport passes on.

const FIXTURE = join(import.meta.dirname, '../../test/fixtures/stdio-server.ts');
const node = process.execPath;
const server = `'${node}' --import tsx '${FIXTURE}'`;

function entryFor(command: string, args: string[], extra: Record<string, unknown> = {}): StdioEntry {
  const parsed = parseIntegrations({ integrations: [{ id: 'notes', kind: 'mcp-stdio', command, args, tools: { allow: ['echo'] }, ...extra }] });
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value[0] as StdioEntry;
}

function capture() {
  const lines: string[] = [];
  const logger: Logger = { ...silentLogger, info: (msg, fields) => void (msg === 'mcp server stderr' && lines.push(String(fields?.line))) };
  return { lines, logger };
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe.runIf(process.platform !== 'win32')('stdio server in its own process group, at its edges', () => {
  // a shell wrapper starts a helper in the background and then becomes the server, as many install guides do.
  it('ends a helper that a shell wrapper left in the background, through stdioTransport', async () => {
    const { lines, logger } = capture();
    const helper = `'${node}' -e "process.on('SIGTERM', () => {}); process.stderr.write('helper ' + process.pid + '\\\\n'); setInterval(() => {}, 1000)"`;
    const entry = entryFor('/bin/sh', ['-c', `${helper} & exec ${server}`]);
    const transport = await stdioTransport(entry, createMemorySecretStore(), logger);
    const client = new Client({ name: 'test', version: '0' });
    await client.connect(transport);
    await expect.poll(() => lines.find((line) => line.startsWith('helper ')), { timeout: 15_000 }).toBeDefined();
    const pid = Number(lines.find((line) => line.startsWith('helper '))!.split(' ')[1]);
    expect(alive(pid)).toBe(true);
    expect((await client.listTools()).tools.map((tool) => tool.name)).toContain('echo');
    await client.close();
    await expect.poll(() => alive(pid), { timeout: 8_000 }).toBe(false);
  }, 30_000);

  it('gives the server its secret from the store, its own cwd, and not the variables of this process', async () => {
    const { lines, logger } = capture();
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'okc-cwd-')));
    process.env.OKC_EDGE_PARENT_ONLY = 'leak';
    try {
      const script = "process.stderr.write(['cwd', process.cwd(), process.env.TOKEN, process.env.PLAIN, String(process.env.OKC_EDGE_PARENT_ONLY)].join('|') + '\\n'); setInterval(() => {}, 1000)";
      const entry = entryFor(node, ['-e', script], { cwd, env: { TOKEN: { secretRef: 'notes-token' }, PLAIN: 'plain value' } });
      const transport = await stdioTransport(entry, createMemorySecretStore({ 'notes-token': 's3cret value' }), logger);
      await transport.start();
      await expect.poll(() => lines.find((line) => line.startsWith('cwd|')), { timeout: 15_000 }).toBe(`cwd|${cwd}|s3cret value|plain value|undefined`);
      await transport.close();
    } finally {
      delete process.env.OKC_EDGE_PARENT_ONLY;
    }
  }, 30_000);

  it('refuses a send after the server ended, and a close before a start does nothing', async () => {
    const idle = groupStdioTransport({ command: node, args: ['-e', ''], env: getDefaultEnvironment() }, 'notes', silentLogger);
    await expect(idle.close()).resolves.toBeUndefined();

    const transport = groupStdioTransport({ command: node, args: ['-e', 'setTimeout(() => {}, 50)'], env: getDefaultEnvironment() }, 'notes', silentLogger);
    let closed = 0;
    transport.onclose = () => void closed++;
    await transport.start();
    await expect.poll(() => closed, { timeout: 10_000 }).toBe(1);
    await expect(transport.send({ jsonrpc: '2.0', method: 'ping', id: 1 })).rejects.toThrow('Not connected');
    await transport.close();
    expect(closed).toBe(1);
  }, 30_000);

  // a server that prints a line that is not json, for example a banner, must not stop the messages after it. the read
  // buffer of the sdk can skip such a line without an error, so only the message counts.
  it('still gives the message after a bad line on stdout', async () => {
    const script = `process.stdout.write('banner of the server\\n' + JSON.stringify({ jsonrpc: '2.0', method: 'notifications/hello' }) + '\\n'); setInterval(() => {}, 1000)`;
    const transport = groupStdioTransport({ command: node, args: ['-e', script], env: getDefaultEnvironment() }, 'notes', silentLogger);
    const errors: Error[] = [];
    const messages: unknown[] = [];
    transport.onerror = (error) => void errors.push(error);
    transport.onmessage = (message) => void messages.push(message);
    await transport.start();
    await expect.poll(() => messages.length, { timeout: 10_000 }).toBe(1);
    expect(messages[0]).toEqual({ jsonrpc: '2.0', method: 'notifications/hello' });
    const pid = transport.pid!;
    await transport.close();
    expect(alive(pid)).toBe(false);
  }, 30_000);

  // the group id is the pid of the server, so a server must lead a group of its own and not join the group of the
  // agent. a signal to that group would end the agent.
  it('starts the server as the leader of a new group, away from the group of this process', async () => {
    const script = "process.stderr.write('ready\\n'); setInterval(() => {}, 1000)";
    const transport = groupStdioTransport({ command: node, args: ['-e', script], env: getDefaultEnvironment() }, 'notes', silentLogger);
    const lines: string[] = [];
    transport.stderr.on('data', (chunk: Buffer) => lines.push(chunk.toString()));
    await transport.start();
    await expect.poll(() => lines.join(''), { timeout: 10_000 }).toContain('ready');
    const { execFileSync } = await import('node:child_process');
    const group = (pid: number) => Number(execFileSync('ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf8' }).trim());
    expect(group(transport.pid!)).toBe(transport.pid);
    expect(group(transport.pid!)).not.toBe(group(process.pid));
    await transport.close();
    expect(alive(process.pid)).toBe(true);
  }, 30_000);
});
