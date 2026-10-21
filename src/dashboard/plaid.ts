import type { Hono } from 'hono';
import type { DashboardDeps } from './server.js';

// track s3 (the bank) owns this module. it mounts the /api/plaid routes of the bank page, the subscriptions page and the
// bank card. docs/API.md (s3) gives the shapes and the errors, and the types are in plaid-types.ts. server.ts calls it
// after the sign-in check, so each route is behind the dashboard auth, and a write without a json body already got 415
// there. no route answers with a client secret, an access token or a public token.

// the scaffold mounts no route yet, so each /api/plaid path gives the 404 of server.ts until the link package builds
// them on app.plaid.
export function mountPlaid(server: Hono, deps: DashboardDeps): void {
  void server;
  void deps;
}
