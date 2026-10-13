import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseConfig } from '../src/config/load.js';
import { createDashboard } from '../src/dashboard/server.js';
import { openDb } from '../src/db/index.js';
import { silentLogger } from '../src/observability/logger.js';

const REMOTE = 'https://okc-pc.example.ts.net';

function dashboard(options: { token?: string; url?: string }) {
  const dir = mkdtempSync(join(tmpdir(), 'okc-login-'));
  const parsed = parseConfig({ paths: { data: dir, workspace: dir }, ...(options.url ? { dashboard: { url: options.url } } : {}) });
  if (!parsed.ok) throw new Error(parsed.error);
  return createDashboard({
    db: openDb(':memory:'),
    config: parsed.value,
    clock: () => new Date('2026-10-13T16:00:00Z'),
    logger: silentLogger,
    app: {} as never,
    webDir: dir,
    ...(options.token ? { token: options.token } : {}),
  });
}

const login = (server: ReturnType<typeof dashboard>, token: string, base = 'http://127.0.0.1', headers: Record<string, string> = {}) =>
  server.request(`${base}/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams({ token }).toString(),
  });

describe('dashboard login', () => {
  it('signs in once with a form and then uses an http-only cookie', async () => {
    const server = dashboard({ token: 'secret-token' });
    expect((await server.request('/login')).status).toBe(200);
    expect(await (await server.request('/login')).text()).toContain('<form method="post" action="/login">');

    const wrong = await login(server, 'wrong-token');
    expect(wrong.status).toBe(401);
    expect(wrong.headers.get('set-cookie')).toBeNull();

    const right = await login(server, 'secret-token');
    expect(right.status).toBe(303);
    expect(right.headers.get('location')).toBe('/');
    const cookie = right.headers.get('set-cookie')!;
    expect(cookie).toMatch(/^okc_session=[0-9a-f]{64}; Max-Age=2592000; Path=\/; HttpOnly; SameSite=Strict$/);
    // the cookie holds a value derived from the token, not the token.
    expect(cookie).not.toContain('secret-token');

    const session = cookie.split(';')[0]!;
    expect((await server.request('/api/meta', { headers: { cookie: session } })).status).toBe(200);
    expect((await server.request('/api/meta', { headers: { cookie: 'okc_session=00' } })).status).toBe(401);
    expect((await server.request('/api/meta')).status).toBe(401);
    // a new token makes the old cookie invalid.
    expect((await dashboard({ token: 'new-token' }).request('/api/meta', { headers: { cookie: session } })).status).toBe(401);
  });

  it('accepts the host of dashboard.url only with a token, and marks the cookie secure behind https', async () => {
    const open = dashboard({ url: REMOTE });
    expect((await open.request(`${REMOTE}/api/meta`)).status).toBe(403);
    expect((await open.request('/login')).status).toBe(302);

    const server = dashboard({ token: 'secret-token', url: REMOTE });
    expect((await server.request(`${REMOTE}/api/meta`)).status).toBe(401);
    expect((await server.request('http://evil.example/api/meta?token=secret-token')).status).toBe(403);
    const right = await login(server, 'secret-token', REMOTE, { 'x-forwarded-proto': 'https' });
    expect(right.headers.get('set-cookie')).toContain('; Secure');
    const session = right.headers.get('set-cookie')!.split(';')[0]!;
    expect((await server.request(`${REMOTE}/api/meta`, { headers: { cookie: session } })).status).toBe(200);
  });
});
