import type { Hono } from 'hono';
import type { DashboardDeps } from './server.js';

// phase 6 track T6 owns this module. it mounts GET /api/autonomy, GET /api/autonomy/history and
// POST /api/autonomy/:domain, with the shapes of autonomy-types.ts. server.ts calls it after the sign-in check, so each
// route is behind the dashboard auth, and the post is the only way to raise a level. the routes come when the module is
// built, so until then each path gives the 404 of the api.
export function mountAutonomy(server: Hono, deps: DashboardDeps): void {
  void server;
  void deps;
}
