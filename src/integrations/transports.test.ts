import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { describe, expect, it } from 'vitest';
import { silentLogger, type Logger } from '../observability/logger.js';
import { parseIntegrations, type StdioEntry } from './config.js';
import { STDERR_LINES_PER_MINUTE } from './mcp.js';
import { createMemorySecretStore } from './secrets.js';
import { descendants, limitBody, sameProcesses, stdioTransport } from './transports.js';

const FIXTURE = join(import.meta.dirname, '../../test/fixtures/stdio-server.ts');

function entryFor(command: string, args: string[]): StdioEntry {
  const parsed = parseIntegrations({ integrations: [{ id: 'notes', kind: 'mcp-stdio', command, args, tools: { allow: ['echo'] } }] });
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value[0] as StdioEntry;
}

function capture() {
  const lines: string[] = [];
  const warnings: Array<{ msg: string; fields?: Record<string, unknown> }> = [];
  const logger: Logger = {
    ...silentLogger,
    info: (msg, fields) => void (msg === 'mcp server stderr' && lines.push(String(fields?.line))),
    warn: (msg, fields) => void warnings.push({ msg, ...(fields ? { fields } : {}) }),
  };
  return { lines, warnings, logger };
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// windows keeps the parent pid of a process after its parent ends, and gives the freed pid to a new process. the close
// of a server whose pid was such a freed pid ended the unrelated orphans, for example explorer.exe.
describe('process tree of a stdio server', () => {
  const owner = 100;
  const startedAt = 10_000;
  const server = { pid: 10, parent: owner, created: 10_010 };
  const child = { pid: 11, parent: 10, created: 10_020 };
  const grandchild = { pid: 12, parent: 11, created: 10_030 };
  // the old owner of pid 10 started this process and ended before the server started.
  const orphan = { pid: 20, parent: 10, created: 5_000 };
  const orphanChild = { pid: 21, parent: 20, created: 6_000 };
  // a process that got the freed pid 11 after the child ended, during the close.
  const reused = { pid: 11, parent: 50, created: 10_500 };

  it('lists only the processes that started after the server and after their parent', () => {
    const rows = [server, child, grandchild, orphan, orphanChild];
    expect(descendants(rows, 10, startedAt, owner)).toEqual([child, grandchild]);
    // the server already ended: its children are still found by the start time.
    expect(descendants([child, grandchild, orphan, orphanChild], 10, startedAt, owner)).toEqual([child, grandchild]);
  });

  it('lists nothing for a root that this process did not start', () => {
    expect(descendants([{ ...server, parent: 77 }, child], 10, startedAt, owner)).toEqual([]);
    expect(descendants([{ ...server, created: 1_000 }, child], 10, startedAt, owner)).toEqual([]);
  });

  it('ends only a listed process that still has the same start time', () => {
    expect(sameProcesses([child, grandchild], [reused, grandchild])).toEqual([grandchild]);
  });
});

describe('stdio transport', () => {
  it.skipIf(process.platform !== 'win32')(
    'ends a stubborn server that runs behind cmd.exe, as npx does on windows',
    async () => {
      const { lines, warnings, logger } = capture();
      const entry = entryFor('cmd.exe', ['/d', '/c', process.execPath, '--import', 'tsx', FIXTURE, '--stubborn']);
      const transport = await stdioTransport(entry, createMemorySecretStore(), logger);
      const client = new Client({ name: 'test', version: '0' });
      await client.connect(transport);
      await expect.poll(() => lines.find((line) => line.startsWith('test server ready')), { timeout: 10_000 }).toBeDefined();
      const pid = Number(lines.find((line) => line.startsWith('test server ready'))!.split(' pid ')[1]);
      expect(alive(pid)).toBe(true);
      await client.close();
      await expect.poll(() => alive(pid), { timeout: 5_000 }).toBe(false);
      expect(warnings.map((each) => each.msg)).toContain('mcp server process ended after the close');
    },
    30_000,
  );

  it('keeps a noisy server from filling the log', async () => {
    const { lines, logger } = capture();
    const entry = entryFor(process.execPath, ['--import', 'tsx', FIXTURE, '--noisy']);
    const transport = await stdioTransport(entry, createMemorySecretStore(), logger, () => 0);
    const client = new Client({ name: 'test', version: '0' });
    await client.connect(transport);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(lines).toHaveLength(STDERR_LINES_PER_MINUTE);
    await client.close();
  }, 30_000);

  it('starts a new stderr window when the clock moves back', async () => {
    const { lines, logger } = capture();
    const entry = entryFor(process.execPath, ['--import', 'tsx', FIXTURE, '--noisy']);
    // the first 200 reads of the clock are an hour later than the others, as when the clock of the pc moves back.
    let reads = 0;
    const now = () => (++reads <= 200 ? 3_600_000 : 0);
    const transport = await stdioTransport(entry, createMemorySecretStore(), logger, now);
    const client = new Client({ name: 'test', version: '0' });
    await client.connect(transport);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(lines).toHaveLength(2 * STDERR_LINES_PER_MINUTE);
    await client.close();
  }, 30_000);
});

describe('the size limit of an http answer', () => {
  // the http transport read an answer of any size. one large result held the event loop for seconds.
  // the body comes in pieces of 7 bytes, so a line end and a blank line can cross the end of a piece.
  const answer = (body: string, type: string) => async () => {
    const bytes = new TextEncoder().encode(body);
    const pieces = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let at = 0; at < bytes.length; at += 7) controller.enqueue(bytes.slice(at, at + 7));
        controller.close();
      },
    });
    return new Response(pieces, { headers: { 'content-type': type } });
  };
  const read = async (fetcher: typeof fetch) => (await fetcher('http://127.0.0.1/mcp')).text();

  it('stops a body over the limit, and lets a body at the limit through', async () => {
    let over = 0;
    await expect(read(limitBody(answer('x'.repeat(101), 'application/json'), 100, () => over++))).rejects.toThrow('larger than 100 bytes');
    expect(over).toBe(1);
    // a json body counts as one message, also with blank lines in it.
    await expect(read(limitBody(answer(`${'x'.repeat(60)}\n\n${'x'.repeat(60)}`, 'application/json'), 100, () => over++))).rejects.toThrow();
    expect(await read(limitBody(answer('x'.repeat(100), 'application/json'), 100, () => over++))).toHaveLength(100);
    expect(over).toBe(2);
  });

  it('counts each event of an event stream on its own, also when one event has many data lines', async () => {
    let over = 0;
    const event = `data: ${'x'.repeat(40)}\n\n`;
    // a long stream of small events stays open, with a blank line of \n or of \r\n.
    const stream = `${event.repeat(20)}${event.replace(/\n/g, '\r\n').repeat(20)}`;
    expect(await read(limitBody(answer(stream, 'text/event-stream'), 100, () => over++))).toBe(stream);
    // the parser of the sdk joins the data lines of one event, so a split does not reset the count.
    const split = `${'data: xxxxxxxxxx\n'.repeat(10)}\n`;
    await expect(read(limitBody(answer(split, 'text/event-stream'), 100, () => over++))).rejects.toThrow('larger than 100 bytes');
    expect(over).toBe(1);
  });
});
