import { request } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { createGoogleHarness, type GoogleHarness } from '../../test/google-harness.js';
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

  it('refuses a sign-in without every scope, and revokes its token at google', async () => {
    h = await createGoogleHarness({ accounts: ['personal'] });
    h.fake.grant = [SCOPES.readonly, SCOPES.events, SCOPES.calendarRead];
    h.fake.nextSignIn = { alias: 'personal', refreshToken: NEW_REFRESH };
    const { state, callback } = await begin('personal');
    expect(await visit(callback, `code=good-code&state=${state}`)).toContain('did not grant gmail.modify');
    expect(h.fake.requests.some((each) => each.path.startsWith('/revoke'))).toBe(true);
    expect(h.secrets.values.get('google.personal')).not.toBe(NEW_REFRESH);
    expect(h.rows('SELECT status FROM google_accounts')).toEqual([{ status: 'signed_out' }]);
  });

  it('refuses a sign-in with another google account than the alias names', async () => {
    h = await createGoogleHarness({ accounts: ['personal', 'school'] });
    // the owner was still signed in to the school account in the browser.
    h.fake.nextSignIn = { alias: 'school', refreshToken: NEW_REFRESH };
    const { state, callback } = await begin('personal');
    expect(await visit(callback, `code=good-code&state=${state}`)).toContain('must be personal@example.com, but the sign-in was for school@example.com');
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

  it('stores a desktop client from its json file and refuses a web client', async () => {
    h = await createGoogleHarness({ accounts: ['personal'] });
    expect(await h.accounts.saveClient({ web: { client_id: 'w', client_secret: 'web-secret-123456' } })).toEqual({ error: expect.stringContaining('web client') });
    expect(await h.accounts.saveClient({ installed: { client_id: 'd.apps.googleusercontent.com', client_secret: 'GOCSPX-desktop-secret', redirect_uris: ['http://localhost'] } })).toEqual({ saved: true });
    expect(JSON.parse(h.secrets.values.get('google.client')!)).toEqual({ client_id: 'd.apps.googleusercontent.com', client_secret: 'GOCSPX-desktop-secret' });
  });

  it('clears the needs_auth state and the alert mark after a new sign-in', async () => {
    h = await createGoogleHarness({ accounts: ['personal'] });
    h.signedIn('personal');
    h.db.prepare("UPDATE google_accounts SET status = 'needs_auth', alertedAt = '2026-10-12T00:00:00Z'").run();
    h.fake.nextSignIn = { alias: 'personal', refreshToken: NEW_REFRESH };
    const { state, callback } = await begin('personal');
    await visit(callback, `code=good-code&state=${state}`);
    expect(h.rows('SELECT status, alertedAt FROM google_accounts')).toEqual([{ status: 'ok', alertedAt: null }]);
    expect(h.accounts.unavailable('personal')).toBeUndefined();
  });
});
