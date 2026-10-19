import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CredentialStoreError } from '../integrations/secrets.js';
import { createFileSecretStore, replace } from './file.js';
import { createSecretVault } from './index.js';

// these tests try to break the file backend: refs that look like object keys, files of a wrong shape, many writes at
// the same time, and a file that other users can read.

const posix = process.platform !== 'win32';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'okc-secret-edge-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const writeSecretFile = (path: string, text: string, mode = 0o600) => {
  writeFileSync(path, text, { mode });
  chmodSync(path, mode);
};

describe('the file store against hostile refs and files', () => {
  it('keeps refs that are names of object keys as plain refs', async () => {
    const path = join(dir, 'secrets.json');
    const store = createFileSecretStore(path);
    expect(await store.get('__proto__')).toBeUndefined();
    expect(await store.get('constructor')).toBeUndefined();
    writeSecretFile(path, JSON.stringify({ version: 1, secrets: {} }));
    expect(await store.get('toString')).toBeUndefined();
    expect(await store.get('hasOwnProperty')).toBeUndefined();
    await store.set('__proto__', 'proto-value-1234');
    await store.set('constructor', 'constructor-value-1234');
    const again = createFileSecretStore(path);
    expect(await again.get('__proto__')).toBe('proto-value-1234');
    expect(await again.get('constructor')).toBe('constructor-value-1234');
    expect(await again.get('toString')).toBeUndefined();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('keeps values with quotes, backslashes, new lines and emoji', async () => {
    const path = join(dir, 'secrets.json');
    const value = 'a"b\\c\nd e🔑f\u0000g';
    await createFileSecretStore(path).set('odd', value);
    expect(await createFileSecretStore(path).get('odd')).toBe(value);
  });

  it('refuses a file of another version or with a value that is not text, without its contents in the message', async () => {
    const path = join(dir, 'secrets.json');
    const store = createFileSecretStore(path);
    for (const body of [
      { version: 2, secrets: { a: 'hidden-content-one' } },
      { version: 1, secrets: { a: 7 } },
      { version: 1, secrets: ['hidden-content-two'] },
      { version: 1 },
      'hidden-content-three',
      null,
    ]) {
      writeSecretFile(path, JSON.stringify(body));
      const err = (await store.get('a').catch((e: unknown) => e)) as Error;
      expect(err).toBeInstanceOf(CredentialStoreError);
      expect(err.message).toBe(`the secret file ${path} is damaged`);
      // a set never replaces a damaged file, so the owner can still read it.
      await expect(store.set('a', 'value-of-a-1234')).rejects.toBeInstanceOf(CredentialStoreError);
      expect(readFileSync(path, 'utf8')).toBe(JSON.stringify(body));
    }
  });

  it('gives a path that is a folder as an error that names the path only', async () => {
    const path = join(dir, 'secrets.json');
    mkdirSync(path, { mode: 0o700 });
    chmodSync(path, 0o700);
    const err = (await createFileSecretStore(path).get('a').catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(CredentialStoreError);
    expect(err.message).toContain(path);
  });

  it('keeps every value of many sets and deletes at the same time, and leaves no temporary file', async () => {
    const path = join(dir, 'secrets.json');
    const store = createFileSecretStore(path);
    await Promise.all(Array.from({ length: 50 }, (_, i) => store.set(`ref:${i}`, `value-number-${i}-abcdef`)));
    await Promise.all(Array.from({ length: 50 }, (_, i) => (i % 2 ? store.delete(`ref:${i}`) : store.set(`ref:${i}`, `again-${i}-abcdef`))));
    for (let i = 0; i < 50; i++) expect(await store.get(`ref:${i}`)).toBe(i % 2 ? undefined : `again-${i}-abcdef`);
    expect(readdirSync(dir)).toEqual(['secrets.json']);
  });

  it('keeps the writes of two stores on one file in one process', async () => {
    const path = join(dir, 'secrets.json');
    const one = createFileSecretStore(path);
    const two = createFileSecretStore(path);
    await Promise.all([one.set('a', 'value-of-a-1234'), two.set('b', 'value-of-b-1234'), one.set('c', 'value-of-c-1234')]);
    expect(await two.get('a')).toBe('value-of-a-1234');
    expect(await one.get('b')).toBe('value-of-b-1234');
    expect(await two.get('c')).toBe('value-of-c-1234');
  });

  it('a failed set does not stop the next set of the same store', async () => {
    const path = join(dir, 'secrets.json');
    const store = createFileSecretStore(path);
    writeSecretFile(path, 'not json');
    await expect(store.set('a', 'value-of-a-1234')).rejects.toBeInstanceOf(CredentialStoreError);
    rmSync(path);
    await store.set('b', 'value-of-b-1234');
    expect(await store.get('b')).toBe('value-of-b-1234');
  });

  it.skipIf(!posix)('makes the missing folder with mode 0700 and keeps mode 0600 after each write', async () => {
    const path = join(dir, 'deep', 'er', 'secrets.json');
    const store = createFileSecretStore(path);
    await store.set('a', 'value-of-a-1234');
    expect(statSync(join(dir, 'deep', 'er')).mode & 0o777).toBe(0o700);
    for (let i = 0; i < 5; i++) await store.set(`r${i}`, `value-number-${i}-abcdef`);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it.skipIf(!posix)('refuses a set over a file that other users can read, and leaves it as it was', async () => {
    const path = join(dir, 'secrets.json');
    const text = JSON.stringify({ version: 1, secrets: { a: 'old-value-1234' } });
    writeSecretFile(path, text, 0o640);
    const store = createFileSecretStore(path);
    await expect(store.set('a', 'new-value-1234')).rejects.toThrow(`Run chmod 600 ${path}.`);
    expect(readFileSync(path, 'utf8')).toBe(text);
    expect(statSync(path).mode & 0o777).toBe(0o640);
  });

  it('resolves a relative path against the folder where the app runs', async () => {
    const before = process.cwd();
    try {
      process.chdir(dir);
      await createFileSecretStore('data/secrets.json').set('a', 'value-of-a-1234');
    } finally {
      process.chdir(before);
    }
    expect(JSON.parse(readFileSync(join(dir, 'data', 'secrets.json'), 'utf8'))).toEqual({ version: 1, secrets: { a: 'value-of-a-1234' } });
  });
});

describe('the file vault', () => {
  it('shows a damaged file with its path, never with its contents or a ref', async () => {
    const path = join(dir, 'secrets.json');
    writeSecretFile(path, '{"version":1,"secrets":{"google.personal":"content-of-the-file-8181"');
    const view = await createSecretVault({ backend: 'file', path }).view();
    expect(view).toEqual({ backend: 'file', detail: path, ok: false, error: `the secret file ${path} is damaged` });
  });

  it('shows a working file as ok, and the view holds no ref or value', async () => {
    const path = join(dir, 'secrets.json');
    const vault = createSecretVault({ backend: 'file', path });
    await vault.store.set('google.personal', 'stored-value-of-ref-9191');
    const text = JSON.stringify(await vault.view());
    expect(JSON.parse(text)).toEqual({ backend: 'file', detail: path, ok: true, error: null });
    expect(text).not.toContain('google.personal');
    expect(text).not.toContain('stored-value-of-ref-9191');
  });

  it.skipIf(!posix)('shows a file that other users can read with the chmod that fixes it', async () => {
    const path = join(dir, 'secrets.json');
    writeSecretFile(path, JSON.stringify({ version: 1, secrets: {} }), 0o644);
    const view = await createSecretVault({ backend: 'file', path }).view();
    expect(view.ok).toBe(false);
    expect(view.error).toBe(`the secret file ${path} can be read by other users. Run chmod 600 ${path}.`);
  });
});

// windows has no mode bits, so the store limits the file to its owner with an access list. a fake protect records
// each file, so this runs on every system.
describe('the file secret store on windows', () => {
  it('limits a new file before a value is in it, and an old file at its first read', async () => {
    const root = mkdtempSync(join(tmpdir(), 'okc-secret-acl-'));
    try {
      const path = join(root, 'secrets.json');
      const seen: { file: string; size: number }[] = [];
      const protect = (file: string) => seen.push({ file, size: statSync(file).size });
      const store = createFileSecretStore(path, { platform: 'win32', protect });
      await store.set('a', 'value-of-a-1234');
      expect(seen).toHaveLength(1);
      expect(seen[0]!.file).toMatch(/secrets\.json\.[0-9a-f]+\.tmp$/);
      expect(seen[0]!.size).toBe(0);
      // the set read no file, because none was there. the next read finds the file and limits it once.
      expect(await store.get('a')).toBe('value-of-a-1234');
      expect(await store.get('a')).toBe('value-of-a-1234');
      expect(seen.map((each) => each.file).filter((file) => file === path)).toHaveLength(1);

      // an old file with an open mode is fine on windows, because the mode bits mean nothing there.
      writeFileSync(path, JSON.stringify({ version: 1, secrets: { b: 'value-of-b-1234' } }), { mode: 0o644 });
      const old: string[] = [];
      expect(await createFileSecretStore(path, { platform: 'win32', protect: (file) => old.push(file) }).get('b')).toBe('value-of-b-1234');
      expect(old).toEqual([path]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails without the value when the access list cannot be set, and leaves no temporary file', async () => {
    const root = mkdtempSync(join(tmpdir(), 'okc-secret-acl-'));
    try {
      const path = join(root, 'secrets.json');
      const store = createFileSecretStore(path, {
        platform: 'win32',
        protect: () => {
          throw new Error('icacls failed for value-of-a-1234');
        },
      });
      const err = await store.set('a', 'value-of-a-1234').catch((caught: unknown) => caught);
      expect(err).toBeInstanceOf(CredentialStoreError);
      expect((err as Error).message).toContain('cannot be limited to its owner');
      expect((err as Error).message).not.toContain('value-of-a');
      expect(readdirSync(root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('writes the sets and deletes that come at the same time together, so icacls does not run once for each', async () => {
    const root = mkdtempSync(join(tmpdir(), 'okc-secret-acl-'));
    try {
      const path = join(root, 'secrets.json');
      const seen: string[] = [];
      const store = createFileSecretStore(path, { platform: 'win32', protect: (file) => seen.push(file) });
      await Promise.all(Array.from({ length: 50 }, (_, i) => store.set(`ref:${i}`, `value-number-${i}-abcdef`)));
      await Promise.all(Array.from({ length: 50 }, (_, i) => (i % 2 ? store.delete(`ref:${i}`) : store.set(`ref:${i}`, `again-${i}-abcdef`))));
      for (let i = 0; i < 50; i++) expect(await store.get(`ref:${i}`)).toBe(i % 2 ? undefined : `again-${i}-abcdef`);
      // one temporary file for each of the two rounds, and the file itself once at its first read.
      expect(seen.filter((file) => file.endsWith('.tmp'))).toHaveLength(2);
      expect(readdirSync(root)).toEqual(['secrets.json']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('tries a rename again while another program holds the file, and gives up after a short while', async () => {
    const busy = (code: string) => Object.assign(new Error(`${code}: the file is in use`), { code });
    let calls = 0;
    await replace('a.tmp', 'a', true, () => {
      if (++calls < 3) throw busy(calls === 1 ? 'EPERM' : 'EBUSY');
    });
    expect(calls).toBe(3);

    calls = 0;
    const started = Date.now();
    const err = await replace('a.tmp', 'a', true, () => {
      calls++;
      throw busy('EACCES');
    }).catch((caught: unknown) => caught);
    expect((err as NodeJS.ErrnoException).code).toBe('EACCES');
    expect(calls).toBe(8);
    expect(Date.now() - started).toBeLessThan(5_000);

    // another error, or the same error on another system, fails at once.
    for (const [code, windows] of [['ENOENT', true], ['EPERM', false]] as const) {
      calls = 0;
      await expect(
        replace('a.tmp', 'a', windows, () => {
          calls++;
          throw busy(code);
        }),
      ).rejects.toMatchObject({ code });
      expect(calls).toBe(1);
    }
  });
});

