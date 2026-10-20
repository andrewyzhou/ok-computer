import type { Hono } from 'hono';
import type { DashboardDeps } from './server.js';

// phase 6 t3 owns this module. it mounts the desk routes, and docs/API.md (T3) gives their shapes and errors:
// GET /api/desk, GET /api/desk/delegations/:id, POST /api/desk/delegations and POST /api/desk/delegations/:id.
// server.ts calls it after the sign-in check, so each route is behind the dashboard auth. the work package
// "dashboard routes" fills it; until then the routes answer with the 404 of an unknown /api path.
export function mountDesk(_server: Hono, _deps: DashboardDeps): void {}
