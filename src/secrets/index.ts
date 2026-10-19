import type { SecretStoreConfig, SecretStoreView } from '../dashboard/types.js';
import { createKeyringStore, CredentialStoreError, type SecretStore } from '../integrations/secrets.js';
import { createAwsSecretStore, type SecretsManagerPort } from './aws.js';
import { DEFAULT_AWS_PREFIX, PROBE_REF } from './config.js';
import { createFileSecretStore } from './file.js';

// a store that can say if it answers. check rejects when the backend cannot be reached or refuses the access.
export interface CheckedSecretStore extends SecretStore {
  check(): Promise<void>;
}

// the store that the config chose, with what the dashboard shows about it.
export interface SecretVault {
  backend: SecretStoreConfig['backend'];
  // the path of the file, the region and the prefix, or the keyring. never a ref or a value.
  detail: string;
  store: SecretStore;
  // GET /api/secrets gives this view. it calls check, so it never reads a value that the page could show.
  view(): Promise<SecretStoreView>;
}

export interface SecretVaultDeps {
  // tests give a fake aws client.
  awsClient?: SecretsManagerPort;
}

// the keyring has no request that only checks the access, so its check reads a ref that nothing writes. the constant
// lives in config.ts, so the backends can import it without an import cycle.
export { PROBE_REF };

// the page shows this text when a backend fails with an error that this code did not write. such a text can hold
// a ref or a name, so the page never shows it.
const UNKNOWN_FAILURE: Record<SecretStoreConfig['backend'], string> = {
  keyring: 'the credential store of the os did not answer.',
  file: 'the secret file cannot be used.',
  aws: 'aws secrets manager did not answer.',
};

// each backend gives each value that it reads or writes to the redactor. the error texts of the file and aws
// backends name a path or a region only, so view() shows them. any other text gives a fixed sentence.
function viewError(backend: SecretStoreConfig['backend'], err: unknown): string {
  if (backend !== 'keyring' && err instanceof CredentialStoreError && !err.message.includes(PROBE_REF)) {
    return err.message;
  }
  return UNKNOWN_FAILURE[backend];
}

export function createSecretVault(config: SecretStoreConfig, deps: SecretVaultDeps = {}): SecretVault {
  const { store, detail } = open(config, deps);
  return {
    backend: config.backend,
    detail,
    store,
    async view() {
      try {
        await store.check();
        return { backend: config.backend, detail, ok: true, error: null };
      } catch (err) {
        return { backend: config.backend, detail, ok: false, error: viewError(config.backend, err) };
      }
    },
  };
}

function open(config: SecretStoreConfig, deps: SecretVaultDeps): { store: CheckedSecretStore; detail: string } {
  switch (config.backend) {
    case 'keyring': {
      const keyring = createKeyringStore();
      return { store: { ...keyring, check: async () => void (await keyring.get(PROBE_REF)) }, detail: 'the credential store of the os' };
    }
    case 'file':
      return { store: createFileSecretStore(config.path), detail: config.path };
    case 'aws': {
      const prefix = config.prefix ?? DEFAULT_AWS_PREFIX;
      const store = createAwsSecretStore({ region: config.region, prefix, ...(deps.awsClient ? { client: deps.awsClient } : {}) });
      return { store, detail: `${config.region}, ${prefix}` };
    }
  }
}
