import type { IntegrationEntry } from '../integrations/config.js';
import { mcpConnector, presetEntry, type McpPreset } from './mcp-preset.js';
import { GITHUB } from './presets/github.js';
import { googleConnector, type GoogleConnectorDeps } from './presets/google.js';
import { GRANOLA } from './presets/granola.js';
import { LINEAR } from './presets/linear.js';
import { NOTION } from './presets/notion.js';
import { SLACK } from './presets/slack.js';
import type { ConnectorDef, ManagedConnection } from './types.js';

// the presets of the remote mcp servers, in the order of the page.
export const MCP_PRESETS: readonly McpPreset[] = [GITHUB, LINEAR, NOTION, SLACK, GRANOLA];

// the built-in connectors in the order of the page: google first, then the mcp presets. another track adds its
// connector to the list that src/connectors/wire.ts gives the registry, with one line there.
export function builtinConnectors(deps: GoogleConnectorDeps): ConnectorDef[] {
  return [googleConnector(deps), ...MCP_PRESETS.map(mcpConnector)];
}

// entryOf turns a managed row into its entry with the preset of its connector. a row of a connector without a preset,
// for example one whose preset was removed, gives undefined, and the merge reports it.
export function entryOf(row: ManagedConnection): IntegrationEntry | undefined {
  const preset = MCP_PRESETS.find((each) => each.connectorId === row.connectorId);
  return preset ? presetEntry(preset, row) : undefined;
}
