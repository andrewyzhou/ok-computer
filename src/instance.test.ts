import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { holdInstanceLock, lockName } from './instance.js';

describe('the instance lock', () => {
  it('lets one holder have the data folder, and frees it on release', async () => {
    const data = mkdtempSync(join(tmpdir(), 'okc-lock-'));
    const first = await holdInstanceLock(data);
    expect(first).toBeDefined();
    expect(await holdInstanceLock(data)).toBeUndefined();
    // another data folder is another database.
    const other = await holdInstanceLock(mkdtempSync(join(tmpdir(), 'okc-lock-')));
    expect(other).toBeDefined();
    await other!.release();
    await first!.release();
    const again = await holdInstanceLock(data);
    expect(again).toBeDefined();
    await again!.release();
  });

  it.runIf(process.platform === 'win32')('gives one name for each spelling of the folder on windows', () => {
    const data = mkdtempSync(join(tmpdir(), 'okc-lock-'));
    expect(lockName(data.toUpperCase())).toBe(lockName(join(data, '.')));
  });

  // a crash cannot leave the lock behind, so the supervisor can start the agent again at once.
  it('is free again when its process ends without a stop', async () => {
    const data = mkdtempSync(join(tmpdir(), 'okc-lock-'));
    const url = pathToFileURL(join(import.meta.dirname, 'instance.ts')).href;
    const body = `const { holdInstanceLock } = await import(${JSON.stringify(url)});\nawait holdInstanceLock(${JSON.stringify(data)});\nconsole.log('held');\nsetInterval(() => {}, 1000);`;
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', body], { stdio: ['ignore', 'pipe', 'inherit'] });
    await new Promise<void>((held) => child.stdout.on('data', (chunk: Buffer) => chunk.toString().includes('held') && held()));
    expect(await holdInstanceLock(data)).toBeUndefined();
    const ended = new Promise((exit) => child.once('exit', exit));
    child.kill('SIGKILL');
    await ended;
    const lock = await holdInstanceLock(data);
    expect(lock).toBeDefined();
    await lock!.release();
  });
});
