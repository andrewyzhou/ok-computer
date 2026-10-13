import { AsyncEntry } from '@napi-rs/keyring';
import { registerSecret } from '../observability/redact.js';

// the database and the config files hold only the reference. the value stays in the credential manager.
export interface SecretStore {
  get(ref: string): Promise<string | undefined>;
  set(ref: string, value: string): Promise<void>;
  delete(ref: string): Promise<void>;
}

export const KEYRING_SERVICE = 'ok-computer';

// each value that goes through the store is also a secret for the redactor, so it never reaches a log or a blob.
export function createKeyringStore(service = KEYRING_SERVICE): SecretStore {
  const entry = (ref: string) => new AsyncEntry(service, ref);
  return {
    async get(ref) {
      const value = (await entry(ref).getPassword()) ?? undefined;
      registerSecret(value);
      return value;
    },
    async set(ref, value) {
      registerSecret(value);
      await entry(ref).setPassword(value);
    },
    async delete(ref) {
      await entry(ref).deletePassword();
    },
  };
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
