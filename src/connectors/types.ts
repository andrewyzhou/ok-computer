// the shapes of the connections hub (docs/CONNECT-PLAN.md, track S2). the connector modules, the dashboard routes and
// the web page all import them, so this file holds types only and imports nothing. src/dashboard/connectors-types.ts
// gives the same names to the web page.
//
// a connector is one service that the owner can connect with a button: a remote mcp server with an oauth sign-in, a
// native module of the app (google, the bank), or a module that needs keys from .env. each connector is one
// ConnectorDef, and src/connectors/index.ts lists the built-in ones. another track adds its connector with one line in
// the list of defs that src/connectors/wire.ts gives the registry.

// mcp-oauth: a remote mcp server with an oauth sign-in through src/integrations/oauth.ts. native: a module of the app
// with its own sign-in, for example google. env-keys: a module that needs keys from .env or the keyring.
export type ConnectorKind = 'mcp-oauth' | 'native' | 'env-keys';

// the state of a connector, from the point of view of the owner.
// - not_connected: nothing is set up, or the owner disconnected it.
// - connecting: an attempt runs, or a sign-in link waits for the owner.
// - connected: it works now.
// - needs_sign_in: it worked before, and the service wants the owner to sign in again.
// - error: it is set up and does not work. reason holds the full text.
// - unavailable: the service has no official way in yet, or the app lacks a part (for example no google block in the
//   config). reason says why, and the card has no Connect button.
export type ConnectorState = 'not_connected' | 'connecting' | 'connected' | 'needs_sign_in' | 'error' | 'unavailable';

// the risk of a tool, as in the policy engine. read runs at once, write goes to the reviewer, external waits for the
// owner. a preset gives read to the tools that only read, and external to every other tool, so each write asks the
// owner (docs/CONNECT-PLAN.md S2, "defaults").
export type ConnectorRisk = 'read' | 'write' | 'external';

// one account of a connector, for example one google address or one slack workspace.
export interface ConnectorAccount {
  id: string;
  // the words that the card shows, for example an address or a workspace name.
  label: string;
  // a second line, for example the scopes or "read only".
  detail?: string;
  connectedAt: string | null;
}

export interface ConnectorStatus {
  state: ConnectorState;
  // the full text of the last error, or of why the connector is unavailable. the card shows all of it and never cuts
  // it. null when there is nothing to say.
  reason: string | null;
  // when the reason was recorded, as an iso time.
  reasonAt: string | null;
  accounts: ConnectorAccount[];
  // the sign-in link that waits for the owner, while state is connecting.
  authUrl?: string;
  // true when the last connect or disconnect is saved but takes effect only after one restart of the app.
  restartNeeded?: boolean;
}

// a field that the owner fills in during a setup step, for example the client id of an oauth app. a secret field is
// a password input, and its value goes only to the keyring.
export interface SetupField {
  name: string;
  label: string;
  secret: boolean;
  optional?: boolean;
  placeholder?: string;
}

// a value that the owner copies into the settings of the service, for example the redirect url of an oauth app.
export interface SetupCopy {
  label: string;
  value: string;
}

// one step of a guided setup. the card shows the steps in order, with copy buttons and fields, so the owner never
// edits a file.
export interface SetupStep {
  id: string;
  title: string;
  // plain sentences for the owner.
  text: string;
  link?: { label: string; url: string };
  copy?: SetupCopy[];
  fields?: SetupField[];
  // done is true when the app can tell that the step is finished, for example a stored client.
  done?: boolean;
}

// one tool of a connector, with the switch of the card. name is the name that the service gives the tool (the mcp
// name for a remote server). enabled is false for a tool that the server offers and the owner did not turn on.
export interface ConnectorTool {
  name: string;
  description: string;
  risk: ConnectorRisk;
  enabled: boolean;
  // where the risk comes from: the preset, the owner, or okc.integrations.json for an entry of the file.
  riskFrom: 'preset' | 'owner' | 'file' | 'default';
}

// what the owner gives with Connect: the fields of the setup steps. a secret value never comes back in an answer.
export type ConnectInput = Record<string, string>;

// the answer of a connect.
// - connected: it works now.
// - redirect: the page opens url in a new tab for the sign-in. paste is true when the owner finishes the sign-in by
//   pasting the address of the page that the sign-in ends on (a service that accepts only an https redirect).
// - needs_setup: a setup step is not done. step names it, and error says what is missing.
// - restart_needed: the connection is saved, and one restart of the app applies it.
// - error: the full text.
export type ConnectResult =
  | { status: 'connected' }
  | { status: 'redirect'; url: string; paste: boolean }
  | { status: 'needs_setup'; step: string; error: string }
  | { status: 'restart_needed'; reason: string }
  | { status: 'error'; error: string };

export type DisconnectResult = { status: 'disconnected'; restartNeeded: boolean } | { status: 'error'; error: string };

export type TestResult = { ok: true; text: string } | { ok: false; error: string };

// the answer of a change of the integration layer. applied means that the change works without a restart.
// restart_needed means that it is saved and works after one restart, and reason says why in plain words.
export type ApplyResult = { status: 'applied' } | { status: 'restart_needed'; reason: string };

// one connection that the hub manages, as 029_connectors.sql keeps it. integrationId is the id in the integration
// layer and the first part of each tool name, connectorId is the id of the ConnectorDef. settings never hold a secret:
// a secret goes to the keyring, and settings may hold its reference.
export interface ManagedConnection {
  integrationId: string;
  connectorId: string;
  settings: Record<string, string | number | boolean>;
  // the names of the tools that are on.
  allow: string[];
  // the risk of each tool that the owner or the preset set. a tool without one gets the default of the catalog.
  risks: Record<string, ConnectorRisk>;
  createdAt: string;
  updatedAt: string;
}

// the history of the hub, one row for each thing that happened. the table is append-only.
export type ConnectorEventType =
  | 'connect_started'
  | 'connected'
  | 'connect_failed'
  | 'disconnected'
  | 'client_stored'
  | 'tool_changed'
  | 'tested'
  | 'applied'
  | 'restart_requested';

export interface ConnectorEvent {
  id: number;
  connectorId: string;
  integrationId: string | null;
  type: ConnectorEventType;
  // plain facts about the event, never a secret. the store redacts it before the write.
  detail: Record<string, unknown>;
  at: string;
}

// the store of the managed connections and of their history (src/connectors/store.ts).
export interface ManagedStore {
  list(): ManagedConnection[];
  get(integrationId: string): ManagedConnection | undefined;
  // save inserts or replaces the row of one connection, and keeps createdAt of an existing row.
  save(row: Omit<ManagedConnection, 'createdAt' | 'updatedAt'>): ManagedConnection;
  remove(integrationId: string): boolean;
  record(event: Omit<ConnectorEvent, 'id' | 'at'>): ConnectorEvent;
  events(connectorId: string, limit?: number): ConnectorEvent[];
}

// the live state of one integration of the mcp layer that a connector reads. it is the part of IntegrationStatus of
// src/integrations/integrations.ts that the hub needs, so that type fits here as it is.
export interface LiveIntegration {
  id: string;
  state: { status: 'stopped' | 'connecting' | 'connected' | 'error' | 'needs_auth'; error?: string; retryAt?: string };
  paused: boolean;
  authorizedAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
  authUrl?: string;
  oauthApp?: { redirectUrl: string; callback: 'loopback' | 'paste'; clientRef?: string };
  tools: Array<{ mcpName: string; description: string; risk: ConnectorRisk | 'exec'; riskFrom: string }>;
  hidden: string[];
}

// the part of the integration layer that a connector may use. src/connectors/wire.ts builds it from the app.
export interface IntegrationsPort {
  status(integrationId: string): LiveIntegration | undefined;
  connect(integrationId: string): Promise<{ connected: true } | { url: string } | { error: string }>;
  finishSignIn(pasted: string): Promise<{ ok: boolean; text: string }>;
  storeClient(integrationId: string, client: { client_id: string; client_secret?: string }): Promise<{ stored: true } | { error: string }>;
  // forget stops the integration and deletes its tokens and its registered client from the keyring. a client that
  // the owner stored under clientRef stays, so a later connect needs no new setup.
  forget(integrationId: string): Promise<void>;
  // the redirect url that an oauth app of the owner must allow, for a pre-registered client.
  redirectUrl(callback: 'loopback' | 'paste'): string;
}

export interface SecretsPort {
  get(ref: string): Promise<string | undefined>;
  set(ref: string, value: string): Promise<void>;
  delete(ref: string): Promise<void>;
}

export interface LogPort {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

// what the hub gives each connector at each call.
export interface ConnectorContext {
  now(): Date;
  store: ManagedStore;
  integrations: IntegrationsPort;
  secrets: SecretsPort;
  log: LogPort;
  // apply merges the managed connections with okc.integrations.json again and gives the result to the integration
  // layer, without a restart where it can (src/connectors/apply.ts).
  apply(reason: string): Promise<ApplyResult>;
  // the address of the dashboard, for links in the setup steps.
  dashboardUrl: string;
}

// one connector. every method gets the context, so a def is a plain object that a test can call with a fake context.
export interface ConnectorDef {
  id: string;
  name: string;
  // a short generic name of the icon that the web page draws, for example github, linear, notion, slack, granola,
  // google or bank. the page has a fallback for a name that it does not know.
  icon: string;
  // one short line on what the agent can do with it.
  summary: string;
  kind: ConnectorKind;
  // the page of the service that explains its official server, for the details panel.
  docsUrl?: string;
  // the page of the app for a native connector, for example #/google. the card links to it.
  pageHash?: string;
  // the setup steps, in order. an empty list means that Connect works at once.
  setup(ctx: ConnectorContext): Promise<SetupStep[]>;
  status(ctx: ConnectorContext): Promise<ConnectorStatus>;
  connect(ctx: ConnectorContext, input: ConnectInput): Promise<ConnectResult>;
  // finish takes the address that the owner pasted after a sign-in that ends on an https page that nothing answers.
  finish?(ctx: ConnectorContext, pasted: string): Promise<ConnectResult>;
  disconnect(ctx: ConnectorContext, accountId?: string): Promise<DisconnectResult>;
  test(ctx: ConnectorContext): Promise<TestResult>;
  tools(ctx: ConnectorContext): Promise<ConnectorTool[]>;
  // setTool turns a tool on or off, or sets its risk. a connector without it has no switches.
  setTool?(ctx: ConnectorContext, name: string, change: { enabled?: boolean; risk?: ConnectorRisk }): Promise<ApplyResult | { status: 'error'; error: string }>;
}

// the view of one connector on the connections page. the hub builds it from the def, and no field holds a secret.
export interface ConnectionCard {
  id: string;
  name: string;
  icon: string;
  summary: string;
  kind: ConnectorKind;
  docsUrl: string | null;
  pageHash: string | null;
  status: ConnectorStatus;
  setup: SetupStep[];
  tools: ConnectorTool[];
  // true when the def has setTool, so the card shows a switch for each tool.
  switches: boolean;
}

// the details panel: the card, the history of the hub and the recent calls of its tools.
export interface ConnectionDetail {
  card: ConnectionCard;
  events: ConnectorEvent[];
  calls: Array<{ id: number; toolName: string; at: string; isError: boolean; outcome: string }>;
}

// GET /api/connections.
export interface ConnectionsPage {
  cards: ConnectionCard[];
  // true when a saved change waits for one restart, and false when everything is applied.
  restartNeeded: boolean;
  // false when nothing supervises the process, so a restart from the page would stop the app for good. the page then
  // says to run okc restart.
  canRestart: boolean;
}
