import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Context, Hono } from 'hono';
import { profileBusy } from '../browser/worker.js';
import type { Db } from '../db/index.js';
import { createByteStore } from '../observability/byte-blobs.js';
import type { Clock } from '../time.js';
import { ENGINES, engineStates, pausedNow } from '../web/search.js';
import type { BrowserOverview, BrowserStep, BrowserTaskDetail, BrowserTaskSummary, SearchEngineState } from './browser-types.js';
import type { BrowserLive, BrowserLiveStep } from './types.js';

const json = <T>(text: unknown, fallback: T): T => {
  if (typeof text !== 'string') return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
};

const SUMMARY = `SELECT t.*, (SELECT COUNT(*) FROM browser_steps s WHERE s.taskId = t.id) AS steps,
  (SELECT COALESCE(SUM(json_array_length(s.blockedRequests)), 0) FROM browser_steps s WHERE s.taskId = t.id AND s.blockedRequests IS NOT NULL) AS blocked,
  (SELECT COALESCE(SUM(json_array_length(s.sent)), 0) FROM browser_steps s WHERE s.taskId = t.id AND s.sent IS NOT NULL) AS sent
  FROM browser_tasks t`;

function toSummary(row: Record<string, unknown>): BrowserTaskSummary {
  return {
    id: String(row.id),
    kind: row.kind as BrowserTaskSummary['kind'],
    sessionKey: String(row.sessionKey),
    runId: row.runId === null ? null : String(row.runId),
    allowlist: json<string[]>(row.allowlist, []),
    status: row.status as BrowserTaskSummary['status'],
    endReason: (row.endReason as string | null) ?? null,
    hasTrace: row.tracePath === `traces/${String(row.id)}.zip`,
    traceBytes: row.traceBytes === null ? null : Number(row.traceBytes),
    traceError: (row.traceError as string | null) ?? null,
    startedAt: String(row.startedAt),
    endedAt: (row.endedAt as string | null) ?? null,
    steps: Number(row.steps),
    blocked: Number(row.blocked),
    sent: Number(row.sent),
  };
}

export function browserTasks(db: Db, limit = 100): BrowserTaskSummary[] {
  return db.prepare(`${SUMMARY} ORDER BY t.startedAt DESC, t.rowid DESC LIMIT ?`).all(limit).map(toSummary);
}

export function searchEngines(db: Db, now: Date): SearchEngineState[] {
  const states = engineStates(db);
  return ENGINES.map((engine) => {
    const state = states[engine.id];
    const until = state?.until ?? null;
    return { id: engine.id, label: engine.label, paused: pausedNow(state, now), until, reason: state?.reason ?? null, strikes: state?.strikes ?? 0 };
  });
}

// a step joins its tool call by run and call id: the risk of the call, and the decision that let it run. an approved
// call runs in the run of its request with the call id approval-<id>, so it finds its decision through the approval.
const STEP = `SELECT s.*, (SELECT riskLevel FROM tool_calls c WHERE c.runId = s.runId AND c.toolCallId = s.toolCallId LIMIT 1) AS risk,
  d.decision, d.rule, d.approvalId
  FROM browser_steps s LEFT JOIN policy_decisions d ON d.runId = s.runId
    AND (d.toolCallId = s.toolCallId OR (d.approvalId IS NOT NULL AND s.toolCallId = 'approval-' || d.approvalId))
  WHERE s.taskId = ? ORDER BY s.id`;

export function browserTask(db: Db, id: string): BrowserTaskDetail | undefined {
  const row = db.prepare(`${SUMMARY} WHERE t.id = ?`).get(id);
  if (!row) return undefined;
  const steps = db
    .prepare(STEP)
    .all(id)
    .map(
      (step): BrowserStep => ({
        id: Number(step.id),
        runId: (step.runId as string | null) ?? null,
        toolCallId: (step.toolCallId as string | null) ?? null,
        action: String(step.action),
        // the row keeps the target as json text, so a url or the input of a submit shows without escapes.
        target: json<string | null>(step.target, null),
        urlBefore: (step.urlBefore as string | null) ?? null,
        urlAfter: (step.urlAfter as string | null) ?? null,
        snapshotBlob: (step.snapshotBlob as string | null) ?? null,
        screenshotBlob: (step.screenshotBlob as string | null) ?? null,
        consoleErrors: json<string[]>(step.consoleErrors, []),
        blockedRequests: json<BrowserStep['blockedRequests']>(step.blockedRequests, []),
        sent: json<BrowserStep['sent']>(step.sent, []),
        offsiteHosts: json<string[]>(step.offsiteHosts, []),
        error: (step.error as string | null) ?? null,
        durationMs: Number(step.durationMs),
        createdAt: String(step.createdAt),
        risk: (step.risk as string | null) ?? null,
        decision: (step.decision as string | null) ?? null,
        rule: (step.rule as string | null) ?? null,
        approvalId: step.approvalId === null || step.approvalId === undefined ? null : Number(step.approvalId),
      }),
    );
  return { task: toSummary(row), steps };
}

// phase 5 m1: the open browser tasks, newest first, each with its latest step.
export function browserLive(db: Db): BrowserLive {
  const latest = db.prepare('SELECT * FROM browser_steps WHERE taskId = ? ORDER BY id DESC LIMIT 1');
  const tasks = db
    .prepare(
      `SELECT t.*, (SELECT COUNT(*) FROM browser_steps s WHERE s.taskId = t.id) AS steps FROM browser_tasks t
        WHERE t.status = 'open' ORDER BY t.startedAt DESC, t.rowid DESC`,
    )
    .all()
    .map((row) => {
      const step = latest.get(String(row.id));
      return {
        id: String(row.id),
        kind: row.kind as BrowserLive['tasks'][number]['kind'],
        sessionKey: String(row.sessionKey),
        runId: row.runId === null ? null : String(row.runId),
        allowlist: json<string[]>(row.allowlist, []),
        startedAt: String(row.startedAt),
        steps: Number(row.steps),
        latest: step ? toLiveStep(step) : null,
      };
    });
  return { tasks };
}

function toLiveStep(step: Record<string, unknown>): BrowserLiveStep {
  return {
    id: Number(step.id),
    action: String(step.action),
    target: json<string | null>(step.target, null),
    urlAfter: (step.urlAfter as string | null) ?? null,
    screenshotBlob: (step.screenshotBlob as string | null) ?? null,
    error: (step.error as string | null) ?? null,
    durationMs: Number(step.durationMs),
    createdAt: String(step.createdAt),
  };
}

// the path of a trace comes from the row, and the row names only traces/<task id>.zip. the id check keeps a damaged
// row from naming a file outside the folder.
export function tracePathOf(db: Db, id: string): string | undefined {
  if (!/^[\w-]{1,80}$/.test(id)) return undefined;
  const row = db.prepare('SELECT tracePath FROM browser_tasks WHERE id = ?').get(id);
  return row?.tracePath === `traces/${id}.zip` ? `traces/${id}.zip` : undefined;
}

// the routes of the browser page. they go on the server after its access checks, like the other api routes.
export function mountBrowser(server: Hono, deps: { db: Db; dataDir: string; clock: Clock }): void {
  const { db, dataDir, clock } = deps;
  const bytes = createByteStore(db, join(dataDir, 'blobs'), clock);
  const notFound = (c: Context, what: string) => c.json({ error: `${what} not found` }, 404);
  server.get('/api/browser', (c) =>
    c.json({ engines: searchEngines(db, clock()), profileInUse: profileBusy(join(dataDir, 'browser', 'profile')), tasks: browserTasks(db) } satisfies BrowserOverview),
  );
  server.get('/api/browser/live', (c) => c.json(browserLive(db)));
  server.get('/api/browser/tasks/:id', (c) => {
    const detail = browserTask(db, c.req.param('id'));
    return detail ? c.json(detail) : notFound(c, 'browser task');
  });
  // a screenshot is bytes. only an image goes out, with its type fixed, so a blob of text never renders as a page.
  server.get('/api/browser/screenshots/:hash', (c) => {
    try {
      const blob = bytes.read(c.req.param('hash'));
      if (!blob || !blob.mime.startsWith('image/')) return notFound(c, 'screenshot');
      return c.body(new Uint8Array(blob.bytes), 200, { 'content-type': blob.mime, 'x-content-type-options': 'nosniff' });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500);
    }
  });
  // the trace holds the screenshots and the actions of the task, so it goes out only to a client that passed the token.
  server.get('/api/browser/tasks/:id/trace', (c) => {
    const path = tracePathOf(db, c.req.param('id'));
    const full = path && join(dataDir, 'browser', path);
    if (!full || !existsSync(full)) return notFound(c, 'trace');
    return c.body(new Uint8Array(readFileSync(full)), 200, {
      'content-type': 'application/zip',
      'content-disposition': `attachment; filename="${c.req.param('id')}.zip"`,
    });
  });
}
