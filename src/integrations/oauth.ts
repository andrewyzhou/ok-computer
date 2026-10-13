import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { OAuthClientMetadata, OAuthClientProvider, OAuthDiscoveryState, StoredOAuthClientInformation, StoredOAuthTokens, Transport } from '@modelcontextprotocol/client';
import type { Db } from '../db/index.js';
import type { Logger } from '../observability/logger.js';
import { redact, registerSecret } from '../observability/redact.js';
import type { Clock } from '../time.js';
import { errorText } from '../tools/registry.js';
import type { HttpEntry } from './config.js';
import { CredentialStoreError, type SecretStore } from './secrets.js';

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
  // fetchFor gives the fetch of the http transport of one integration. it logs each sign-in step, and two refreshes
  // with the same refresh token become one request.
  fetchFor(entry: HttpEntry): typeof fetch;
  // the text of the last failed sign-in step of an integration, as the server wrote it. a success clears it.
  serverError(integrationId: string): string | undefined;
  // the reason when the last sign-in step failed because the sign-in server was down: no answer, a 5xx, or the oauth
  // errors server_error and temporarily_unavailable. the tokens are not known to be bad then.
  signInOutage(integrationId: string): string | undefined;
  hasTokens(integrationId: string): Promise<boolean>;
  // closeIfIdle closes the callback port when no flow waits, for example after a connect with working tokens.
  closeIfIdle(): Promise<void>;
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
  const serverErrors = new Map<string, string>();
  const outages = new Map<string, string>();
  let server: Server | undefined;
  let starting: Promise<void> | undefined;
  let closeTimer: NodeJS.Timeout | undefined;

  // the sdk calls the provider inside a request, before the post or after a 401. a failure of the credential manager
  // gets its own type, so the call can say that the tool did not run.
  const vault = async <T>(work: () => Promise<T>): Promise<T> => {
    try {
      return await work();
    } catch (err) {
      throw new CredentialStoreError(`the credential manager failed: ${errorText(err)}`, { cause: err });
    }
  };
  const readJson = async <T>(ref: string): Promise<T | undefined> => {
    const text = await vault(() => secrets.get(ref));
    return text === undefined ? undefined : (JSON.parse(text) as T);
  };
  // new tokens that the credential manager did not take. a server with rotation already spent the old refresh token,
  // so a lost new set would end the sign-in at the next refresh. the provider uses this copy and saves it again at
  // each read, until a save works. a restart before that loses it.
  const unsaved = new Map<string, StoredOAuthTokens>();
  const saveUnsaved = async (id: string) => {
    const tokens = unsaved.get(id);
    if (!tokens) return;
    try {
      await secrets.set(tokensRef(id), JSON.stringify(tokens));
      if (unsaved.get(id) === tokens) unsaved.delete(id);
      logger.info('oauth tokens saved after an earlier failure', { integration: id });
    } catch (err) {
      logger.warn('oauth tokens still not saved', { integration: id, err });
    }
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
        await vault(() => secrets.set(clientRef(id), JSON.stringify(info)));
      },
      async tokens() {
        await saveUnsaved(id);
        const tokens = unsaved.get(id) ?? (await readJson<StoredOAuthTokens>(tokensRef(id)));
        // each token is a secret on its own. the redaction of the whole json text would miss a token in a header.
        registerSecret(tokens?.access_token, `${tokensRef(id)}#access`);
        registerSecret(tokens?.refresh_token, `${tokensRef(id)}#refresh`);
        return tokens;
      },
      async saveTokens(tokens) {
        registerSecret(tokens.access_token, `${tokensRef(id)}#access`);
        registerSecret(tokens.refresh_token, `${tokensRef(id)}#refresh`);
        const before = unsaved.get(id) ?? (await readJson<StoredOAuthTokens>(tokensRef(id)).catch(() => undefined));
        try {
          await secrets.set(tokensRef(id), JSON.stringify(tokens));
          unsaved.delete(id);
        } catch (err) {
          // the new tokens work. a throw here would lose them, and the request with them.
          unsaved.set(id, tokens);
          logger.error('oauth tokens not saved, so the app keeps them in memory and tries again', { integration: id, err });
        }
        // the sdk also saves the stored tokens again to add the issuer. only new tokens from the server are a sign-in,
        // and only they have a new expiry.
        if (before?.access_token === tokens.access_token) return;
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
        // the sdk asks for a new sign-in also when a refresh fails because the sign-in server is down. the stored tokens
        // can still be good then, so the owner gets no new link, and the connection tries again later.
        if (outages.has(id)) {
          logger.warn('oauth sign-in server is down, so no new sign-in link', { integration: id, reason: outages.get(id) });
          return;
        }
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
        armClose();
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
        if (scope === 'all' || scope === 'tokens') {
          unsaved.delete(id);
          await vault(() => secrets.delete(tokensRef(id)));
        }
        if (scope === 'all' || scope === 'client') await vault(() => secrets.delete(clientRef(id)));
        if (scope === 'all' || scope === 'verifier') drafts.delete(id);
      },
    };
  };

  // the sdk refreshes on each 401, inside each request. two calls that both get a 401 would both use the same refresh
  // token, and a server with rotation refuses the second, or revokes the whole family.
  const shared = new Map<string, { response: Promise<Response>; at: number }>();
  const singleFlight =
    (base: typeof fetch): typeof fetch =>
    async (input, init) => {
      const body = init?.body;
      const params = body instanceof URLSearchParams ? body : typeof body === 'string' ? new URLSearchParams(body) : undefined;
      const token = params?.get('grant_type') === 'refresh_token' ? params.get('refresh_token') : null;
      if (init?.method !== 'POST' || !token) return base(input, init);
      const now = clock().getTime();
      for (const [key, each] of shared) if (now - each.at > REFRESH_SHARE_MS) shared.delete(key);
      let entry = shared.get(token);
      if (!entry) {
        const mine = { response: base(input, init), at: now };
        entry = mine;
        shared.set(token, mine);
        // only new tokens are shared. a failed refresh must not answer the next refresh for 30 s, because the next one
        // can work after a short outage.
        const forget = () => {
          if (shared.get(token) === mine) shared.delete(token);
        };
        mine.response.then((response) => !response.ok && forget(), forget);
      }
      // each caller reads its own copy. the first response is never read, so it can give more copies.
      return (await entry.response).clone();
    };

  // the sign-in steps (discovery, registration, token) are not json-rpc, so mcp_messages does not show them. the log
  // gets each step with the integration id, and a failed step keeps the server's text for the owner. the log has no
  // query and no body, because they hold the code, the verifier and the tokens. requests to the mcp endpoint are in
  // mcp_messages already.
  const observed =
    (entry: HttpEntry): typeof fetch =>
    async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const endpoint = new URL(entry.url);
      if (url.origin === endpoint.origin && url.pathname === endpoint.pathname) return fetch(input, init);
      const fields = { integration: entry.id, method: init?.method ?? 'GET', url: `${url.origin}${url.pathname}` };
      const started = performance.now();
      let response: Response;
      try {
        response = await fetch(input, init);
      } catch (err) {
        outages.set(entry.id, `${url.pathname}: ${errorText(err)}`);
        logger.warn('oauth step failed', { ...fields, err });
        throw err;
      }
      const ms = Math.round(performance.now() - started);
      // discovery tries several well-known urls, and a 404 there is normal. a failed post (registration or token) is a
      // failed step.
      if (response.ok || fields.method !== 'POST') {
        logger.info('oauth step', { ...fields, status: response.status, ms });
        // any answer shows that the sign-in server works again. a client that the owner registered makes no post
        // before its link, so a post alone cannot end the outage.
        if (response.ok) outages.delete(entry.id);
        if (response.ok && fields.method === 'POST') serverErrors.delete(entry.id);
        return response;
      }
      const failed = await errorDetail(response.clone());
      const detail = redact(failed.text);
      if (failed.down) outages.set(entry.id, `${url.pathname}: ${detail}`);
      else outages.delete(entry.id);
      serverErrors.set(entry.id, detail);
      logger.warn('oauth step failed', { ...fields, status: response.status, ms, detail });
      // a failed callback does not change the state of the connection, so the page reads the text from here.
      try {
        const now = clock().toISOString();
        db.prepare(
          `INSERT INTO integration_state (integrationId, lastError, lastErrorAt, updatedAt) VALUES (?, ?, ?, ?)
           ON CONFLICT (integrationId) DO UPDATE SET lastError = excluded.lastError, lastErrorAt = excluded.lastErrorAt, updatedAt = excluded.updatedAt`,
        ).run(entry.id, `the sign-in step ${url.pathname} failed. The server said: ${detail}`, now, now);
      } catch (err) {
        logger.error('integration state write failed', { integration: entry.id, err });
      }
      return response;
    };

  // the callback listens only while a flow waits for the owner. the timer closes the port when the last flow ends, so a
  // second connect within the time of the first moves the close to the end of the second.
  const armClose = (until = 0) => {
    clearTimeout(closeTimer);
    if (!server) return;
    const last = Math.max(until, ...[...flows.values()].map((flow) => flow.expiresAt));
    closeTimer = setTimeout(() => void closeWhenIdle(), Math.max(0, last - clock().getTime()) + 1_000);
    closeTimer.unref();
  };
  const closeWhenIdle = async () => {
    prune();
    if (!server) return;
    if (flows.size) {
      armClose();
      return;
    }
    clearTimeout(closeTimer);
    const current = server;
    server = undefined;
    await new Promise<void>((resolve) => current.close(() => resolve()));
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
    fetchFor: (entry) => singleFlight(observed(entry)),
    serverError: (id) => serverErrors.get(id),
    signInOutage: (id) => outages.get(id),
    hasTokens: async (id) => unsaved.has(id) || (await secrets.get(tokensRef(id))) !== undefined,
    closeIfIdle: closeWhenIdle,
    pendingUrl(id) {
      // the sdk also makes a flow when a sign-in stops in a call or a start that the owner did not begin. the callback
      // does not listen then, so its link would end in a refused connection after the consent. the page shows Connect
      // instead, which makes a new flow while the callback listens.
      if (!server) return undefined;
      prune();
      return [...flows.values()].find((flow) => flow.integrationId === id)?.url;
    },
    callback,
    async listen(finish, onDone) {
      if (server) return;
      // two connects at the same time share one start, so the second does not get EADDRINUSE from the first.
      starting ??= start(finish, onDone).finally(() => (starting = undefined));
      return starting;
    },
    async close() {
      clearTimeout(closeTimer);
      const current = server;
      server = undefined;
      if (current) await new Promise<void>((resolve) => current.close(() => resolve()));
    },
  };

  async function start(finish: (integrationId: string) => Transport | undefined, onDone: (integrationId: string) => void) {
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
        void closeWhenIdle();
      });
    });
    await new Promise<void>((resolve, reject) => {
      next.once('error', reject);
      next.listen(port, '127.0.0.1', () => resolve());
    });
    server = next;
    // a flow that the owner never finishes ends after its time limit, and the port closes then too. the flow of this
    // connect comes after the start, so the first limit counts from now.
    armClose(clock().getTime() + FLOW_TTL_MS);
  }
}

// an oauth error answer has error and error_description. other answers give the start of their text. down marks an
// answer that says that the sign-in server cannot work now, and not that the request or the tokens are bad.
async function errorDetail(response: Response): Promise<{ text: string; down: boolean }> {
  const text = (await response.text().catch(() => '')).slice(0, 500);
  let body: { error?: unknown; error_description?: unknown } = {};
  try {
    body = JSON.parse(text) as typeof body;
  } catch {
    // the body is not json. the status and the start of the text say enough.
  }
  const code = typeof body.error === 'string' ? body.error : undefined;
  const down = response.status >= 500 || code === 'server_error' || code === 'temporarily_unavailable';
  if (code !== undefined) return { text: body.error_description ? `${code}: ${String(body.error_description)}` : code, down };
  return { text: `http ${response.status}${text ? `: ${text}` : ''}`, down };
}
