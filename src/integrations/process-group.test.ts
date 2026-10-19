import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { getDefaultEnvironment } from '@modelcontextprotocol/client/stdio';
import { describe, expect, it } from 'vitest';
import { silentLogger, type Logger } from '../observability/logger.js';
import { groupStdioTransport, killProcessGroup, type GroupStdioParams } from './process-group.js';

const FIXTURE = join(import.meta.dirname, '../../test/fixtures/stdio-group-server.ts');
const PLAIN_FIXTURE = join(import.meta.dirname, '../../test/fixtures/stdio-server.ts');

function params(fixture: string, ...flags: string[]): GroupStdioParams {
  return { command: process.execPath, args: ['--import', 'tsx', fixture, ...flags], env: getDefaultEnvironment() };
}

function capture() {
  const lines: string[] = [];
  const warnings: Array<{ msg: string; fields?: Record<string, unknown> }> = [];
  const logger: Logger = { ...silentLogger, warn: (msg, fields) => void warnings.push({ msg, ...(fields ? { fields } : {}) }) };
  return { lines, warnings, logger };
}

function readLines(stream: NodeJS.ReadableStream, lines: string[]) {
  let rest = '';
  stream.on('data', (chunk: Buffer) => {
    const parts = (rest + chunk.toString('utf8')).split('\n');
    rest = parts.pop()!;
    lines.push(...parts);
  });
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// the pids that the group fixture prints at the start: the server and its stubborn helper.
async function pids(lines: string[]) {
  await expect.poll(() => lines.find((line) => line.startsWith('group server ready')), { timeout: 15_000 }).toBeDefined();
  const match = /pid (\d+) helper (\d+)/.exec(lines.find((line) => line.startsWith('group server ready'))!)!;
  return { server: Number(match[1]), helper: Number(match[2]) };
}

describe.runIf(process.platform !== 'win32')('stdio server in its own process group', () => {
  it('ends the server and a stubborn helper of the server at the close', async () => {
    const { lines, warnings, logger } = capture();
    const transport = groupStdioTransport(params(FIXTURE), 'notes', logger);
    readLines(transport.stderr, lines);
    const client = new Client({ name: 'test', version: '0' });
    await client.connect(transport);
    const { server, helper } = await pids(lines);
    expect(transport.pid).toBe(server);
    expect(alive(helper)).toBe(true);
    await client.close();
    await expect.poll(() => alive(server), { timeout: 5_000 }).toBe(false);
    await expect.poll(() => alive(helper), { timeout: 5_000 }).toBe(false);
    expect(warnings).toContainEqual({ msg: 'mcp server process group ended after the close', fields: { integration: 'notes', pid: server } });
  }, 30_000);

  it('lists the tools through a real client, with the legacy and the auto version negotiation', async () => {
    for (const mode of ['legacy', 'auto'] as const) {
      const transport = groupStdioTransport(params(PLAIN_FIXTURE), 'notes', silentLogger);
      const client = new Client({ name: 'test', version: '0' }, { versionNegotiation: { mode } });
      await client.connect(transport);
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name)).toContain('echo');
      await client.close();
    }
  }, 30_000);

  it('gives the stderr lines of the server, also the lines before the first message', async () => {
    const lines: string[] = [];
    const transport = groupStdioTransport(params(PLAIN_FIXTURE, '--noisy'), 'notes', silentLogger);
    readLines(transport.stderr, lines);
    await transport.start();
    await expect.poll(() => lines.length, { timeout: 15_000 }).toBeGreaterThanOrEqual(501);
    expect(lines[0]).toMatch(/^test server ready pid \d+$/);
    expect(lines).toContain('noise 499');
    await transport.close();
  }, 30_000);

  it('ends a server that ignores SIGTERM', async () => {
    const { lines, logger } = capture();
    const transport = groupStdioTransport(params(FIXTURE, '--ignore-term'), 'notes', logger);
    readLines(transport.stderr, lines);
    await transport.start();
    const { server, helper } = await pids(lines);
    await transport.close();
    await expect.poll(() => alive(server), { timeout: 5_000 }).toBe(false);
    await expect.poll(() => alive(helper), { timeout: 5_000 }).toBe(false);
  }, 30_000);

  it('rejects the start of a command that does not exist, and leaves no group', async () => {
    const errors: Error[] = [];
    const transport = groupStdioTransport({ command: 'okc-no-such-command', args: [], env: getDefaultEnvironment() }, 'notes', silentLogger);
    transport.onerror = (error) => void errors.push(error);
    await expect(transport.start()).rejects.toMatchObject({ code: 'ENOENT' });
    expect(errors).toHaveLength(1);
    await transport.close();
    await expect(transport.send({ jsonrpc: '2.0', id: 1, method: 'ping' })).rejects.toThrow('Not connected');
  });

  it('refuses a second start, and a second close is a no-op', async () => {
    const transport = groupStdioTransport(params(PLAIN_FIXTURE), 'notes', silentLogger);
    await transport.start();
    await expect(transport.start()).rejects.toThrow('already started');
    const pid = transport.pid!;
    await Promise.all([transport.close(), transport.close()]);
    await transport.close();
    await expect.poll(() => alive(pid), { timeout: 5_000 }).toBe(false);
  }, 30_000);

  it('ends the group when the close comes during the start', async () => {
    const { lines, logger } = capture();
    const transport = groupStdioTransport(params(FIXTURE), 'notes', logger);
    readLines(transport.stderr, lines);
    const started = transport.start();
    await transport.close();
    await started;
    // the server can end at the end of stdin before it printed its pids. then the group already ended.
    const line = lines.find((each) => each.startsWith('group server ready'));
    if (line) {
      const helper = Number(/helper (\d+)/.exec(line)![1]);
      await expect.poll(() => alive(helper), { timeout: 5_000 }).toBe(false);
    }
    await expect.poll(() => transport.pid, { timeout: 5_000 }).toBeNull();
  }, 30_000);

  it('fires onclose once for a server that exits by itself, and ends the helper that it left', async () => {
    const { lines, logger } = capture();
    const transport = groupStdioTransport(params(FIXTURE, '--exit-after', '1500'), 'notes', logger);
    readLines(transport.stderr, lines);
    let closes = 0;
    transport.onclose = () => void closes++;
    await transport.start();
    const { server, helper } = await pids(lines);
    await expect.poll(() => closes, { timeout: 10_000 }).toBe(1);
    expect(alive(server)).toBe(false);
    await expect.poll(() => alive(helper), { timeout: 5_000 }).toBe(false);
    await expect(transport.send({ jsonrpc: '2.0', id: 1, method: 'ping' })).rejects.toThrow('Not connected');
    await transport.close();
    expect(closes).toBe(1);
  }, 30_000);
});

describe.runIf(process.platform !== 'win32')('killProcessGroup', () => {
  it('sends SIGKILL to a group that ignores SIGTERM after the grace time, and gives false for a group that ended', async () => {
    const child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1_000); process.stdout.write('ready')"], {
      detached: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    await new Promise((resolve) => child.stdout.once('data', resolve));
    const pid = child.pid!;
    const exited = new Promise((resolve) => child.once('exit', (_code, signal) => resolve(signal)));
    const startedAt = Date.now();
    expect(await killProcessGroup(pid, 300)).toBe(true);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(300);
    expect(await exited).toBe('SIGKILL');
    expect(alive(pid)).toBe(false);
    expect(await killProcessGroup(pid, 300)).toBe(false);
  }, 30_000);

  it('never signals the group of this process or the groups 0 and 1', async () => {
    expect(await killProcessGroup(process.pid, 10)).toBe(false);
    expect(await killProcessGroup(1, 10)).toBe(false);
    expect(await killProcessGroup(0, 10)).toBe(false);
  });
});

describe.runIf(process.platform !== 'win32')('the exit of the agent', () => {
  it('ends the groups of the servers that still run when the process exits', async () => {
    // a small agent starts the group fixture, prints the pid of the helper, and exits without a close.
    const script = `
      import { groupStdioTransport } from ${JSON.stringify(join(import.meta.dirname, 'process-group.ts'))};
      import { silentLogger } from ${JSON.stringify(join(import.meta.dirname, '../observability/logger.ts'))};
      const transport = groupStdioTransport(${JSON.stringify(params(FIXTURE))}, 'notes', silentLogger);
      let text = '';
      transport.stderr.on('data', (chunk) => {
        text += chunk;
        const match = /helper (\\d+)/.exec(text);
        if (match) {
          process.stdout.write(match[1] + '\\n');
          process.exit(1);
        }
      });
      await transport.start();
      setInterval(() => {}, 1_000);
    `;
    const agent = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    agent.stdout.on('data', (chunk: Buffer) => void (out += chunk.toString('utf8')));
    const code = await new Promise((resolve) => agent.once('exit', resolve));
    expect(code).toBe(1);
    const helper = Number(out.trim());
    expect(helper).toBeGreaterThan(1);
    await expect.poll(() => alive(helper), { timeout: 5_000 }).toBe(false);
  }, 30_000);
});
