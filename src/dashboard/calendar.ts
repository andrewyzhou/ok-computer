import type { Hono } from 'hono';
import type { DashboardDeps } from './server.js';

// phase 6 t1 (the today track) owns this module. it mounts GET /api/calendar for the calendar page. docs/API.md (t1)
// gives the shape and the errors, and the types are in calendar-types.ts. server.ts calls it after the sign-in check.
// the work package "routes" fills it.
export function mountCalendar(server: Hono, deps: DashboardDeps): void {
  void server;
  void deps;
}
