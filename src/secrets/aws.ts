import type { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import type { CheckedSecretStore } from './index.js';

// the part of the sdk client that the store uses. tests give a fake that records the commands.
export type SecretsManagerPort = Pick<SecretsManagerClient, 'send'>;

export interface AwsSecretStoreOptions {
  region: string;
  // the start of each secret name. the default is okc/.
  prefix?: string;
  // tests give a fake client. the app makes a real client on the first use, so a desktop never loads the sdk.
  client?: SecretsManagerPort;
}

// the name of the secret that holds a ref. a ref can hold characters that a secret name cannot hold, for example
// the colon in "linear:oauth-tokens", so each such character is written as @ and two hex digits.
// TODO(m7 secrets): build it.
export function awsSecretName(_prefix: string, _ref: string): string {
  throw new Error('not built: awsSecretName');
}

// aws secrets manager with one secret for each ref, named prefix + ref.
// TODO(m7 secrets): build it. the work package gives the commands and the errors.
export function createAwsSecretStore(_options: AwsSecretStoreOptions): CheckedSecretStore {
  throw new Error('not built: the aws secret store');
}
