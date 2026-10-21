// the shapes of the connections api (docs/CONNECT-PLAN.md, track S2). they live in the import-free
// src/connectors/types.ts, because the connector modules use the same shapes, and this file gives them to the web page
// under the name of the dashboard. it holds no code. docs/API.md (S2) gives the routes and the errors.
export type {
  ApplyResult,
  ConnectInput,
  ConnectionCard,
  ConnectionDetail,
  ConnectionsPage,
  ConnectorAccount,
  ConnectorEvent,
  ConnectorEventType,
  ConnectorKind,
  ConnectorRisk,
  ConnectorState,
  ConnectorStatus,
  ConnectorTool,
  ConnectResult,
  DisconnectResult,
  SetupCopy,
  SetupField,
  SetupStep,
  TestResult,
} from '../connectors/types.js';

// POST /api/connections/:id/connect. the values of the setup fields, for example a client id and a secret.
export interface ConnectRequest {
  input?: Record<string, string>;
}

// POST /api/connections/:id/finish. the whole address of the page that the sign-in ended on.
export interface FinishRequest {
  url: string;
}

// POST /api/connections/:id/disconnect.
export interface DisconnectRequest {
  accountId?: string;
}

// POST /api/connections/:id/tools/:name. at least one of the two.
export interface ToolChangeRequest {
  enabled?: boolean;
  risk?: 'read' | 'write' | 'external';
}

// POST /api/connections/restart. 202 with this body, then the app stops gracefully and its supervisor starts it again.
export interface RestartResponse {
  restarting: true;
}
