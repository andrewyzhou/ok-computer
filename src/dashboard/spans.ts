import type { Hono } from 'hono';
import type { Db } from '../db/index.js';
import { notBuilt } from './params.js';
import type { DashboardDeps } from './server.js';
import type { RunSpans } from './types.js';

// phase 5 m1 owns this module. it mounts GET /api/runs/:id/spans. docs/PHASE5-API.md gives the shapes and the errors.
// server.ts calls it after the sign-in check, so each route is behind the dashboard auth.

// the waterfall of one run and of its child runs. a run that does not exist gives undefined.
export function runSpans(_db: Db, _runId: string): RunSpans | undefined {
  return notBuilt('the spans of a run');
}

export function mountSpans(server: Hono, deps: DashboardDeps): void {
  const { db } = deps;
  server.get('/api/runs/:id/spans', (c) => {
    const spans = runSpans(db, c.req.param('id'));
    return spans ? c.json(spans) : c.json({ error: 'run not found' }, 404);
  });
}
