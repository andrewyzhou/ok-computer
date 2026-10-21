import type { Db } from '../db/index.js';
import type { SecretStore } from '../integrations/secrets.js';
import type { Logger } from '../observability/logger.js';
import type { OwnerMessenger } from '../sessions/owner.js';
import type { Clock } from '../time.js';
import type { PlaidClient } from './client.js';
import type { PlaidConfig } from './config.js';

// the parts of the app that the bank track (s3) uses. app.ts gives them to createPlaid, with or without credentials.
export interface PlaidDeps {
  db: Db;
  clock: Clock;
  logger: Logger;
  timeZone: string;
  config: PlaidConfig;
  // the keyring (or the store that the secrets block chose). the client id and secret that the owner enters on the
  // dashboard and every access token live here, never in the database.
  secrets: SecretStore;
  // PLAID_CLIENT_ID and PLAID_SECRET of .env, when they are set.
  env: { clientId?: string; secret?: string };
  // a message to the owner, for example that a bank needs a new sign-in.
  owner?: Pick<OwnerMessenger, 'send'>;
  // the address of the dashboard for links in messages, without a trailing slash.
  dashboardUrl: string;
  // the scheduler plans again after the sync automation changes.
  replan?: () => void;
  signal: AbortSignal;
  // tests give a client against test/fake-plaid.ts. the default is createPlaidClient of client.ts.
  client?: PlaidClient;
  newId?: () => string;
}

// the same parts with a fixed client and id function. every module of src/plaid gets this.
export interface PlaidContext extends Omit<PlaidDeps, 'client' | 'newId'> {
  client: PlaidClient;
  newId: () => string;
}
