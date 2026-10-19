import { spawn } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
    // on macos the socket file stays after the crash, and the next start removes it.
    if (process.platform === 'darwin') expect(existsSync(lockName(data))).toBe(true);
    const lock = await holdInstanceLock(data);
    expect(lock).toBeDefined();
    await lock!.release();
  });

  it('names a socket file that fits the socket path limit on macos', () => {
    const data = mkdtempSync(join(tmpdir(), 'okc-lock-'));
    // only macos makes a name for macos, as the agent always asks for the name of the platform it runs on. a unix
    // host can still check that name, as it has a user id and paths with the separator of macos. windows has
    // neither, and its data folder is not a path of macos, so there a name for macos means nothing.
    if (process.platform !== 'win32') {
      const name = lockName(data, 'darwin');
      expect(name).toMatch(/^\/.*\/okc-(\d+-)?[0-9a-f]{32}\.sock$/);
      expect(Buffer.byteLength(name)).toBeLessThanOrEqual(103);
      expect(lockName(join(data, '.'), 'darwin')).toBe(name);
    }
    expect(lockName(data, 'linux')).toMatch(/^\0okc-[0-9a-f]{32}$/);
    expect(lockName(data, 'win32')).toMatch(/^\\\\\.\\pipe\\okc-[0-9a-f]{32}$/);
  });

  // an ssh or sudo shell can start the agent without TMPDIR, and it must still see the lock of the login agent.
  it('names the same socket file on macos whatever TMPDIR holds', () => {
    const data = mkdtempSync(join(tmpdir(), 'okc-lock-'));
    const name = lockName(data, 'darwin');
    const saved = process.env.TMPDIR;
    try {
      process.env.TMPDIR = '/somewhere/else';
      expect(lockName(data, 'darwin')).toBe(name);
      delete process.env.TMPDIR;
      expect(lockName(data, 'darwin')).toBe(name);
    } finally {
      if (saved === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = saved;
    }
    expect(name.startsWith('/somewhere')).toBe(false);
  });

  // a socket file that no process listens on is from a process that ended, so the lock removes it and takes its place.
  it.runIf(process.platform !== 'win32' && process.platform !== 'linux')('takes the place of a socket file that no process answers on', async () => {
    const data = mkdtempSync(join(tmpdir(), 'okc-lock-'));
    const name = lockName(data);
    const body = `require('node:net').createServer().listen(${JSON.stringify(name)}, () => console.log('held'));`;
    const child = spawn(process.execPath, ['-e', body], { stdio: ['ignore', 'pipe', 'inherit'] });
    await new Promise<void>((held) => child.stdout.on('data', (chunk: Buffer) => chunk.toString().includes('held') && held()));
    const ended = new Promise((exit) => child.once('exit', exit));
    child.kill('SIGKILL');
    await ended;
    expect(lstatSync(name).isSocket()).toBe(true);
    const lock = await holdInstanceLock(data);
    expect(lock).toBeDefined();
    expect(await holdInstanceLock(data)).toBeUndefined();
    await lock!.release();
    expect(existsSync(name)).toBe(false);
  });

  // each test run and each start with a new data folder would otherwise leave one more socket file in the temp folder.
  it.runIf(process.platform !== 'win32' && process.platform !== 'linux')('removes its socket file when its process exits without a release', async () => {
    const data = mkdtempSync(join(tmpdir(), 'okc-lock-'));
    const url = pathToFileURL(join(import.meta.dirname, 'instance.ts')).href;
    const body = `const { holdInstanceLock } = await import(${JSON.stringify(url)});\nawait holdInstanceLock(${JSON.stringify(data)});\nconsole.log('held');\nprocess.exit(0);`;
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', body], { stdio: ['ignore', 'pipe', 'inherit'] });
    let held = false;
    child.stdout.on('data', (chunk: Buffer) => (held ||= chunk.toString().includes('held')));
    await new Promise((exit) => child.once('exit', exit));
    expect(held).toBe(true);
    expect(existsSync(lockName(data))).toBe(false);
  });

  it.runIf(process.platform !== 'win32' && process.platform !== 'linux')('does not remove a file that is not a socket', async () => {
    const data = mkdtempSync(join(tmpdir(), 'okc-lock-'));
    writeFileSync(lockName(data), 'x');
    await expect(holdInstanceLock(data)).rejects.toThrow();
    expect(existsSync(lockName(data))).toBe(true);
    rmSync(lockName(data));
  });

  it('gives a data folder the same name before and after it exists', () => {
    const data = join(mkdtempSync(join(tmpdir(), 'okc-lock-')), 'data');
    const before = lockName(data);
    mkdirSync(data);
    expect(lockName(data)).toBe(before);
  });
});
