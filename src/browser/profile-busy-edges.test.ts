import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { chromePaths } from './login.js';
import { profileBusy } from './worker.js';

// these cases try the edges of the profile lock on macos and linux, and of the places of chrome.

const profile = () => mkdtempSync(join(tmpdir(), 'okc-profile-'));
const lock = (dir: string, target: string) => symlinkSync(target, join(dir, 'SingletonLock'));

describe.skipIf(process.platform === 'win32')('the profile lock of chrome on macos and linux, at its edges', () => {
  it('is free for a profile folder that does not exist yet, as before the first start', () => {
    expect(profileBusy(join(tmpdir(), 'okc-no-such-profile', 'profile'))).toBe(false);
  });

  // chrome makes a dangling link: its target is no file. readlink must not follow it.
  it('reads a dangling link and does not need its target to exist', () => {
    const dir = profile();
    lock(dir, `${hostname()}-${process.pid}`);
    expect(profileBusy(dir)).toBe(true);
  });

  it('is busy while a child process of the link is alive, and free after it ended', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    const dir = profile();
    lock(dir, `${hostname()}-${child.pid}`);
    try {
      expect(profileBusy(dir)).toBe(true);
    } finally {
      child.kill('SIGKILL');
    }
    await new Promise((done) => child.once('exit', done));
    expect(profileBusy(dir)).toBe(false);
  });

  // a folder in place of the link is not chrome's lock, and a link to a folder is still read as a link.
  it('treats a folder named SingletonLock as free, and a link that points to a folder by its text', () => {
    const folder = profile();
    mkdirSync(join(folder, 'SingletonLock'));
    expect(profileBusy(folder)).toBe(false);
    const linked = profile();
    lock(linked, tmpdir());
    expect(profileBusy(linked)).toBe(true);
  });

  it('gives the same answer on each call, so the check has no side effect on the link', () => {
    const dir = profile();
    lock(dir, `${hostname()}-${process.pid}`);
    for (let i = 0; i < 3; i++) expect(profileBusy(dir)).toBe(true);
    const plain = profile();
    writeFileSync(join(plain, 'SingletonLock'), `${hostname()}-${process.pid}`);
    for (let i = 0; i < 3; i++) expect(profileBusy(plain)).toBe(false);
  });
});

describe('the places of chrome, at their edges', () => {
  it('gives only absolute places on macos and linux', () => {
    for (const each of chromePaths('darwin', { HOME: '/Users/owner' })) expect(isAbsolute(each), each).toBe(true);
    for (const each of chromePaths('linux', {})) expect(isAbsolute(each), each).toBe(true);
  });

  it('looks in the system folder first on macos, then in the folder of the owner', () => {
    const paths = chromePaths('darwin', { HOME: '/Users/a b' });
    expect(paths[0]).toBe('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
    expect(paths[1]).toBe('/Users/a b/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
  });

  it('gives the stable chrome of linux before the other names', () => {
    const paths = chromePaths('linux', {});
    expect(paths[0]).toBe('/opt/google/chrome/chrome');
    expect(paths).toContain('/usr/bin/google-chrome-stable');
  });
});
