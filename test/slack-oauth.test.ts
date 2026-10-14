import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseConfig } from '../src/config/load.js';
import { createDashboard, type DashboardDeps } from '../src/dashboard/server.js';
import { openDb } from '../src/db/index.js';
import { parseIntegrations, type IntegrationEntry } from '../src/integrations/config.js';
import { createIntegrations, type Integrations } from '../src/integrations/integrations.js';
import { createOAuth } from '../src/integrations/oauth.js';
import { createMemorySecretStore } from '../src/integrations/secrets.js';
import { createBlobStore } from '../src/observability/blobs.js';
import { createLogger, silentLogger } from '../src/observability/logger.js';
import { redact } from '../src/observability/redact.js';
import { createSlackFake, startSlackOAuth, type SlackOAuthServer } from './slack-server.js';

// the real sdk and the real oauth provider sign in to a fake of the official slack server over local http.

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const each of cleanup.splice(0).reverse()) await each();
});

const SCOPES = ['search:read.im', 'search:read.mpim', 'im:history', 'mpim:history', 'users:read', 'chat:write'];

async function setup(
  options: { callback?: 'loopback' | 'paste'; rotation?: boolean; client?: string | null; withhold?: string[]; scopes?: string[] } = {},
) {
  let now = Date.parse('2026-10-13T16:00:00Z');
  const clock = () => new Date(now);
  const fake = createSlackFake(() => Math.floor(now / 1000));
  const slack = await startSlackOAuth(fake, { rotation: options.rotation ?? false, withhold: options.withhold ?? [] });
  cleanup.push(() => slack.close());
  const logDir = mkdtempSync(join(tmpdir(), 'okc-slack-log-'));
  const logger = createLogger({ dir: logDir, consoleLevel: 'off' });
  const logLines = () => readdirSync(logDir).flatMap((file) => readFileSync(join(logDir, file), 'utf8').split('\n').filter(Boolean));
  const db = openDb(':memory:');
  db.prepare("INSERT INTO runs (id, sessionKey, trigger, slot, status, startedAt) VALUES ('r1', 'main', 'message', 'main', 'running', 'x')").run();
  const client = options.client === undefined ? JSON.stringify({ client_id: slack.clientId, client_secret: slack.clientSecret }) : options.client;
  const secrets = createMemorySecretStore(client === null ? {} : { 'slack-work-app': client });
  const port = await freePort();
  const oauth = createOAuth({ db, clock, logger, secrets, port });
  cleanup.push(() => oauth.close());
  const parsed = parseIntegrations({
    integrations: [
      {
        id: 'slack-work',
        kind: 'mcp-http',
        url: slack.url,
        auth: { type: 'oauth', clientRef: 'slack-work-app', scopes: options.scopes ?? SCOPES, callback: options.callback ?? 'paste' },
        tools: { allow: ['slack_search_public_and_private', 'slack_read_user_profile', 'slack_send_message'] },
        risk: { slack_search_public_and_private: 'read', slack_read_user_profile: 'read', slack_send_message: 'external' },
      },
    ],
  });
  if (!parsed.ok) throw new Error(parsed.error);
  const needsAuth: Array<[string, string | undefined]> = [];
  const integrations = createIntegrations({
    db,
    blobs: createBlobStore(db, mkdtempSync(join(tmpdir(), 'okc-slack-')), clock),
    logger,
    clock,
    entries: parsed.value as IntegrationEntry[],
    secrets,
    oauth,
    onNeedsAuth: (id, said) => needsAuth.push([id, said]),
  });
  cleanup.push(() => integrations.stop());
  const state = () => integrations.connection('slack-work')!.state();
  return { slack, fake, db, secrets, oauth, integrations, needsAuth, logLines, state, port, advance: (ms: number) => (now += ms) };
}

// the owner's browser: slack sends it to the https redirect, where no page loads. the owner copies that address.
async function consent(slack: SlackOAuthServer, url: string): Promise<string> {
  const response = await fetch(url, { redirect: 'manual' });
  expect(response.status, await response.clone().text()).toBe(302);
  return response.headers.get('location')!;
}

async function signIn(t: Awaited<ReturnType<typeof setup>>): Promise<string> {
  const started = await t.integrations.connect('slack-work');
  if (!('url' in started)) throw new Error(`expected a link, got ${JSON.stringify(started)}`);
  const address = await consent(t.slack, started.url);
  expect(await t.integrations.finishSignIn(address)).toEqual({ ok: true, text: 'Connected. You can close this tab.' });
  await expect.poll(() => t.state().status).toBe('connected');
  return address;
}

const search = (integrations: Integrations, id = 'c1') =>
  integrations.connection('slack-work')!.callTool('slack_search_public_and_private', { filters: 'after:2026-10-12' }, { runId: 'r1', toolCallId: id });

describe('slack sign-in with the paste callback', () => {
  it('cannot sign in through the plain http loopback, because slack wants an https redirect', async () => {
    const t = await setup({ callback: 'loopback' });
    const started = await t.integrations.connect('slack-work');
    if (!('url' in started)) throw new Error('expected a link');
    expect(new URL(started.url).searchParams.get('redirect_uri')).toMatch(/^http:\/\/127\.0\.0\.1:/);
    const response = await fetch(started.url, { redirect: 'manual' });
    expect(response.status).toBe(400);
    expect(await response.text()).toContain('bad_redirect_uri');
  });

  it('finishes the sign-in with the pasted https address, once', async () => {
    const t = await setup();
    await t.integrations.start();
    const address = await signIn(t);
    expect(address).toMatch(/^https:\/\/127\.0\.0\.1:\d+\/oauth\/callback\?code=/);
    expect(t.integrations.status()[0]!.oauthApp).toEqual({ redirectUrl: `https://127.0.0.1:${t.port}/oauth/callback`, callback: 'paste', clientRef: 'slack-work-app' });
    expect(await search(t.integrations)).toMatchObject({ kind: 'result' });
    // a second paste of the same address finds no flow, and the code was spent anyway.
    expect(await t.integrations.finishSignIn(address)).toEqual({ ok: false, text: 'This sign-in link is not valid any more. Start again from the dashboard.' });
    expect(await t.integrations.finishSignIn('not an address')).toMatchObject({ ok: false, text: expect.stringContaining('not an address') });
    expect(t.slack.stats.codeGrants).toBe(1);
  });
});

describe('slack sign-in with a pre-registered client', () => {
  const lastError = (t: Awaited<ReturnType<typeof setup>>) =>
    String(t.db.prepare("SELECT lastError FROM integration_state WHERE integrationId = 'slack-work'").get()?.lastError ?? '');

  it('signs in without a registration, with only the configured scopes, and keeps the token and the client secret out of every record', async () => {
    const t = await setup();
    await t.integrations.start();
    await signIn(t);
    expect(t.slack.stats.registrations).toBe(0);
    // the metadata offers more scopes, and the configured list wins.
    expect(t.slack.scopes).toEqual([SCOPES.join(' ')]);
    // the secret goes only in the token request, in the basic header.
    expect(t.slack.tokenAuth).toEqual(['basic']);
    const tokens = JSON.parse((await t.secrets.get('slack-work:oauth-tokens'))!) as { access_token: string };
    expect(tokens.access_token).toMatch(/^xoxp-/);
    // the client is read from clientRef only. a copy under another name would hide a client that the owner stores later.
    expect(await t.secrets.get('slack-work:oauth-client')).toBeUndefined();
    expect(await search(t.integrations)).toMatchObject({ kind: 'result' });
    const stored = [
      ...t.db.prepare('SELECT payload FROM mcp_messages').all().map((row) => String(row.payload)),
      JSON.stringify(t.db.prepare('SELECT * FROM integration_state').all()),
      JSON.stringify(t.integrations.status()),
      ...t.logLines(),
    ].join('\n');
    expect(stored).not.toContain(tokens.access_token);
    expect(stored).not.toContain(t.slack.clientSecret);
    // a server can quote the secret in an error, so the redactor knows it after the first read.
    expect(redact(`said ${t.slack.clientSecret}`)).toBe('said [redacted]');
  });

  // a token that never expires kept its old scopes after the owner added a scope to the config, so the guide's fix for
  // missing_scope connected again with the same token and slack was never asked for the new scope.
  it('signs in again when the last sign-in did not ask for each configured scope', async () => {
    const t = await setup();
    await t.integrations.start();
    await signIn(t);
    const { requested, ...older } = JSON.parse((await t.secrets.get('slack-work:oauth-tokens'))!) as Record<string, unknown>;
    expect(requested).toBe(SCOPES.join(' '));
    // a token from before the record of the asked scopes uses the scopes that it names. slack can name them with
    // commas. a token that holds each configured scope connects with no new sign-in.
    await t.secrets.set('slack-work:oauth-tokens', JSON.stringify({ ...older, scope: SCOPES.join(',') }));
    expect(await t.integrations.connect('slack-work')).toEqual({ connected: true });
    await t.secrets.set('slack-work:oauth-tokens', JSON.stringify({ ...older, scope: SCOPES.slice(1).join(',') }));
    const started = await t.integrations.connect('slack-work');
    if (!('url' in started)) throw new Error(`expected a link, got ${JSON.stringify(started)}`);
    expect(await t.integrations.finishSignIn(await consent(t.slack, started.url))).toMatchObject({ ok: true });
    await expect.poll(() => t.state().status).toBe('connected');
    // the owner added a scope to the config after the sign-in, so the last sign-in did not ask for it.
    const tokens = JSON.parse((await t.secrets.get('slack-work:oauth-tokens'))!) as Record<string, unknown>;
    await t.secrets.set('slack-work:oauth-tokens', JSON.stringify({ ...tokens, requested: SCOPES.slice(1).join(' ') }));
    const again = await t.integrations.connect('slack-work');
    if (!('url' in again)) throw new Error(`expected a link, got ${JSON.stringify(again)}`);
    expect(new URL(again.url).searchParams.get('scope')).toBe(SCOPES.join(' '));
    expect(t.slack.scopes).toEqual([SCOPES.join(' '), SCOPES.join(' ')]);
  });

  it('connects with a token that holds fewer scopes than it asked for, and names the missing scopes', async () => {
    const t = await setup({ withhold: ['users:read'] });
    await t.integrations.start();
    const started = await t.integrations.connect('slack-work');
    if (!('url' in started)) throw new Error(`expected a link, got ${JSON.stringify(started)}`);
    const text = 'Connected, but the server did not grant these scopes: users:read. Tools that need them fail with missing_scope.';
    expect(await t.integrations.finishSignIn(await consent(t.slack, started.url))).toEqual({ ok: true, text });
    await expect.poll(() => t.state().status).toBe('connected');
    expect(lastError(t)).toBe(text);
    expect(await search(t.integrations)).toMatchObject({ kind: 'result' });
    // the next start uses the same token, with no new sign-in.
    await t.integrations.stop();
    await t.integrations.start();
    await expect.poll(() => t.state().status).toBe('connected');
    expect(t.slack.stats.codeGrants).toBe(1);
  });

  it('keeps the record of the asked scopes through a refresh', async () => {
    const t = await setup({ rotation: true, withhold: ['users:read'] });
    await t.integrations.start();
    const started = await t.integrations.connect('slack-work');
    if (!('url' in started)) throw new Error('expected a link');
    expect(await t.integrations.finishSignIn(await consent(t.slack, started.url))).toMatchObject({ ok: true });
    await expect.poll(() => t.state().status).toBe('connected');
    t.slack.expire();
    expect(await search(t.integrations)).toMatchObject({ kind: 'result' });
    expect(t.slack.stats.refreshGrants).toBe(1);
    expect(JSON.parse((await t.secrets.get('slack-work:oauth-tokens'))!)).toMatchObject({ requested: SCOPES.join(' ') });
    await t.integrations.stop();
    await t.integrations.start();
    await expect.poll(() => t.state().status).toBe('connected');
    expect(t.slack.stats.codeGrants).toBe(1);
  });

  it('connects once when a configured scope entry holds a list with commas or spaces', async () => {
    const t = await setup({ scopes: ['search:read.im,search:read.mpim', 'im:history mpim:history', 'users:read', 'chat:write'] });
    await t.integrations.start();
    await signIn(t);
    expect(t.slack.scopes.at(-1)).toBe(SCOPES.join(' '));
    expect(JSON.parse((await t.secrets.get('slack-work:oauth-tokens'))!)).toMatchObject({ requested: SCOPES.join(' ') });
    expect(await search(t.integrations)).toMatchObject({ kind: 'result' });
    await t.integrations.stop();
    await t.integrations.start();
    await expect.poll(() => t.state().status).toBe('connected');
    expect(t.slack.stats.codeGrants).toBe(1);
    expect(t.needsAuth).toEqual([]);
  });

  it('keeps the record of the asked scopes through a refresh when the read of the stored tokens fails', async () => {
    const t = await setup({ rotation: true, withhold: ['users:read'] });
    await t.integrations.start();
    const started = await t.integrations.connect('slack-work');
    if (!('url' in started)) throw new Error('expected a link');
    expect(await t.integrations.finishSignIn(await consent(t.slack, started.url))).toMatchObject({ ok: true });
    await expect.poll(() => t.state().status).toBe('connected');
    t.slack.expire();
    // the transport reads the tokens for the header, and the sdk reads them for the refresh. only the third read, the
    // one inside saveTokens, fails.
    const get = t.secrets.get.bind(t.secrets);
    let reads = 0;
    t.secrets.get = async (ref: string) => {
      if (ref === 'slack-work:oauth-tokens' && ++reads === 3) throw new Error('the credential manager is busy');
      return get(ref);
    };
    expect(await search(t.integrations)).toMatchObject({ kind: 'result' });
    t.secrets.get = get;
    expect(reads).toBeGreaterThanOrEqual(3);
    expect(t.slack.stats.refreshGrants).toBe(1);
    expect(JSON.parse((await t.secrets.get('slack-work:oauth-tokens'))!)).toMatchObject({ requested: SCOPES.join(' ') });
    await t.integrations.stop();
    await t.integrations.start();
    await expect.poll(() => t.state().status).toBe('connected');
    expect(t.slack.stats.codeGrants).toBe(1);
    expect(t.needsAuth).toEqual([]);
  });

  it('signs in again when the owner presses Connect and the token lacks a configured scope, and a start keeps the token', async () => {
    const t = await setup({ withhold: ['users:read'] });
    await t.integrations.start();
    const started = await t.integrations.connect('slack-work');
    if (!('url' in started)) throw new Error('expected a link');
    expect(await t.integrations.finishSignIn(await consent(t.slack, started.url))).toMatchObject({ ok: true });
    await expect.poll(() => t.state().status).toBe('connected');
    expect(t.integrations.status()[0]!.withheldScopes).toEqual(['users:read']);
    // a start by itself keeps the smaller grant, so no sign-in link waits while the admin does not allow the scope.
    await t.integrations.stop();
    await t.integrations.start();
    await expect.poll(() => t.state().status).toBe('connected');
    expect(t.slack.stats.codeGrants).toBe(1);
    // the admin allows the scope, and the owner presses Connect.
    t.slack.options.withhold = [];
    const again = await t.integrations.connect('slack-work');
    if (!('url' in again)) throw new Error(`expected a link, got ${JSON.stringify(again)}`);
    expect(await t.integrations.finishSignIn(await consent(t.slack, again.url))).toEqual({ ok: true, text: 'Connected. You can close this tab.' });
    await expect.poll(() => t.state().status).toBe('connected');
    expect(t.slack.stats.codeGrants).toBe(2);
    const stored = JSON.parse((await t.secrets.get('slack-work:oauth-tokens'))!) as { scope: string };
    expect(stored.scope.split(',')).toContain('users:read');
    expect(t.integrations.status()[0]!.withheldScopes).toBeUndefined();
    expect(await t.integrations.connect('slack-work')).toEqual({ connected: true });
  });

  it('names the withheld scopes on the page after a later error overwrites lastError', async () => {
    const t = await setup({ withhold: ['users:read'] });
    await t.integrations.start();
    const started = await t.integrations.connect('slack-work');
    if (!('url' in started)) throw new Error('expected a link');
    expect(await t.integrations.finishSignIn(await consent(t.slack, started.url))).toMatchObject({ ok: true });
    await expect.poll(() => t.state().status).toBe('connected');
    expect(lastError(t)).toContain('users:read');
    await t.integrations.stop();
    const get = t.secrets.get.bind(t.secrets);
    t.secrets.get = async (ref: string) => {
      if (ref === 'slack-work:oauth-tokens') throw new Error('the credential manager is busy');
      return get(ref);
    };
    await t.integrations.start();
    await expect.poll(() => lastError(t)).not.toContain('users:read');
    t.secrets.get = get;
    await t.integrations.stop();
    await t.integrations.start();
    await expect.poll(() => t.state().status).toBe('connected');
    expect(lastError(t)).not.toContain('users:read');
    expect(t.integrations.status()[0]!.withheldScopes).toEqual(['users:read']);
  });

  it('uses a client that the owner stores again after the first sign-in', async () => {
    const t = await setup();
    await t.integrations.start();
    await signIn(t);
    await t.secrets.set('slack-work-app', JSON.stringify({ client_id: t.slack.clientId, client_secret: 'cs-a-wrong-secret' }));
    await t.secrets.delete('slack-work:oauth-tokens');
    const started = await t.integrations.connect('slack-work');
    if (!('url' in started)) throw new Error('expected a link');
    expect(await t.integrations.finishSignIn(await consent(t.slack, started.url))).toMatchObject({ ok: false });
    expect(lastError(t)).toContain('the server said bad_client_secret');
    // the sdk drops the stored client after invalid_client. that is its own copy, never the client of the owner.
    expect(await t.secrets.get('slack-work-app')).toContain('cs-a-wrong-secret');
    await t.secrets.set('slack-work-app', JSON.stringify({ client_id: t.slack.clientId, client_secret: t.slack.clientSecret }));
    await signIn(t);
  });

  it('keeps the slack code of a refused code, which comes with http 200', async () => {
    const t = await setup();
    await t.integrations.start();
    const started = await t.integrations.connect('slack-work');
    if (!('url' in started)) throw new Error('expected a link');
    const address = new URL(await consent(t.slack, started.url));
    address.searchParams.set('code', 'not-a-code');
    expect(await t.integrations.finishSignIn(address.href)).toMatchObject({ ok: false });
    expect(lastError(t)).toBe('the sign-in step /api/oauth.v2.user.access failed. The server said: invalid_grant: the server said invalid_code');
  });

  it('clears the tokens of a refresh that slack refuses with http 200, tells the owner once, and parks after a restart', async () => {
    const t = await setup({ rotation: true });
    await t.integrations.start();
    await signIn(t);
    t.slack.options.refreshError = 'invalid_refresh_token';
    t.slack.expire();
    expect(await search(t.integrations)).toMatchObject({ kind: 'not_sent' });
    expect(t.state().status).toBe('needs_auth');
    expect(await t.secrets.get('slack-work:oauth-tokens')).toBeUndefined();
    expect(t.needsAuth).toEqual([['slack-work', 'invalid_grant: the server said invalid_refresh_token']]);
    await t.integrations.stop();
    const before = t.slack.stats.mcpRequests + t.slack.stats.apiRequests;
    await t.integrations.start();
    expect(t.integrations.status()[0]!.state).toMatchObject({ status: 'needs_auth', error: expect.stringContaining('not signed in yet') });
    expect(t.slack.stats.mcpRequests + t.slack.stats.apiRequests).toBe(before);
    expect(t.needsAuth).toHaveLength(1);
  });

  it('keeps the tokens through a rate limit on the refresh, and sends no message', async () => {
    const t = await setup({ rotation: true });
    await t.integrations.start();
    await signIn(t);
    t.slack.options.refreshError = 'ratelimited';
    t.slack.expire();
    expect(await search(t.integrations)).toMatchObject({ kind: 'not_sent', reason: expect.stringContaining('did not answer') });
    expect(await t.secrets.get('slack-work:oauth-tokens')).toBeDefined();
    expect(t.needsAuth).toEqual([]);
    // the limit ends, and the stored refresh token still works.
    t.slack.options.refreshError = undefined;
    expect(await search(t.integrations, 'c2')).toMatchObject({ kind: 'result' });
    expect(t.slack.stats.refreshGrants).toBe(1);
  });

  it('says that a client without quotes, as cmdkey stores json, is not valid json, and never shows the secret', async () => {
    const t = await setup({ client: '{client_id:1111111111.2222222222,client_secret:cs-secret-from-cmdkey}' });
    await t.integrations.start();
    const started = await t.integrations.connect('slack-work');
    expect(started).toEqual({ error: expect.stringContaining('the secret slack-work-app in the credential manager is not valid json') });
    const shown = [JSON.stringify(started), JSON.stringify(t.integrations.status()), JSON.stringify(t.db.prepare('SELECT * FROM integration_state').all()), ...t.logLines()].join('\n');
    expect(shown).not.toContain('cs-secret-from-cmdkey');
  });
});

describe('the issuer stamp of a pre-registered client', () => {
  it('stays in memory, so the sdk warns about a missing stamp only at the first sign-in of the process', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    cleanup.push(async () => warn.mockRestore());
    const t = await setup({ rotation: true });
    await t.integrations.start();
    await signIn(t);
    const stamp = () => warn.mock.calls.filter((call) => String(call[0]).includes("no 'issuer' stamp")).length;
    expect(stamp()).toBe(1);
    t.slack.expire();
    expect(await search(t.integrations)).toMatchObject({ kind: 'result' });
    expect(t.slack.stats.refreshGrants).toBe(1);
    expect(stamp()).toBe(1);
  });
});

describe('storing the client of the slack app', () => {
  it('says what to do when no client is stored, and sends no request', async () => {
    const t = await setup({ client: null });
    await t.integrations.start();
    expect(await t.integrations.connect('slack-work')).toEqual({
      error: 'the OAuth client of slack-work is not stored yet. Enter the client id and the client secret of its app on this page, then press Connect.',
    });
    expect(t.slack.stats.mcpRequests + t.slack.stats.apiRequests).toBe(0);
  });

  it('stores the client from the dashboard without an echo, and the next sign-in uses it', async () => {
    const t = await setup({ client: null });
    await t.integrations.start();
    const parsed = parseConfig({ slots: { main: { chain: ['fake/m'] } }, pricing: { 'fake/m': { input: 1, cachedInput: 0.1, cacheWrite: 1.25, output: 5 } } });
    if (!parsed.ok) throw new Error(parsed.error);
    const app = { integrations: t.integrations } as unknown as DashboardDeps['app'];
    const dashboard = createDashboard({ db: t.db, config: parsed.value, clock: () => new Date(), logger: silentLogger, app });
    const post = (path: string, body: unknown) =>
      dashboard.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

    const client = { client_id: t.slack.clientId, client_secret: t.slack.clientSecret };
    expect((await post('/api/integrations/slack-work/client', { ...client, extra: 1 })).status).toBe(400);
    expect((await post('/api/integrations/slack-work/client', { client_secret: t.slack.clientSecret })).status).toBe(400);
    expect((await post('/api/integrations/slack-work/client', { ...client, client_id: 'two words' })).status).toBe(400);
    expect((await post('/api/integrations/nope/client', client)).status).toBe(404);
    expect(await t.secrets.get('slack-work-app')).toBeUndefined();

    const stored = await post('/api/integrations/slack-work/client', client);
    const text = await stored.text();
    expect(stored.status).toBe(200);
    expect(JSON.parse(text)).toEqual({ stored: true });
    expect(text).not.toContain(t.slack.clientSecret);
    expect(JSON.parse((await t.secrets.get('slack-work-app'))!)).toEqual(client);
    const page = await (await dashboard.request('/api/integrations/slack-work')).text();
    expect(page).toContain('slack-work-app');
    expect(page).not.toContain(t.slack.clientSecret);
    expect(t.logLines().join('\n')).not.toContain(t.slack.clientSecret);
    await signIn(t);
  });

  it('keeps the stored secret when the owner stores the same client id without a secret', async () => {
    const t = await setup();
    await t.integrations.start();
    const stored = async () => JSON.parse((await t.secrets.get('slack-work-app'))!) as unknown;
    expect(await t.integrations.storeClient('slack-work', { client_id: t.slack.clientId })).toEqual({ stored: true });
    expect(await stored()).toEqual({ client_id: t.slack.clientId, client_secret: t.slack.clientSecret });
    await signIn(t);
    // another client id is another app, so the secret of the old app does not go with it.
    expect(await t.integrations.storeClient('slack-work', { client_id: '3333333333.4444444444' })).toEqual({ stored: true });
    expect(await stored()).toEqual({ client_id: '3333333333.4444444444' });
    // a client that the owner stored with cmdkey is not json, so the page cannot keep its secret and says so.
    await t.secrets.set('slack-work-app', '{client_id:1111111111.2222222222,client_secret:cs-secret-from-cmdkey}');
    expect(await t.integrations.storeClient('slack-work', { client_id: t.slack.clientId })).toEqual({ error: expect.stringContaining('Enter the client secret too') });
    expect(await t.secrets.get('slack-work-app')).toContain('cs-secret-from-cmdkey');
  });
});
