import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SCOPES } from '../src/google/config.js';
import { CLIENT_ID, createGoogleHarness, type GoogleHarness } from './google-harness.js';

let h: GoogleHarness;
afterEach(async () => h?.close());

// a refresh token that a sign-in on the desktop made. the server has not seen it before.
const DESKTOP = '1//desktop-sign-in-token-0123456789abcdef';

// the harness signs every account in. an import is for a server that has no token yet.
async function server(options: { accounts?: string[] } = {}) {
  h = await createGoogleHarness({ accounts: options.accounts ?? ['personal'] });
  for (const alias of options.accounts ?? ['personal']) await h.secrets.delete(`google.${alias}`);
  return h;
}

const revoked = () => h.fake.requests.filter((each) => each.path.startsWith('/revoke'));

// every place that a failure can write to: the log files, the trace rows and the answer.
function written(...answers: unknown[]): string {
  const logs = readdirSync(join(h.dir, 'logs')).map((name) => readFileSync(join(h.dir, 'logs', name), 'utf8'));
  return [JSON.stringify(h.rows('SELECT * FROM google_requests')), ...logs, ...answers.map((each) => JSON.stringify(each))].join('\n');
}

function expectNoToken(text: string, token = DESKTOP) {
  for (const form of [token, encodeURIComponent(token), new URLSearchParams({ v: token }).toString().slice(2)]) expect(text).not.toContain(form);
}

describe('google token import', () => {
  it('refreshes the token once, stores it under the alias, and marks the account ok', async () => {
    await server();
    h.fake.addAccount('personal', 'personal@example.com', DESKTOP);
    const result = await h.accounts.importToken('personal', { refreshToken: DESKTOP, clientId: CLIENT_ID });
    expect(result).toEqual({ ok: true, email: 'personal@example.com', scopes: expect.arrayContaining([SCOPES.modify, SCOPES.events]), storedAt: '2026-10-13T16:00:00.000Z' });
    expect(h.secrets.values.get('google.personal')).toBe(DESKTOP);
    expect(h.rows('SELECT status, email, historyId FROM google_accounts')).toEqual([{ status: 'ok', email: 'personal@example.com', historyId: '1000' }]);
    expect(h.fake.requests.filter((each) => each.path === '/token')).toHaveLength(1);
    expect(revoked()).toEqual([]);
    // the trace row of the refresh belongs to the account.
    expect(h.rows("SELECT account FROM google_requests WHERE url LIKE '%/token%'")).toEqual([{ account: 'personal' }]);
    expect(written()).toContain('google token imported');
    expectNoToken(written(result));

    // the account works with the stored token.
    expect(h.accounts.unavailable('personal')).toBeUndefined();
    await h.accounts.run('personal', (apis) => apis.gmail.users.getProfile({ userId: 'me' }));
  });

  it('answers 404 for an alias that is not in the config', async () => {
    await server();
    expect(await h.accounts.importToken('work', { refreshToken: DESKTOP, clientId: CLIENT_ID })).toEqual({ ok: false, status: 404, error: 'google account not found' });
    expect(h.fake.requests).toEqual([]);
  });

  it('answers 409 for a token of another client', async () => {
    await server();
    const result = await h.accounts.importToken('personal', { refreshToken: DESKTOP, clientId: 'other.apps.googleusercontent.com' });
    expect(result).toEqual({
      ok: false,
      status: 409,
      error: `the token is for the client other.apps.googleusercontent.com, but clientId in okc.config.json is ${CLIENT_ID}.`,
    });
    expect(h.fake.requests).toEqual([]);
  });

  it('answers 409 when the server has no client secret yet', async () => {
    await server();
    await h.secrets.delete('google.client');
    const result = await h.accounts.importToken('personal', { refreshToken: DESKTOP, clientId: CLIENT_ID });
    expect(result).toEqual({ ok: false, status: 409, error: 'the server has no client secret yet. Upload the client file on the Google page of the server first.' });
  });

  it('answers 503 when the secret store fails to read the client secret', async () => {
    await server();
    h.secrets.get = async () => {
      throw new Error('the store is down');
    };
    const result = await h.accounts.importToken('personal', { refreshToken: DESKTOP, clientId: CLIENT_ID });
    expect(result).toEqual({ ok: false, status: 503, error: 'the secret store failed, so the token was not stored.' });
  });

  it('answers 422 for a token that google revoked or never issued', async () => {
    await server();
    h.fake.addAccount('personal', 'personal@example.com', DESKTOP);
    h.fake.revoke(DESKTOP);
    const result = await h.accounts.importToken('personal', { refreshToken: DESKTOP, clientId: CLIENT_ID });
    expect(result).toEqual({ ok: false, status: 422, error: expect.stringMatching(/^google refused the token: sign-in refused: Token has been expired or revoked\./) });
    expect(h.secrets.values.has('google.personal')).toBe(false);
    expect(h.rows('SELECT status FROM google_accounts')).toEqual([{ status: 'signed_out' }]);
    expectNoToken(written(result));
  });

  it('revokes a token without every scope and answers 422', async () => {
    await server();
    h.fake.addAccount('personal', 'personal@example.com', DESKTOP);
    h.fake.grant = [SCOPES.readonly, SCOPES.events, SCOPES.calendarRead];
    const result = await h.accounts.importToken('personal', { refreshToken: DESKTOP, clientId: CLIENT_ID });
    expect(result).toEqual({
      ok: false,
      status: 422,
      error: 'the token does not grant: label and archive mail. It was revoked, so sign in again on the desktop and keep every box checked.',
    });
    expect(revoked()).toHaveLength(1);
    expect(h.secrets.values.has('google.personal')).toBe(false);
    expectNoToken(written(result));
  });

  it('revokes a token of another google account and answers 422', async () => {
    await server();
    h.fake.addAccount('other', 'other@example.com', DESKTOP);
    const result = await h.accounts.importToken('personal', { refreshToken: DESKTOP, clientId: CLIENT_ID });
    expect(result).toEqual({ ok: false, status: 422, error: expect.stringContaining('the token is for other@example.com, but personal is personal@example.com in the config. The token was revoked') });
    expect(revoked()).toHaveLength(1);
    expect(h.secrets.values.has('google.personal')).toBe(false);
    expect(h.rows('SELECT status, email FROM google_accounts')).toEqual([{ status: 'signed_out', email: null }]);
  });

  it('answers 503 without a revoke when the secret store does not take the token', async () => {
    await server();
    h.fake.addAccount('personal', 'personal@example.com', DESKTOP);
    h.secrets.set = async () => {
      throw new Error('the store is read only');
    };
    const result = await h.accounts.importToken('personal', { refreshToken: DESKTOP, clientId: CLIENT_ID });
    expect(result).toEqual({ ok: false, status: 503, error: 'the secret store did not take the token.' });
    expect(revoked()).toEqual([]);
    expect(h.rows('SELECT status FROM google_accounts')).toEqual([{ status: 'signed_out' }]);
    expectNoToken(written(result));
  });

  // a token endpoint can quote its form body in an error, and the body holds the refresh token.
  it('answers 503 when the token endpoint fails, and keeps the token out of the trace and the log', async () => {
    await server();
    h.fake.addAccount('personal', 'personal@example.com', DESKTOP);
    h.fake.fault({ route: 'POST /token', status: 500, times: 1, echoAuth: true });
    const result = await h.accounts.importToken('personal', { refreshToken: DESKTOP, clientId: CLIENT_ID });
    expect(result).toEqual({ ok: false, status: 503, error: 'google did not answer, so nothing was stored. Try again.' });
    expect(h.secrets.values.has('google.personal')).toBe(false);
    const text = written(result);
    // the echo is in the trace, so the check below looks at the right text.
    expect(text).toContain('injected fault');
    expectNoToken(text);
  });
});
