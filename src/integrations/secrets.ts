import { createHash, randomBytes } from 'node:crypto';
import { registerSecret } from '../observability/redact.js';
import { safeEnd } from '../text.js';

// the database and the config files hold only the reference. the value stays in the credential manager.
export interface SecretStore {
  get(ref: string): Promise<string | undefined>;
  set(ref: string, value: string): Promise<void>;
  delete(ref: string): Promise<void>;
}

// one entry of the credential manager. get gives null for a missing entry.
export interface KeyringBackend {
  get(ref: string): Promise<string | null>;
  set(ref: string, value: string): Promise<void>;
  delete(ref: string): Promise<void>;
}

export const KEYRING_SERVICE = 'ok-computer';
// windows keeps at most 2,560 bytes in one credential, which is 1,280 utf-16 units. an oauth token set with an id
// token is often longer, so a long value goes into parts. a part leaves room below the limit.
export const PART_UNITS = 1_200;
const HEAD = 'okc-parts:1:';

const hashOf = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 16);

function split(value: string): string[] {
  const parts: string[] = [];
  for (let at = 0; at < value.length; ) {
    // a part never ends inside a surrogate pair, because the credential manager stores each part as utf-16 text.
    const end = at + PART_UNITS >= value.length ? value.length : safeEnd(value, at + PART_UNITS);
    parts.push(value.slice(at, end));
    at = end;
  }
  return parts;
}

interface Head {
  generation: string;
  count: number;
  hash: string;
}

function parseHead(text: string): Head | undefined {
  if (!text.startsWith(HEAD)) return undefined;
  const [generation, count, hash] = text.slice(HEAD.length).split(':');
  if (!generation || !count || !hash) return undefined;
  return { generation, count: Number(count), hash };
}

const partRef = (ref: string, generation: string, index: number) => `${ref}#${generation}.${index}`;

// a value in parts is written in this order: the parts under a new generation, then the head, then the delete of the
// parts of the old generation. so a crash at any point leaves the old value or the new value, never a mix, and two
// processes that write at the same time each write their own parts. the hash in the head finds a damaged value.
export function createPartedStore(backend: KeyringBackend): SecretStore {
  const deleteParts = async (ref: string, head: Head | undefined) => {
    if (!head) return;
    for (let i = 0; i < head.count; i++) await backend.delete(partRef(ref, head.generation, i)).catch(() => {});
  };

  const read = async (ref: string): Promise<string | undefined> => {
    const text = await backend.get(ref);
    if (text === null) return undefined;
    const head = parseHead(text);
    if (!head) return text;
    const parts: string[] = [];
    for (let i = 0; i < head.count; i++) {
      const part = await backend.get(partRef(ref, head.generation, i));
      if (part === null) throw new Error(`part ${i} of the secret ${ref} is missing`);
      parts.push(part);
    }
    const value = parts.join('');
    if (hashOf(value) !== head.hash) throw new Error(`the secret ${ref} is damaged`);
    return value;
  };

  return {
    async get(ref) {
      let value: string | undefined;
      try {
        value = await read(ref);
      } catch {
        // a writer can replace the head and delete the old parts during the read. a second read sees the new value.
        value = await read(ref);
      }
      registerSecret(value);
      return value;
    },
    async set(ref, value) {
      registerSecret(value);
      const old = await backend.get(ref).then((text) => (text === null ? undefined : parseHead(text)));
      if (value.length <= PART_UNITS && !value.startsWith(HEAD)) {
        await backend.set(ref, value);
      } else {
        const generation = randomBytes(4).toString('hex');
        const parts = split(value);
        for (const [i, part] of parts.entries()) await backend.set(partRef(ref, generation, i), part);
        await backend.set(ref, `${HEAD}${generation}:${parts.length}:${hashOf(value)}`);
      }
      await deleteParts(ref, old);
    },
    async delete(ref) {
      const text = await backend.get(ref);
      await deleteParts(ref, text === null ? undefined : parseHead(text));
      await backend.delete(ref);
    },
  };
}

// the native module loads only when the app uses the credential manager, so a missing binary does not stop an app
// without integrations.
export function createKeyringStore(service = KEYRING_SERVICE): SecretStore {
  const entry = async (ref: string) => new (await import('@napi-rs/keyring')).AsyncEntry(service, ref);
  return createPartedStore({
    get: async (ref) => (await (await entry(ref)).getPassword()) ?? null,
    set: async (ref, value) => void (await (await entry(ref)).setPassword(value)),
    delete: async (ref) => void (await (await entry(ref)).deletePassword()),
  });
}

// tests use this store, so they never touch the credential manager of the pc.
export function createMemorySecretStore(initial: Record<string, string> = {}): SecretStore & { values: Map<string, string> } {
  const values = new Map(Object.entries(initial));
  return {
    values,
    async get(ref) {
      return values.get(ref);
    },
    async set(ref, value) {
      registerSecret(value);
      values.set(ref, value);
    },
    async delete(ref) {
      values.delete(ref);
    },
  };
}
