import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { OAuthClientMetadata, OAuthClientProvider, OAuthDiscoveryState, StoredOAuthClientInformation, StoredOAuthTokens, Transport } from '@modelcontextprotocol/client';
import type { Db } from '../db/index.js';
import type { Logger } from '../observability/logger.js';
import { redact, registerSecret } from '../observability/redact.js';
import type { Clock } from '../time.js';
import { errorText } from '../tools/registry.js';
import type { HttpEntry } from './config.js';
import { normalizeTokenErrors } from './oauth-errors.js';
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
  // the configured scopes that the server did not grant at the code grant of this flow.
  missing?: string[];
}

// the stored tokens also keep the scopes that the app asked for at the last sign-in. a server can grant fewer scopes
// than it was asked for, so the scopes of the token cannot show if the config changed after the sign-in.
type Tokens = StoredOAuthTokens & { requested?: string };

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
  // the redirect url of an integration, which the owner gives the oauth app of a pre-registered client.
  redirectUrl(entry: HttpEntry): string;
  // fetchFor gives the fetch of the http transport of one integration. it logs each sign-in step, and two refreshes
  // with the same refresh token become one request.
  fetchFor(entry: HttpEntry): typeof fetch;
  // the text of the last failed sign-in step of an integration, as the server wrote it. a success clears it.
  serverError(integrationId: string): string | undefined;
  // the reason when the last sign-in step failed because the sign-in server was down: no answer, a 5xx, or the oauth
  // errors server_error and temporarily_unavailable. the tokens are not known to be bad then.
  signInOutage(integrationId: string): string | undefined;
  hasTokens(integrationId: string): Promise<boolean>;
  // the configured scopes that the stored token of an integration does not hold, as of the last read or save of the
  // token. the server did not grant them, so tools that need them fail with missing_scope.
  withheld(integrationId: string): string[];
  // while the owner presses Connect, a stored token that lacks a configured scope is not used, so the sdk starts a new
  // sign-in. an admin can allow a scope after the sign-in, and the owner has no other way to get it.
  askAgain(integrationId: string, on: boolean): void;
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
  // with paste nothing answers with tls on the address. the browser shows an error page, and the owner pastes its
  // address on the dashboard.
  const redirectFor = (entry: HttpEntry) =>
    `${entry.auth?.type === 'oauth' && entry.auth.callback === 'paste' ? 'https' : 'http'}://127.0.0.1:${port}${CALLBACK_PATH}`;
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
    if (text === undefined) return undefined;
    try {
      return JSON.parse(text) as T;
    } catch {
      // the message of JSON.parse can quote the value, and the value is a secret. a terminal also drops the quotes of
      // json that it gives to cmdkey, so this is the usual result of a client that the owner stored with cmdkey.
      throw new CredentialStoreError(`the secret ${ref} in the credential manager is not valid json`);
    }
  };
  // the issuer that the sdk adds to a pre-registered client. the client itself is never copied, so a new client that
  // the owner stores under clientRef takes effect at the next sign-in.
  const issuers = new Map<string, { clientId: string; issuer: string }>();
  // new tokens that the credential manager did not take. a server with rotation already spent the old refresh token,
  // so a lost new set would end the sign-in at the next refresh. the provider uses this copy and saves it again at
  // each read, until a save works. a restart before that loses it.
  const unsaved = new Map<string, Tokens>();
  // the last known record of the asked scopes. a refresh keeps the record from the stored tokens, and a failed read of
  // them would otherwise save the new tokens without it. a server that granted fewer scopes would then make the next
  // read refuse the new, working token.
  const requestedById = new Map<string, string>();
  const withheldById = new Map<string, string[]>();
  const askingAgain = new Set<string>();
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
    // slack writes a scope list with commas, and the record of a sign-in is split on commas and spaces. a config entry
    // that holds a list must thus be split the same way, or it can never match the record.
    const scopes = auth?.scopes?.flatMap((scope) => scope.split(/[\s,]+/)).filter(Boolean);
    const redirectUrl = redirectFor(entry);
    // the record of the withheld scopes is kept apart from lastError, because the next error overwrites lastError.
    const notGranted = (tokens: Tokens | undefined): string[] => {
      if (!tokens?.scope || !scopes) {
        withheldById.delete(id);
        return [];
      }
      const granted = new Set(tokens.scope.split(/[\s,]+/));
      const missing = scopes.filter((scope) => !granted.has(scope));
      withheldById.set(id, missing);
      return missing;
    };
    const metadata: OAuthClientMetadata = {
      client_name: 'OK Computer',
      redirect_uris: [redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      ...(scopes ? { scope: scopes.join(' ') } : {}),
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
        if (!auth?.clientRef) return readJson<StoredOAuthClientInformation>(clientRef(id));
        // a pre-registered client (for example one slack app per workspace) is a secret that the owner stores.
        const client = await readJson<StoredOAuthClientInformation>(auth.clientRef);
        // the secret goes in each token request, and a server can quote it in an error.
        registerSecret(client?.client_secret, `${auth.clientRef}#secret`);
        const stamp = issuers.get(id);
        return client && stamp?.clientId === client.client_id ? { ...client, issuer: stamp.issuer } : client;
      },
      async saveClientInformation(info) {
        // the sdk saves a pre-registered client again only to add the issuer. a copy under another name would hide a
        // new client that the owner stores later.
        if (auth?.clientRef) {
          if (info.issuer) issuers.set(id, { clientId: info.client_id, issuer: info.issuer });
          return;
        }
        await vault(() => secrets.set(clientRef(id), JSON.stringify(info)));
      },
      async tokens() {
        await saveUnsaved(id);
        const tokens = unsaved.get(id) ?? (await readJson<Tokens>(tokensRef(id)));
        // each token is a secret on its own. the redaction of the whole json text would miss a token in a header.
        registerSecret(tokens?.access_token, `${tokensRef(id)}#access`);
        registerSecret(tokens?.refresh_token, `${tokensRef(id)}#refresh`);
        // the owner can add a scope to the config after a sign-in. a token that never expires would then hold the old
        // scopes for ever, so a configured scope that the last sign-in did not ask for makes the sdk start a new
        // sign-in. the check uses the scopes that the app asked for, not the granted ones: a server can grant fewer,
        // and a new sign-in would then end with a token that the app refuses again. a token from before this record
        // uses the scopes that it names. a token without either is kept, because the app cannot know what it holds.
        if (tokens?.requested !== undefined) requestedById.set(id, tokens.requested);
        const record = tokens?.requested ?? tokens?.scope;
        const asked = record ? new Set(record.split(/[\s,]+/)) : undefined;
        const missing = scopes?.filter((scope) => !asked?.has(scope)) ?? [];
        if (asked && missing.length) {
          logger.warn('a configured scope is new since the last sign-in, so a new sign-in starts', { integration: id, missing });
          return undefined;
        }
        const withheld = notGranted(tokens);
        // only a connect that the owner starts asks again. a start or a call by itself keeps the smaller grant, or each
        // start would make a new sign-in link while the admin still does not allow the scope.
        if (withheld.length && askingAgain.has(id)) {
          logger.warn('the stored token lacks a configured scope, so the connect of the owner starts a new sign-in', { integration: id, withheld });
          return undefined;
        }
        return tokens;
      },
      async saveTokens(given) {
        registerSecret(given.access_token, `${tokensRef(id)}#access`);
        registerSecret(given.refresh_token, `${tokensRef(id)}#refresh`);
        const before = unsaved.get(id) ?? (await readJson<Tokens>(tokensRef(id)).catch(() => undefined));
        // a code comes only through the callback, which marks its flow as active. a refresh keeps the record of the
        // sign-in before it.
        const flow = active.get(id);
        const requested = flow ? scopes?.join(' ') : (before?.requested ?? requestedById.get(id));
        if (requested !== undefined) requestedById.set(id, requested);
        // oauth lets a refresh answer leave out the scope when it does not change. without the granted scopes, the record
        // of the withheld scopes would go, and Connect would then never ask again for a scope that the admin allows later.
        const scope = given.scope ?? (flow ? undefined : before?.scope);
        const kept: Tokens = scope === undefined ? given : { ...given, scope };
        const tokens: Tokens = requested === undefined ? kept : { ...kept, requested };
        const missing = notGranted(tokens);
        if (flow && missing.length) flow.missing = missing;
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
        // the sdk asks for every scope that the metadata of the server offers. the configured scopes win, so the app
        // gets only the access that the owner names, and an app that lacks one of the offered scopes still works.
        if (scopes) url.searchParams.set('scope', scopes.join(' '));
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
          withheldById.delete(id);
          await vault(() => secrets.delete(tokensRef(id)));
        }
        if (scope === 'all' || scope === 'client') {
          issuers.delete(id);
          await vault(() => secrets.delete(clientRef(id)));
        }
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
      // only a form body can be a refresh. a json-rpc call to the mcp endpoint is a string too, and the arguments of a
      // tool call can hold any text, also text that reads as a refresh.
      const form = /application\/x-www-form-urlencoded/i.test(new Headers(init?.headers).get('content-type') ?? '');
      const params = body instanceof URLSearchParams ? body : typeof body === 'string' && form ? new URLSearchParams(body) : undefined;
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
        response = await normalizeTokenErrors(fetch)(input, init);
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
    // a token endpoint that quotes its form body in an error puts the code and the verifier in lastError and the log.
    registerSecret(url.searchParams.get('code') ?? undefined, `${id}:code`);
    registerSecret(flow.verifier, `${id}:verifier`);
    active.set(id, flow);
    try {
      await transport.finishAuth(url.searchParams);
      logger.info('oauth flow finished', { integration: id });
      if (!flow.missing) return { status: 200, integrationId: id, text: 'Connected. You can close this tab.' };
      // the token works, so the connection starts. the owner must still know which tools can fail, also later on the
      // dashboard.
      const text = `Connected, but the server did not grant these scopes: ${flow.missing.join(', ')}. Tools that need them fail with missing_scope.`;
      logger.warn('oauth sign-in got fewer scopes than configured', { integration: id, missing: flow.missing });
      try {
        const now = clock().toISOString();
        db.prepare(
          `INSERT INTO integration_state (integrationId, lastError, lastErrorAt, updatedAt) VALUES (?, ?, ?, ?)
           ON CONFLICT (integrationId) DO UPDATE SET lastError = excluded.lastError, lastErrorAt = excluded.lastErrorAt, updatedAt = excluded.updatedAt`,
        ).run(id, text, now, now);
      } catch (err) {
        logger.error('integration state write failed', { integration: id, err });
      }
      return { status: 200, integrationId: id, text };
    } catch (err) {
      logger.error('oauth flow failed', { integration: id, err: errorText(err) });
      return { status: 400, integrationId: id, text: 'The sign-in did not finish. Start again from the dashboard.' };
    } finally {
      active.delete(id);
    }
  };

  return {
    provider: providerFor,
    redirectUrl: redirectFor,
    fetchFor: (entry) => singleFlight(observed(entry)),
    serverError: (id) => serverErrors.get(id),
    signInOutage: (id) => outages.get(id),
    hasTokens: async (id) => unsaved.has(id) || (await secrets.get(tokensRef(id))) !== undefined,
    withheld: (id) => withheldById.get(id) ?? [],
    askAgain(id, on) {
      if (on) askingAgain.add(id);
      else askingAgain.delete(id);
    },
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
