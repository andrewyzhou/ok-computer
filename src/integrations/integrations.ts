import type { Transport } from '@modelcontextprotocol/client';
import { z } from 'zod';
import type { Db } from '../db/index.js';
import type { BlobStore } from '../observability/blobs.js';
import type { Logger } from '../observability/logger.js';
import type { SetTimer } from '../scheduler/scheduler.js';
import { localTime, type Clock } from '../time.js';
import { errorText, TOOL_CALL, type Explanation, type Tool } from '../tools/registry.js';
import { redact, redactValue, registerSecret } from '../observability/redact.js';
import type { Risk } from '../policy/policy.js';
import { createCatalogStore, riskFrom, riskOf, type Catalog, type CatalogTool } from './catalog.js';
import { sessionProfile, type IntegrationEntry } from './config.js';
import type { OAuth } from './oauth.js';
import { createDiscoveryTools, outcomeOutput, TOOL_SEARCH, type Discoverable } from './discovery.js';
import { createMcpConnection, type ConnectionState, type McpConnection } from './mcp.js';
import { integrationOf, toolName } from './names.js';
import type { SecretStore } from './secrets.js';
import { httpTransport, stdioTransport } from './transports.js';

export interface IntegrationsDeps {
  db: Db;
  blobs: BlobStore;
  logger: Logger;
  clock: Clock;
  entries: IntegrationEntry[];
  secrets: SecretStore;
  // tests give an in-memory transport. the app uses stdio and http.
  transport?: (entry: IntegrationEntry) => Promise<Transport>;
  oauth?: OAuth;
  // the owner gets a message when a sign-in that worked stops working, for example after a revoked refresh token. it
  // gets the text of the server, when the failed sign-in step had one.
  onNeedsAuth?: (integrationId: string, serverText: string | undefined) => void;
  setTimer?: SetTimer;
  // false in a process that never connects (npm run chat). two processes would start each server twice and could
  // refresh the same oauth token at once, which a server with rotation punishes.
  connects?: boolean;
}

export interface IntegrationStatus {
  id: string;
  kind: IntegrationEntry['kind'];
  // the pinned command or the url. a secret in it is redacted.
  target: string;
  sessions: string[];
  untrustedOutput: boolean;
  state: ConnectionState;
  paused: boolean;
  auth: 'none' | 'bearer' | 'oauth';
  authorizedAt: string | null;
  tokenExpiresAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
  // the sign-in link that waits for the owner.
  authUrl?: string;
  // the redirect url that the owner gives the oauth app, and the credential name of a pre-registered client. paste
  // means that the owner finishes the sign-in with the address of the failed callback page.
  oauthApp?: { redirectUrl: string; callback: 'loopback' | 'paste'; clientRef?: string };
  catalogHash?: string;
  // stored means that the tool list is the one from the database, and the server has not answered since the start.
  catalogStored?: boolean;
  tools: Array<{ name: string; mcpName: string; description: string; risk: Risk; riskFrom: string; inputSchema: Record<string, unknown> }>;
  rejected: Array<{ mcpName: string; reason: string }>;
  // missing: tools.allow names them, and the last tool list does not have them. hidden: the server has them, and
  // tools.allow does not name them. unknown: tools.allow names them, and no tool list was seen since then.
  missing: string[];
  hidden: string[];
  unknown: string[];
}

export interface Integrations {
  // tool_search and tool_call. without integrations the list is empty, and the tools parameter does not change.
  tools: Tool[];
  // the integration tool with this name, for the registry. it reads the current catalog and config at each call, so a
  // session whose profile lost the integration does not find the tool.
  find(name: string, sessionKey: string): Tool | undefined;
  // why find has no tool for a name that the config allows, when the reason is the state of its integration: the
  // server has not sent a tool list yet. undefined for every other name.
  explain(name: string, sessionKey: string): Explanation | undefined;
  // the tool names that a session may use: the discovery pair, and every allowed tool of its integrations. this
  // depends only on the config, so a new catalog never changes it.
  allowedNames(sessionKey: string): string[];
  start(): Promise<void>;
  stop(): Promise<void>;
  status(): IntegrationStatus[];
  connection(id: string): McpConnection | undefined;
  // connect starts a new attempt from the dashboard, and resumes a paused integration. for an oauth integration it
  // gives the sign-in link for the owner, or connected when the stored tokens still work.
  connect(id: string): Promise<{ connected: true } | { url: string } | { error: string }>;
  // a paused integration stays stopped over a restart. its tools stay in the catalog, and a call says that it is paused.
  setPaused(id: string, paused: boolean): Promise<boolean>;
  // finishSignIn takes the address of the callback page that the owner pasted, for a server that accepts only an https
  // redirect. the state in the address selects the flow, as in the loopback callback.
  finishSignIn(pasted: string): Promise<{ ok: boolean; text: string }>;
  // storeClient saves a pre-registered oauth client (for example a slack app) under the clientRef of its entry. the app
  // writes the json itself, because a terminal drops the quotes of json that it gives to cmdkey.
  storeClient(id: string, client: { client_id: string; client_secret?: string }): Promise<{ stored: true } | { error: string }>;
}

export function createIntegrations(deps: IntegrationsDeps): Integrations {
  const { entries, logger } = deps;
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const catalogs = createCatalogStore({ db: deps.db, clock: deps.clock, logger, entries });
  const connections = new Map<string, McpConnection>();
  const states = new Map<string, ConnectionState>();
  // an oauth integration without tokens waits for the owner and makes no request. an attempt would register a client
  // and make a sign-in link that nobody opens, at each start.
  const parked = new Map<string, ConnectionState>();
  // a sign-in that the owner starts from the dashboard can end in needs_auth too. the owner needs no message then.
  const authorizing = new Set<string>();
  const connecting = new Map<string, Promise<{ connected: true } | { url: string } | { error: string }>>();
  const stateOf = (id: string): ConnectionState => parked.get(id) ?? states.get(id) ?? { status: 'stopped' };
  const paused = new Set(
    deps.db
      .prepare('SELECT integrationId FROM integration_state WHERE paused = 1')
      .all()
      .map((row) => String(row.integrationId)),
  );

  // the text says why an integration cannot take a call now, and whether a retry can help. the model can then tell the
  // owner what to do. undefined means that it is connected. without a time zone the text gives no time.
  const unavailable = (id: string, timeZone?: string): string | undefined => {
    if (deps.connects === false) return `the ${id} integration runs only in the background app, not in this chat process.`;
    if (paused.has(id)) return `the owner paused the ${id} integration.`;
    const state = stateOf(id);
    switch (state.status) {
      case 'connected':
        return undefined;
      case 'connecting':
        return `${id} is not connected yet. The app connects it now; try again in a moment.`;
      case 'error':
        return `${id} is not connected: ${state.error ?? 'unknown error'}.${state.retryAt && timeZone ? ` The app tries again at ${localTime(new Date(state.retryAt), timeZone)}.` : ''}`;
      case 'needs_auth':
        return parked.has(id)
          ? `${id} is not signed in yet. The owner connects it on the dashboard.`
          : `${id} needs the owner to sign in again on the dashboard.`;
      case 'stopped':
        return `${id} is stopped.`;
    }
  };
  // a tool object depends on the catalog version, so a new version gives new objects with new validators.
  const built = new Map<string, { hash: string; tool: Tool }>();

  const transportFor = async (entry: IntegrationEntry): Promise<Transport> => {
    if (deps.transport) return deps.transport(entry);
    if (entry.kind === 'mcp-stdio') return stdioTransport(entry, deps.secrets, logger);
    return httpTransport(entry, deps.secrets, deps.oauth);
  };

  const saveState = (id: string, state: ConnectionState) => {
    const before = states.get(id)?.status;
    states.set(id, state);
    if (state.status !== 'error' && state.status !== 'needs_auth') return;
    const said = state.status === 'needs_auth' ? deps.oauth?.serverError(id) : undefined;
    let authorizedAt: unknown;
    try {
      const now = deps.clock().toISOString();
      deps.db
        .prepare(
          `INSERT INTO integration_state (integrationId, lastError, lastErrorAt, updatedAt) VALUES (?, ?, ?, ?)
           ON CONFLICT (integrationId) DO UPDATE SET lastError = excluded.lastError, lastErrorAt = excluded.lastErrorAt, updatedAt = excluded.updatedAt`,
        )
        .run(id, `${state.error ?? state.status}${said ? ` The server said: ${said}` : ''}`, now, now);
      authorizedAt = deps.db.prepare('SELECT authorizedAt FROM integration_state WHERE integrationId = ?').get(id)?.authorizedAt;
    } catch (err) {
      logger.error('integration state write failed', { integration: id, err });
    }
    // the owner hears once when a sign-in that worked stops working. a first sign-in and a crash loop send nothing:
    // the owner just added the first, and the app retries the second by itself.
    if (state.status === 'needs_auth' && before !== 'needs_auth' && authorizedAt && !authorizing.has(id)) deps.onNeedsAuth?.(id, said);
  };

  const writePaused = (id: string, pause: boolean) => {
    deps.db
      .prepare(
        `INSERT INTO integration_state (integrationId, paused, updatedAt) VALUES (?, ?, ?)
         ON CONFLICT (integrationId) DO UPDATE SET paused = excluded.paused, updatedAt = excluded.updatedAt`,
      )
      .run(id, pause ? 1 : 0, deps.clock().toISOString());
    if (pause) paused.add(id);
    else paused.delete(id);
  };

  // begin connects an integration, or parks an oauth integration that has no tokens.
  const begin = async (entry: IntegrationEntry, connection: McpConnection) => {
    if (entry.kind === 'mcp-http' && entry.auth?.type === 'oauth' && deps.oauth) {
      let signedIn = true;
      try {
        signedIn = await deps.oauth.hasTokens(entry.id);
      } catch (err) {
        // the credential manager can fail, for example while its service starts. the connection reads the tokens
        // again, and its retry gives the owner the error and tries again later.
        logger.warn('the credential manager failed before an oauth integration started', { integration: entry.id, err });
      }
      if (!signedIn) {
        parked.set(entry.id, { status: 'needs_auth', error: 'it is not signed in yet. connect it from the dashboard.' });
        return;
      }
    }
    parked.delete(entry.id);
    await connection.start();
  };

  const transportOf = (integrationId: string) => connections.get(integrationId)?.transport();
  // the owner can pause the integration while the sign-in page is open. the tokens stay, and the connection starts when
  // the owner resumes it.
  const signedIn = (integrationId: string) => {
    if (paused.has(integrationId)) return;
    const done = connections.get(integrationId);
    void done?.stop().then(() => done.start()).catch((err: unknown) => logger.error('mcp restart after sign-in failed', { integration: integrationId, err }));
  };

  for (const entry of entries) {
    if (entry.kind !== 'mcp-stdio' && entry.kind !== 'mcp-http') continue;
    connections.set(
      entry.id,
      createMcpConnection({
        id: entry.id,
        db: deps.db,
        blobs: deps.blobs,
        logger,
        clock: deps.clock,
        transport: () => transportFor(entry),
        onTools: (listed) => {
          try {
            catalogs.update(entry, listed);
          } catch (err) {
            logger.error('mcp catalog update failed', { integration: entry.id, err });
          }
        },
        onState: (state) => saveState(entry.id, state),
        ...(deps.setTimer ? { setTimer: deps.setTimer } : {}),
        ...(entry.kind === 'mcp-http' && entry.auth?.type === 'oauth' && deps.oauth ? { signInOutage: () => deps.oauth?.signInOutage(entry.id) } : {}),
        ...(entry.kind === 'mcp-http' && entry.auth?.type === 'bearer'
          ? { refusedKeyHint: `Update the secret ${entry.auth.secretRef} in the credential manager with cmdkey, then press Connect.` }
          : {}),
      }),
    );
  }

  const visibleTo = (sessionKey: string) => {
    const profile = sessionProfile(sessionKey);
    return entries.filter((entry) => entry.sessions.includes(profile));
  };

  const toolFor = (entry: IntegrationEntry, catalog: Catalog, item: CatalogTool): Tool => {
    const validate = catalog.validators.get(item.name)!;
    const connection = connections.get(entry.id)!;
    return {
      name: item.name,
      description: item.description,
      // the schema check runs in the registry, like the zod check of a built-in tool, so a bad input never reaches the
      // policy or the server.
      input: z.record(z.string(), z.unknown()).superRefine((value, ctx) => {
        const checked = validate(value);
        if (!checked.ok) ctx.addIssue({ code: 'custom', message: checked.message });
      }),
      risk: riskOf(entry, item),
      ...(entry.untrustedOutput ? { untrustedOutput: `mcp:${entry.id}` } : {}),
      source: 'mcp',
      serverId: entry.id,
      async run(input, ctx) {
        // a call does not wait for a server that is not connected. a wait would hold the session queue, and the tool
        // did not run, so the model can safely try again.
        const why = unavailable(entry.id, ctx.timeZone);
        if (why) return { content: `${item.name} did not run: ${why}`, isError: true, effect: 'none' };
        const outcome = await connection.callTool(item.mcpName, input as Record<string, unknown>, { runId: ctx.runId, toolCallId: ctx.toolCallId ?? '' });
        return outcomeOutput(item.name, entry.id, outcome);
      },
    };
  };

  const find = (name: string, sessionKey: string): Tool | undefined => {
    const id = integrationOf(name);
    const entry = id === undefined ? undefined : byId.get(id);
    const catalog = id === undefined ? undefined : catalogs.get(id);
    if (!entry || !catalog || !entry.sessions.includes(sessionProfile(sessionKey))) return undefined;
    const item = catalog.snapshot.tools.find((each) => each.name === name);
    if (!item) return undefined;
    const cached = built.get(name);
    if (cached?.hash === catalog.hash) return cached.tool;
    const tool = toolFor(entry, catalog, item);
    built.set(name, { hash: catalog.hash, tool });
    return tool;
  };

  const discovery = {
    visible(sessionKey: string, timeZone: string): Discoverable[] {
      return visibleTo(sessionKey).flatMap((entry) => {
        const why = unavailable(entry.id, timeZone);
        return (catalogs.get(entry.id)?.snapshot.tools ?? []).map((tool) => ({
          tool,
          risk: riskOf(entry, tool),
          untrusted: entry.untrustedOutput,
          ...(why ? { unavailable: why } : {}),
        }));
      });
    },
  };

  return {
    tools: entries.length ? createDiscoveryTools(discovery) : [],
    find,
    explain(name, sessionKey) {
      const id = integrationOf(name);
      const entry = id === undefined ? undefined : byId.get(id);
      if (!entry || catalogs.get(entry.id) || !entry.sessions.includes(sessionProfile(sessionKey))) return undefined;
      if (!entry.tools.allow.some((mcpName) => toolName(entry.id, mcpName) === name)) return undefined;
      const why = unavailable(entry.id);
      return {
        content: `${name} did not run, because the ${entry.id} integration has not sent its tool list yet.${why ? ` ${why}` : ''}`,
        ...(entry.untrustedOutput ? { untrustedSource: `mcp:${entry.id}` } : {}),
        source: 'mcp',
        serverId: entry.id,
      };
    },
    allowedNames(sessionKey) {
      // a heartbeat or a consolidation session sees no integration, so it gets no discovery tools either.
      const visible = visibleTo(sessionKey);
      if (!visible.length) return [];
      return [TOOL_SEARCH, TOOL_CALL, ...visible.flatMap((entry) => entry.tools.allow.map((mcpName) => toolName(entry.id, mcpName)))];
    },
    async start() {
      if (deps.connects === false) return;
      // the servers start side by side. one slow server must not hold the others.
      await Promise.all(
        [...connections].filter(([id]) => !paused.has(id)).map(([id, connection]) => begin(byId.get(id)!, connection)),
      );
    },
    async stop() {
      await Promise.all([...connections.values()].map((connection) => connection.stop()));
    },
    status() {
      return entries.map((entry) => {
        const catalog = catalogs.get(entry.id);
        const row = deps.db.prepare('SELECT authorizedAt, tokenExpiresAt, lastError, lastErrorAt FROM integration_state WHERE integrationId = ?').get(entry.id);
        const text = (key: string) => (row?.[key] as string | null | undefined) ?? null;
        const authUrl = deps.oauth?.pendingUrl(entry.id);
        const snapshot = catalog?.snapshot;
        const seen = new Set([...(snapshot?.tools.map((tool) => tool.mcpName) ?? []), ...(snapshot?.rejected.map((each) => each.mcpName) ?? []), ...(snapshot?.missing ?? [])]);
        return {
          id: entry.id,
          kind: entry.kind,
          target: redact(entry.kind === 'mcp-stdio' ? [entry.command, ...entry.args].join(' ') : entry.url),
          sessions: entry.sessions,
          untrustedOutput: entry.untrustedOutput,
          state: stateOf(entry.id),
          paused: paused.has(entry.id),
          auth: entry.kind === 'mcp-http' && entry.auth ? entry.auth.type : 'none',
          authorizedAt: text('authorizedAt'),
          tokenExpiresAt: text('tokenExpiresAt'),
          lastError: text('lastError'),
          lastErrorAt: text('lastErrorAt'),
          ...(authUrl ? { authUrl } : {}),
          ...(entry.kind === 'mcp-http' && entry.auth?.type === 'oauth' && deps.oauth
            ? {
                oauthApp: {
                  redirectUrl: deps.oauth.redirectUrl(entry),
                  callback: entry.auth.callback,
                  ...(entry.auth.clientRef ? { clientRef: entry.auth.clientRef } : {}),
                },
              }
            : {}),
          ...(catalog ? { catalogHash: catalog.hash, catalogStored: catalog.stored } : {}),
          // the live catalog is the text of the server, and a server can quote its key in a description. the stored
          // copy is redacted, and the page gets the same.
          tools: redactValue((snapshot?.tools ?? []).map((tool) => ({
            name: tool.name,
            mcpName: tool.mcpName,
            description: tool.description,
            risk: riskOf(entry, tool),
            riskFrom: riskFrom(entry, tool),
            inputSchema: tool.inputSchema,
          }))),
          rejected: redactValue(snapshot?.rejected ?? []),
          missing: snapshot?.missing ?? [],
          hidden: redactValue(catalog?.hidden ?? []),
          unknown: entry.tools.allow.filter((name) => !seen.has(name)),
        };
      });
    },
    async setPaused(id, pause) {
      const connection = connections.get(id);
      if (!connection) return false;
      writePaused(id, pause);
      if (deps.connects === false) return true;
      if (pause) {
        parked.delete(id);
        await connection.stop();
      } else {
        await begin(byId.get(id)!, connection);
      }
      return true;
    },
    connection: (id) => connections.get(id),
    async finishSignIn(pasted) {
      let url: URL;
      try {
        url = new URL(pasted.trim());
      } catch {
        return { ok: false, text: 'That is not an address. Copy the whole address of the page that the sign-in opened.' };
      }
      if (!deps.oauth) return { ok: false, text: 'No integration signs in with OAuth.' };
      const done = await deps.oauth.callback(url, transportOf);
      if (done.status === 200 && done.integrationId) signedIn(done.integrationId);
      void deps.oauth.closeIfIdle();
      return { ok: done.status === 200, text: done.text };
    },
    async storeClient(id, client) {
      const entry = byId.get(id);
      const ref = entry?.kind === 'mcp-http' && entry.auth?.type === 'oauth' ? entry.auth.clientRef : undefined;
      if (!ref) return { error: `${id} has no auth.clientRef in okc.integrations.json, so it has no place for a client.` };
      registerSecret(client.client_secret, `${ref}#secret`);
      try {
        await deps.secrets.set(ref, JSON.stringify(client));
      } catch (err) {
        return { error: `the credential manager did not take the client: ${redact(errorText(err))}` };
      }
      logger.info('oauth client stored', { integration: id, clientRef: ref });
      return { stored: true };
    },
    connect(id) {
      // a second press of Connect while the first one runs joins it. a second attempt would stop the first one before
      // its sign-in link exists.
      const running = connecting.get(id);
      if (running) return running;
      const attempt = connectOnce(id).finally(() => connecting.delete(id));
      connecting.set(id, attempt);
      return attempt;
    },
  };

  async function connectOnce(id: string): Promise<{ connected: true } | { url: string } | { error: string }> {
    const entry = byId.get(id);
    const connection = connections.get(id);
    if (!entry || !connection) return { error: `no integration has the id ${id}` };
    const oauth = entry.kind === 'mcp-http' && entry.auth?.type === 'oauth' ? deps.oauth : undefined;
    // without its pre-registered client the sdk fails later, with words about dynamic registration that do not say what
    // the owner must do. a failure of the credential manager is not a missing client, so the attempt goes on and shows
    // its own error.
    const clientRef = entry.kind === 'mcp-http' && entry.auth?.type === 'oauth' ? entry.auth.clientRef : undefined;
    if (oauth && clientRef && (await deps.secrets.get(clientRef).catch(() => 'unknown')) === undefined) {
      return { error: `the OAuth client of ${id} is not stored yet. Enter the client id and the client secret of its app on this page, then press Connect.` };
    }
    if (oauth) {
      try {
        await oauth.listen(transportOf, signedIn);
      } catch (err) {
        // another process, for example a second copy of the app, can hold the port.
        return { error: `the sign-in callback cannot listen: ${(err as Error).message}` };
      }
    }
    if (paused.has(id)) writePaused(id, false);
    // a new attempt makes the sdk create a new flow, or connect with the stored tokens.
    parked.delete(id);
    authorizing.add(id);
    try {
      await connection.stop();
      // the owner can press Pause while the old connection closes, and a stdio close on windows takes seconds. the
      // pause wins, or the page says paused while the server runs.
      if (paused.has(id)) return { error: `the owner paused the ${id} integration.` };
      await connection.start();
    } finally {
      authorizing.delete(id);
    }
    const url = oauth?.pendingUrl(id);
    // the connect of another integration can still wait for its sign-in link, and it needs the port.
    if (!url && connecting.size <= 1) await oauth?.closeIfIdle();
    if (connection.state().status === 'connected') return { connected: true };
    return url ? { url } : { error: connection.state().error ?? 'the connection did not start' };
  }
}
