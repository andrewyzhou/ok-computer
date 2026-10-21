import type { McpPreset } from '../mcp-preset.js';

// the official remote server of notion (https://developers.notion.com/guides/mcp/get-started-with-mcp). it speaks
// streamable http at /mcp, and its authorization server at https://mcp.notion.com registers a client by itself. only
// a member of a workspace can connect, not a guest.
export const NOTION: McpPreset = {
  connectorId: 'notion',
  integrationId: 'notion',
  name: 'Notion',
  icon: 'notion',
  summary: 'Search and read your pages and databases. Creating or changing a page asks you first.',
  docsUrl: 'https://developers.notion.com/docs/mcp',
  url: 'https://mcp.notion.com/mcp',
  client: { type: 'dynamic' },
  callback: 'loopback',
  readTools: [],
  writeTools: [],
};
