import { notBuilt } from './not-built.js';
import type { ConnectorRegistry } from './registry.js';
import type {
  ApplyResult,
  ConnectInput,
  ConnectionDetail,
  ConnectionsPage,
  ConnectorContext,
  ConnectorRisk,
  ConnectResult,
  DisconnectResult,
  TestResult,
} from './types.js';

// the hub that the dashboard and the agent tool use. it finds the def of an id, calls it with the context, records
// each step in the history, and builds the views of the page. an unknown id gives undefined, which the routes answer
// with 404. no answer holds a secret.
export interface Connectors {
  page(): Promise<Omit<ConnectionsPage, 'canRestart'>>;
  detail(id: string): Promise<ConnectionDetail | undefined>;
  connect(id: string, input: ConnectInput): Promise<ConnectResult | undefined>;
  finish(id: string, pasted: string): Promise<ConnectResult | undefined>;
  disconnect(id: string, accountId?: string): Promise<DisconnectResult | undefined>;
  test(id: string): Promise<TestResult | undefined>;
  setTool(
    id: string,
    name: string,
    change: { enabled?: boolean; risk?: ConnectorRisk },
  ): Promise<ApplyResult | { status: 'error'; error: string } | undefined>;
  // true while a saved change waits for one restart of the app.
  restartNeeded(): boolean;
}

export interface ConnectorsDeps {
  registry: ConnectorRegistry;
  context: ConnectorContext;
  // the recent calls of the tools of one integration, for the details panel. src/connectors/wire.ts reads them from
  // tool_calls.
  calls(integrationId: string): ConnectionDetail['calls'];
  // the restart flag of the applier.
  pending(): boolean;
}

export function createConnectors(deps: ConnectorsDeps): Connectors {
  void deps;
  const stub = (): never => notBuilt('the connections hub');
  return { page: stub, detail: stub, connect: stub, finish: stub, disconnect: stub, test: stub, setTool: stub, restartNeeded: () => false };
}
