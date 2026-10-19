import type { Hono } from 'hono';
import { z } from 'zod';
import type { DashboardDeps } from './server.js';
import type { GoogleTokenImportRequest, GoogleTokenImportResponse, SecretStoreView } from './types.js';

// phase 5 m7 owns this module. it mounts POST /api/google/accounts/:alias/token and GET /api/secrets.
// docs/PHASE5-API.md gives the shapes and the errors. server.ts calls it after the sign-in check, so each route is
// behind the dashboard auth.

// a refresh token and a client id are one word each. the limits only keep a wrong paste out.
export const tokenImportBody = z
  .object({ refreshToken: z.string().regex(/^\S{1,2048}$/), clientId: z.string().regex(/^\S{1,200}$/) })
  .strict() satisfies z.ZodType<GoogleTokenImportRequest>;

type Answer<T> = { status: 200; body: T } | { status: 400 | 404 | 409 | 422 | 503; body: { error: string } };

// TODO(m7 routes): build it. the work package gives each status. the token never goes into an answer or a log.
export async function importGoogleToken(_deps: DashboardDeps, _alias: string, _body: unknown): Promise<Answer<GoogleTokenImportResponse>> {
  throw new Error('not built: the google token import route');
}

// TODO(m7 routes): build it. without a vault the answer is 503.
export async function secretsView(_deps: DashboardDeps): Promise<Answer<SecretStoreView>> {
  throw new Error('not built: the secret store view');
}

export function mountDeploy(server: Hono, deps: DashboardDeps): void {
  server.post('/api/google/accounts/:alias/token', async (c) => {
    const body: unknown = await c.req.json().catch(() => undefined);
    const answer = await importGoogleToken(deps, c.req.param('alias'), body);
    return c.json(answer.body, answer.status);
  });
  server.get('/api/secrets', async (c) => {
    const answer = await secretsView(deps);
    return c.json(answer.body, answer.status);
  });
}
