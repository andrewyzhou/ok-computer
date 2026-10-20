import type { Hono } from 'hono';
import { mountDocComments } from './docs-comments.js';
import type { DashboardDeps } from './server.js';

// phase 6 t4 owns this module. it mounts GET /api/docs, GET /api/docs/:id, GET /api/docs/:id/diff and
// GET /api/docs/:id/export, and the comment routes of docs-comments.ts. docs/API.md (T4) gives the shapes and the
// errors, and docs-types.ts holds the types. server.ts calls it after the sign-in check, so each route is behind the
// dashboard auth.
export function mountDocs(server: Hono, deps: DashboardDeps): void {
  // the routes package adds the read and export routes here. until then each docs path answers the 404 of server.ts.
  mountDocComments(server, deps);
}
