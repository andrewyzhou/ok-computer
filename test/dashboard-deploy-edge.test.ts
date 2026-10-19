import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseConfig } from '../src/config/load.js';
import { createDashboard } from '../src/dashboard/server.js';
import type { GoogleTokenImportResponse, SecretStoreView } from '../src/dashboard/types.js';
import { openDb } from '../src/db/index.js';
import { SCOPES } from '../src/google/config.js';
import { silentLogger } from '../src/observability/logger.js';
import type { SecretsManagerPort } from '../src/secrets/aws.js';
import { createSecretVault, type SecretVault } from '../src/secrets/index.js';
import { CLIENT_ID, CLIENT_SECRET, createGoogleHarness, type GoogleHarness } from './google-harness.js';

// these tests try to break the m7 routes through the dashboard: bad bodies, aliases that are not in the config, a
// token of the wrong account, and secret stores whose errors could carry a ref. docs/PHASE5-API.md (m7) is the
// contract.

const TOKEN = 'dashboard-token-edge';
const DESKTOP = '1//desktop-token-for-the-edge-tests-0123456789';

let h: GoogleHarness | undefined;
const dirs: string[] = [];
afterEach(async () => {
  await h?.close();
  h = undefined;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'okc-deploy-edge-'));
  dirs.push(dir);
  return dir;
};

function dashboard(app: { google?: unknown; secretVault?: SecretVault }) {
  const dir = tempDir();
  const parsed = parseConfig({ paths: { data: dir, workspace: dir } });
  if (!parsed.ok) throw new Error(parsed.error);
  return createDashboard({
    db: h?.db ?? openDb(':memory:'),
    config: parsed.value,
    clock: () => new Date('2026-10-13T16:00:00Z'),
    logger: h?.logger ?? silentLogger,
    app: app as never,
    webDir: dir,
    token: TOKEN,
  });
}

const auth = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };
const post = (server: ReturnType<typeof dashboard>, alias: string, body: unknown) =>
  server.request(`http://127.0.0.1/api/google/accounts/${alias}/token`, {
    method: 'POST',
    headers: auth,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

async function withGoogle(accounts = ['personal']) {
  h = await createGoogleHarness({ accounts });
  for (const alias of accounts) await h.secrets.delete(`google.${alias}`);
  return dashboard({ google: { accounts: h.accounts } });
}

// the log files of the harness, the trace rows and the answers: every place that a failure can write to.
function written(...answers: string[]): string {
  const logs = readdirSync(join(h!.dir, 'logs')).map((name) => readFileSync(join(h!.dir, 'logs', name), 'utf8'));
  return [JSON.stringify(h!.rows('SELECT * FROM google_requests')), ...logs, ...answers].join('\n');
}

const expectNoToken = (text: string) => {
  for (const form of [DESKTOP, encodeURIComponent(DESKTOP)]) expect(text).not.toContain(form);
};

describe('POST /api/google/accounts/:alias/token at its edges', () => {
  it('answers 404 for each alias that is not in the config, before any request to google', async () => {
    const server = await withGoogle();
    for (const alias of ['Personal', 'work', 'personal%20', '..', 'google.client', encodeURIComponent('personal/../school')]) {
      const answer = await post(server, alias, { refreshToken: DESKTOP, clientId: CLIENT_ID });
      expect(answer.status, alias).toBe(404);
      const text = await answer.text();
      expectNoToken(text);
    }
    expect(h!.fake.requests).toEqual([]);
    expect(h!.secrets.values.get('google.client')).toBe(CLIENT_SECRET);
  });

  it('answers 400 for a body of a wrong shape, and never quotes it', async () => {
    const server = await withGoogle();
    const bodies: unknown[] = [
      'null',
      '[]',
      '"just a string"',
      '{"refreshToken":',
      { refreshToken: '', clientId: CLIENT_ID },
      { refreshToken: DESKTOP, clientId: '' },
      { refreshToken: 7, clientId: CLIENT_ID },
      { refreshToken: `${DESKTOP}\n`, clientId: CLIENT_ID },
      { refreshToken: 'x'.repeat(2049), clientId: CLIENT_ID },
      { refreshToken: DESKTOP, clientId: 'c'.repeat(201) },
      { refreshToken: DESKTOP, clientId: CLIENT_ID, scopes: ['all'] },
    ];
    for (const body of bodies) {
      const answer = await post(server, 'personal', body);
      expect(answer.status, JSON.stringify(body).slice(0, 60)).toBe(400);
      const text = await answer.text();
      expectNoToken(text);
      expect(Object.keys(JSON.parse(text))).toEqual(['error']);
    }
    expect(h!.fake.requests).toEqual([]);
    expect(h!.secrets.values.has('google.personal')).toBe(false);
    expectNoToken(written());
  });

  it('answers with exactly the fields of GoogleTokenImportResponse', async () => {
    const server = await withGoogle();
    h!.fake.addAccount('personal', 'Personal@Example.com', DESKTOP);
    const answer = await post(server, 'personal', { refreshToken: DESKTOP, clientId: CLIENT_ID });
    expect(answer.status).toBe(200);
    const body = (await answer.json()) as GoogleTokenImportResponse;
    expect(Object.keys(body).sort()).toEqual(['alias', 'email', 'scopes', 'status', 'storedAt']);
    // the email in the config is lower case, so the check takes the address in any case.
    expect(body.email).toBe('personal@example.com');
    expect(body.status).toBe('ok');
    expect(body.scopes.every((scope) => typeof scope === 'string' && scope.length > 0)).toBe(true);
    expect(new Date(body.storedAt).toISOString()).toBe(body.storedAt);
  });

  it('revokes and answers 422 for a token of another google account, and keeps it out of every log', async () => {
    const server = await withGoogle();
    h!.fake.addAccount('someone', 'someone@example.com', DESKTOP);
    const answer = await post(server, 'personal', { refreshToken: DESKTOP, clientId: CLIENT_ID });
    expect(answer.status).toBe(422);
    const text = await answer.text();
    expect(JSON.parse(text).error).toContain('someone@example.com');
    expect(h!.fake.requests.filter((each) => each.path.startsWith('/revoke'))).toHaveLength(1);
    expect(h!.secrets.values.has('google.personal')).toBe(false);
    expectNoToken(written(text));
  });

  it('revokes and answers 422 for a token without the scopes of the config', async () => {
    const server = await withGoogle();
    h!.fake.addAccount('personal', 'personal@example.com', DESKTOP);
    h!.fake.grant = [SCOPES.readonly];
    const answer = await post(server, 'personal', { refreshToken: DESKTOP, clientId: CLIENT_ID });
    expect(answer.status).toBe(422);
    expect(h!.fake.requests.filter((each) => each.path.startsWith('/revoke'))).toHaveLength(1);
    expect(h!.secrets.values.has('google.personal')).toBe(false);
  });

  it('answers 503 when the store does not take the token, and the account stays signed out', async () => {
    const server = await withGoogle();
    h!.fake.addAccount('personal', 'personal@example.com', DESKTOP);
    h!.secrets.set = async () => {
      throw new Error(`the disk is full while writing ${DESKTOP}`);
    };
    const answer = await post(server, 'personal', { refreshToken: DESKTOP, clientId: CLIENT_ID });
    expect(answer.status).toBe(503);
    const text = await answer.text();
    expectNoToken(written(text));
    expect(h!.rows('SELECT status FROM google_accounts')).toEqual([{ status: 'signed_out' }]);
  });

  it('imports two accounts at the same time, each under its own ref', async () => {
    const server = await withGoogle(['personal', 'school']);
    const school = '1//desktop-token-of-school-0123456789abcdef';
    h!.fake.addAccount('personal', 'personal@example.com', DESKTOP);
    h!.fake.addAccount('school', 'school@example.com', school);
    const [one, two] = await Promise.all([
      post(server, 'personal', { refreshToken: DESKTOP, clientId: CLIENT_ID }),
      post(server, 'school', { refreshToken: school, clientId: CLIENT_ID }),
    ]);
    expect([one.status, two.status]).toEqual([200, 200]);
    expect(h!.secrets.values.get('google.personal')).toBe(DESKTOP);
    expect(h!.secrets.values.get('google.school')).toBe(school);
    expect(h!.rows('SELECT alias, status FROM google_accounts ORDER BY alias')).toEqual([
      { alias: 'personal', status: 'ok' },
      { alias: 'school', status: 'ok' },
    ]);
  });

  it('a second import replaces the token of an account that is already signed in', async () => {
    const server = await withGoogle();
    h!.fake.addAccount('personal', 'personal@example.com', DESKTOP);
    expect((await post(server, 'personal', { refreshToken: DESKTOP, clientId: CLIENT_ID })).status).toBe(200);
    const next = '1//a-newer-desktop-token-0123456789abcdef';
    h!.fake.addAccount('personal', 'personal@example.com', next);
    expect((await post(server, 'personal', { refreshToken: next, clientId: CLIENT_ID })).status).toBe(200);
    expect(h!.secrets.values.get('google.personal')).toBe(next);
  });
});

describe('GET /api/secrets with the real backends', () => {
  const get = async (vault: SecretVault) => {
    h = await createGoogleHarness({ accounts: ['personal'] });
    const answer = await dashboard({ secretVault: vault }).request('http://127.0.0.1/api/secrets', { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(answer.status).toBe(200);
    return answer.text();
  };

  it('shows a file store with its secrets, without a ref or a value', async () => {
    const path = join(tempDir(), 'secrets.json');
    const vault = createSecretVault({ backend: 'file', path });
    await vault.store.set('google.personal', 'file-value-for-the-view-7272');
    await vault.store.set('linear:oauth-tokens', 'file-value-for-the-view-7373');
    const text = await get(vault);
    expect(JSON.parse(text)).toEqual({ backend: 'file', detail: path, ok: true, error: null } satisfies SecretStoreView);
    for (const part of ['google.personal', 'linear', 'file-value-for-the-view']) expect(text).not.toContain(part);
  });

  it('shows an aws store whose errors quote a secret name, without the name', async () => {
    for (const name of ['AccessDeniedException', 'InternalServiceError', 'ThrottlingException', 'DecryptionFailure']) {
      const client = {
        send: async (command: { input: { SecretId?: string } }) => {
          throw Object.assign(new Error(`failed on ${command.input.SecretId} for google.personal`), { name, $metadata: {} });
        },
      } as unknown as SecretsManagerPort;
      const text = await get(createSecretVault({ backend: 'aws', region: 'eu-west-1' }, { awsClient: client }));
      const view = JSON.parse(text) as SecretStoreView;
      expect(view.ok).toBe(false);
      expect(view.backend).toBe('aws');
      for (const part of ['okc.probe', 'google.personal', 'failed on']) expect(text).not.toContain(part);
      await h!.close();
      h = undefined;
    }
  });
});
