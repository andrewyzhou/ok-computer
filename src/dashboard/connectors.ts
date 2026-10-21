import type { Hono } from 'hono';
import type { DashboardDeps } from './server.js';

// the routes of the connections hub (docs/CONNECT-PLAN.md, track S2). server.ts mounts them after the sign-in check,
// so each route is behind the dashboard auth, and a write without a json body already got 415 there. docs/API.md (S2)
// gives the shapes and the errors, and src/dashboard/connectors-types.ts the types:
// - GET /api/connections: the page, with every card.
// - GET /api/connections/:id: the details panel of one connector.
// - POST /api/connections/:id/connect, /finish, /disconnect and /test.
// - POST /api/connections/:id/tools/:name: a tool switch or a risk.
// - POST /api/connections/restart: one graceful restart, only when a supervisor runs the app.
// no answer holds a secret: a client secret or a token goes from the body to the keyring and never comes back.
export function mountConnectors(server: Hono, deps: DashboardDeps): void {
  void server;
  void deps;
}
