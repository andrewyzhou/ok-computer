import { join } from 'node:path';
import type { Context, Hono } from 'hono';
import type { Db } from '../db/index.js';
import { createBlobStore, type BlobStore } from '../observability/blobs.js';
import { redact } from '../observability/redact.js';
import { DEFAULT_LIMITS, DETAIL_TEXT_BYTES, SANDBOX_IMAGE } from '../sandbox/limits.js';
import { errorText } from '../tools/registry.js';
import type { DashboardDeps } from './server.js';
import type {
  SandboxExecDetail,
  SandboxExecRow,
  SandboxExecStatus,
  SandboxFile,
  SandboxPage,
  SandboxPolicyView,
  SandboxQuery,
  SandboxStatus,
} from './types.js';

type Row = Record<string, unknown>;

const STATUSES: readonly SandboxExecStatus[] = ['running', 'ok', 'failed', 'timeout', 'killed', 'error'];
const RUN_ID_CHARS = 200;
const DEFAULT_PAGE = 50;
const MAX_PAGE = 200;
const NOT_SET_UP = 'the code sandbox is not set up in this process';

const str = (value: unknown) => (value === null || value === undefined ? null : String(value));
const num = (value: unknown) => (value === null || value === undefined ? null : Number(value));

// the status when the process has no sandbox, or when its status check fails. the page then shows the tool as off,
// and the list of the old execs still loads.
const offStatus = (reason: string): SandboxStatus => ({
  available: false,
  reason,
  engine: null,
  image: SANDBOX_IMAGE,
  defaults: DEFAULT_LIMITS,
  network: false,
  networkReason: reason,
});

// phase 5 m9 owns this module. it mounts GET /api/sandbox and GET /api/sandbox/execs/:id. docs/PHASE5-API.md gives the
// shapes and the errors. server.ts calls it after the sign-in check, so each route is behind the dashboard auth.
export function mountSandbox(server: Hono, deps: DashboardDeps): void {
  const { db, config, clock, app } = deps;
  const blobs = createBlobStore(db, join(config.paths.data, 'blobs'), clock);
  const notFound = (c: Context) => c.json({ error: 'sandbox exec not found' }, 404);
  // a damaged row or blob is an error that the page shows, not a crash of the request.
  const failed = (c: Context, err: unknown) => c.json({ error: errorText(err) }, 500);

  server.get('/api/sandbox', async (c) => {
    const parsed = parseSandboxQuery(c.req.query());
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);
    try {
      // a missing docker is not an error. the status says so, and the answer is still 200.
      let status: SandboxStatus;
      try {
        status = app.sandbox ? await app.sandbox.status() : offStatus(NOT_SET_UP);
      } catch (err) {
        status = offStatus(errorText(err));
      }
      const page = listSandboxExecs(db, parsed.value);
      return c.json({ status, execs: page.execs, before: page.before } satisfies SandboxPage);
    } catch (err) {
      return failed(c, err);
    }
  });

  server.get('/api/sandbox/execs/:id', (c) => {
    const id = c.req.param('id');
    if (!/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id))) return notFound(c);
    try {
      const detail = getSandboxExec(db, blobs, Number(id));
      return detail ? c.json(detail) : notFound(c);
    } catch (err) {
      return failed(c, err);
    }
  });
}

// parseSandboxQuery reads the query of GET /api/sandbox. limit is clamped to 1-200 (default 50). an unknown status or a
// before that is not a positive whole number gives the reason for a 400.
export function parseSandboxQuery(query: Record<string, string | undefined>): { ok: true; value: SandboxQuery } | { ok: false; error: string } {
  const value: SandboxQuery = {};
  if (query.runId !== undefined && query.runId !== '') {
    if (query.runId.length > RUN_ID_CHARS) return { ok: false, error: `runId must be at most ${RUN_ID_CHARS} characters` };
    value.runId = query.runId;
  }
  if (query.status !== undefined && query.status !== '') {
    if (!STATUSES.includes(query.status as SandboxExecStatus)) return { ok: false, error: `status must be one of ${STATUSES.join(', ')}` };
    value.status = query.status as SandboxExecStatus;
  }
  if (query.before !== undefined && query.before !== '') {
    const before = Number(query.before);
    if (!/^[1-9]\d*$/.test(query.before) || !Number.isSafeInteger(before)) return { ok: false, error: 'before must be an exec id' };
    value.before = before;
  }
  // a limit that is not a number gives the default, as for every list (PHASE5-API section 1).
  const limit = Number(query.limit);
  value.limit = query.limit === undefined || query.limit === '' || !Number.isFinite(limit) ? DEFAULT_PAGE : Math.min(Math.max(Math.trunc(limit), 1), MAX_PAGE);
  return { ok: true, value };
}

// the file count is a subquery of the same statement, so a page of execs is one read and not one read for each row.
const EXEC = `SELECT e.*, (SELECT COUNT(*) FROM sandbox_files f WHERE f.execId = e.id) AS fileCount FROM sandbox_execs e`;

function toExecRow(row: Row): SandboxExecRow {
  return {
    id: Number(row.id),
    runId: str(row.runId),
    toolCallId: str(row.toolCallId),
    sessionKey: str(row.sessionKey),
    language: row.language as SandboxExecRow['language'],
    command: String(row.command),
    image: String(row.image),
    network: row.network as SandboxExecRow['network'],
    allowlist: JSON.parse(String(row.allowlist)) as string[],
    limits: JSON.parse(String(row.limits)) as SandboxExecRow['limits'],
    status: row.status as SandboxExecStatus,
    exitCode: num(row.exitCode),
    durationMs: Number(row.durationMs),
    stdoutBytes: Number(row.stdoutBytes),
    stderrBytes: Number(row.stderrBytes),
    truncated: Number(row.truncated) !== 0,
    fileCount: Number(row.fileCount),
    createdAt: String(row.createdAt),
  };
}

// listSandboxExecs gives one page, newest first. before is the id of the last row when the page is full and more rows
// exist, and null on the last page.
export function listSandboxExecs(db: Db, query: SandboxQuery): { execs: SandboxExecRow[]; before: number | null } {
  const limit = query.limit ?? DEFAULT_PAGE;
  const where = [
    ...(query.runId !== undefined ? ['e.runId = @runId'] : []),
    ...(query.status !== undefined ? ['e.status = @status'] : []),
    ...(query.before !== undefined ? ['e.id < @before'] : []),
  ];
  // one more row than the page tells if an older page exists, without a count of the whole table.
  const rows = db
    .prepare(`${EXEC} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY e.id DESC LIMIT @limit`)
    .all({
      ...(query.runId !== undefined ? { runId: query.runId } : {}),
      ...(query.status !== undefined ? { status: query.status } : {}),
      ...(query.before !== undefined ? { before: query.before } : {}),
      limit: limit + 1,
    });
  const execs = rows.slice(0, limit).map(toExecRow);
  return { execs, before: rows.length > limit ? (execs.at(-1)?.id ?? null) : null };
}

// the cut never splits a character: it moves back to the first byte of the character at the limit.
function head(text: string, bytes: number): string {
  const buffer = Buffer.from(text, 'utf8');
  if (buffer.length <= bytes) return text;
  let end = bytes;
  while (end > 0 && ((buffer[end] ?? 0) & 0xc0) === 0x80) end--;
  return buffer.subarray(0, end).toString('utf8');
}

// a missing blob file gives null, so the page shows that the text is gone. a damaged file throws in read.
function textOf(blobs: BlobStore, hash: string | null): string | null {
  if (hash === null) return null;
  const text = blobs.read(hash);
  return text === undefined ? null : head(text, DETAIL_TEXT_BYTES);
}

// the tool call row names its decision when the call is done. while the call runs, that row does not exist yet, so the
// decision is found by run and call id. an approved call runs with the call id approval-<id>, so it finds the decision
// of the call that asked through the approval.
const DECISION = `SELECT d.*, approvals.status AS approvalStatus FROM policy_decisions d LEFT JOIN approvals ON approvals.id = d.approvalId`;

function policyOf(db: Db, runId: string | null, toolCallId: string | null): SandboxPolicyView | null {
  if (runId === null || toolCallId === null) return null;
  const call = db.prepare('SELECT policyDecisionId FROM tool_calls WHERE runId = ? AND toolCallId = ? ORDER BY id LIMIT 1').get(runId, toolCallId);
  const row =
    call && call.policyDecisionId !== null
      ? db.prepare(`${DECISION} WHERE d.id = ?`).get(Number(call.policyDecisionId))
      : db
          .prepare(`${DECISION} WHERE d.runId = ? AND (d.toolCallId = ? OR (d.approvalId IS NOT NULL AND ? = 'approval-' || d.approvalId)) ORDER BY d.id DESC LIMIT 1`)
          .get(runId, toolCallId, toolCallId);
  if (!row) return null;
  // a reason can quote the input of the call, so it is redacted, as on the policy page.
  return {
    decisionId: Number(row.id),
    decision: row.decision as SandboxPolicyView['decision'],
    rule: String(row.rule),
    reason: redact(String(row.reason)),
    reviewerVerdict: (str(row.reviewerVerdict) as SandboxPolicyView['reviewerVerdict']) ?? null,
    reviewerReason: row.reviewerReason === null ? null : redact(String(row.reviewerReason)),
    reviewerModelCallId: num(row.reviewerModelCallId),
    approvalId: num(row.approvalId),
    approvalStatus: str(row.approvalStatus),
  };
}

// getSandboxExec gives undefined for an id that has no row. it throws when a blob of the row is damaged, and the route
// answers 500.
export function getSandboxExec(db: Db, blobs: BlobStore, id: number): SandboxExecDetail | undefined {
  const row = db.prepare(`${EXEC} WHERE e.id = ?`).get(id);
  if (!row) return undefined;
  const exec = toExecRow(row);
  const files = db
    .prepare('SELECT path, direction, blob, size, mime FROM sandbox_files WHERE execId = ? ORDER BY id')
    .all(id)
    .map(
      (file): SandboxFile => ({
        path: String(file.path),
        direction: file.direction as SandboxFile['direction'],
        blob: String(file.blob),
        size: Number(file.size),
        mime: String(file.mime),
      }),
    );
  const stdoutBlob = str(row.stdoutBlob);
  const stderrBlob = str(row.stderrBlob);
  return {
    ...exec,
    cwd: String(row.cwd),
    imageId: str(row.imageId),
    containerId: str(row.containerId),
    stdout: textOf(blobs, stdoutBlob),
    stderr: textOf(blobs, stderrBlob),
    stdoutBlob,
    stderrBlob,
    error: str(row.error),
    files,
    policy: policyOf(db, exec.runId, exec.toolCallId),
    endedAt: str(row.endedAt),
  };
}
