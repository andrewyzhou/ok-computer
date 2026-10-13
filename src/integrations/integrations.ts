import type { Transport } from '@modelcontextprotocol/client';
import { z } from 'zod';
import type { Db } from '../db/index.js';
import type { BlobStore } from '../observability/blobs.js';
import type { Logger } from '../observability/logger.js';
import type { SetTimer } from '../scheduler/scheduler.js';
import type { Clock } from '../time.js';
import { TOOL_CALL, type Tool } from '../tools/registry.js';
import { createCatalogStore, riskOf, type Catalog, type CatalogTool } from './catalog.js';
import { sessionProfile, type IntegrationEntry } from './config.js';
import type { OAuth } from './oauth.js';
import { createDiscoveryTools, outcomeOutput, TOOL_SEARCH, type Discoverable } from './discovery.js';
import { createMcpConnection, type ConnectionState, type McpConnection } from './mcp.js';
import { toolName } from './names.js';
import type { SecretStore } from './secrets.js';
import { httpTransport, stdioTransport } from './transports.js';

// a call after a restart waits this long for its server. npx can need many seconds to start a server.
export const READY_WAIT_MS = 30_000;

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
  // the owner gets a message when a server needs a new sign-in, for example after a failed refresh.
  onNeedsAuth?: (integrationId: string) => void;
  setTimer?: SetTimer;
  readyWaitMs?: number;
}

export interface IntegrationStatus {
  id: string;
  kind: IntegrationEntry['kind'];
  state: ConnectionState;
  catalogHash?: string;
  catalogStored?: boolean;
  tools: Array<{ name: string; mcpName: string; risk: string }>;
  rejected: Array<{ mcpName: string; reason: string }>;
  paused: boolean;
  tokenExpiresAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
  // the sign-in link that waits for the owner.
  authUrl?: string;
}

export interface Integrations {
  // tool_search and tool_call. without integrations the list is empty, and the tools parameter does not change.
  tools: Tool[];
  // the integration tool with this name, for the registry. it reads the current catalog at each call.
  resolve(name: string): Tool | undefined;
  // the tool names that a session may use: the discovery pair, and every allowed tool of its integrations. this
  // depends only on the config, so a new catalog never changes it.
  allowedNames(sessionKey: string): string[];
  start(): Promise<void>;
  stop(): Promise<void>;
  status(): IntegrationStatus[];
  connection(id: string): McpConnection | undefined;
  // authorize starts a sign-in from the dashboard. it gives the link for the owner, or connected when the stored
  // tokens still work.
  authorize(id: string): Promise<{ connected: true } | { url: string } | { error: string }>;
  // a paused integration stays stopped over a restart. its tools stay in the catalog, and a call says that it is paused.
  setPaused(id: string, paused: boolean): Promise<boolean>;
}

export function createIntegrations(deps: IntegrationsDeps): Integrations {
  const { entries, logger } = deps;
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const catalogs = createCatalogStore({ db: deps.db, clock: deps.clock, logger, entries });
  const connections = new Map<string, McpConnection>();
  const states = new Map<string, ConnectionState>();
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
    // the owner hears once when a server needs a new sign-in, not at each failed attempt.
    if (state.status === 'needs_auth' && before !== 'needs_auth') deps.onNeedsAuth?.(id);
    if (state.status !== 'error' && state.status !== 'needs_auth') return;
    try {
      deps.db
        .prepare(
          `INSERT INTO integration_state (integrationId, lastError, lastErrorAt, updatedAt) VALUES (?, ?, ?, ?)
           ON CONFLICT (integrationId) DO UPDATE SET lastError = excluded.lastError, lastErrorAt = excluded.lastErrorAt, updatedAt = excluded.updatedAt`,
        )
        .run(id, state.error ?? state.status, deps.clock().toISOString(), deps.clock().toISOString());
    } catch (err) {
      logger.error('integration state write failed', { integration: id, err });
    }
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
        if (!(await connection.ready(deps.readyWaitMs ?? READY_WAIT_MS, ctx.signal))) {
          const state = connection.state();
          return { content: `${item.name} did not run: ${entry.id} is ${state.status}${state.error ? ` (${state.error})` : ''}.`, isError: true };
        }
        const outcome = await connection.callTool(item.mcpName, input as Record<string, unknown>, { runId: ctx.runId, toolCallId: ctx.toolCallId ?? '' });
        return outcomeOutput(item.name, entry.id, outcome);
      },
    };
  };

  const resolve = (name: string): Tool | undefined => {
    const id = name.split('__')[0]!;
    const entry = byId.get(id);
    const catalog = catalogs.get(id);
    if (!entry || !catalog) return undefined;
    const item = catalog.snapshot.tools.find((each) => each.name === name);
    if (!item) return undefined;
    const cached = built.get(name);
    if (cached?.hash === catalog.hash) return cached.tool;
    const tool = toolFor(entry, catalog, item);
    built.set(name, { hash: catalog.hash, tool });
    return tool;
  };

  const status = (entry: IntegrationEntry): string => states.get(entry.id)?.status ?? 'stopped';

  const discovery = {
    visible(sessionKey: string): Discoverable[] {
      return visibleTo(sessionKey).flatMap((entry) =>
        (catalogs.get(entry.id)?.snapshot.tools ?? []).map((tool) => ({
          tool,
          risk: riskOf(entry, tool),
          untrusted: entry.untrustedOutput,
          status: status(entry),
        })),
      );
    },
  };

  return {
    tools: entries.length ? createDiscoveryTools(discovery) : [],
    resolve,
    allowedNames(sessionKey) {
      // a heartbeat or a consolidation session sees no integration, so it gets no discovery tools either.
      const visible = visibleTo(sessionKey);
      if (!visible.length) return [];
      return [TOOL_SEARCH, TOOL_CALL, ...visible.flatMap((entry) => entry.tools.allow.map((mcpName) => toolName(entry.id, mcpName)))];
    },
    async start() {
      const paused = new Set(
        deps.db
          .prepare('SELECT integrationId FROM integration_state WHERE paused = 1')
          .all()
          .map((row) => String(row.integrationId)),
      );
      // the servers start side by side. one slow server must not hold the others.
      await Promise.all(
        [...connections].filter(([id]) => !paused.has(id)).map(([, connection]) => connection.start()),
      );
    },
    async stop() {
      await Promise.all([...connections.values()].map((connection) => connection.stop()));
    },
    status() {
      return entries.map((entry) => {
        const catalog = catalogs.get(entry.id);
        const row = deps.db.prepare('SELECT paused, tokenExpiresAt, lastError, lastErrorAt FROM integration_state WHERE integrationId = ?').get(entry.id);
        const authUrl = deps.oauth?.pendingUrl(entry.id);
        return {
          id: entry.id,
          kind: entry.kind,
          state: states.get(entry.id) ?? { status: 'stopped' },
          ...(catalog ? { catalogHash: catalog.hash, catalogStored: catalog.stored } : {}),
          tools: (catalog?.snapshot.tools ?? []).map((tool) => ({ name: tool.name, mcpName: tool.mcpName, risk: riskOf(entry, tool) })),
          rejected: catalog?.snapshot.rejected ?? [],
          paused: row?.paused === 1,
          tokenExpiresAt: (row?.tokenExpiresAt as string | null | undefined) ?? null,
          lastError: (row?.lastError as string | null | undefined) ?? null,
          lastErrorAt: (row?.lastErrorAt as string | null | undefined) ?? null,
          ...(authUrl ? { authUrl } : {}),
        };
      });
    },
    async setPaused(id, paused) {
      const connection = connections.get(id);
      if (!connection) return false;
      const now = deps.clock().toISOString();
      deps.db
        .prepare(
          `INSERT INTO integration_state (integrationId, paused, updatedAt) VALUES (?, ?, ?)
           ON CONFLICT (integrationId) DO UPDATE SET paused = excluded.paused, updatedAt = excluded.updatedAt`,
        )
        .run(id, paused ? 1 : 0, now);
      if (paused) await connection.stop();
      else await connection.start();
      return true;
    },
    connection: (id) => connections.get(id),
    async authorize(id) {
      const entry = byId.get(id);
      const connection = connections.get(id);
      if (!entry || entry.kind !== 'mcp-http' || entry.auth?.type !== 'oauth' || !connection || !deps.oauth) {
        return { error: `${id} does not use oauth` };
      }
      const oauth = deps.oauth;
      try {
        await oauth.listen(
          (integrationId) => connections.get(integrationId)?.transport(),
          (integrationId) => {
            const done = connections.get(integrationId);
            void done?.stop().then(() => done.start()).catch((err: unknown) => logger.error('mcp restart after sign-in failed', { integration: integrationId, err }));
          },
        );
      } catch (err) {
        // another process, for example a second copy of the app, can hold the port.
        return { error: `the sign-in callback cannot listen: ${(err as Error).message}` };
      }
      // a new attempt makes the sdk create a new flow, or connect with the stored tokens.
      await connection.stop();
      await connection.start();
      if (connection.state().status === 'connected') return { connected: true };
      const url = oauth.pendingUrl(id);
      return url ? { url } : { error: connection.state().error ?? 'no sign-in link was made' };
    },
  };
}
