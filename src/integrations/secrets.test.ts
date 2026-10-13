import { describe, expect, it } from 'vitest';
import { redact } from '../observability/redact.js';
import { createKeyringStore, createPartedStore, type KeyringBackend } from './secrets.js';

// the fake keeps the limit of the windows credential manager: 1,280 utf-16 units in one entry.
function fakeKeyring() {
  const entries = new Map<string, string>();
  let failAfter = Infinity;
  const backend: KeyringBackend = {
    async get(ref) {
      return entries.get(ref) ?? null;
    },
    async set(ref, value) {
      if (failAfter-- <= 0) throw new Error('the process stopped');
      if (value.length > 1_280) throw new Error("Value of 'password encoded as UTF-16' is longer than the platform limit of 2560 chars");
      entries.set(ref, value);
    },
    async delete(ref) {
      entries.delete(ref);
    },
  };
  return { entries, backend, crashAfter: (writes: number) => void (failAfter = writes) };
}

const tokens = JSON.stringify({ access_token: 'a'.repeat(900), refresh_token: 'r'.repeat(400), id_token: 'i'.repeat(1_400), expires_in: 3600 });

describe('parted secret store', () => {
  it('stores a value over the platform limit in parts and reads it back', async () => {
    const { entries, backend } = fakeKeyring();
    const store = createPartedStore(backend);
    await store.set('slack:tokens', tokens);
    expect(await store.get('slack:tokens')).toBe(tokens);
    expect(entries.size).toBe(4);
    expect([...entries.values()].every((each) => each.length <= 1_280)).toBe(true);
  });

  it('keeps a short value in one plain entry, so the existing references still work', async () => {
    const { entries, backend } = fakeKeyring();
    const store = createPartedStore(backend);
    await store.set('github-token', 'ghp_short');
    expect(entries.get('github-token')).toBe('ghp_short');
  });

  it('never splits a surrogate pair', async () => {
    const { backend } = fakeKeyring();
    const store = createPartedStore(backend);
    const value = 'x' + '\u{1F600}'.repeat(1_500);
    await store.set('emoji', value);
    expect(await store.get('emoji')).toBe(value);
  });

  it('keeps the old value when the process stops during a write, at every point', async () => {
    for (let writes = 0; writes < 4; writes++) {
      const { backend, crashAfter } = fakeKeyring();
      const store = createPartedStore(backend);
      await store.set('slack:tokens', tokens);
      const next = tokens.replace('expires_in', 'expires_at');
      crashAfter(writes);
      await store.set('slack:tokens', next).catch(() => {});
      crashAfter(Infinity);
      expect(await store.get('slack:tokens')).toBe(tokens);
    }
  });

  it('removes the parts of the old value after a new value, and all parts on a delete', async () => {
    const { entries, backend } = fakeKeyring();
    const store = createPartedStore(backend);
    await store.set('t', tokens);
    await store.set('t', tokens + 'x');
    expect(entries.size).toBe(4);
    await store.set('t', 'short now');
    expect([...entries.keys()]).toEqual(['t']);
    await store.set('t', tokens);
    await store.delete('t');
    expect(entries.size).toBe(0);
  });

  it('deletes the head first, so a stop during a delete never leaves a head without its parts', async () => {
    const { entries, backend } = fakeKeyring();
    const store = createPartedStore(backend);
    const remove = backend.delete;
    for (let done = 0; done < 4; done++) {
      await store.set('t', tokens);
      // the process stops after this many deletes, so each later delete fails.
      let deletes = 0;
      backend.delete = async (ref) => {
        if (deletes++ >= done) throw new Error('the process stopped');
        await remove(ref);
      };
      await store.delete('t').catch(() => {});
      backend.delete = remove;
      const value = await store.get('t');
      expect(value === tokens || value === undefined).toBe(true);
      expect(entries.has('t')).toBe(done === 0);
      entries.clear();
    }
  });

  it('reads a head whose parts are gone as no value, so a new sign-in can replace it', async () => {
    const { entries, backend } = fakeKeyring();
    const store = createPartedStore(backend);
    await store.set('t', tokens);
    for (const key of [...entries.keys()]) if (key !== 't') entries.delete(key);
    expect(await store.get('t')).toBeUndefined();
    await store.set('t', 'new tokens');
    expect(await store.get('t')).toBe('new tokens');
  });

  it('finds a damaged value instead of giving wrong text', async () => {
    const { entries, backend } = fakeKeyring();
    const store = createPartedStore(backend);
    await store.set('t', tokens);
    const part = [...entries.keys()].find((key) => key.endsWith('.1'))!;
    entries.set(part, 'x'.repeat(entries.get(part)!.length));
    await expect(store.get('t')).rejects.toThrow('damaged');
  });

  it('keeps every value that passes through it out of the logs', async () => {
    const { backend } = fakeKeyring();
    await createPartedStore(backend).set('t', 'xoxp-secret-token-value');
    expect(redact('token xoxp-secret-token-value')).toBe('token [redacted]');
  });

  // a token set changes at each oauth refresh. the redactor keeps only the two newest values of each reference, so its
  // list does not grow for the life of the process.
  it('replaces the registered value of a reference when the reference gets a new value', async () => {
    const store = createPartedStore(fakeKeyring().backend);
    await store.set('mail:oauth-tokens', 'old-token-set-value-2026');
    await store.set('mail:oauth-tokens', 'mid-token-set-value-2026');
    await store.set('mail:oauth-tokens', 'new-token-set-value-2026');
    expect(redact('old-token-set-value-2026 mid-token-set-value-2026 new-token-set-value-2026')).toBe('old-token-set-value-2026 [redacted] [redacted]');
  });
});

// this test writes to the credential manager of the pc under a random service name and removes its entries. it runs
// only on request: OKC_KEYRING_TEST=1 npx vitest run src/integrations/secrets.test.ts
describe.skipIf(process.env.OKC_KEYRING_TEST !== '1' || process.platform !== 'win32')('windows credential manager', () => {
  it('stores and removes a token set over the platform limit', async () => {
    const store = createKeyringStore(`okc-test-${Math.random().toString(16).slice(2)}`);
    await store.set('tokens', tokens);
    expect(await store.get('tokens')).toBe(tokens);
    await store.delete('tokens');
    expect(await store.get('tokens')).toBeUndefined();
  });
});
