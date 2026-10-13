import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { calendar, type calendar_v3 } from '@googleapis/calendar';
import { gmail, type gmail_v1 } from '@googleapis/gmail';
import { CodeChallengeMethod, OAuth2Client } from 'google-auth-library';
import type { Db } from '../db/index.js';
import type { SecretStore } from '../integrations/secrets.js';
import type { Logger } from '../observability/logger.js';
import { registerSecret } from '../observability/redact.js';
import type { Clock } from '../time.js';
import { requiredScopes, scopeWords, type GoogleConfig } from './config.js';
import { CLIENT_REFUSED, fromSdk, GoogleError, toGoogleError } from './errors.js';
import { requestContext, tracedFetch, type RequestTrace } from './trace.js';

export interface GoogleApis {
  gmail: gmail_v1.Gmail;
  calendar: calendar_v3.Calendar;
}

// tests point these at a local fake. the app uses the google defaults.
export interface GoogleEndpoints {
  apiRoot?: string;
  tokenUrl?: string;
  authUrl?: string;
  revokeUrl?: string;
}

export interface GoogleAccounts {
  aliases: string[];
  // run gives fn the apis of one account. every error becomes a GoogleError. a 401 gets one new access token and one
  // retry. an auth error parks the account until the owner signs in again, so nothing retries a dead token.
  run<T>(alias: string, fn: (apis: GoogleApis) => Promise<T>): Promise<T>;
  // why the account cannot take a call now, or undefined.
  unavailable(alias: string): string | undefined;
  // saveClient stores the oauth client from the json file that google cloud gives for a desktop app.
  saveClient(file: unknown): Promise<{ saved: true } | { error: string }>;
  beginSignIn(alias: string): Promise<{ url: string } | { error: string }>;
  finishSignIn(state: string, code: string): Promise<{ email: string } | { error: string }>;
  close(): Promise<void>;
}

export interface AccountsDeps {
  db: Db;
  clock: Clock;
  logger: Logger;
  secrets: SecretStore;
  config: GoogleConfig;
  // every request of the clients goes through the trace, the token requests too.
  trace: RequestTrace;
  endpoints?: GoogleEndpoints;
  // the owner hears once when a sign-in that worked stops working.
  onNeedsAuth: (alias: string, text: string) => void;
  // called when an account gets a new mailbox, so the sync starts again from nothing.
  onNewMailbox?: (alias: string) => void;
  // tests use a short timeout.
  requestTimeoutMs?: number;
}

const CLIENT_REF = 'google.client';
const tokenRef = (alias: string) => `google.${alias}`;
// a timeout on each request, so a hung connection to google cannot hold a poll or a session queue.
const REQUEST_TIMEOUT_MS = 30_000;
const FLOW_MS = 10 * 60_000;
// a testing-mode consent screen ends each refresh token after 7 days.
const DAY_MS = 24 * 60 * 60_000;

interface Flow {
  alias: string;
  verifier: string;
  redirectUri: string;
  expiresAt: number;
}

export function createGoogleAccounts(deps: AccountsDeps): GoogleAccounts {
  const { db, clock, logger, secrets, config } = deps;
  const endpoints = deps.endpoints ?? {};
  const timeout = deps.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  const aliases = config.accounts.map((each) => each.alias);
  const cached = new Map<string, { auth: OAuth2Client; apis: GoogleApis }>();
  const flows = new Map<string, Flow>();
  let server: Server | undefined;
  let serverUrl: Promise<string> | undefined;

  const now = () => clock().toISOString();
  for (const alias of aliases) {
    db.prepare('INSERT INTO google_accounts (alias, updatedAt) VALUES (?, ?) ON CONFLICT (alias) DO NOTHING').run(alias, now());
  }
  const row = (alias: string) => db.prepare('SELECT * FROM google_accounts WHERE alias = ?').get(alias) as Record<string, string | null> | undefined;

  const clientSecret = async (): Promise<string> => {
    const secret = await secrets.get(CLIENT_REF);
    if (!secret) throw new GoogleError('client', 'the client secret of the google oauth client is not stored. Upload the client file on the Google page.', undefined, false);
    registerSecret(secret, CLIENT_REF);
    return secret;
  };

  const oauthClient = async (redirectUri?: string) =>
    new OAuth2Client({
      clientId: config.clientId,
      clientSecret: await clientSecret(),
      ...(redirectUri ? { redirectUri } : {}),
      // a 401 alone does not prove a dead sign-in: an access token can end early. with this flag the library gets a
      // new token and tries once more, so the answer of the token endpoint decides. invalid_grant is a dead sign-in,
      // and a 5xx is an outage.
      forceRefreshOnFailure: true,
      // the token requests go through this transporter, not through the api clients, so they need their own timeout.
      // without it a token endpoint that never answers holds a poll for about 15 minutes: the 300 s header timeout of
      // node, three times over the retries of the library. the poll owns its retries, so the library makes none.
      transporterOptions: { fetchImplementation: tracedFetch(deps.trace), timeout, retryConfig: { retry: 0, noResponseRetries: 0 } },
      endpoints: {
        ...(endpoints.tokenUrl ? { oauth2TokenUrl: endpoints.tokenUrl } : {}),
        ...(endpoints.authUrl ? { oauth2AuthBaseUrl: endpoints.authUrl } : {}),
        ...(endpoints.revokeUrl ? { oauth2RevokeUrl: endpoints.revokeUrl } : {}),
      },
    });

  // the sdk retries a get three times on a 5xx by default. the poll owns its retries, so the sdk does not.
  const apisFor = (auth: OAuth2Client): GoogleApis => {
    const options = { auth, retry: false, timeout, ...(endpoints.apiRoot ? { rootUrl: endpoints.apiRoot } : {}) };
    return { gmail: gmail({ version: 'v1', ...options }), calendar: calendar({ version: 'v3', ...options }) };
  };

  const clientFor = async (alias: string) => {
    const hit = cached.get(alias);
    if (hit) return hit;
    let refresh: string | undefined;
    try {
      refresh = await secrets.get(tokenRef(alias));
    } catch (err) {
      // the credential manager can fail while its service starts. the request did not leave, and a later poll tries again.
      logger.warn('the credential manager failed for a google account', { alias, err });
      throw new GoogleError('transient', 'the credential manager failed, so the request did not go out', undefined, false);
    }
    if (!refresh) throw new GoogleError('auth', `${alias} is not signed in yet. The owner connects it on the dashboard.`, undefined, false);
    registerSecret(refresh, tokenRef(alias));
    const auth = await oauthClient();
    auth.setCredentials({ refresh_token: refresh });
    // each new access token is a secret too. the source keeps only the newest one in the redactor.
    auth.on('tokens', (tokens) => {
      registerSecret(tokens.access_token ?? undefined, `google:${alias}:access`);
      // google seldom rotates a refresh token. when it does, the new one must be kept, or the next start has none.
      if (tokens.refresh_token && tokens.refresh_token !== refresh) {
        registerSecret(tokens.refresh_token, tokenRef(alias));
        void secrets.set(tokenRef(alias), tokens.refresh_token).catch((err: unknown) => logger.error('a rotated google token was not stored', { alias, err }));
      }
    });
    const client = { auth, apis: apisFor(auth) };
    cached.set(alias, client);
    return client;
  };

  // a refused client stops every account, so the owner gets one message that names the client.
  const parkAll = (err: GoogleError) => {
    cached.clear();
    db.prepare("UPDATE google_accounts SET status = 'needs_auth', lastError = ?, lastErrorAt = ?, updatedAt = ? WHERE status = 'ok'").run(err.message, now(), now());
    const claimed = db.prepare('UPDATE google_accounts SET alertedAt = ? WHERE alertedAt IS NULL AND authorizedAt IS NOT NULL').run(now());
    if (Number(claimed.changes) === 0) return;
    deps.onNeedsAuth('', `Google refused the OAuth client of OK Computer (${err.message}), so no Google account is checked. Check clientId in okc.config.json, then upload the client file again on the Google page.`);
  };

  const park = (alias: string, err: GoogleError) => {
    if (err.kind === 'client') return parkAll(err);
    cached.delete(alias);
    const before = row(alias);
    db.prepare("UPDATE google_accounts SET status = 'needs_auth', lastError = ?, lastErrorAt = ?, updatedAt = ? WHERE alias = ?").run(err.message, now(), now(), alias);
    // only a sign-in that worked can stop working. the compare and set sends the message one time, also over a restart
    // and with a second process.
    if (!before?.authorizedAt) return;
    const claimed = db.prepare('UPDATE google_accounts SET alertedAt = ? WHERE alias = ? AND alertedAt IS NULL').run(now(), alias);
    if (Number(claimed.changes) !== 1) return;
    const age = clock().getTime() - Date.parse(before.authorizedAt);
    const testing = age > 6.5 * DAY_MS && age < 7.5 * DAY_MS ? ' The sign-in is about 7 days old, so the consent screen is probably still in Testing mode; set it to In production.' : '';
    deps.onNeedsAuth(alias, `Google stopped accepting the sign-in of the ${alias} account (${err.message}). Its mail and calendar are not checked until you sign in again on the PC.${testing}`);
  };

  const unavailable = (alias: string): string | undefined => {
    if (!aliases.includes(alias)) return `no google account has the alias ${alias}`;
    const state = row(alias);
    if (state?.status === 'needs_auth') return `the ${alias} google account needs the owner to sign in again on the dashboard.`;
    if (state?.status !== 'ok') return `the ${alias} google account is not signed in yet. The owner connects it on the dashboard.`;
    return undefined;
  };

  const startListener = (): Promise<string> => {
    if (serverUrl) return serverUrl;
    serverUrl = new Promise((resolve, reject) => {
      const listener = createServer((req, res) => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        const loopback = /^(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.host ?? '');
        if (req.method !== 'GET' || !loopback || url.pathname !== '/callback') {
          res.writeHead(404).end();
          return;
        }
        // the listener closes after the reply. a close before it would wait for this open connection for ever.
        const reply = (text: string) => res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', connection: 'close' }).end(text, () => void closeIfIdle());
        const error = url.searchParams.get('error');
        const state = url.searchParams.get('state') ?? '';
        if (error) {
          flows.delete(state);
          reply('The sign-in was cancelled. You can close this tab.');
          return;
        }
        void finishSignIn(state, url.searchParams.get('code') ?? '').then((result) =>
          reply('error' in result ? `The sign-in did not work: ${result.error}` : `Signed in as ${result.email}. You can close this tab.`),
        );
      });
      listener.on('error', reject);
      // a desktop client accepts any loopback port, so the flow never fights the mcp callback for port 4318.
      listener.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(listener.address() as { port: number }).port}/callback`));
      server = listener;
    });
    return serverUrl;
  };

  const closeIfIdle = async () => {
    for (const [state, flow] of flows) if (flow.expiresAt < clock().getTime()) flows.delete(state);
    if (flows.size || !server) return;
    const closing = server;
    server = undefined;
    serverUrl = undefined;
    await new Promise<void>((resolve) => {
      closing.close(() => resolve());
      // a browser keeps a connection open after the reply. it must not hold the close.
      closing.closeIdleConnections();
    });
  };

  // the requests of a sign-in belong to the account, without a run.
  async function finishSignIn(state: string, code: string): Promise<{ email: string } | { error: string }> {
    const alias = flows.get(state)?.alias;
    return alias ? requestContext.run({ account: alias }, () => exchange(state, code)) : exchange(state, code);
  }

  async function exchange(state: string, code: string): Promise<{ email: string } | { error: string }> {
    const flow = flows.get(state);
    // a state works once, so a replayed callback cannot sign in a second time.
    flows.delete(state);
    try {
      if (!flow || flow.expiresAt < clock().getTime()) return { error: 'the sign-in link is unknown or expired. Press Connect again.' };
      const auth = await oauthClient(flow.redirectUri);
      const { tokens } = await auth.getToken({ code, codeVerifier: flow.verifier, redirect_uri: flow.redirectUri });
      registerSecret(tokens.access_token ?? undefined, `google:${flow.alias}:access`);
      registerSecret(tokens.refresh_token ?? undefined, `google:${flow.alias}:new`);
      if (!tokens.refresh_token) return { error: 'google gave no refresh token. Remove the app at myaccount.google.com/permissions, then connect again.' };
      const granted = new Set((tokens.scope ?? '').split(/\s+/));
      const missing = requiredScopes(config).filter((scope) => !granted.has(scope));
      const revoke = () => auth.revokeToken(tokens.refresh_token!).catch((err: unknown) => logger.warn('google token revoke failed', { alias: flow.alias, err: toGoogleError(err) }));
      if (missing.length) {
        await revoke();
        return { error: `Google did not grant: ${scopeWords(missing)}. Nothing was saved. Press Connect again and keep every box checked.` };
      }
      auth.setCredentials(tokens);
      const profile = await apisFor(auth).gmail.users.getProfile({ userId: 'me' });
      const email = String(profile.data.emailAddress ?? '').toLowerCase();
      const expected = config.accounts.find((each) => each.alias === flow.alias)?.email?.toLowerCase();
      if (expected && email !== expected) {
        // the owner signed in with another account in the browser. the token must not stay valid at google either.
        await revoke();
        return { error: `You signed in as ${email}, but ${flow.alias} is ${expected} in the config. Nothing was saved. Press Connect again and pick ${expected}.` };
      }
      const before = row(flow.alias)?.email;
      await secrets.set(tokenRef(flow.alias), tokens.refresh_token);
      cached.delete(flow.alias);
      db.prepare(
        `UPDATE google_accounts SET email = ?, scopes = ?, status = 'ok', authorizedAt = ?, alertedAt = NULL, lastError = NULL, lastErrorAt = NULL, failures = 0, updatedAt = ? WHERE alias = ?`,
      ).run(email, [...granted].join(' '), now(), now(), flow.alias);
      if (before && before !== email) deps.onNewMailbox?.(flow.alias);
      // the gmail baseline is the moment of the sign-in, not the first poll that works. mail that comes between the
      // two is news. a cursor that exists stays, so a sign-in after needs_auth still finds the mail of the outage.
      db.prepare('UPDATE google_accounts SET historyId = COALESCE(historyId, ?) WHERE alias = ?').run(String(profile.data.historyId), flow.alias);
      logger.info('google account signed in', { alias: flow.alias });
      return { email };
    } catch (err) {
      const error = toGoogleError(err);
      logger.warn('google sign-in failed', { alias: flow?.alias, err: error });
      return { error: error.message };
    }
  }

  return {
    aliases,
    unavailable,
    async run(alias, fn) {
      const why = unavailable(alias);
      if (why) throw new GoogleError('auth', why, undefined, false);
      let client: Awaited<ReturnType<typeof clientFor>>;
      try {
        client = await clientFor(alias);
      } catch (err) {
        throw toGoogleError(err);
      }
      try {
        return await requestContext.run({ ...requestContext.getStore(), account: alias }, () => fn(client.apis));
      } catch (err) {
        if (!fromSdk(err)) throw err;
        const error = toGoogleError(err);
        if (error.kind === 'auth' || error.kind === 'client') park(alias, error);
        throw error;
      }
    },
    async saveClient(file) {
      // a web client needs a registered redirect url, and the loopback flow with any port works only for a desktop
      // client. the file of a desktop client has its fields under "installed".
      const installed = (file as { installed?: { client_id?: unknown; client_secret?: unknown } } | null)?.installed;
      if (!installed) {
        return { error: (file as { web?: unknown } | null)?.web ? 'this is a web client. Create an OAuth client of type "Desktop app" instead.' : 'the file has no "installed" client. Upload the JSON file of a "Desktop app" OAuth client.' };
      }
      if (typeof installed.client_id !== 'string' || typeof installed.client_secret !== 'string') return { error: 'the client has no client_id or client_secret.' };
      if (installed.client_id !== config.clientId) return { error: `the file is for the client ${installed.client_id}, but clientId in okc.config.json is ${config.clientId}.` };
      registerSecret(installed.client_secret, CLIENT_REF);
      try {
        await secrets.set(CLIENT_REF, installed.client_secret);
      } catch (err) {
        logger.error('the google client was not stored', { err });
        return { error: 'the credential manager did not take the client.' };
      }
      cached.clear();
      // the accounts that the refused client stopped work again. their refresh tokens are still valid.
      db.prepare("UPDATE google_accounts SET status = 'ok', alertedAt = NULL, lastError = NULL, lastErrorAt = NULL, failures = 0, updatedAt = ? WHERE status = 'needs_auth' AND lastError LIKE ?").run(now(), `${CLIENT_REFUSED}%`);
      return { saved: true };
    },
    async beginSignIn(alias) {
      if (!aliases.includes(alias)) return { error: `no google account has the alias ${alias}` };
      try {
        const redirectUri = await startListener();
        const auth = await oauthClient(redirectUri);
        const { codeVerifier, codeChallenge } = await auth.generateCodeVerifierAsync();
        const state = randomBytes(16).toString('hex');
        flows.set(state, { alias, verifier: codeVerifier, redirectUri, expiresAt: clock().getTime() + FLOW_MS });
        const email = config.accounts.find((each) => each.alias === alias)?.email;
        const url = auth.generateAuthUrl({
          access_type: 'offline',
          // consent makes google send a refresh token each time. without it a second connect gets none.
          prompt: 'consent',
          scope: requiredScopes(config),
          state,
          code_challenge_method: CodeChallengeMethod.S256,
          code_challenge: codeChallenge!,
          ...(email ? { login_hint: email } : {}),
        });
        return { url };
      } catch (err) {
        await closeIfIdle();
        return { error: toGoogleError(err).message };
      }
    },
    finishSignIn,
    async close() {
      flows.clear();
      await closeIfIdle();
    },
  };
}
