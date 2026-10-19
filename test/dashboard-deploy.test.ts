import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseConfig } from '../src/config/load.js';
import { createDashboard } from '../src/dashboard/server.js';
import type { SecretStoreView } from '../src/dashboard/types.js';
import { openDb } from '../src/db/index.js';
import type { GoogleAccounts } from '../src/google/accounts.js';
import { createMemorySecretStore } from '../src/integrations/secrets.js';
import { silentLogger } from '../src/observability/logger.js';
import { registerSecret } from '../src/observability/redact.js';
import type { SecretVault } from '../src/secrets/index.js';
import { CLIENT_ID, createGoogleHarness, type GoogleHarness } from './google-harness.js';

const TOKEN = 'dashboard-token';
const DESKTOP = '1//desktop-sign-in-token-for-the-route-0123456789';

let h: GoogleHarness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

// a vault whose view the test sets. the route only calls view.
function vault(view: SecretStoreView): SecretVault {
  return { backend: view.backend, detail: view.detail, store: createMemorySecretStore(), view: async () => view };
}

function dashboard(app: { google?: { accounts: Pick<GoogleAccounts, 'importToken'> }; secretVault?: SecretVault }) {
  const dir = mkdtempSync(join(tmpdir(), 'okc-deploy-'));
  const parsed = parseConfig({ paths: { data: dir, workspace: dir } });
  if (!parsed.ok) throw new Error(parsed.error);
  return createDashboard({
    db: h?.db ?? openDb(':memory:'),
    config: parsed.value,
    clock: () => new Date('2026-10-13T16:00:00Z'),
    logger: silentLogger,
    app: app as never,
    webDir: dir,
    token: TOKEN,
  });
}

const auth = { authorization: `Bearer ${TOKEN}` };
const importToken = (server: ReturnType<typeof dashboard>, body: unknown, alias = 'personal', headers: Record<string, string> = { ...auth, 'content-type': 'application/json' }) =>
  server.request(`http://127.0.0.1/api/google/accounts/${alias}/token`, { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) });

async function withGoogle() {
  h = await createGoogleHarness({ accounts: ['personal'] });
  await h.secrets.delete('google.personal');
  h.fake.addAccount('personal', 'personal@example.com', DESKTOP);
  return dashboard({ google: { accounts: h.accounts } });
}

describe('POST /api/google/accounts/:alias/token', () => {
  it('needs the token, json and a valid body', async () => {
    const server = await withGoogle();
    expect((await importToken(server, { refreshToken: DESKTOP, clientId: CLIENT_ID }, 'personal', { 'content-type': 'application/json' })).status).toBe(401);
    expect((await importToken(server, `refreshToken=${DESKTOP}`, 'personal', { ...auth, 'content-type': 'application/x-www-form-urlencoded' })).status).toBe(415);
    const bad = { error: 'send {"refreshToken": "...", "clientId": "..."} as json' };
    for (const body of ['not json', { refreshToken: DESKTOP }, { refreshToken: 'two words', clientId: CLIENT_ID }, { refreshToken: DESKTOP, clientId: CLIENT_ID, extra: 1 }]) {
      const answer = await importToken(server, body);
      expect(answer.status).toBe(400);
      expect(await answer.json()).toEqual(bad);
    }
    expect(h!.fake.requests).toEqual([]);
  });

  it('imports the token and answers with the account, never with the token', async () => {
    const server = await withGoogle();
    const answer = await importToken(server, { refreshToken: DESKTOP, clientId: CLIENT_ID });
    expect(answer.status).toBe(200);
    const text = await answer.text();
    expect(JSON.parse(text)).toEqual({ alias: 'personal', email: 'personal@example.com', status: 'ok', scopes: expect.arrayContaining([expect.stringContaining('gmail')]), storedAt: '2026-10-13T16:00:00.000Z' });
    expect(text).not.toContain(DESKTOP);
    expect(h!.secrets.values.get('google.personal')).toBe(DESKTOP);
  });

  it('passes an error of the import through', async () => {
    const server = await withGoogle();
    h!.fake.revoke(DESKTOP);
    const refused = await importToken(server, { refreshToken: DESKTOP, clientId: CLIENT_ID });
    expect(refused.status).toBe(422);
    const text = await refused.text();
    expect(JSON.parse(text)).toEqual({ error: expect.stringMatching(/^google refused the token: /) });
    expect(text).not.toContain(DESKTOP);

    const unknown = await importToken(server, { refreshToken: DESKTOP, clientId: CLIENT_ID }, 'work');
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({ error: 'google account not found' });
    const other = await importToken(server, { refreshToken: DESKTOP, clientId: 'other.apps.googleusercontent.com' });
    expect(other.status).toBe(409);
  });

  it('redacts the error text, and answers 500 for a throw', async () => {
    // an import that quotes the token in its error. the route registers nothing, so this checks redact() on the text.
    registerSecret(DESKTOP, 'test:desktop');
    const quoting = dashboard({ google: { accounts: { importToken: async () => ({ ok: false, status: 503, error: `the store refused ${DESKTOP}` }) } } });
    const answer = await importToken(quoting, { refreshToken: DESKTOP, clientId: CLIENT_ID });
    expect(answer.status).toBe(503);
    expect(await answer.text()).not.toContain(DESKTOP);

    const throwing = dashboard({
      google: {
        accounts: {
          importToken: async () => {
            throw new Error(`a bug with ${DESKTOP}`);
          },
        },
      },
    });
    const failed = await importToken(throwing, { refreshToken: DESKTOP, clientId: CLIENT_ID });
    expect(failed.status).toBe(500);
    expect(await failed.json()).toEqual({ error: 'the token import failed' });
  });

  it('answers 404 without google', async () => {
    const answer = await importToken(dashboard({}), { refreshToken: DESKTOP, clientId: CLIENT_ID });
    expect(answer.status).toBe(404);
    expect(await answer.json()).toEqual({ error: 'google account not found' });
  });
});

describe('GET /api/secrets', () => {
  it('shows the backend and the state of the store', async () => {
    const up: SecretStoreView = { backend: 'aws', detail: 'us-west-2, okc/', ok: true, error: null };
    const view = await dashboard({ secretVault: vault(up) }).request('http://127.0.0.1/api/secrets', { headers: auth });
    expect(view.status).toBe(200);
    expect(await view.json()).toEqual(up);

    // a store that does not answer is still a 200, because the view carries the state.
    const down: SecretStoreView = { backend: 'file', detail: '/srv/okc/secrets.json', ok: false, error: 'the secret file cannot be read.' };
    const failed = await dashboard({ secretVault: vault(down) }).request('http://127.0.0.1/api/secrets', { headers: auth });
    expect(failed.status).toBe(200);
    expect(await failed.json()).toEqual(down);
  });

  it('needs the token, and answers 503 without a vault', async () => {
    const server = dashboard({});
    expect((await server.request('http://127.0.0.1/api/secrets')).status).toBe(401);
    const answer = await server.request('http://127.0.0.1/api/secrets', { headers: auth });
    expect(answer.status).toBe(503);
    expect(await answer.json()).toEqual({ error: 'the secret store is not set up' });
  });
});
