import type { PlaidCredentialSource } from '../dashboard/plaid-types.js';
import type { PlaidCredentials } from './client.js';
import type { PlaidContext } from './context.js';
import { NOT_BUILT } from './names.js';

// the client id and the secret of plaid. a pair that the owner entered on the dashboard lives in the keyring
// (PLAID_CLIENT_ID_REF and plaidSecretRef of the environment) and wins over PLAID_CLIENT_ID and PLAID_SECRET of .env.
// each value goes to the redactor (registerSecret) when it is read, so no log line, trace row or api answer holds it.

export interface ResolvedCredentials {
  source: PlaidCredentialSource;
  credentials?: PlaidCredentials;
}

// the pair to use now, and where it comes from. a keyring that fails is an error, not a fall back to .env, so the
// owner sees the failure of the keyring.
export async function resolveCredentials(ctx: Pick<PlaidContext, 'secrets' | 'env' | 'config'>): Promise<ResolvedCredentials> {
  void ctx;
  throw new Error(NOT_BUILT);
}

// stores a pair from the dashboard in the keyring. both values are one word without spaces.
export async function storeCredentials(ctx: Pick<PlaidContext, 'secrets' | 'config'>, credentials: PlaidCredentials): Promise<PlaidCredentialSource> {
  void ctx;
  void credentials;
  throw new Error(NOT_BUILT);
}

// deletes the pair of the keyring, so the values of .env count again. it gives the source after the delete.
export async function clearCredentials(ctx: Pick<PlaidContext, 'secrets' | 'env' | 'config'>): Promise<PlaidCredentialSource> {
  void ctx;
  throw new Error(NOT_BUILT);
}
