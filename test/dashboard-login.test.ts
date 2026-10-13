import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseConfig } from '../src/config/load.js';
import { createLoginCodes, type LoginCodes } from '../src/dashboard/login.js';
import { createDashboard } from '../src/dashboard/server.js';
import { openDb } from '../src/db/index.js';
import { silentLogger } from '../src/observability/logger.js';

const REMOTE = 'https://okc-pc.example.ts.net';
// tailscale serve forwards plain http with the host name of the tailnet.
const FORWARDED = 'http://okc-pc.example.ts.net';

function dashboard(options: { token?: string; publicUrl?: string; codes?: LoginCodes }) {
  const dir = mkdtempSync(join(tmpdir(), 'okc-login-'));
  const parsed = parseConfig({ paths: { data: dir, workspace: dir }, ...(options.publicUrl ? { dashboard: { publicUrl: options.publicUrl } } : {}) });
  if (!parsed.ok) throw new Error(parsed.error);
  return createDashboard({
    db: openDb(':memory:'),
    config: parsed.value,
    clock: () => new Date('2026-10-13T16:00:00Z'),
    logger: silentLogger,
    app: {} as never,
    webDir: dir,
    ...(options.token ? { token: options.token } : {}),
    ...(options.codes ? { codes: options.codes } : {}),
  });
}

const login = (server: ReturnType<typeof dashboard>, body: unknown, base = 'http://127.0.0.1', headers: Record<string, string> = {}) =>
  server.request(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

describe('dashboard login', () => {
  it('signs in once with the token and then uses an http-only cookie', async () => {
    const server = dashboard({ token: 'secret-token' });
    const page = await server.request('/login');
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("fetch('/api/login'");

    const wrong = await login(server, { token: 'wrong-token' });
    expect(wrong.status).toBe(401);
    expect(wrong.headers.get('set-cookie')).toBeNull();
    // a form from another site cannot send json without a cors request, which this server never allows.
    const form = await server.request('/api/login', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'token=secret-token' });
    expect(form.status).toBe(415);

    const right = await login(server, { token: 'secret-token' });
    expect(right.status).toBe(200);
    const cookie = right.headers.get('set-cookie')!;
    expect(cookie).toMatch(/^okc_session=[0-9a-f]{64}; Max-Age=2592000; Path=\/; HttpOnly; SameSite=Strict$/);
    // the cookie holds a value derived from the token, not the token.
    expect(cookie).not.toContain('secret-token');

    const session = cookie.split(';')[0]!;
    expect((await server.request('/api/meta', { headers: { cookie: session } })).status).toBe(200);
    expect((await server.request('/api/meta', { headers: { cookie: 'okc_session=00' } })).status).toBe(401);
    expect((await server.request('/api/meta')).status).toBe(401);
    expect((await server.request('/api/meta', { headers: { authorization: 'Bearer secret-token' } })).status).toBe(200);
    expect((await server.request('/api/meta?token=secret-token')).status).toBe(200);
    // a new token makes the old cookie invalid.
    expect((await dashboard({ token: 'new-token' }).request('/api/meta', { headers: { cookie: session } })).status).toBe(401);
  });

  it('takes a code one time, only before it expires, and a page load does not spend it', async () => {
    let now = new Date('2026-10-13T16:00:00Z');
    const codes = createLoginCodes(() => now);
    const server = dashboard({ token: 'secret-token', publicUrl: REMOTE, codes });

    const code = codes.issue();
    expect(code).toMatch(/^[\w-]{22}$/);
    // a link preview loads the page. the code still works after that.
    expect((await server.request(`${REMOTE}/login?code=${code}`)).status).toBe(200);
    const first = await login(server, { code }, FORWARDED);
    expect(first.status).toBe(200);
    expect(first.headers.get('set-cookie')).toMatch(/^okc_session=[0-9a-f]{64};.*; Secure(;|$)/);
    expect((await login(server, { code }, REMOTE)).status).toBe(401);

    const late = codes.issue();
    now = new Date(now.getTime() + 5 * 60_000);
    expect((await login(server, { code: late }, REMOTE)).status).toBe(401);
    expect((await login(server, { code: 'made-up-code' }, REMOTE)).status).toBe(401);
  });

  it('accepts the public host only with a token, and marks the cookie secure behind https', async () => {
    const open = dashboard({ publicUrl: REMOTE });
    expect((await open.request(`${REMOTE}/api/meta`)).status).toBe(403);
    expect((await open.request('/login')).status).toBe(302);
    expect((await login(open, { token: 'anything' })).status).toBe(401);

    const server = dashboard({ token: 'secret-token', publicUrl: REMOTE });
    expect((await server.request(`${REMOTE}/api/meta`)).status).toBe(401);
    expect((await server.request('http://evil.example/api/meta?token=secret-token')).status).toBe(403);
    expect((await login(server, { token: 'secret-token' })).headers.get('set-cookie')).not.toContain('Secure');
    expect((await login(server, { token: 'secret-token' }, 'http://127.0.0.1', { 'x-forwarded-proto': 'https' })).headers.get('set-cookie')).toContain('; Secure');
    const right = await login(server, { token: 'secret-token' }, FORWARDED);
    expect(right.headers.get('set-cookie')).toContain('; Secure');
    const session = right.headers.get('set-cookie')!.split(';')[0]!;
    expect((await server.request(`${REMOTE}/api/meta`, { headers: { cookie: session } })).status).toBe(200);
  });

  it('refuses a public url that is not https', () => {
    expect(parseConfig({ dashboard: { publicUrl: 'http://okc-pc.example.ts.net' } }).ok).toBe(false);
    expect(parseConfig({ dashboard: { publicUrl: REMOTE } }).ok).toBe(true);
  });
});
