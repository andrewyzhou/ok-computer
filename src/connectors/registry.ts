import { notBuilt } from './not-built.js';
import type { ConnectorDef } from './types.js';

// the registry holds every connector of the hub, in the order of the page. each id is used once, and an id follows
// the id rule of an integration (src/integrations/config.ts), so a connector id can be its integration id.
export interface ConnectorRegistry {
  list(): ConnectorDef[];
  get(id: string): ConnectorDef | undefined;
}

// createConnectorRegistry checks the defs: a second def with the same id, or an id that breaks the rule, throws at the
// start of the app, so a wrong registration never reaches the page.
export function createConnectorRegistry(defs: readonly ConnectorDef[]): ConnectorRegistry {
  void defs;
  return {
    list: () => notBuilt('the connector registry'),
    get: () => notBuilt('the connector registry'),
  };
}
