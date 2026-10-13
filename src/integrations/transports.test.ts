import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { describe, expect, it } from 'vitest';
import { silentLogger, type Logger } from '../observability/logger.js';
import { parseIntegrations, type StdioEntry } from './config.js';
import { STDERR_LINES_PER_MINUTE } from './mcp.js';
import { createMemorySecretStore } from './secrets.js';
import { stdioTransport } from './transports.js';

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
