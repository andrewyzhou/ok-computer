import type { Hono } from 'hono';
import type { DashboardDeps } from './server.js';

// phase 6 t1 (the today track) owns this module. it mounts the /api/briefs and /api/brief routes of the today page.
// docs/API.md (t1) gives the shapes and the errors, and the types are in brief-types.ts. server.ts calls it after the
// sign-in check, so each route is behind the dashboard auth, and a write without a json body already got 415 there.
// the work package "routes" fills it.
export function mountBrief(server: Hono, deps: DashboardDeps): void {
  void server;
  void deps;
}
