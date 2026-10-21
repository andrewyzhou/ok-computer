import type { McpPreset } from '../mcp-preset.js';

// the official hosted server of granola (https://docs.granola.ai/help-center/sharing/integrations/mcp). it speaks
// streamable http at /mcp and signs in only with oauth in the browser. its authorization server at
// https://mcp-auth.granola.ai registers a client by itself. granola calls the server generally available to test, so
// its tools can change.
export const GRANOLA: McpPreset = {
  connectorId: 'granola',
  integrationId: 'granola',
  name: 'Granola',
  icon: 'granola',
  summary: 'Search your meeting notes and read the notes and transcript of a meeting.',
  docsUrl: 'https://docs.granola.ai/help-center/sharing/integrations/mcp',
  url: 'https://mcp.granola.ai/mcp',
  client: { type: 'dynamic' },
  callback: 'loopback',
  readTools: [],
  writeTools: [],
};
