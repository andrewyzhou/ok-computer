import type { Hono } from 'hono';
import type { Db } from '../db/index.js';
import { REVIEW_TOOL } from '../policy/reviewer.js';
import { toDecision, toMcpMessage } from './queries.js';
import type { DashboardDeps } from './server.js';
import type { RunSpans, Span, SpanKind, SpanRef } from './types.js';

// phase 5 m1 owns this module. it mounts GET /api/runs/:id/spans. docs/PHASE5-API.md gives the shapes and the errors.
// server.ts calls it after the sign-in check, so each route is behind the dashboard auth.

type Row = Record<string, unknown>;

// spans that start at the same ms are sorted in this order, so a parent comes before the spans inside it.
const KIND_ORDER: readonly SpanKind[] = ['run', 'subagent', 'model', 'review', 'tool', 'approval', 'mcp', 'google', 'browser', 'sandbox'];

const str = (value: unknown) => (value === null || value === undefined ? null : String(value));
const num = (value: unknown) => (value === null || value === undefined ? null : Number(value));
// a row that is written when its action ends holds the end, and its duration gives the start.
const minus = (at: string, ms: number) => new Date(Date.parse(at) - ms).toISOString();
const plus = (at: string, ms: number) => new Date(Date.parse(at) + ms).toISOString();

interface Walk {
  db: Db;
  // the start of the root run. every span of the root run and of its child runs counts from it.
  origin: number;
  spans: Span[];
  visited: Set<string>;
  // the cost of each run in the walk that has a price.
  costs: number[];
  sandbox: boolean;
}

interface SpanInput {
  id: string;
  parentId: string | null;
  kind: SpanKind;
  label: string;
  startAt: string;
  endAt: string | null;
  status: string | null;
  error?: string | null;
  costUsd?: number | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  ref: SpanRef;
}

function span(walk: Walk, input: SpanInput): Span {
  const ms = (at: string) => Math.round(Date.parse(at) - walk.origin);
  const made: Span = {
    id: input.id,
    parentId: input.parentId,
    kind: input.kind,
    label: input.label,
    startAt: input.startAt,
    endAt: input.endAt,
    startMs: ms(input.startAt),
    endMs: input.endAt === null ? null : ms(input.endAt),
    status: input.status,
    error: input.error ?? null,
    costUsd: input.costUsd ?? null,
    inputTokens: input.inputTokens ?? null,
    outputTokens: input.outputTokens ?? null,
    ref: input.ref,
  };
  walk.spans.push(made);
  return made;
}

// the cost and the tokens of the model calls of one run, review calls included. the cost is null when no call has a
// price.
function usageOf(db: Db, runId: string) {
  const row = db
    .prepare('SELECT SUM(costUsd) AS costUsd, COALESCE(SUM(inputTokens), 0) AS inputTokens, COALESCE(SUM(outputTokens), 0) AS outputTokens FROM model_calls WHERE runId = ?')
    .get(runId)!;
  return { costUsd: num(row.costUsd), inputTokens: Number(row.inputTokens), outputTokens: Number(row.outputTokens) };
}

// migration 006 dropped sandbox_execs and m9 brings it back, so the spans read it only when it has the columns they use.
function hasSandbox(db: Db): boolean {
  const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sandbox_execs'").get();
  if (!table) return false;
  const columns = new Set(db.prepare("SELECT name FROM pragma_table_info('sandbox_execs')").all().map((row) => String(row.name)));
  return ['runId', 'durationMs', 'createdAt'].every((column) => columns.has(column));
}

// the method, the host and the path of a google request. the query string can hold the words of a search, so it is cut.
function googleLabel(method: string, url: string): string {
  try {
    const parsed = new URL(url);
    return `${method} ${parsed.host}${parsed.pathname}`;
  } catch {
    return `${method} ${url.split('?')[0]}`;
  }
}

// the waterfall of one run and of its child runs. a run that does not exist gives undefined.
export function runSpans(db: Db, runId: string): RunSpans | undefined {
  const run = db.prepare('SELECT * FROM runs WHERE id = ?').get(runId);
  if (!run) return undefined;
  const startedAt = String(run.startedAt);
  const endedAt = str(run.endedAt);
  const walk: Walk = { db, origin: Date.parse(startedAt), spans: [], visited: new Set([runId]), costs: [], sandbox: hasSandbox(db) };
  const usage = usageOf(db, runId);
  if (usage.costUsd !== null) walk.costs.push(usage.costUsd);
  const root = span(walk, {
    id: `run:${runId}`,
    parentId: null,
    kind: 'run',
    label: `${String(run.trigger)} (${String(run.slot)})`,
    startAt: startedAt,
    endAt: endedAt,
    status: String(run.status),
    error: str(run.error),
    ...usage,
    ref: { kind: 'run', runId },
  });
  collect(walk, runId, root.id);
  const rank = (kind: SpanKind) => KIND_ORDER.indexOf(kind);
  const rest = walk.spans
    .slice(1)
    .sort((a, b) => a.startMs - b.startMs || rank(a.kind) - rank(b.kind) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return {
    runId,
    startedAt,
    endedAt,
    durationMs: endedAt === null ? null : Math.round(Date.parse(endedAt) - walk.origin),
    costUsd: walk.costs.length ? walk.costs.reduce((sum, cost) => sum + cost, 0) : null,
    spans: [root, ...rest],
  };
}

// adds the spans of one run below parentId: the run span for the root run, the sub-agent span for a child run.
function collect(walk: Walk, runId: string, parentId: string): void {
  const { db } = walk;
  const decisions = db.prepare('SELECT * FROM policy_decisions WHERE runId = ? ORDER BY id').all(runId);
  // a reviewer call is linked from the decision that it gave a verdict for.
  const reviewOf = new Map<number, Row>();
  for (const row of decisions) if (row.reviewerModelCallId !== null) reviewOf.set(Number(row.reviewerModelCallId), row);

  const modelRows = db
    .prepare(
      `SELECT model_calls.*, EXISTS (SELECT 1 FROM tool_catalog_snapshots, json_each(tool_catalog_snapshots.tools)
         WHERE hash = model_calls.toolCatalogHash AND json_extract(json_each.value, '$.name') = ?) AS isReview
       FROM model_calls WHERE runId = ? ORDER BY id`,
    )
    .all(REVIEW_TOOL, runId);
  // the model spans of the run and the ids of the tool calls that each one asked for, in the order of the calls.
  const turns: Array<{ id: string; asked: Set<string> }> = [];
  const reviews: Row[] = [];
  for (const row of modelRows) {
    if (reviewOf.has(Number(row.id)) || row.isReview === 1) {
      reviews.push(row);
      continue;
    }
    const response = row.response ? (JSON.parse(String(row.response)) as { toolCalls?: Array<{ id?: unknown }> } | null) : null;
    const made = span(walk, {
      id: `model:${Number(row.id)}`,
      parentId,
      kind: 'model',
      label: `${String(row.model)} (${String(row.slot)})`,
      startAt: minus(String(row.createdAt), Number(row.latencyMs)),
      endAt: String(row.createdAt),
      status: row.error !== null ? 'error' : str(row.stopReason),
      error: str(row.error),
      costUsd: num(row.costUsd),
      inputTokens: Number(row.inputTokens),
      outputTokens: Number(row.outputTokens),
      ref: { kind: 'model', modelCallId: Number(row.id) },
    });
    turns.push({ id: made.id, asked: new Set((response?.toolCalls ?? []).map((call) => String(call.id))) });
  }
  // a tool call goes inside the latest model call that asked for it. an approved call has no such model call.
  const askedBy = (toolCallId: string) => turns.findLast((turn) => turn.asked.has(toolCallId))?.id ?? parentId;

  // the tool span of each call id, so the rows that a tool call made can find it. the first row of an id wins.
  const toolByCall = new Map<string, string>();
  const toolRows = new Set<number>();
  for (const row of db.prepare('SELECT * FROM tool_calls WHERE runId = ? ORDER BY id').all(runId)) {
    const toolCallId = String(row.toolCallId);
    const made = span(walk, {
      id: `tool:${Number(row.id)}`,
      parentId: askedBy(toolCallId),
      kind: 'tool',
      label: String(row.name),
      startAt: minus(String(row.createdAt), Number(row.durationMs)),
      endAt: String(row.createdAt),
      status: str(row.outcome) ?? (row.isError === 1 ? 'error' : 'ok'),
      ref: { kind: 'tool', toolCallRowId: Number(row.id), toolCallId },
    });
    toolRows.add(Number(row.id));
    if (!toolByCall.has(toolCallId)) toolByCall.set(toolCallId, made.id);
  }

  // the delegate row is written when the child ends, so until then the call is a placeholder that starts with the link.
  // its row id is negative and unique in the run, as in the run detail.
  const links = db
    .prepare(
      `SELECT subagent_runs.*, runs.status AS childStatus, runs.endedAt AS childEndedAt FROM subagent_runs
       LEFT JOIN runs ON runs.id = subagent_runs.childRunId WHERE subagent_runs.parentRunId = ? ORDER BY subagent_runs.id`,
    )
    .all(runId);
  links.forEach((link, index) => {
    const toolCallId = String(link.toolCallId);
    if (toolByCall.has(toolCallId)) return;
    const made = span(walk, {
      id: `tool:pending:${toolCallId}`,
      parentId: askedBy(toolCallId),
      kind: 'tool',
      label: 'delegate',
      startAt: String(link.createdAt),
      endAt: null,
      status: 'running',
      ref: { kind: 'tool', toolCallRowId: -1 - index, toolCallId },
    });
    toolByCall.set(toolCallId, made.id);
  });

  // a review call checks a tool call, or the reply when the call id is reply, which has no tool span.
  for (const row of reviews) {
    const decision = reviewOf.get(Number(row.id));
    const toolCallId = decision ? String(decision.toolCallId) : null;
    span(walk, {
      id: `review:${Number(row.id)}`,
      parentId: (toolCallId !== null && toolByCall.get(toolCallId)) || parentId,
      kind: 'review',
      label: `${String(row.model)} (${String(row.slot)})`,
      startAt: minus(String(row.createdAt), Number(row.latencyMs)),
      endAt: String(row.createdAt),
      status: decision ? toDecision(decision).reviewerVerdict : null,
      error: str(row.error),
      costUsd: num(row.costUsd),
      inputTokens: Number(row.inputTokens),
      outputTokens: Number(row.outputTokens),
      ref: { kind: 'review', modelCallId: Number(row.id), toolCallId },
    });
  }

  // an approval goes inside the tool call that ran under its decision. a pending one has no tool call yet.
  const approvals = db
    .prepare(
      `SELECT approvals.*, (SELECT tool_calls.id FROM tool_calls JOIN policy_decisions ON policy_decisions.id = tool_calls.policyDecisionId
         WHERE policy_decisions.approvalId = approvals.id ORDER BY tool_calls.id LIMIT 1) AS toolRowId
       FROM approvals WHERE runId = ? ORDER BY id`,
    )
    .all(runId);
  for (const row of approvals) {
    const toolRowId = num(row.toolRowId);
    span(walk, {
      id: `approval:${Number(row.id)}`,
      parentId: toolRowId !== null && toolRows.has(toolRowId) ? `tool:${toolRowId}` : parentId,
      kind: 'approval',
      label: String(row.toolName),
      startAt: String(row.requestedAt),
      endAt: str(row.resolvedAt),
      status: String(row.status),
      ref: { kind: 'approval', approvalId: Number(row.id) },
    });
  }

  // a sub-agent span lasts from the link to the end of the child run, and the spans of the child run go inside it.
  for (const link of links) {
    const childRunId = String(link.childRunId);
    const made = span(walk, {
      id: `subagent:${childRunId}`,
      parentId: toolByCall.get(String(link.toolCallId)) ?? parentId,
      kind: 'subagent',
      label: `sub-agent ${String(link.profile)}`,
      startAt: String(link.createdAt),
      endAt: str(link.childEndedAt),
      status: str(link.childStatus),
      costUsd: usageOf(db, childRunId).costUsd,
      ref: { kind: 'subagent', childRunId },
    });
    // a link that points back into the walk would add the same spans again, so a child is walked only once.
    if (walk.visited.has(childRunId)) continue;
    walk.visited.add(childRunId);
    if (made.costUsd !== null) walk.costs.push(made.costUsd);
    collect(walk, childRunId, made.id);
  }

  // an mcp request pairs with the first answer after it that has the same server, rpc id and tool call. a
  // notification has no rpc id and gets no span.
  const answerOf = db.prepare(
    "SELECT * FROM mcp_messages WHERE direction = 'in' AND serverId = ? AND rpcId = ? AND toolCallId IS ? AND id > ? ORDER BY id LIMIT 1",
  );
  for (const row of db.prepare("SELECT * FROM mcp_messages WHERE runId = ? AND direction IN ('out', 'unsent') AND rpcId IS NOT NULL ORDER BY id").all(runId)) {
    const request = toMcpMessage(row);
    const unsent = request.direction === 'unsent';
    const answerRow = unsent ? undefined : answerOf.get(request.serverId, request.rpcId, request.toolCallId, request.id);
    const answer = answerRow ? toMcpMessage(answerRow) : null;
    span(walk, {
      id: `mcp:${request.id}`,
      parentId: (request.toolCallId !== null && toolByCall.get(request.toolCallId)) || parentId,
      kind: 'mcp',
      label: `${request.serverId} ${request.method ?? ''}`.trim(),
      startAt: request.createdAt,
      endAt: unsent ? request.createdAt : (answer?.createdAt ?? null),
      status: unsent ? 'unsent' : answer === null ? null : answer.error !== null ? 'error' : 'ok',
      error: answer?.error ?? null,
      ref: { kind: 'mcp', mcpMessageId: request.id },
    });
  }

  // a google request row is written before the request leaves, so createdAt is the start and latencyMs gives the end.
  // a row with no latency but with a status or an error ended without a time.
  for (const row of db.prepare('SELECT * FROM google_requests WHERE runId = ? ORDER BY id').all(runId)) {
    const createdAt = String(row.createdAt);
    const ended = row.status !== null || row.error !== null;
    const toolCallId = str(row.toolCallId);
    span(walk, {
      id: `google:${Number(row.id)}`,
      parentId: (toolCallId !== null && toolByCall.get(toolCallId)) || parentId,
      kind: 'google',
      label: googleLabel(String(row.method), String(row.url)),
      startAt: createdAt,
      endAt: row.latencyMs !== null ? plus(createdAt, Number(row.latencyMs)) : ended ? createdAt : null,
      status: row.status !== null ? String(row.status) : row.error !== null ? 'error' : null,
      error: str(row.error),
      ref: { kind: 'google', googleRequestId: Number(row.id) },
    });
  }

  for (const row of db.prepare('SELECT * FROM browser_steps WHERE runId = ? ORDER BY id').all(runId)) {
    const toolCallId = str(row.toolCallId);
    span(walk, {
      id: `browser:${Number(row.id)}`,
      parentId: (toolCallId !== null && toolByCall.get(toolCallId)) || parentId,
      kind: 'browser',
      label: String(row.action),
      startAt: minus(String(row.createdAt), Number(row.durationMs)),
      endAt: String(row.createdAt),
      status: row.error !== null ? 'error' : 'ok',
      error: str(row.error),
      ref: { kind: 'browser', browserStepId: Number(row.id), taskId: String(row.taskId) },
    });
  }

  if (!walk.sandbox) return;
  for (const row of db.prepare('SELECT * FROM sandbox_execs WHERE runId = ? ORDER BY id').all(runId)) {
    const toolCallId = str(row.toolCallId);
    span(walk, {
      id: `sandbox:${Number(row.id)}`,
      parentId: (toolCallId !== null && toolByCall.get(toolCallId)) || parentId,
      kind: 'sandbox',
      label: str(row.command) ?? 'sandbox',
      startAt: minus(String(row.createdAt), Number(row.durationMs)),
      endAt: String(row.createdAt),
      status: str(row.exitCode),
      error: str(row.error),
      ref: { kind: 'sandbox', sandboxExecId: Number(row.id) },
    });
  }
}

export function mountSpans(server: Hono, deps: DashboardDeps): void {
  const { db } = deps;
  server.get('/api/runs/:id/spans', (c) => {
    const spans = runSpans(db, c.req.param('id'));
    return spans ? c.json(spans) : c.json({ error: 'run not found' }, 404);
  });
}
