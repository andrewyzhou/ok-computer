import type { PlaidLinkTokenResponse } from '../dashboard/plaid-types.js';
import type { Risk } from '../policy/policy.js';
import { PLAID_TOOLS } from './names.js';

// the card of the bank in the connections hub (track s2). the hub exposes ConnectorDef from src/connectors/types.ts,
// which that track builds at the same time as this one. so this file describes the card in the shape that
// docs/CONNECT-PLAN.md gives, with no import from src/connectors, and the final integration adds the one line that
// registers toConnectorDef(plaidConnector(...)) with the registry, mapping each field to the real interface.

export type ConnectorKind = 'mcp-oauth' | 'native' | 'env-keys';

// the status of a card, as the plan lists it.
export type ConnectorState =
  | { state: 'not_connected' }
  | { state: 'connecting' }
  | { state: 'connected' }
  | { state: 'needs_sign_in'; reason: string }
  | { state: 'error'; reason: string };

export interface ConnectorAccount {
  id: string;
  label: string;
  detail: string | null;
}

// what connect asks of the browser. plaid link runs in the page, so connect gives the link token, and the card opens
// link with it (web/src/views/plaid/link.ts). a reconnect gives a token of update mode.
export type PlaidConnectAction = { kind: 'plaid-link'; token: PlaidLinkTokenResponse } | { kind: 'setup'; reason: string };

// the bank card in the words of the plan: an id, a name, an icon, a short line on what the agent can do with it, a
// kind, the setup steps, the status and the accounts, connect, disconnect and test, and the tools with their risk.
export interface PlaidConnectorDef {
  id: 'plaid';
  name: string;
  icon: string;
  summary: string;
  kind: ConnectorKind;
  setupSteps: string[];
  status(): Promise<ConnectorState>;
  accounts(): Promise<ConnectorAccount[]>;
  // account is the id of an item, for a reconnect. without it connect links a new bank.
  connect(account?: string): Promise<PlaidConnectAction>;
  // removes the item at plaid and deletes its token.
  disconnect(account: string): Promise<{ ok: boolean; error?: string }>;
  // a harmless call that proves the credentials: /link/token/create, whose token is thrown away.
  test(): Promise<{ ok: boolean; error?: string }>;
  tools: Array<{ name: string; risk: Risk }>;
}

// the parts of the bank module that the card uses. src/plaid/index.ts gives them.
export interface PlaidConnectorDeps {
  status(): Promise<ConnectorState>;
  accounts(): Promise<ConnectorAccount[]>;
  connect(account?: string): Promise<PlaidConnectAction>;
  disconnect(account: string): Promise<{ ok: boolean; error?: string }>;
  test(): Promise<{ ok: boolean; error?: string }>;
}

export const PLAID_SETUP_STEPS: readonly string[] = [
  'Make a free account on the plaid dashboard. A new team gets the trial plan, which links up to 10 banks.',
  'Copy the client id and the production secret from the keys page of the plaid dashboard.',
  'Put them in .env as PLAID_CLIENT_ID and PLAID_SECRET, or enter them on this card.',
  'Press Connect and sign in to the bank in the window that opens.',
];

export function plaidConnector(deps: PlaidConnectorDeps): PlaidConnectorDef {
  return {
    id: 'plaid',
    name: 'Bank',
    icon: 'bank',
    summary: 'Reads the recurring charges of your bank accounts to find subscriptions, price increases and trials. It cannot move money.',
    kind: 'native',
    setupSteps: [...PLAID_SETUP_STEPS],
    status: () => deps.status(),
    accounts: () => deps.accounts(),
    connect: (account) => deps.connect(account),
    disconnect: (account) => deps.disconnect(account),
    test: () => deps.test(),
    tools: PLAID_TOOLS.map((name) => ({ name, risk: 'read' as Risk })),
  };
}

// the adapter of the registration: the final integration passes the map from this card to ConnectorDef of
// src/connectors/types.ts. the generic keeps this file free of that import until the registry exists.
export function toConnectorDef<T>(card: PlaidConnectorDef, map: (card: PlaidConnectorDef) => T): T {
  return map(card);
}
