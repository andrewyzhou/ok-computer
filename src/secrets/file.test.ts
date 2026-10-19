import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CredentialStoreError } from '../integrations/secrets.js';
import { redact } from '../observability/redact.js';
import { createFileSecretStore } from './file.js';

const posix = process.platform !== 'win32';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'okc-secret-file-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const writeSecretFile = (path: string, text: string, mode = 0o600) => {
  writeFileSync(path, text, { mode });
  chmodSync(path, mode);
};

describe('the file secret store', () => {
  it('gives undefined for a missing file and a missing ref', async () => {
    const store = createFileSecretStore(join(dir, 'secrets.json'));
    expect(await store.get('google:a')).toBeUndefined();
    await store.set('google:a', 'value-of-a-1234');
    expect(await store.get('google:b')).toBeUndefined();
  });

  it('keeps a value through a new store, with a unicode value and a ref with : @ and #', async () => {
    const path = join(dir, 'nested', 'deeper', 'secrets.json');
    const ref = 'linear:oauth@tokens#1';
    const value = 'tökén-🔑-値-0123456789';
    await createFileSecretStore(path).set(ref, value);
    expect(await createFileSecretStore(path).get(ref)).toBe(value);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ version: 1, secrets: { [ref]: value } });
    if (posix) expect(statSync(join(dir, 'nested', 'deeper')).mode & 0o777).toBe(0o700);
  });

  it.skipIf(!posix)('writes the file with mode 0600', async () => {
    const path = join(dir, 'secrets.json');
    await createFileSecretStore(path).set('a', 'value-of-a-1234');
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir)).toEqual(['secrets.json']);
  });

  it.skipIf(!posix)('refuses a file that other users can read', async () => {
    const path = join(dir, 'secrets.json');
    writeSecretFile(path, JSON.stringify({ version: 1, secrets: { a: 'value-of-a-1234' } }), 0o644);
    const store = createFileSecretStore(path);
    const err = await store.get('a').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CredentialStoreError);
    expect((err as Error).message).toBe(`the secret file ${path} can be read by other users. Run chmod 600 ${path}.`);
    await expect(store.check()).rejects.toThrow('chmod 600');
    await expect(store.set('b', 'value-of-b-1234')).rejects.toThrow('chmod 600');
  });

  it('refuses damaged json and a wrong shape without the contents in the message', async () => {
    const path = join(dir, 'secrets.json');
    const store = createFileSecretStore(path);
    for (const text of ['{"version":1,"secrets":{"a":"hidden-value-1234"', '{"version":2,"secrets":{}}', '{"version":1,"secrets":{"a":5}}', '[]']) {
      writeSecretFile(path, text);
      const err = await store.get('a').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(CredentialStoreError);
      expect((err as Error).message).toBe(`the secret file ${path} is damaged`);
      expect((err as Error).message).not.toContain('hidden');
      await expect(store.check()).rejects.toThrow('is damaged');
    }
  });

  it('keeps both values of two sets at the same time', async () => {
    const path = join(dir, 'secrets.json');
    const store = createFileSecretStore(path);
    await Promise.all([store.set('a', 'value-of-a-1234'), store.set('b', 'value-of-b-1234'), store.set('c', 'value-of-c-1234')]);
    expect(await store.get('a')).toBe('value-of-a-1234');
    expect(await store.get('b')).toBe('value-of-b-1234');
    expect(await store.get('c')).toBe('value-of-c-1234');
  });

  it('deletes a ref, and a delete of a missing ref or a missing file does nothing', async () => {
    const path = join(dir, 'secrets.json');
    const store = createFileSecretStore(path);
    await store.delete('a');
    expect(readdirSync(dir)).toEqual([]);
    await store.set('a', 'value-of-a-1234');
    await store.set('b', 'value-of-b-1234');
    await store.delete('missing');
    await store.delete('a');
    expect(await store.get('a')).toBeUndefined();
    expect(await store.get('b')).toBe('value-of-b-1234');
  });

  it('a failed write leaves the old file and no temporary file', async () => {
    const path = join(dir, 'secrets.json');
    const store = createFileSecretStore(path);
    await store.set('a', 'value-of-a-1234');
    // a folder in the place of the file makes the rename fail.
    rmSync(path);
    mkdirSync(path);
    writeFileSync(join(path, 'x'), '');
    await expect(store.set('b', 'value-of-b-1234')).rejects.toBeInstanceOf(CredentialStoreError);
    expect(readdirSync(dir)).toEqual(['secrets.json']);
    // a later write still runs after the failed one.
    rmSync(path, { recursive: true });
    await store.set('c', 'value-of-c-1234');
    expect(await store.get('c')).toBe('value-of-c-1234');
  });

  it('check passes for a missing file in a writable folder', async () => {
    await expect(createFileSecretStore(join(dir, 'secrets.json')).check()).resolves.toBeUndefined();
    await expect(createFileSecretStore(join(dir, 'not', 'yet', 'secrets.json')).check()).resolves.toBeUndefined();
  });

  it.skipIf(!posix || process.getuid?.() === 0)('check fails for a missing file in a folder that cannot be written', async () => {
    const folder = join(dir, 'locked');
    mkdirSync(folder, { mode: 0o500 });
    chmodSync(folder, 0o500);
    try {
      const path = join(folder, 'secrets.json');
      await expect(createFileSecretStore(path).check()).rejects.toThrow(`the folder of the secret file ${path} cannot be written`);
    } finally {
      chmodSync(folder, 0o700);
    }
  });

  it('gives each value to the redactor after a get or a set', async () => {
    const path = join(dir, 'secrets.json');
    await createFileSecretStore(path).set('a', 'set-value-redact-5150');
    expect(redact('x set-value-redact-5150 y')).toBe('x [redacted] y');
    writeSecretFile(path, JSON.stringify({ version: 1, secrets: { b: 'read-value-redact-6260' } }));
    expect(redact('read-value-redact-6260')).toBe('read-value-redact-6260');
    expect(await createFileSecretStore(path).get('b')).toBe('read-value-redact-6260');
    expect(redact('read-value-redact-6260')).toBe('[redacted]');
  });
});
