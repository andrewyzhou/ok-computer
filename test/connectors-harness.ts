import type {
  ApplyResult,
  ConnectorContext,
  ConnectorEvent,
  IntegrationsPort,
  LiveIntegration,
  ManagedConnection,
  ManagedStore,
} from '../src/connectors/types.js';
import { createMemorySecretStore } from '../src/integrations/secrets.js';

// the fakes of the connections hub. a connector test calls a ConnectorDef with fakeContext, so it needs neither the
// app, the database nor a real integration layer. the real store, the real applier and the real integration layer
// have their own tests.

export const HUB_NOW = new Date('2026-10-21T16:00:00.000Z');

// an in-memory ManagedStore with the same rules as src/connectors/store.ts: save keeps createdAt, and the events are
// append-only.
export function memoryStore(now: () => Date = () => HUB_NOW): ManagedStore & { rows: Map<string, ManagedConnection>; log: ConnectorEvent[] } {
  const rows = new Map<string, ManagedConnection>();
  const log: ConnectorEvent[] = [];
  return {
    rows,
    log,
    list: () => [...rows.values()],
    get: (id) => rows.get(id),
    save(row) {
      const at = now().toISOString();
      const saved = { ...row, createdAt: rows.get(row.integrationId)?.createdAt ?? at, updatedAt: at };
      rows.set(row.integrationId, saved);
      return saved;
    },
    remove: (id) => rows.delete(id),
    record(event) {
      const saved = { ...event, id: log.length + 1, at: now().toISOString() };
      log.push(saved);
      return saved;
    },
    events: (connectorId, limit = 50) =>
      log
        .filter((event) => event.connectorId === connectorId)
        .reverse()
        .slice(0, limit),
  };
}

// a live integration in a given state, for the status of an mcp connector.
export function liveIntegration(id: string, patch: Partial<LiveIntegration> = {}): LiveIntegration {
  return {
    id,
    state: { status: 'stopped' },
    paused: false,
    authorizedAt: null,
    lastError: null,
    lastErrorAt: null,
    tools: [],
    hidden: [],
    ...patch,
  };
}

// a fake integration layer. live holds the state that status gives, and calls records each call in order, so a test
// can show that a disconnect forgot the tokens before the apply.
export function fakeIntegrations(live: Map<string, LiveIntegration> = new Map()): IntegrationsPort & { live: Map<string, LiveIntegration>; calls: string[] } {
  const calls: string[] = [];
  return {
    live,
    calls,
    status: (id) => live.get(id),
    async connect(id) {
      calls.push(`connect ${id}`);
      return { url: `https://auth.example.test/authorize?client=${id}` };
    },
    async finishSignIn(pasted) {
      calls.push(`finish ${pasted}`);
      return { ok: true, text: 'signed in' };
    },
    async storeClient(id, client) {
      calls.push(`storeClient ${id} ${client.client_id}`);
      return { stored: true };
    },
    async forget(id) {
      calls.push(`forget ${id}`);
    },
    redirectUrl: (callback) => `${callback === 'paste' ? 'https' : 'http'}://127.0.0.1:4318/oauth/callback`,
  };
}

export interface FakeContext extends ConnectorContext {
  store: ReturnType<typeof memoryStore>;
  integrations: ReturnType<typeof fakeIntegrations>;
  secrets: ReturnType<typeof createMemorySecretStore>;
  applied: string[];
  logged: Array<{ level: string; message: string; fields?: Record<string, unknown> }>;
}

// fakeContext gives a context with the fakes above. apply records its reason and answers with result.
export function fakeContext(options: { result?: ApplyResult; live?: Map<string, LiveIntegration> } = {}): FakeContext {
  const applied: string[] = [];
  const logged: FakeContext['logged'] = [];
  const log = (level: string) => (message: string, fields?: Record<string, unknown>) => void logged.push({ level, message, ...(fields ? { fields } : {}) });
  return {
    now: () => HUB_NOW,
    store: memoryStore(),
    integrations: fakeIntegrations(options.live),
    secrets: createMemorySecretStore(),
    log: { info: log('info'), warn: log('warn'), error: log('error') },
    async apply(reason) {
      applied.push(reason);
      return options.result ?? { status: 'applied' };
    },
    dashboardUrl: 'http://127.0.0.1:4317',
    applied,
    logged,
  };
}
