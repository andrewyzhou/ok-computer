import type { Hono } from 'hono';
import type { DashboardDeps } from './server.js';

// phase 5 m9 owns this module. it mounts GET /api/sandbox and GET /api/sandbox/execs/:id. docs/PHASE5-API.md gives the
// shapes and the errors. server.ts calls it after the sign-in check, so each route is behind the dashboard auth.
export function mountSandbox(_server: Hono, _deps: DashboardDeps): void {}
