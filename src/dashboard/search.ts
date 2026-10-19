import { join } from 'node:path';
import type { Hono } from 'hono';
import type { Db } from '../db/index.js';
import { notBuilt, limitOf } from './params.js';
import type { DashboardDeps } from './server.js';
import type { SearchResults, SearchScope } from './types.js';

// phase 5 m1 owns this module. it mounts GET /api/search. docs/PHASE5-API.md gives the shapes and the errors.
// server.ts calls it after the sign-in check, so each route is behind the dashboard auth.

// the order of the groups in an answer.
export const SEARCH_SCOPES: readonly SearchScope[] = ['messages', 'runs', 'tools', 'automations', 'memory', 'approvals'];

export interface SearchInput {
  // 1 to 200 characters.
  q: string;
  scope?: SearchScope;
  // the hits per scope, already clamped to 1 to 50.
  limit: number;
  // the memory folder, for searchMemory.
  memoryDir: string;
  now: Date;
}

export function search(_db: Db, _input: SearchInput): SearchResults {
  return notBuilt('the search');
}

export function mountSearch(server: Hono, deps: DashboardDeps): void {
  const { db, config, clock } = deps;
  const memoryDir = join(config.paths.data, 'memory');
  server.get('/api/search', (c) => {
    const q = c.req.query('q') ?? '';
    if (!q.trim() || q.length > 200) return c.json({ error: 'give q as 1 to 200 characters' }, 400);
    const scope = c.req.query('scope') as SearchScope | undefined;
    if (scope !== undefined && !SEARCH_SCOPES.includes(scope)) return c.json({ error: `give scope as one of ${SEARCH_SCOPES.join(', ')}` }, 400);
    const limit = limitOf(c.req.query('limit'), 50, scope ? 30 : 8);
    return c.json(search(db, { q, ...(scope ? { scope } : {}), limit, memoryDir, now: clock() }));
  });
}
