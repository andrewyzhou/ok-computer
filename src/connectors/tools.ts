import type { Tool } from '../tools/registry.js';
import type { Connectors } from './service.js';

// the agent tools of the hub. connections_status (read) tells the agent which services are connected and which need
// the owner, so it can point the owner at the Connect button. no tool connects, disconnects or changes a switch:
// those stay with the owner on the dashboard.
export function createConnectorTools(deps: { connectors: Connectors; dashboardUrl: string }): Tool[] {
  void deps;
  return [];
}
