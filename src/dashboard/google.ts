import type { Hono } from 'hono';
import type { App } from '../app.js';
import type { Config } from '../config/schema.js';
import type { Db } from '../db/index.js';
import type { Clock } from '../time.js';
import type { GoogleAccountView, GooglePage, GoogleRequestRow, SignalRow } from './google-types.js';

type Row = Record<string, unknown>;
const text = (value: unknown) => (value === null || value === undefined ? null : String(value));
const num = (value: unknown) => (value === null || value === undefined ? null : Number(value));
const DAY_MS = 24 * 60 * 60_000;

// an error from google can end with a period, and the sentence adds its own.
const reason = (error: string | null) => (error ?? 'unknown reason').replace(/\.$/, '');

// the page leads with what the owner must do. the details below it say why.
function nextStep(account: Omit<GoogleAccountView, 'nextStep'>): string | null {
  if (account.status === 'signed_out') return `Connect ${account.alias}${account.expected ? ` and pick ${account.expected}` : ''}.`;
  if (account.status === 'needs_auth') return `It stopped working: ${reason(account.lastError)}. Connect it again.`;
  if (account.failures) return `The last ${account.failures} polls failed: ${reason(account.lastError)}. The next poll tries again.`;
  return null;
}

export function googlePage(db: Db, app: Pick<App, 'google'>, config: Config, now: Date): GooglePage {
  const google = config.google;
  if (!app.google || !google) return { configured: false, clientId: null, send: false, pollMinutes: 0, sessions: [], accounts: [], lastPoll: null, tools: [] };
  const since = new Date(now.getTime() - DAY_MS).toISOString();
  const calls = db.prepare(
    "SELECT COUNT(*) AS calls, COALESCE(SUM(isError), 0) AS errors FROM tool_calls WHERE source = 'google' AND account = ? AND createdAt >= ?",
  );
  const accounts = google.accounts.map(({ alias, email }) => {
    const row = (db.prepare('SELECT * FROM google_accounts WHERE alias = ?').get(alias) ?? {}) as Row;
    const counts = calls.get(alias, since)!;
    const view = {
      alias,
      expected: email ?? null,
      email: text(row.email),
      status: (text(row.status) ?? 'signed_out') as GoogleAccountView['status'],
      authorizedAt: text(row.authorizedAt),
      lastError: text(row.lastError),
      lastErrorAt: text(row.lastErrorAt),
      alertedAt: text(row.alertedAt),
      failures: Number(row.failures ?? 0),
      calls24h: Number(counts.calls),
      errors24h: Number(counts.errors),
    };
    return { ...view, nextStep: nextStep(view) };
  });
  const poll = db
    .prepare(
      `SELECT r.runId, r.status, r.startedAt, r.endedAt, r.error FROM automation_runs r JOIN automations a ON a.id = r.automationId
       WHERE json_extract(a.payload, '$.type') = 'poll' AND json_extract(a.payload, '$.source') = 'google' ORDER BY r.id DESC LIMIT 1`,
    )
    .get();
  return {
    configured: true,
    clientId: google.clientId,
    send: google.send,
    pollMinutes: google.pollMinutes,
    sessions: google.sessions,
    accounts,
    lastPoll: poll ? { runId: text(poll.runId), status: String(poll.status), startedAt: String(poll.startedAt), endedAt: text(poll.endedAt), note: text(poll.error) } : null,
    tools: app.google.tools.map((tool) => ({
      name: tool.name,
      risk: tool.riskFor ? `${tool.risk}, external with attendees` : tool.risk,
      description: tool.description,
    })),
  };
}

const toRequest = (row: Row): GoogleRequestRow => ({
  id: Number(row.id),
  account: text(row.account),
  runId: text(row.runId),
  toolCallId: text(row.toolCallId),
  method: String(row.method),
  url: String(row.url),
  request: text(row.request),
  status: num(row.status),
  response: text(row.response),
  responseBlob: text(row.responseBlob),
  error: text(row.error),
  latencyMs: num(row.latencyMs),
  createdAt: String(row.createdAt),
});

// the requests of one tool call, of one run (a poll), or the newest ones.
export function googleRequests(db: Db, query: { runId?: string; toolCallId?: string }): GoogleRequestRow[] {
  if (query.runId && query.toolCallId) return db.prepare('SELECT * FROM google_requests WHERE runId = ? AND toolCallId = ? ORDER BY id').all(query.runId, query.toolCallId).map(toRequest);
  if (query.runId) return db.prepare('SELECT * FROM google_requests WHERE runId = ? ORDER BY id').all(query.runId).map(toRequest);
  return db.prepare('SELECT * FROM google_requests ORDER BY id DESC LIMIT 200').all().map(toRequest);
}

// each signal with the message that its heartbeat sent, so the page answers "did the owner hear about this?".
export function signalRows(db: Db, limit = 200): SignalRow[] {
  const sent = db.prepare("SELECT input FROM tool_calls WHERE runId = ? AND name = 'heartbeat_respond' AND isError = 0 ORDER BY id DESC LIMIT 1");
  return db
    .prepare("SELECT * FROM integration_events WHERE state = 'ready' ORDER BY id DESC LIMIT ?")
    .all(limit)
    .map((row) => {
      const handledAs = text(row.handledAs) as SignalRow['handledAs'];
      const respond = handledAs === 'notified' && row.handledBy ? sent.get(String(row.handledBy)) : undefined;
      return {
        id: Number(row.id),
        source: String(row.source),
        account: String(row.account),
        kind: String(row.kind),
        summary: text(row.summary),
        occursAt: text(row.occursAt),
        state: String(row.state),
        label: text(row.label),
        labelModelCallId: num(row.labelModelCallId),
        detectors: row.detectors ? (JSON.parse(String(row.detectors)) as SignalRow['detectors']) : null,
        runId: text(row.runId),
        seenAt: String(row.seenAt),
        handledAt: text(row.handledAt),
        handledAs,
        handledBy: text(row.handledBy),
        notification: respond ? ((JSON.parse(String(respond.input)) as { text?: string }).text ?? null) : null,
      };
    });
}

export function googleRoutes(server: Hono, deps: { db: Db; app: Pick<App, 'google'>; config: Config; clock: Clock }): void {
  const { db, app } = deps;
  server.get('/api/google', (c) => c.json(googlePage(db, app, deps.config, deps.clock())));
  server.get('/api/google/requests', (c) => {
    const { runId, toolCallId } = c.req.query();
    return c.json(googleRequests(db, { ...(runId ? { runId } : {}), ...(toolCallId ? { toolCallId } : {}) }));
  });
  server.get('/api/signals', (c) => c.json(signalRows(db)));
  // the client file goes to the credential manager, never to the database.
  server.post('/api/google/client', async (c) => {
    if (!app.google) return c.json({ error: 'google is not configured' }, 404);
    const result = await app.google.accounts.saveClient(await c.req.json().catch(() => undefined));
    return c.json(result, 'error' in result ? 400 : 200);
  });
  // the consent page opens on this pc only, because its callback listens on 127.0.0.1.
  server.post('/api/google/accounts/:alias/connect', async (c) => {
    if (!app.google) return c.json({ error: 'google is not configured' }, 404);
    const result = await app.google.accounts.beginSignIn(c.req.param('alias'));
    return c.json(result, 'error' in result ? 400 : 200);
  });
}
