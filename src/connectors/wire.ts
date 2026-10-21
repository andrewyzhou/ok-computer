import type { Db } from '../db/index.js';
import type { Google } from '../google/google.js';
import type { IntegrationEntry } from '../integrations/config.js';
import type { Integrations } from '../integrations/integrations.js';
import type { OAuth } from '../integrations/oauth.js';
import type { SecretStore } from '../integrations/secrets.js';
import type { Logger } from '../observability/logger.js';
import type { Clock } from '../time.js';
import type { Tool } from '../tools/registry.js';
import { createConnectors, type Connectors } from './service.js';
import { createConnectorRegistry } from './registry.js';
import { createManagedStore } from './store.js';
import { notBuilt } from './not-built.js';
import { createConnectorTools } from './tools.js';
import type { ConnectorContext, ConnectorDef } from './types.js';

// the wiring of the hub into the app. src/app.ts calls integrationEntries before it makes the integration layer, and
// createHub after it, so the app has one line for each.

// integrationEntries gives the entries of the integration layer at the start: the entries of okc.integrations.json
// and the managed connections of the database, merged. a managed row that does not merge is left out and logged, and
// it never stops the start.
export function integrationEntries(deps: { db: Db; clock: Clock; logger: Logger; file: IntegrationEntry[] }): IntegrationEntry[] {
  return deps.file;
}

export interface HubDeps {
  db: Db;
  clock: Clock;
  logger: Logger;
  secrets: SecretStore;
  integrations: Integrations;
  // the oauth flows of the integration layer. the app always makes it, so a first oauth connector needs no restart.
  oauth?: OAuth;
  google?: Pick<Google, 'accounts'>;
  file: IntegrationEntry[];
  dashboardUrl: string;
  // the connectors of other tracks, for example the bank. each one is one line in src/app.ts.
  extra?: ConnectorDef[];
}

export interface Hub {
  connectors: Connectors;
  tools: Tool[];
}

export function createHub(deps: HubDeps): Hub {
  const stub = (): never => notBuilt('the wiring of the connections hub');
  const context: ConnectorContext = {
    now: deps.clock,
    store: createManagedStore({ db: deps.db, clock: deps.clock }),
    integrations: { status: stub, connect: stub, finishSignIn: stub, storeClient: stub, forget: stub, redirectUrl: stub },
    secrets: deps.secrets,
    log: deps.logger,
    apply: stub,
    dashboardUrl: deps.dashboardUrl,
  };
  const connectors = createConnectors({ registry: createConnectorRegistry(deps.extra ?? []), context, calls: stub, pending: () => false });
  return { connectors, tools: createConnectorTools({ connectors, dashboardUrl: deps.dashboardUrl }) };
}
