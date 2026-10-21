import type { HttpEntry } from '../integrations/config.js';
import { notBuilt } from './not-built.js';
import type { ConnectorContext, ConnectorDef, ManagedConnection, SetupStep } from './types.js';

// the guide of an oauth app that the owner makes at the service, for a server without dynamic client registration
// (github, slack). steps gives the setup steps for the redirect url that the app must allow. the last step has the
// client id and secret fields, and Connect stores them under clientRef in the keyring.
export interface OwnerAppGuide {
  // the reference of the stored client in the keyring, for example github-app. it is a name, never the value.
  clientRef: string;
  steps(redirectUrl: string): SetupStep[];
}

// a preset is the fixed part of a remote mcp connector: the official server of the service, its sign-in and its tools.
// the managed row adds the owner's part: which tools are on, and their risks.
export interface McpPreset {
  connectorId: string;
  // the id in the integration layer, and so the first part of each tool name.
  integrationId: string;
  name: string;
  icon: string;
  summary: string;
  docsUrl: string;
  // the official endpoint of the server, with streamable http.
  url: string;
  // dynamic: the server registers the app itself (rfc 7591). owner-app: the owner makes an oauth app at the service.
  client: { type: 'dynamic' } | { type: 'owner-app'; guide: OwnerAppGuide };
  // loopback finishes the sign-in on the callback port by itself. paste is for a server that accepts only an https
  // redirect: the owner pastes the address of the page that the sign-in ends on.
  callback: 'loopback' | 'paste';
  scopes?: string[];
  // the tools that are on after a connect. readTools get the risk read, writeTools the risk external, so each write
  // asks the owner. every name is the name that the server gives the tool.
  readTools: string[];
  writeTools: string[];
  // tools that the hub never turns on, also when the owner asks: tools that would schedule, draft or publish on the
  // owner's behalf without a card. the switch shows them off and locked.
  blockedTools?: string[];
  poll?: HttpEntry['poll'];
}

// presetEntry builds the entry of the integration layer for a managed row of a preset. the entry passes the schema of
// src/integrations/config.ts, untrustedOutput is always true, and sessions is main.
export function presetEntry(preset: McpPreset, row: ManagedConnection): HttpEntry {
  void preset;
  void row;
  return notBuilt('the entry of an mcp preset');
}

// mcpConnector makes the ConnectorDef of a preset: the setup steps of its client, connect through the oauth flow of
// src/integrations/oauth.ts, disconnect that forgets the tokens, test, and the tool switches.
export function mcpConnector(preset: McpPreset): ConnectorDef {
  const stub = (_ctx: ConnectorContext): never => notBuilt(`the ${preset.name} connector`);
  return {
    id: preset.connectorId,
    name: preset.name,
    icon: preset.icon,
    summary: preset.summary,
    kind: 'mcp-oauth',
    docsUrl: preset.docsUrl,
    setup: async (ctx) => stub(ctx),
    status: async (ctx) => stub(ctx),
    connect: async (ctx) => stub(ctx),
    finish: async (ctx) => stub(ctx),
    disconnect: async (ctx) => stub(ctx),
    test: async (ctx) => stub(ctx),
    tools: async (ctx) => stub(ctx),
    setTool: async (ctx) => stub(ctx),
  };
}
