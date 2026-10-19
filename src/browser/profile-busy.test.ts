import { spawnSync } from 'node:child_process';
import { mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { chromePaths } from './login.js';
import { profileBusy } from './worker.js';

// the host name of a mac is often like "owners-macbook-pro.local". a fixed name with dashes makes the tests the same
// on every machine.
vi.mock('node:os', async (original) => ({ ...(await original<typeof import('node:os')>()), hostname: () => 'owners-macbook-pro.local' }));

const profile = () => mkdtempSync(join(tmpdir(), 'okc-profile-'));

// a pid of a process that ended a moment ago, so no process has it now.
const endedPid = () => spawnSync(process.execPath, ['-e', '']).pid!;

// chrome on macos and linux makes the SingletonLock link. windows uses the lockfile, which the chrome tests cover.
describe.skipIf(process.platform === 'win32')('the profile lock of chrome on macos and linux', () => {
  it('is free without the link', () => {
    expect(profileBusy(profile())).toBe(false);
  });

  it('is busy while the process of the link is alive', () => {
    const dir = profile();
    symlinkSync(`${hostname()}-${process.pid}`, join(dir, 'SingletonLock'));
    expect(profileBusy(dir)).toBe(true);
  });

  it('is free when the process of the link ended, as after a crash of chrome', () => {
    const dir = profile();
    symlinkSync(`${hostname()}-${endedPid()}`, join(dir, 'SingletonLock'));
    expect(profileBusy(dir)).toBe(false);
  });

  it('is busy when the link comes from another host or has no pid', () => {
    const other = profile();
    symlinkSync(`another-host.example-${process.pid}`, join(other, 'SingletonLock'));
    expect(profileBusy(other)).toBe(true);
    const broken = profile();
    symlinkSync('no-pid-here', join(broken, 'SingletonLock'));
    expect(profileBusy(broken)).toBe(true);
  });

  it('reads the pid after the last dash of a host name with dashes', () => {
    expect(hostname()).toBe('owners-macbook-pro.local');
    const alive = profile();
    symlinkSync(`owners-macbook-pro.local-${process.pid}`, join(alive, 'SingletonLock'));
    expect(profileBusy(alive)).toBe(true);
    const ended = profile();
    symlinkSync(`owners-macbook-pro.local-${endedPid()}`, join(ended, 'SingletonLock'));
    expect(profileBusy(ended)).toBe(false);
  });

  it('is busy for a pid of 0, a negative pid or a pid that is not plain digits', () => {
    for (const pid of ['0', '', `-${process.pid}`, '0x1', '1e3', ' 1']) {
      const dir = profile();
      symlinkSync(`${hostname()}-${pid}`, join(dir, 'SingletonLock'));
      expect(profileBusy(dir), pid).toBe(true);
    }
  });

  // pid 1 belongs to root, so a check from another user fails with EPERM, and the process is alive.
  it('is busy while the process of the link runs as another user', () => {
    const dir = profile();
    symlinkSync(`${hostname()}-1`, join(dir, 'SingletonLock'));
    expect(profileBusy(dir)).toBe(true);
  });

  it('is free with a plain file in place of the link', () => {
    const dir = profile();
    writeFileSync(join(dir, 'SingletonLock'), '');
    expect(profileBusy(dir)).toBe(false);
  });
});

describe('the places of chrome', () => {
  it('has a usual place for each platform', () => {
    expect(chromePaths('darwin', { HOME: '/Users/owner' })).toEqual([
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Users/owner/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    ]);
    expect(chromePaths('linux', {})).toContain('/opt/google/chrome/chrome');
    expect(chromePaths('win32', { PROGRAMFILES: 'C:/Program Files' })[0]).toMatch(/Google[\\/]Chrome[\\/]Application[\\/]chrome\.exe$/);
  });
});
