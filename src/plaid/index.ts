import { randomUUID } from 'node:crypto';
import type {
  PlaidCredentialSource,
  PlaidCredentialsRequest,
  PlaidExchangeRequest,
  PlaidItemView,
  PlaidLinkTokenRequest,
  PlaidLinkTokenResponse,
  PlaidStatus,
  PlaidSyncTrigger,
} from '../dashboard/plaid-types.js';
import type { JobResult } from '../scheduler/scheduler.js';
import type { Tool } from '../tools/registry.js';
import { createPlaidClient } from './client.js';
import { PLAID_HOSTS } from './config.js';
import { plaidConnector, type PlaidConnectorDef } from './connector.js';
import type { PlaidContext, PlaidDeps } from './context.js';
import { clearCredentials, resolveCredentials, storeCredentials } from './credentials.js';
import { createLinkToken, disconnectItem, exchangePublicToken, finishUpdate, type PlaidResult } from './link.js';
import { NOT_BUILT } from './names.js';
import { runSync } from './sync.js';
import { createPlaidTools } from './tools.js';

// the bank of track s3 (docs/CONNECT-PLAN.md): plaid, read-only, for subscriptions. app.ts makes one of these for every
// app. without credentials it still exists: its status says so, and its tools and its job say that no bank is linked.

export interface Plaid {
  tools: Tool[];
  // the bank card of the connections hub, in the shape of the plan (connector.ts).
  connector: PlaidConnectorDef;
  status(): Promise<PlaidStatus>;
  linkToken(request: PlaidLinkTokenRequest): Promise<PlaidResult<PlaidLinkTokenResponse>>;
  exchange(request: PlaidExchangeRequest): Promise<PlaidResult<PlaidItemView>>;
  // the end of update mode (reconnect) of an item.
  updated(itemId: number): Promise<PlaidResult<PlaidItemView>>;
  disconnect(itemId: number): Promise<PlaidResult<PlaidItemView>>;
  setCredentials(request: PlaidCredentialsRequest): Promise<PlaidResult<PlaidCredentialSource>>;
  clearCredentials(): Promise<PlaidResult<PlaidCredentialSource>>;
  // a sync of one item or of every item. a second sync while one runs gives skipped.
  sync(options: { trigger: PlaidSyncTrigger; itemId?: number }): Promise<JobResult>;
  // the job of the sync automation.
  runJob(job: 'sync'): Promise<JobResult>;
  syncing(): boolean;
}

export function createPlaid(deps: PlaidDeps): Plaid {
  const ctx: PlaidContext = {
    ...deps,
    newId: deps.newId ?? randomUUID,
    client:
      deps.client ??
      createPlaidClient({
        environment: deps.config.environment,
        baseUrl: PLAID_HOSTS[deps.config.environment],
        credentials: async () => (await resolveCredentials(deps)).credentials,
        signal: deps.signal,
      }),
  };
  let running = false;
  const sync = async (options: { trigger: PlaidSyncTrigger; itemId?: number }): Promise<JobResult> => {
    // two syncs at once would page one cursor twice.
    if (running) return { status: 'skipped', error: 'a bank sync is already running' };
    running = true;
    try {
      return await runSync(ctx, options);
    } finally {
      running = false;
    }
  };
  // the link flow starts the first sync of a new item and does not wait for it.
  const startSync = (itemId: number) =>
    void sync({ trigger: 'link', itemId }).catch((err: unknown) => deps.logger.error('bank sync after link failed', { itemId, err }));
  const notBuilt = async (): Promise<never> => {
    throw new Error(NOT_BUILT);
  };
  const plaid: Plaid = {
    tools: createPlaidTools(ctx),
    connector: plaidConnector({ status: notBuilt, accounts: notBuilt, connect: notBuilt, disconnect: notBuilt, test: notBuilt }),
    status: notBuilt,
    linkToken: (request) => createLinkToken(ctx, request),
    exchange: (request) => exchangePublicToken(ctx, request, startSync),
    updated: (itemId) => finishUpdate(ctx, itemId, startSync),
    disconnect: (itemId) => disconnectItem(ctx, itemId),
    setCredentials: async (request) => ({ ok: true, value: await storeCredentials(ctx, request) }),
    clearCredentials: async () => ({ ok: true, value: await clearCredentials(ctx) }),
    sync,
    runJob: () => sync({ trigger: 'automation' }),
    syncing: () => running,
  };
  return plaid;
}
