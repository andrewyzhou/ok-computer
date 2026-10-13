import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { OAuthClientMetadata, OAuthClientProvider, OAuthDiscoveryState, StoredOAuthClientInformation, StoredOAuthTokens, Transport } from '@modelcontextprotocol/client';
import type { Db } from '../db/index.js';
import type { Logger } from '../observability/logger.js';
import { registerSecret } from '../observability/redact.js';
import type { Clock } from '../time.js';
import { errorText } from '../tools/registry.js';
import type { HttpEntry } from './config.js';
import type { SecretStore } from './secrets.js';

export const CALLBACK_PORT = 4318;
export const CALLBACK_PATH = '/oauth/callback';
// the owner finishes the consent in a few minutes. an older flow cannot finish, so a stolen link stops working.
export const FLOW_TTL_MS = 10 * 60_000;
// a refresh result stays for this long, so a request that read the old refresh token just before the refresh gets the
// same new tokens instead of a second refresh with a used token.
export const REFRESH_SHARE_MS = 30_000;

interface Flow {
  integrationId: string;
  state: string;
  url: string;
  verifier: string;
  discovery?: OAuthDiscoveryState;
  expiresAt: number;
}

// the sdk calls the provider in a fixed order during one auth(): discovery, state, verifier, redirect. the draft holds
// these values until the redirect, which binds them to the state of the flow.
interface Draft {
  state?: string;
  verifier?: string;
  discovery?: OAuthDiscoveryState;
}

export interface OAuthDeps {
  db: Db;
  clock: Clock;
  logger: Logger;
  secrets: SecretStore;
  port?: number;
}

export interface OAuth {
  provider(entry: HttpEntry): OAuthClientProvider;
  // fetch for the http transport. two refreshes with the same refresh token become one request.
  fetch: typeof fetch;
  // the authorization link of the last flow of an integration that has not ended, for the dashboard.
  pendingUrl(integrationId: string): string | undefined;
  // callback finishes a flow. it is the handler of the loopback server, and tests call it without the server.
  callback(url: URL, finish: (integrationId: string) => Transport | undefined): Promise<{ status: number; integrationId?: string; text: string }>;
  listen(finish: (integrationId: string) => Transport | undefined, onDone: (integrationId: string) => void): Promise<void>;
  close(): Promise<void>;
}

const tokensRef = (id: string) => `${id}:oauth-tokens`;
const clientRef = (id: string) => `${id}:oauth-client`;

export function createOAuth(deps: OAuthDeps): OAuth {
  const { db, clock, logger, secrets } = deps;
  const port = deps.port ?? CALLBACK_PORT;
  const redirectUrl = `http://127.0.0.1:${port}${CALLBACK_PATH}`;
  const flows = new Map<string, Flow>();
  const drafts = new Map<string, Draft>();
  // the flow that finishAuth works on. the callback sets it just before the call.
  const active = new Map<string, Flow>();
  let server: Server | undefined;

  const readJson = async <T>(ref: string): Promise<T | undefined> => {
    const text = await secrets.get(ref);
    return text === undefined ? undefined : (JSON.parse(text) as T);
  };

  const prune = () => {
    const now = clock().getTime();
    for (const [state, flow] of flows) if (flow.expiresAt <= now) flows.delete(state);
  };

  const providerFor = (entry: HttpEntry): OAuthClientProvider => {
    const id = entry.id;
    const draft = () => drafts.get(id) ?? (drafts.set(id, {}), drafts.get(id)!);
    const auth = entry.auth?.type === 'oauth' ? entry.auth : undefined;
    const metadata: OAuthClientMetadata = {
      client_name: 'OK Computer',
      redirect_uris: [redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      ...(auth?.scopes ? { scope: auth.scopes.join(' ') } : {}),
    };
    return {
      get redirectUrl() {
        return redirectUrl;
      },
      get clientMetadata() {
        return metadata;
      },
      state() {
        const state = randomBytes(16).toString('hex');
        draft().state = state;
        return state;
      },
      async clientInformation() {
        // a pre-registered client (for example one slack app per workspace) is a secret that the owner stores once.
        return (await readJson<StoredOAuthClientInformation>(clientRef(id))) ?? (auth?.clientRef ? await readJson(auth.clientRef) : undefined);
      },
      async saveClientInformation(info) {
        await secrets.set(clientRef(id), JSON.stringify(info));
      },
      async tokens() {
        const tokens = await readJson<StoredOAuthTokens>(tokensRef(id));
        // each token is a secret on its own. the redaction of the whole json text would miss a token in a header.
        registerSecret(tokens?.access_token);
        registerSecret(tokens?.refresh_token);
        return tokens;
      },
      async saveTokens(tokens) {
        registerSecret(tokens.access_token);
        registerSecret(tokens.refresh_token);
        await secrets.set(tokensRef(id), JSON.stringify(tokens));
        const now = clock();
        const expires = typeof tokens.expires_in === 'number' ? new Date(now.getTime() + tokens.expires_in * 1000).toISOString() : null;
        db.prepare(
          `INSERT INTO integration_state (integrationId, tokenExpiresAt, authorizedAt, updatedAt) VALUES (?, ?, ?, ?)
           ON CONFLICT (integrationId) DO UPDATE SET tokenExpiresAt = excluded.tokenExpiresAt, authorizedAt = excluded.authorizedAt, updatedAt = excluded.updatedAt`,
        ).run(id, expires, now.toISOString(), now.toISOString());
      },
      // the app never opens a browser by itself. the link waits for the owner on the dashboard, so a failed refresh at
      // night cannot open consent pages again and again.
      redirectToAuthorization(url) {
        const current = draft();
        const state = url.searchParams.get('state');
        drafts.delete(id);
        if (!state || state !== current.state || !current.verifier) {
          logger.error('oauth flow without its state or verifier', { integration: id });
          return;
        }
        prune();
        for (const [key, flow] of flows) if (flow.integrationId === id) flows.delete(key);
        flows.set(state, {
          integrationId: id,
          state,
          url: url.href,
          verifier: current.verifier,
          ...(current.discovery ? { discovery: current.discovery } : {}),
          expiresAt: clock().getTime() + FLOW_TTL_MS,
        });
        logger.info('oauth flow waits for the owner', { integration: id });
      },
      saveCodeVerifier(verifier) {
        draft().verifier = verifier;
      },
      codeVerifier() {
        const verifier = active.get(id)?.verifier ?? drafts.get(id)?.verifier;
        if (!verifier) throw new Error(`no oauth flow of ${id} is waiting`);
        return verifier;
      },
      saveDiscoveryState(state) {
        draft().discovery = state;
      },
      discoveryState() {
        return active.get(id)?.discovery ?? drafts.get(id)?.discovery;
      },
      async invalidateCredentials(scope) {
        if (scope === 'all' || scope === 'tokens') await secrets.delete(tokensRef(id));
        if (scope === 'all' || scope === 'client') await secrets.delete(clientRef(id));
        if (scope === 'all' || scope === 'verifier') drafts.delete(id);
      },
    };
  };

  // the sdk refreshes on each 401, inside each request. two calls that both get a 401 would both use the same refresh
  // token, and a server with rotation refuses the second, or revokes the whole family.
  const shared = new Map<string, { response: Promise<Response>; at: number }>();
  const singleFlight: typeof fetch = async (input, init) => {
    const body = init?.body;
    const params = body instanceof URLSearchParams ? body : typeof body === 'string' ? new URLSearchParams(body) : undefined;
    const token = params?.get('grant_type') === 'refresh_token' ? params.get('refresh_token') : null;
    if (init?.method !== 'POST' || !token) return fetch(input, init);
    const now = clock().getTime();
    for (const [key, each] of shared) if (now - each.at > REFRESH_SHARE_MS) shared.delete(key);
    let entry = shared.get(token);
    if (!entry) {
      entry = { response: fetch(input, init), at: now };
      shared.set(token, entry);
    }
    // each caller reads its own copy. the first response is never read, so it can give more copies.
    return (await entry.response).clone();
  };

  const callback: OAuth['callback'] = async (url, finish) => {
    if (url.pathname !== CALLBACK_PATH) return { status: 404, text: 'not found' };
    prune();
    const state = url.searchParams.get('state') ?? '';
    const flow = flows.get(state);
    // a flow works one time. a second request with the same link, for example a reload, finds nothing.
    flows.delete(state);
    if (!flow) return { status: 400, text: 'This sign-in link is not valid any more. Start again from the dashboard.' };
    const id = flow.integrationId;
    const error = url.searchParams.get('error');
    if (error) {
      logger.warn('oauth flow refused by the server or the owner', { integration: id, error });
      return { status: 400, integrationId: id, text: 'The sign-in did not finish. Start again from the dashboard.' };
    }
    const transport = finish(id) as (Transport & { finishAuth?: (params: URLSearchParams) => Promise<void> }) | undefined;
    if (!transport?.finishAuth) return { status: 500, integrationId: id, text: 'The integration is not ready. Start again from the dashboard.' };
    active.set(id, flow);
    try {
      await transport.finishAuth(url.searchParams);
      logger.info('oauth flow finished', { integration: id });
      return { status: 200, integrationId: id, text: 'Connected. You can close this tab.' };
    } catch (err) {
      logger.error('oauth flow failed', { integration: id, err: errorText(err) });
      return { status: 400, integrationId: id, text: 'The sign-in did not finish. Start again from the dashboard.' };
    } finally {
      active.delete(id);
    }
  };

  return {
    provider: providerFor,
    fetch: singleFlight,
    pendingUrl(id) {
      prune();
      return [...flows.values()].find((flow) => flow.integrationId === id)?.url;
    },
    callback,
    async listen(finish, onDone) {
      if (server) return;
      const next = createServer((req, res) => {
        // the server answers only on loopback, and only with fixed text, so a page cannot read anything from it.
        const host = req.headers.host ?? '';
        if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host) || req.method !== 'GET') {
          res.writeHead(400).end();
          return;
        }
        void callback(new URL(req.url ?? '/', `http://127.0.0.1:${port}`), finish).then(({ status, integrationId, text }) => {
          res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }).end(text);
          if (status === 200 && integrationId) onDone(integrationId);
        });
      });
      await new Promise<void>((resolve, reject) => {
        next.once('error', reject);
        next.listen(port, '127.0.0.1', () => resolve());
      });
      server = next;
    },
    async close() {
      const current = server;
      server = undefined;
      if (current) await new Promise<void>((resolve) => current.close(() => resolve()));
    },
  };
}
