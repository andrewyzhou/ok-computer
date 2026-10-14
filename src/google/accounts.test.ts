import { readdirSync, readFileSync } from 'node:fs';
import { request } from 'node:http';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CLIENT_ID, createGoogleHarness, type GoogleHarness } from '../../test/google-harness.js';
import { SCOPES } from './config.js';

let h: GoogleHarness;
afterEach(async () => h?.close());

const NEW_REFRESH = '1//fresh-sign-in-token-0123456789abcdef';

async function begin(alias: string) {
  const result = await h.accounts.beginSignIn(alias);
  if (!('url' in result)) throw new Error(result.error);
  const url = new URL(result.url);
  return { url, state: url.searchParams.get('state')!, callback: url.searchParams.get('redirect_uri')! };
}

// the browser of the owner follows google's redirect to the loopback callback.
const visit = async (callback: string, query: string) => (await fetch(`${callback}?${query}`)).text();

describe('google sign-in', () => {
  it('signs in with pkce on a loopback port, stores only the refresh token reference, and takes the gmail baseline', async () => {
    h = await createGoogleHarness({ accounts: ['personal'] });
    await h.secrets.delete('google.personal');
    h.fake.nextSignIn = { alias: 'personal', refreshToken: NEW_REFRESH };
    const { url, state, callback } = await begin('personal');
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('consent');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('login_hint')).toBe('personal@example.com');
    expect(url.searchParams.get('scope')!.split(' ')).not.toContain(SCOPES.send);
    expect(callback).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);

    expect(await visit(callback, `code=good-code&state=${state}`)).toContain('Signed in as personal@example.com');
    expect(h.secrets.values.get('google.personal')).toBe(NEW_REFRESH);
    expect(h.rows('SELECT status, email, alertedAt FROM google_accounts')).toEqual([{ status: 'ok', email: 'personal@example.com', alertedAt: null }]);
    expect(h.rows('SELECT historyId FROM google_accounts')).toEqual([{ historyId: '1000' }]);

    // mail after the sign-in is news, also when the first polls fail.
    h.fake.deliver('personal', { id: 'm1', headers: { Subject: 'right after connect' } });
    h.fake.fault({ route: 'GET /gmail/v1/users/me/history', status: 503, times: 1 });
    await h.sync.pollAll('poll-run');
    await h.sync.pollAll('poll-run');
    expect(h.rows('SELECT externalId FROM integration_events')).toEqual([{ externalId: 'm1' }]);

    // the state works once, and the callback listens only while a flow waits.
    expect(await h.accounts.finishSignIn(state, 'good-code')).toEqual({ error: expect.stringContaining('unknown or expired') });
    await expect(visit(callback, `code=good-code&state=${state}`)).rejects.toThrow();
  });

  // a token endpoint can quote its form body in an error. the code and the pkce verifier must not reach the trace,
  // the log or the page in the browser.
  it('keeps the code and the verifier out of the trace, the log and the page when the exchange echoes its body', async () => {
    h = await createGoogleHarness({ accounts: ['school'] });
    const code = '4/0AeaYSHprobe-auth-code-0123456789abcdef';
    const { state, callback } = await begin('school');
    h.fake.fault({ route: 'POST /token', status: 500, times: 1, echoAuth: true });
    const page = await visit(callback, `code=${encodeURIComponent(code)}&state=${state}`);
    expect(page).toContain('The sign-in did not work');
    const body = h.fake.requests.find((each) => each.path === '/token')!.body;
    const verifier = new URLSearchParams(body).get('code_verifier')!;
    expect(verifier.length).toBeGreaterThan(40);
    const logs = readdirSync(join(h.dir, 'logs')).map((name) => readFileSync(join(h.dir, 'logs', name), 'utf8'));
    const written = [JSON.stringify(h.rows('SELECT * FROM google_requests')), ...logs, page].join('\n');
    // the echo is in the trace, so the check below looks at the right text.
    expect(written).toContain('injected fault');
    for (const secret of [code, verifier]) {
      for (const form of [secret, encodeURIComponent(secret), new URLSearchParams({ v: secret }).toString().slice(2)]) expect(written).not.toContain(form);
    }
  });

  it('refuses a sign-in without every scope, and revokes its token at google', async () => {
    h = await createGoogleHarness({ accounts: ['personal'] });
    h.fake.grant = [SCOPES.readonly, SCOPES.events, SCOPES.calendarRead];
    h.fake.nextSignIn = { alias: 'personal', refreshToken: NEW_REFRESH };
    const { state, callback } = await begin('personal');
    expect(await visit(callback, `code=good-code&state=${state}`)).toContain('Google did not grant: label and archive mail. Nothing was saved.');
    expect(h.fake.requests.some((each) => each.path.startsWith('/revoke'))).toBe(true);
    expect(h.secrets.values.get('google.personal')).not.toBe(NEW_REFRESH);
    expect(h.rows('SELECT status FROM google_accounts')).toEqual([{ status: 'signed_out' }]);
  });

  it('refuses a sign-in with another google account than the alias names', async () => {
    h = await createGoogleHarness({ accounts: ['personal', 'school'] });
    // the owner was still signed in to the school account in the browser.
    h.fake.nextSignIn = { alias: 'school', refreshToken: NEW_REFRESH };
    const { state, callback } = await begin('personal');
    expect(await visit(callback, `code=good-code&state=${state}`)).toContain('You signed in as school@example.com, but personal is personal@example.com in the config. Nothing was saved.');
    expect(h.secrets.values.get('google.personal')).not.toBe(NEW_REFRESH);
  });

  it('refuses an expired link and a callback from a host that is not loopback', async () => {
    h = await createGoogleHarness({ accounts: ['personal'] });
    h.fake.nextSignIn = { alias: 'personal', refreshToken: NEW_REFRESH };
    const { state, callback } = await begin('personal');
    const status = await new Promise<number>((resolve) => {
      const target = new URL(`${callback}?code=good-code&state=${state}`);
      request({ host: '127.0.0.1', port: target.port, path: target.pathname + target.search, headers: { host: 'evil.example' } }, (res) => resolve(res.statusCode ?? 0)).end();
    });
    expect(status).toBe(404);
    h.now.value = new Date(h.now.value.getTime() + 11 * 60_000);
    expect(await visit(callback, `code=good-code&state=${state}`)).toContain('unknown or expired');
  });

  it('stores the secret of the configured desktop client from its json file, and refuses a web client or another client', async () => {
    h = await createGoogleHarness({ accounts: ['personal'] });
    expect(await h.accounts.saveClient({ web: { client_id: CLIENT_ID, client_secret: 'web-secret-123456' } })).toEqual({ error: expect.stringContaining('web client') });
    expect(await h.accounts.saveClient({ installed: { client_id: 'other.apps.googleusercontent.com', client_secret: 'GOCSPX-other' } })).toEqual({
      error: expect.stringContaining('but clientId in okc.config.json is fake-client.apps.googleusercontent.com'),
    });
    expect(await h.accounts.saveClient({ installed: { client_id: CLIENT_ID, client_secret: 'GOCSPX-desktop-secret', redirect_uris: ['http://localhost'] } })).toEqual({ saved: true });
    expect(h.secrets.values.get('google.client')).toBe('GOCSPX-desktop-secret');
  });

  // the failures of the dead sign-in are over. else the page says that polls fail right after a sign-in that worked.
  it('clears the needs_auth state, the alert mark and the failure count after a new sign-in', async () => {
    h = await createGoogleHarness({ accounts: ['personal'] });
    h.signedIn('personal');
    h.db.prepare("UPDATE google_accounts SET status = 'needs_auth', alertedAt = '2026-10-12T00:00:00Z', failures = 1, lastErrorAt = '2026-10-12T00:00:00Z'").run();
    h.fake.nextSignIn = { alias: 'personal', refreshToken: NEW_REFRESH };
    const { state, callback } = await begin('personal');
    await visit(callback, `code=good-code&state=${state}`);
    expect(h.rows('SELECT status, alertedAt, failures, lastErrorAt FROM google_accounts')).toEqual([{ status: 'ok', alertedAt: null, failures: 0, lastErrorAt: null }]);
    expect(h.accounts.unavailable('personal')).toBeUndefined();
  });
});
