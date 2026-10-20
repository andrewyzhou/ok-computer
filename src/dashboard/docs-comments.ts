import type { Hono } from 'hono';
import type { DashboardDeps } from './server.js';

// the comment routes of the docs: POST /api/docs/:id/comments (docs/API.md, T4). the comments package owns this
// module, and docs.ts mounts it, so the comments and the other doc routes are built apart.
export function mountDocComments(server: Hono, deps: DashboardDeps): void {
  void server;
  void deps;
}
