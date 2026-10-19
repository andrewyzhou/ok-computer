import type { Hono } from 'hono';
import { z } from 'zod';
import { redact } from '../observability/redact.js';
import type { DashboardDeps } from './server.js';
import type { GoogleTokenImportRequest, GoogleTokenImportResponse, SecretStoreView } from './types.js';

// phase 5 m7 owns this module. it mounts POST /api/google/accounts/:alias/token and GET /api/secrets.
// docs/API.md gives the shapes and the errors. server.ts calls it after the sign-in check, so each route is
// behind the dashboard auth.

// a refresh token and a client id are one word each. the limits only keep a wrong paste out.
export const tokenImportBody = z
  .object({ refreshToken: z.string().regex(/^\S{1,2048}$/), clientId: z.string().regex(/^\S{1,200}$/) })
  .strict() satisfies z.ZodType<GoogleTokenImportRequest>;

type Answer<T> = { status: 200; body: T } | { status: 400 | 404 | 409 | 422 | 500 | 503; body: { error: string } };

// the token never goes into an answer or a log. accounts.importToken gives it to the redactor first, and each error
// text goes through redact() too, so a text that quotes the token cannot reach the page.
export async function importGoogleToken(deps: DashboardDeps, alias: string, body: unknown): Promise<Answer<GoogleTokenImportResponse>> {
  const parsed = tokenImportBody.safeParse(body);
  if (!parsed.success) return { status: 400, body: { error: 'send {"refreshToken": "...", "clientId": "..."} as json' } };
  const google = deps.app.google;
  if (!google) return { status: 404, body: { error: 'google account not found' } };
  try {
    const result = await google.accounts.importToken(alias, parsed.data);
    if (!result.ok) return { status: result.status, body: { error: redact(result.error) } };
    return { status: 200, body: { alias, email: result.email, status: 'ok', scopes: result.scopes, storedAt: result.storedAt } };
  } catch (err) {
    deps.logger.error('the google token import failed', { alias, err });
    return { status: 500, body: { error: 'the token import failed' } };
  }
}

// a view with ok false is still a 200, because the view carries the state of the store.
export async function secretsView(deps: DashboardDeps): Promise<Answer<SecretStoreView>> {
  const vault = deps.app.secretVault;
  if (!vault) return { status: 503, body: { error: 'the secret store is not set up' } };
  return { status: 200, body: await vault.view() };
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
