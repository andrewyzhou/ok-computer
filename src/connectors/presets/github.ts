import type { McpPreset, OwnerAppGuide } from '../mcp-preset.js';
import { notBuilt } from '../not-built.js';

// the guide of the github oauth app of the owner. the sign-in server of the github server is
// https://github.com/login/oauth, and its metadata has no registration endpoint, so the owner makes an oauth app once
// and the card stores its client id and secret in the keyring.
export const GITHUB_APP: OwnerAppGuide = {
  clientRef: 'github-app',
  steps: () => notBuilt('the github app guide'),
};

// the official remote server of github (https://github.com/github/github-mcp-server/blob/main/docs/remote-server.md).
// it speaks streamable http at https://api.githubcopilot.com/mcp/, and its protected resource metadata names the
// scopes below among the ones it supports.
export const GITHUB: McpPreset = {
  connectorId: 'github',
  integrationId: 'github',
  name: 'GitHub',
  icon: 'github',
  summary: 'Read your repositories, issues, pull requests and notifications. Opening or changing anything asks you first.',
  docsUrl: 'https://github.com/github/github-mcp-server/blob/main/docs/remote-server.md',
  url: 'https://api.githubcopilot.com/mcp/',
  client: { type: 'owner-app', guide: GITHUB_APP },
  callback: 'loopback',
  scopes: ['repo', 'read:org', 'read:user', 'notifications'],
  readTools: [],
  writeTools: [],
};
