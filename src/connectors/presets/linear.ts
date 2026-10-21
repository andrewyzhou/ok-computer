import type { McpPreset } from '../mcp-preset.js';

// the official remote server of linear (https://linear.app/docs/mcp). it speaks streamable http at /mcp (the sse
// endpoint is deprecated), and its authorization server at https://mcp.linear.app registers a client by itself, so
// the owner makes no app.
export const LINEAR: McpPreset = {
  connectorId: 'linear',
  integrationId: 'linear',
  name: 'Linear',
  icon: 'linear',
  summary: 'Find, read and track your issues and projects. Creating or changing an issue asks you first.',
  docsUrl: 'https://linear.app/docs/mcp',
  url: 'https://mcp.linear.app/mcp',
  client: { type: 'dynamic' },
  callback: 'loopback',
  readTools: [],
  writeTools: [],
};
