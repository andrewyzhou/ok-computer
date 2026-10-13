import type { Db } from '../db/index.js';
import type { BrowserStep, BrowserTaskDetail, BrowserTaskSummary } from './browser-types.js';

const json = <T>(text: unknown, fallback: T): T => {
  if (typeof text !== 'string') return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
};

const SUMMARY = `SELECT t.*, (SELECT COUNT(*) FROM browser_steps s WHERE s.taskId = t.id) AS steps,
  (SELECT COUNT(*) FROM browser_steps s WHERE s.taskId = t.id AND s.blockedRequests IS NOT NULL) AS blocked FROM browser_tasks t`;

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
  };
}

export function browserTasks(db: Db, limit = 100): BrowserTaskSummary[] {
  return db.prepare(`${SUMMARY} ORDER BY t.startedAt DESC, t.rowid DESC LIMIT ?`).all(limit).map(toSummary);
}

export function browserTask(db: Db, id: string): BrowserTaskDetail | undefined {
  const row = db.prepare(`${SUMMARY} WHERE t.id = ?`).get(id);
  if (!row) return undefined;
  const steps = db
    .prepare('SELECT * FROM browser_steps WHERE taskId = ? ORDER BY id')
    .all(id)
    .map(
      (step): BrowserStep => ({
        id: Number(step.id),
        runId: (step.runId as string | null) ?? null,
        toolCallId: (step.toolCallId as string | null) ?? null,
        action: String(step.action),
        target: (step.target as string | null) ?? null,
        urlBefore: (step.urlBefore as string | null) ?? null,
        urlAfter: (step.urlAfter as string | null) ?? null,
        snapshotBlob: (step.snapshotBlob as string | null) ?? null,
        screenshotBlob: (step.screenshotBlob as string | null) ?? null,
        consoleErrors: json<string[]>(step.consoleErrors, []),
        blockedRequests: json<Array<{ url: string; reason: string }>>(step.blockedRequests, []),
        error: (step.error as string | null) ?? null,
        durationMs: Number(step.durationMs),
        createdAt: String(step.createdAt),
      }),
    );
  return { task: toSummary(row), steps };
}

// the path of a trace comes from the row, and the row names only traces/<task id>.zip. the id check keeps a damaged
// row from naming a file outside the folder.
export function tracePathOf(db: Db, id: string): string | undefined {
  if (!/^[\w-]{1,80}$/.test(id)) return undefined;
  const row = db.prepare('SELECT tracePath FROM browser_tasks WHERE id = ?').get(id);
  return row?.tracePath === `traces/${id}.zip` ? `traces/${id}.zip` : undefined;
}
