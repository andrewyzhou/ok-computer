import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDb } from '../src/db/index.js';
import { parseIntegrations, type IntegrationEntry } from '../src/integrations/config.js';
import { createIntegrations, type Integrations } from '../src/integrations/integrations.js';
import { createOAuth } from '../src/integrations/oauth.js';
import { createMemorySecretStore } from '../src/integrations/secrets.js';
import { createBlobStore } from '../src/observability/blobs.js';
import { createLogger } from '../src/observability/logger.js';
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

async function setup(options: { callback?: 'loopback' | 'paste'; rotation?: boolean; client?: string | null } = {}) {
  let now = Date.parse('2026-10-13T16:00:00Z');
  const clock = () => new Date(now);
  const fake = createSlackFake(() => Math.floor(now / 1000));
  const slack = await startSlackOAuth(fake, { rotation: options.rotation ?? false });
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
        auth: { type: 'oauth', clientRef: 'slack-work-app', scopes: SCOPES, callback: options.callback ?? 'paste' },
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
