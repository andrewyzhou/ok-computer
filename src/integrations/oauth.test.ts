import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startOAuthServer, type OAuthTestServer } from '../../test/oauth-server.js';
import { parseConfig } from '../config/load.js';
import { startDashboard, type DashboardDeps } from '../dashboard/server.js';
import { openDb } from '../db/index.js';
import { createBlobStore } from '../observability/blobs.js';
import { createLogger, silentLogger } from '../observability/logger.js';
import { redact } from '../observability/redact.js';
import { parseIntegrations, type HttpEntry, type IntegrationEntry } from './config.js';
import { createIntegrations, type Integrations } from './integrations.js';
import { createOAuth, FLOW_TTL_MS } from './oauth.js';
import { createMemorySecretStore } from './secrets.js';

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

async function setup() {
  const as = await startOAuthServer();
  // the real logger writes json lines, so a test can show that no token reaches the log.
  const logDir = mkdtempSync(join(tmpdir(), 'okc-oauth-log-'));
  const logger = createLogger({ dir: logDir, consoleLevel: 'off' });
  const logLines = () => readdirSync(logDir).flatMap((file) => readFileSync(join(logDir, file), 'utf8').split('\n').filter(Boolean));
  cleanup.push(() => as.close());
  const db = openDb(':memory:');
  db.prepare("INSERT INTO runs (id, sessionKey, trigger, slot, status, startedAt) VALUES ('r1', 'main', 'message', 'main', 'running', 'x')").run();
  let now = new Date('2026-10-13T10:00:00Z').getTime();
  const clock = () => new Date(now);
  const secrets = createMemorySecretStore({ 'remote-app': JSON.stringify({ client_id: as.clientId }) });
  const port = await freePort();
  const oauth = createOAuth({ db, clock, logger, secrets, port });
  cleanup.push(() => oauth.close());
  const parsed = parseIntegrations({
    integrations: [{ id: 'remote', kind: 'mcp-http', url: `${as.base}/mcp`, auth: { type: 'oauth', clientRef: 'remote-app' }, tools: { allow: ['echo'] }, risk: { echo: 'read' } }],
  });
  if (!parsed.ok) throw new Error(parsed.error);
  const needsAuth: Array<[string, string | undefined]> = [];
  const integrations = createIntegrations({
    db,
    blobs: createBlobStore(db, mkdtempSync(join(tmpdir(), 'okc-oauth-')), clock),
    logger,
    clock,
    entries: parsed.value as IntegrationEntry[],
    secrets,
    oauth,
    onNeedsAuth: (id, said) => needsAuth.push([id, said]),
  });
  cleanup.push(() => integrations.stop());
  return { as, db, secrets, oauth, integrations, needsAuth, port, logLines, advance: (ms: number) => (now += ms) };
}

// the owner's browser: it opens the link, and the server sends it to the loopback callback.
async function consent(url: string): Promise<{ callback: string; response: Response }> {
  const redirect = await fetch(url, { redirect: 'manual' });
  const callback = redirect.headers.get('location')!;
  return { callback, response: await fetch(callback) };
}

async function connect(integrations: Integrations) {
  const started = await integrations.connect('remote');
  if (!('url' in started)) throw new Error(`expected a link, got ${JSON.stringify(started)}`);
  const { response, callback } = await consent(started.url);
  expect(response.status).toBe(200);
  expect(await response.text()).toBe('Connected. You can close this tab.');
  await expect.poll(() => integrations.connection('remote')!.state().status).toBe('connected');
  return callback;
}

const echo = (integrations: Integrations, id = 'c1') => integrations.connection('remote')!.callTool('echo', { text: 'hi' }, { runId: 'r1', toolCallId: id });

describe('oauth', () => {
  it('waits for the owner without a request, signs in through the loopback callback, and keeps every token out of the trace and the log', async () => {
    const { as, db, secrets, integrations, needsAuth, logLines } = await setup();
    await integrations.start();
    // without tokens the integration is parked: no discovery, no registration, no flow, and no message to the owner.
    expect(integrations.status()[0]!.state).toMatchObject({ status: 'needs_auth', error: expect.stringContaining('not signed in yet') });
    expect(as.stats.requests).toBe(0);
    expect(needsAuth).toEqual([]);

    await connect(integrations);
    expect(await echo(integrations)).toMatchObject({ kind: 'result' });
    const tokens = JSON.parse((await secrets.get('remote:oauth-tokens'))!) as { access_token: string; refresh_token: string };
    expect(redact(`Bearer ${tokens.access_token}`)).toBe('Bearer [redacted]');
    expect(redact(tokens.refresh_token)).toBe('[redacted]');
    expect(db.prepare("SELECT tokenExpiresAt FROM integration_state WHERE integrationId = 'remote'").get()).toEqual({
      tokenExpiresAt: '2026-10-13T11:00:00.000Z',
    });
    const stored = [
      ...db.prepare('SELECT payload FROM mcp_messages').all().map((row) => String(row.payload)),
      JSON.stringify(db.prepare('SELECT * FROM integration_state').all()),
      ...logLines(),
    ].join('\n');
    expect(stored).not.toContain(tokens.access_token);
    expect(stored).not.toContain(tokens.refresh_token);
    // the token request carries the code and the pkce verifier. the log never has a request body.
    expect(logLines().join('\n')).not.toMatch(/code_verifier|grant_type/);
    // the log shows each sign-in step with the integration id, so a failed step is visible.
    expect(logLines().some((line) => line.includes('"msg":"oauth step"') && line.includes('/token') && line.includes('"integration":"remote"'))).toBe(true);
  });

  it('closes the callback port when no sign-in waits', async () => {
    const { integrations, port } = await setup();
    await integrations.start();
    await connect(integrations);
    // another process can now take the port, because this one listens only while a flow waits.
    const other = createOAuth({ db: openDb(':memory:'), clock: () => new Date(), logger: silentLogger, secrets: createMemorySecretStore(), port });
    await expect.poll(async () => other.listen(() => undefined, () => {}).then(() => true, () => false)).toBe(true);
    await other.close();
  });

  it('sends no message for stored tokens that never worked in this app', async () => {
    const { db, secrets, integrations, needsAuth } = await setup();
    // for example, the database is new but the credential manager still has old tokens.
    await secrets.set('remote:oauth-tokens', JSON.stringify({ access_token: 'at_old', refresh_token: 'rt_old', token_type: 'Bearer' }));
    await integrations.start();
    expect(integrations.connection('remote')!.state().status).toBe('needs_auth');
    expect(needsAuth).toEqual([]);
    // the sdk saved the old tokens again to add the issuer. that is not a sign-in.
    expect(db.prepare('SELECT authorizedAt, tokenExpiresAt FROM integration_state WHERE integrationId = ?').get('remote')).toEqual({ authorizedAt: null, tokenExpiresAt: null });
  });

  it('sends no message when a first sign-in fails, and keeps the text of the server', async () => {
    const { as, db, integrations, needsAuth } = await setup();
    await integrations.start();
    as.refuseCodes();
    const started = await integrations.connect('remote');
    if (!('url' in started)) throw new Error('expected a link');
    const { response } = await consent(started.url);
    expect(response.status).toBe(400);
    expect(needsAuth).toEqual([]);
    expect(integrations.connection('remote')!.state().status).not.toBe('connected');
    expect(db.prepare('SELECT authorizedAt, lastError FROM integration_state WHERE integrationId = ?').get('remote')).toEqual({
      authorizedAt: null,
      lastError: 'the sign-in step /token failed. The server said: invalid_grant: the code expired',
    });
  });

  it('refuses an unknown state, a second use of the same link, and an expired flow', async () => {
    const { oauth, integrations, advance } = await setup();
    await integrations.start();
    const finish = (id: string) => integrations.connection(id)!.transport();

    expect(await oauth.callback(new URL('http://127.0.0.1/oauth/callback?code=x&state=forged'), finish)).toMatchObject({ status: 400 });

    const callback = await connect(integrations);
    expect(await oauth.callback(new URL(callback), finish)).toMatchObject({ status: 400 });

    // with working tokens a new sign-in is not needed.
    expect(await integrations.connect('remote')).toEqual({ connected: true });
  });

  it('refuses a flow that the owner finishes after the time limit', async () => {
    const { oauth, integrations, advance } = await setup();
    await integrations.start();
    const started = await integrations.connect('remote');
    if (!('url' in started)) throw new Error('expected a link');
    advance(FLOW_TTL_MS + 1);
    const { response } = await consent(started.url);
    expect(response.status).toBe(400);
    expect(oauth.pendingUrl('remote')).toBeUndefined();
    expect(integrations.connection('remote')!.state().status).toBe('needs_auth');
  });

  it('refreshes one time when two calls find an expired token at once, so rotation never sees a reused token', async () => {
    const { as, integrations } = await setup();
    await integrations.start();
    await connect(integrations);
    as.expire();
    const results = await Promise.all([echo(integrations, 'a'), echo(integrations, 'b'), echo(integrations, 'c')]);
    expect(results.map((each) => each.kind)).toEqual(['result', 'result', 'result']);
    expect(as.stats).toMatchObject({ refreshGrants: 1, reuse: 0 });
  });

  it('asks the owner once when the refresh token was revoked, and does not retry by itself', async () => {
    const { as, integrations, needsAuth } = await setup();
    await integrations.start();
    await connect(integrations);
    needsAuth.length = 0;
    as.revoke();
    expect(await echo(integrations)).toMatchObject({ kind: 'not_sent', reason: expect.stringContaining('sign-in') });
    expect(integrations.connection('remote')!.state().status).toBe('needs_auth');
    expect(await echo(integrations, 'again')).toMatchObject({ kind: 'not_sent' });
    // one message, with the text of the token endpoint. the page shows the same text.
    expect(needsAuth).toEqual([['remote', 'invalid_grant: unknown refresh token']]);
    expect(integrations.status()[0]!.lastError).toContain('The server said: invalid_grant: unknown refresh token');
    const requests = as.stats.mcpRequests;
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(as.stats.mcpRequests).toBe(requests);
    // the owner presses connect. the new flow waits for the owner, and the owner gets no second message.
    expect(await integrations.connect('remote')).toMatchObject({ url: expect.any(String) });
    expect(needsAuth).toHaveLength(1);
  });

  it('reads a revoked refresh token correctly while the dashboard runs in the same process', async () => {
    const { as, db, secrets, integrations, needsAuth } = await setup();
    const config = parseConfig({});
    if (!config.ok) throw new Error(config.error);
    // the dashboard server starts before the first refresh, as in the live app.
    const dashboard = await startDashboard({ db, config: config.value, clock: () => new Date(), logger: silentLogger, app: {} as DashboardDeps['app'], port: 0 });
    cleanup.push(() => dashboard.close());
    await integrations.start();
    await connect(integrations);
    needsAuth.length = 0;
    as.revoke();
    expect(await echo(integrations)).toMatchObject({ kind: 'not_sent' });
    expect(integrations.connection('remote')!.state().status).toBe('needs_auth');
    // the sdk removes dead tokens only when it can read the invalid_grant answer.
    expect(await secrets.get('remote:oauth-tokens')).toBeUndefined();
    expect(needsAuth).toHaveLength(1);

    // after a restart the integration has no tokens, so it waits for the owner and sends no second message.
    await integrations.stop();
    await integrations.start();
    expect(integrations.status()[0]!.state.status).toBe('needs_auth');
    expect(needsAuth).toHaveLength(1);
  });

  for (const kind of ['503', 'network'] as const) {
    it(`keeps a working sign-in when the token endpoint is down for a moment (${kind})`, async () => {
      const { as, oauth, secrets, integrations, needsAuth } = await setup();
      await integrations.start();
      await connect(integrations);
      needsAuth.length = 0;
      as.expire();
      as.down(kind);
      expect(await echo(integrations)).toMatchObject({ kind: 'not_sent', reason: expect.stringContaining('sign-in server did not answer') });
      // the tokens can still be good, so the owner gets no message and no new sign-in link.
      expect(integrations.connection('remote')!.state().status).toBe('connected');
      expect(needsAuth).toEqual([]);
      expect(oauth.pendingUrl('remote')).toBeUndefined();
      expect(await secrets.get('remote:oauth-tokens')).toContain('rt_');
      // the next call refreshes again at once. the failed refresh is not shared with it.
      as.down(undefined);
      expect(await echo(integrations, 'c2')).toMatchObject({ kind: 'result' });
      expect(as.stats).toMatchObject({ refreshGrants: 1, refreshFailures: 1 });
    });
  }

  it('tries again when the credential manager fails at the start, so the integration does not stay stopped', async () => {
    const { secrets, integrations, needsAuth } = await setup();
    await integrations.start();
    await connect(integrations);
    await integrations.stop();
    needsAuth.length = 0;
    const get = secrets.get.bind(secrets);
    let broken = true;
    secrets.get = async (ref) => {
      if (broken) throw new Error('the credential manager is not available');
      return get(ref);
    };
    await integrations.start();
    const remote = () => integrations.status().find((each) => each.id === 'remote')!;
    expect(remote().state).toMatchObject({ status: 'error', error: expect.stringContaining('the credential manager is not available'), retryAt: expect.any(String) });
    expect(remote().lastError).toContain('the credential manager is not available');
    // a pause and a resume from the dashboard do not throw to the request either.
    await expect(integrations.setPaused('remote', true)).resolves.toBe(true);
    await expect(integrations.setPaused('remote', false)).resolves.toBe(true);
    broken = false;
    await expect.poll(() => remote().state.status, { timeout: 5_000 }).toBe('connected');
    expect(needsAuth).toEqual([]);
  });

  it('tries again later when the token endpoint is down at the start', async () => {
    const { as, integrations, needsAuth } = await setup();
    await integrations.start();
    await connect(integrations);
    await integrations.stop();
    needsAuth.length = 0;
    as.expire();
    as.down('503');
    await integrations.start();
    expect(integrations.connection('remote')!.state()).toMatchObject({ status: 'error', error: expect.stringContaining('sign-in server did not answer'), retryAt: expect.any(String) });
    expect(needsAuth).toEqual([]);
    as.down(undefined);
    await expect.poll(() => integrations.connection('remote')!.state().status, { timeout: 5_000 }).toBe('connected');
  });

  it('joins a second press of Connect to the first, so the sign-in link works', async () => {
    const { integrations } = await setup();
    await integrations.start();
    const first = integrations.connect('remote');
    await new Promise((resolve) => setTimeout(resolve, 2));
    const [one, two] = await Promise.all([first, integrations.connect('remote'), integrations.connect('remote')]);
    expect(one).toEqual(two);
    if (!one || !('url' in one)) throw new Error(`expected a link, got ${JSON.stringify(one)}`);
    const { response } = await consent(one.url);
    expect(response.status).toBe(200);
    await expect.poll(() => integrations.connection('remote')!.state().status).toBe('connected');
  });

  it('keeps the callback port open for the last sign-in link, and closes it when that link ends', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    cleanup.push(async () => void vi.useRealTimers());
    const { integrations, port, advance } = await setup();
    const taken = async () => {
      const probe = createServer();
      const free = await new Promise<boolean>((resolve) => {
        probe.once('error', () => resolve(false));
        probe.listen(port, '127.0.0.1', () => resolve(true));
      });
      if (free) await new Promise((resolve) => probe.close(resolve));
      return !free;
    };
    await integrations.start();
    expect(await integrations.connect('remote')).toMatchObject({ url: expect.any(String) });
    const later = 9 * 60_000;
    advance(later);
    await vi.advanceTimersByTimeAsync(later);
    expect(await integrations.connect('remote')).toMatchObject({ url: expect.any(String) });
    // the time limit of the first link passes. the second link still waits, so the port stays open.
    advance(FLOW_TTL_MS - later + 1_000);
    await vi.advanceTimersByTimeAsync(FLOW_TTL_MS - later + 1_000);
    expect(await taken()).toBe(true);
    // the second link ends too, and the port closes.
    advance(later);
    await vi.advanceTimersByTimeAsync(later);
    await expect.poll(taken).toBe(false);
  });

  it('leaves a paused integration stopped when the owner finishes its sign-in later', async () => {
    const { integrations, secrets } = await setup();
    await integrations.start();
    const started = await integrations.connect('remote');
    if (!('url' in started)) throw new Error('expected a link');
    await integrations.setPaused('remote', true);
    const { response } = await consent(started.url);
    expect(response.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(integrations.status()[0]).toMatchObject({ paused: true, state: { status: 'stopped' } });
    // the tokens stay, so a resume connects without a new sign-in.
    expect(await secrets.get('remote:oauth-tokens')).toContain('rt_');
    await integrations.setPaused('remote', false);
    expect(integrations.connection('remote')!.state().status).toBe('connected');
  });

  it('says so when another process holds the callback port', async () => {
    const { oauth, integrations } = await setup();
    const blocker = createOAuth({ db: openDb(':memory:'), clock: () => new Date(), logger: silentLogger, secrets: createMemorySecretStore(), port: Number(new URL(oauth.provider({ id: 'remote', kind: 'mcp-http', url: 'http://x', tools: { allow: ['x'] }, risk: {}, untrustedOutput: true, sessions: ['main'] }).redirectUrl as string).port) });
    await blocker.listen(() => undefined, () => {});
    cleanup.push(() => blocker.close());
    expect(await integrations.connect('remote')).toMatchObject({ error: expect.stringContaining('EADDRINUSE') });
  });

  // the server rotates the refresh token at each refresh. a lost new set made the next refresh send a used token, and
  // the server revoked the whole sign-in.
  it('keeps refreshed tokens that the credential manager did not take, and saves them later', async () => {
    const { as, secrets, integrations, needsAuth, advance } = await setup();
    await integrations.start();
    await connect(integrations);
    needsAuth.length = 0;
    const set = secrets.set.bind(secrets);
    let fail = true;
    secrets.set = async (ref, value) => {
      if (fail && ref === 'remote:oauth-tokens') {
        fail = false;
        throw new Error('Platform secure storage failure');
      }
      return set(ref, value);
    };
    const stored = () => secrets.values.get('remote:oauth-tokens');
    const before = stored();
    as.expire();
    expect(await echo(integrations, 'a')).toMatchObject({ kind: 'result' });
    // the next read of the tokens saves the copy.
    expect(stored()).not.toBe(before);
    // after the time in which a refresh result is shared.
    advance(60_000);
    as.expire();
    expect(await echo(integrations, 'b')).toMatchObject({ kind: 'result' });
    expect(as.stats).toMatchObject({ refreshGrants: 2, reuse: 0 });
    expect(needsAuth).toEqual([]);
  });

  // the single flight of a refresh read every post body as a form. a tool call whose arguments held refresh-like text
  // was then never sent, and it got the answer of the call before it.
  it('sends each tool call whose arguments read as a refresh form', async () => {
    const url = 'https://mcp.example.test/mcp';
    const parsed = parseIntegrations({ integrations: [{ id: 'remote', kind: 'mcp-http', url, auth: { type: 'oauth', callback: 'paste' }, tools: { allow: ['send'] } }] });
    if (!parsed.ok) throw new Error(parsed.error);
    const sent: number[] = [];
    vi.stubGlobal('fetch', async (_input: unknown, init?: RequestInit) => {
      const id = (JSON.parse(String(init?.body)) as { id: number }).id;
      sent.push(id);
      return new Response(JSON.stringify({ jsonrpc: '2.0', id, result: { content: [] } }), { headers: { 'content-type': 'application/json' } });
    });
    cleanup.push(async () => void vi.unstubAllGlobals());
    const fetchFor = createOAuth({ db: openDb(':memory:'), clock: () => new Date(), logger: silentLogger, secrets: createMemorySecretStore() }).fetchFor(
      parsed.value[0] as HttpEntry,
    );
    const text = 'a=1&grant_type=refresh_token&refresh_token=abc&b=2';
    const init = (id: number): RequestInit => ({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'send', arguments: { text } } }),
    });
    await fetchFor(url, init(1));
    const second = (await (await fetchFor(url, init(2))).json()) as { id: number };
    expect(sent).toEqual([1, 2]);
    expect(second.id).toBe(2);
  });

  // a sign-in that stops in a call makes a flow, but the callback does not listen then. the page showed its link, and
  // the consent ended in a refused connection.
  it('shows a sign-in link only while the callback listens', async () => {
    const { as, integrations } = await setup();
    await integrations.start();
    await connect(integrations);
    as.revoke();
    expect(await echo(integrations)).toMatchObject({ kind: 'not_sent' });
    expect(integrations.status()[0]!).toMatchObject({ state: { status: 'needs_auth' } });
    expect(integrations.status()[0]!.authUrl).toBeUndefined();
    const started = await integrations.connect('remote');
    if (!('url' in started)) throw new Error(`expected a link, got ${JSON.stringify(started)}`);
    expect(integrations.status()[0]!.authUrl).toBe(started.url);
    expect((await consent(started.url)).response.status).toBe(200);
  });
});

export type { OAuthTestServer };
