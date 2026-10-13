import type { Config } from '../config/schema.js';
import type { Db } from '../db/index.js';
import { goalStats, listGoals, type Goal } from '../goals/store.js';
import { redact } from '../observability/redact.js';
import { outcomeOf } from './outcome.js';
import { getChecklist, inActiveHours } from '../scheduler/heartbeat.js';
import { describeSchedule } from '../scheduler/schedule.js';
import { listAutomations, type Automation } from '../scheduler/store.js';
import { addDays, localDay, zonedToUtc } from '../time.js';
import type {
  ApprovalRow,
  AutomationRow,
  AutomationRunRow,
  BlobBody,
  CostGroup,
  CostPage,
  EventRow,
  GoalRow,
  GoalsPage,
  HeartbeatStatus,
  ModelCallBody,
  ModelCallRow,
  Overview,
  PolicyDecisionRow,
  RunDetail,
  RunRow,
  SessionRow,
  TimelineItem,
  ToolCallRow,
  ToolCatalog,
} from './types.js';

type Row = Record<string, unknown>;
type Settings = Pick<Config, 'timeZone' | 'heartbeat'>;

const str = (value: unknown) => (value === null || value === undefined ? null : String(value));
const num = (value: unknown) => (value === null || value === undefined ? null : Number(value));

// a day is in the owner's time zone. the database keeps utc, so the query needs the utc bounds of the day.
export function dayBounds(from: string, to: string, timeZone: string): [string, string] {
  return [zonedToUtc(from, '00:00', timeZone).toISOString(), zonedToUtc(addDays(to, 1), '00:00', timeZone).toISOString()];
}

const RUN_SELECT = `SELECT runs.*,
    (SELECT SUM(costUsd) FROM model_calls WHERE runId = runs.id) AS costUsd,
    (SELECT COUNT(*) FROM model_calls WHERE runId = runs.id) AS modelCalls,
    (SELECT COUNT(*) FROM tool_calls WHERE runId = runs.id) AS toolCalls
  FROM runs`;

function toRun(row: Row): RunRow {
  return {
    id: String(row.id),
    sessionKey: String(row.sessionKey),
    trigger: String(row.trigger),
    slot: String(row.slot),
    status: String(row.status),
    startedAt: String(row.startedAt),
    endedAt: str(row.endedAt),
    error: str(row.error),
    costUsd: num(row.costUsd),
    modelCalls: Number(row.modelCalls),
    toolCalls: Number(row.toolCalls),
  };
}

export interface RunFilter {
  trigger?: string;
  slot?: string;
  status?: string;
  day?: string;
  limit?: number;
}

export function listRuns(db: Db, filter: RunFilter, timeZone: string): RunRow[] {
  const where: string[] = [];
  const params: string[] = [];
  for (const key of ['trigger', 'slot', 'status'] as const) {
    if (filter[key]) {
      where.push(`runs.${key} = ?`);
      params.push(filter[key]);
    }
  }
  if (filter.day) {
    where.push('runs.startedAt >= ? AND runs.startedAt < ?');
    params.push(...dayBounds(filter.day, filter.day, timeZone));
  }
  const sql = `${RUN_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY runs.startedAt DESC, runs.rowid DESC LIMIT ${Math.min(filter.limit ?? 200, 1000)}`;
  return db.prepare(sql).all(...params).map(toRun);
}

export function getRun(db: Db, id: string): RunRow | undefined {
  const row = db.prepare(`${RUN_SELECT} WHERE runs.id = ?`).get(id);
  return row ? toRun(row) : undefined;
}

function toModelCall(row: Row): ModelCallRow {
  return {
    id: Number(row.id),
    runId: str(row.runId),
    slot: String(row.slot),
    provider: String(row.provider),
    model: String(row.model),
    inputTokens: Number(row.inputTokens),
    outputTokens: Number(row.outputTokens),
    cacheReadTokens: Number(row.cacheReadTokens),
    cacheWriteTokens: Number(row.cacheWriteTokens),
    costUsd: num(row.costUsd),
    latencyMs: Number(row.latencyMs),
    stopReason: str(row.stopReason),
    error: str(row.error),
    createdAt: String(row.createdAt),
    toolCatalogHash: str(row.toolCatalogHash),
    toolCount: num(row.toolCount),
  };
}

function toDecision(row: Row): PolicyDecisionRow {
  return {
    id: Number(row.id),
    decision: String(row.decision),
    rule: String(row.rule),
    reason: String(row.reason),
    reviewerModelCallId: num(row.reviewerModelCallId),
    reviewerVerdict: str(row.reviewerVerdict),
    reviewerReason: str(row.reviewerReason),
    approvalId: num(row.approvalId),
    approvalStatus: str(row.approvalStatus),
    taint: row.taint ? JSON.parse(String(row.taint)) : [],
    createdAt: String(row.createdAt),
  };
}

function toToolCall(row: Row, decisions: Map<number, PolicyDecisionRow>): ToolCallRow {
  const policy = row.policyDecisionId === null ? null : (decisions.get(Number(row.policyDecisionId)) ?? null);
  return {
    id: Number(row.id),
    runId: String(row.runId),
    toolCallId: String(row.toolCallId),
    name: String(row.name),
    input: JSON.parse(String(row.input)),
    output: JSON.parse(String(row.output)),
    isError: row.isError === 1,
    durationMs: Number(row.durationMs),
    createdAt: String(row.createdAt),
    source: String(row.source),
    riskLevel: str(row.riskLevel),
    tainted: row.tainted === 1,
    untrustedSource: str(row.untrustedSource),
    truncated: row.truncated === 1,
    resultHandle: str(row.resultHandle),
    rawResultBlob: str(row.rawResultBlob),
    outcome: outcomeOf({
      toolCallId: String(row.toolCallId),
      isError: row.isError === 1,
      stored: str(row.outcome),
      riskLevel: str(row.riskLevel),
      decision: policy,
    }),
    policy,
  };
}

export function toEventRow(row: Row): EventRow {
  return {
    id: Number(row.id),
    sessionKey: String(row.sessionKey),
    runId: str(row.runId),
    seq: Number(row.seq),
    type: String(row.type),
    payload: JSON.parse(String(row.payload)),
    createdAt: String(row.createdAt),
  };
}

// a fixed clock gives many rows the same time, so the timeline does not sort by time. each tool call goes inside the
// model call that asked for it. a tool call that ran after an approval has no such model call, so it goes last.
export function getRunDetail(db: Db, id: string): RunDetail | undefined {
  const run = getRun(db, id);
  if (!run) return undefined;
  const modelRows = db
    .prepare(
      `SELECT model_calls.*, (SELECT json_array_length(tools) FROM tool_catalog_snapshots
         WHERE hash = model_calls.toolCatalogHash) AS toolCount
       FROM model_calls WHERE runId = ? ORDER BY id`,
    )
    .all(id);
  const decisions = new Map(
    db
      .prepare(
        `SELECT policy_decisions.*, approvals.status AS approvalStatus FROM policy_decisions
         LEFT JOIN approvals ON approvals.id = policy_decisions.approvalId WHERE policy_decisions.runId = ?`,
      )
      .all(id)
      .map((row) => [Number(row.id), toDecision(row)]),
  );
  const tools = db
    .prepare('SELECT * FROM tool_calls WHERE runId = ? ORDER BY id')
    .all(id)
    .map((row) => toToolCall(row, decisions));
  const placed = new Set<number>();
  const timeline: TimelineItem[] = [];
  for (const row of modelRows) {
    const response = row.response ? (JSON.parse(String(row.response)) as { toolCalls?: Array<{ id: string }> }) : undefined;
    const asked: ToolCallRow[] = [];
    for (const requested of response?.toolCalls ?? []) {
      const tool = tools.find((call) => call.toolCallId === requested.id && !placed.has(call.id));
      if (!tool) continue;
      placed.add(tool.id);
      asked.push(tool);
    }
    timeline.push({ kind: 'model', call: toModelCall(row), tools: asked });
  }
  for (const tool of tools) if (!placed.has(tool.id)) timeline.push({ kind: 'tool', call: tool });
  const events = db.prepare('SELECT * FROM events WHERE runId = ? ORDER BY id').all(id).map(toEventRow);
  return { run, timeline, events };
}

export function getModelCallBody(db: Db, id: number): ModelCallBody | undefined {
  const row = db.prepare('SELECT request, response FROM model_calls WHERE id = ?').get(id);
  if (!row) return undefined;
  return { request: JSON.parse(String(row.request)), response: row.response ? JSON.parse(String(row.response)) : null };
}

export function getBlob(db: Db, read: (hash: string) => string | undefined, hash: string): BlobBody | undefined {
  const row = db.prepare('SELECT * FROM blobs WHERE hash = ?').get(hash);
  const text = row ? read(hash) : undefined;
  if (!row || text === undefined) return undefined;
  return { hash, size: Number(row.size), mime: String(row.mime), createdAt: String(row.createdAt), text };
}

export function getToolCatalog(db: Db, hash: string): ToolCatalog | undefined {
  const row = db.prepare('SELECT * FROM tool_catalog_snapshots WHERE hash = ?').get(hash);
  if (!row) return undefined;
  return { hash, createdAt: String(row.createdAt), tools: JSON.parse(String(row.tools)) };
}

export function listSessions(db: Db): SessionRow[] {
  return db
    .prepare(
      `SELECT sessionKey, COUNT(*) AS events, SUM(type = 'compaction') AS compactions,
         MIN(createdAt) AS firstAt, MAX(createdAt) AS lastAt
       FROM events GROUP BY sessionKey ORDER BY MAX(id) DESC`,
    )
    .all()
    .map((row) => ({
      sessionKey: String(row.sessionKey),
      events: Number(row.events),
      compactions: Number(row.compactions),
      firstAt: String(row.firstAt),
      lastAt: String(row.lastAt),
    }));
}

export function sessionEvents(db: Db, sessionKey: string): EventRow[] {
  return db.prepare('SELECT * FROM events WHERE sessionKey = ? ORDER BY seq').all(sessionKey).map(toEventRow);
}

function toGoal(goal: Goal): GoalRow {
  return {
    id: goal.id,
    day: goal.day,
    title: goal.title,
    eta: goal.eta,
    status: goal.status,
    completedAt: goal.completedAt,
    note: goal.note,
  };
}

export function goalsPage(db: Db, now: Date, timeZone: string, days = 30): GoalsPage {
  const today = localDay(now, timeZone);
  const from = addDays(today, -(days - 1));
  const goals = listGoals(db, from, today);
  const perDay = Array.from({ length: days }, (_, i) => {
    const day = addDays(from, i);
    const ofDay = goals.filter((goal) => goal.day === day);
    return { day, goals: ofDay.length, done: ofDay.filter((goal) => goal.status === 'done').length };
  });
  return {
    today,
    goals: goals.map(toGoal),
    days: perDay,
    stats7: goalStats(db, addDays(today, -6), today),
    stats30: goalStats(db, from, today),
  };
}

function toAutomationRow(automation: Automation, timeZone: string): AutomationRow {
  return {
    id: automation.id,
    name: automation.name,
    schedule: describeSchedule(automation.schedule, timeZone),
    payloadType: automation.payload.type,
    sessionMode: automation.sessionMode,
    slot: automation.slot,
    enabled: automation.enabled,
    createdBy: automation.createdBy,
    nextRunAt: automation.nextRunAt,
    lastRunAt: automation.lastRunAt,
    consecutiveFailures: automation.consecutiveFailures,
  };
}

export function automations(db: Db, timeZone: string): AutomationRow[] {
  return listAutomations(db).map((automation) => toAutomationRow(automation, timeZone));
}

function toAutomationRun(row: Row): AutomationRunRow {
  return {
    id: Number(row.id),
    automationId: String(row.automationId),
    runId: str(row.runId),
    status: String(row.status),
    startedAt: String(row.startedAt),
    endedAt: str(row.endedAt),
    error: str(row.error),
  };
}

export function automationRuns(db: Db, automationId: string, limit = 50): AutomationRunRow[] {
  return db
    .prepare('SELECT * FROM automation_runs WHERE automationId = ? ORDER BY id DESC LIMIT ?')
    .all(automationId, limit)
    .map(toAutomationRun);
}

export function heartbeatStatus(db: Db, now: Date, settings: Settings): HeartbeatStatus {
  const automation = listAutomations(db).find((candidate) => candidate.payload.type === 'heartbeat');
  const [lastRun] = automation ? automationRuns(db, automation.id, 1) : [];
  return {
    automation: automation ? toAutomationRow(automation, settings.timeZone) : null,
    every: settings.heartbeat.every,
    activeHours: settings.heartbeat.activeHours,
    inActiveHours: inActiveHours(now, settings.timeZone, settings.heartbeat.activeHours),
    checklist: getChecklist(db),
    lastRun: lastRun ?? null,
  };
}

export function overview(db: Db, now: Date, settings: Settings): Overview {
  const day = localDay(now, settings.timeZone);
  const [from, to] = dayBounds(day, day, settings.timeZone);
  const runs = db
    .prepare(`SELECT COUNT(*) AS runs, SUM(status = 'failed') AS failed FROM runs WHERE startedAt >= ? AND startedAt < ?`)
    .get(from, to)!;
  const calls = db
    .prepare(
      `SELECT SUM(costUsd) AS cost, SUM(error IS NOT NULL) AS errors FROM model_calls WHERE createdAt >= ? AND createdAt < ?`,
    )
    .get(from, to)!;
  return {
    day,
    costUsd: Number(calls.cost ?? 0),
    runs: Number(runs.runs),
    failedRuns: Number(runs.failed ?? 0),
    modelErrors: Number(calls.errors ?? 0),
    openGoals: listGoals(db, day)
      .filter((goal) => goal.status === 'open')
      .map(toGoal),
    nextAutomations: automations(db, settings.timeZone)
      .filter((automation) => automation.enabled && automation.nextRunAt)
      .slice(0, 5),
    heartbeat: heartbeatStatus(db, now, settings),
    blobs: blobTotals(db),
  };
}

function blobTotals(db: Db): Overview['blobs'] {
  const row = db.prepare('SELECT COUNT(*) AS count, SUM(size) AS bytes FROM blobs').get()!;
  return { count: Number(row.count), bytes: Number(row.bytes ?? 0) };
}

// the stored input of an approval is not redacted, because the tool runs again with it. the dashboard redacts the
// summary and the input. the owner checks the full input here when the summary cuts a long field.
export function listApprovals(db: Db): ApprovalRow[] {
  return db
    .prepare(
      `SELECT approvals.*, runs.sessionKey FROM approvals JOIN runs ON runs.id = approvals.runId
       ORDER BY approvals.status = 'pending' DESC, approvals.id DESC LIMIT 200`,
    )
    .all()
    .map((row) => ({
      id: Number(row.id),
      runId: String(row.runId),
      sessionKey: String(row.sessionKey),
      toolName: String(row.toolName),
      summary: redact(String(row.summary)),
      input: JSON.parse(redact(String(row.input))) as unknown,
      status: String(row.status),
      requestedAt: String(row.requestedAt),
      resolvedAt: str(row.resolvedAt),
      resolvedBy: str(row.resolvedBy),
    }));
}

// the owner's days do not match utc days, so the grouping by day happens here and not in sql.
export function costPage(db: Db, now: Date, timeZone: string, days = 30): CostPage {
  const to = localDay(now, timeZone);
  const from = addDays(to, -(days - 1));
  const rows = db
    .prepare(
      `SELECT slot, provider, model, costUsd, error, inputTokens, outputTokens, cacheReadTokens, createdAt
       FROM model_calls WHERE createdAt >= ? AND createdAt < ?`,
    )
    .all(...dayBounds(from, to, timeZone));
  const groups = (keyOf: (row: Row) => string, keys: string[] = []) => {
    const byKey = new Map<string, CostGroup>(keys.map((key) => [key, emptyGroup(key)]));
    for (const row of rows) {
      const key = keyOf(row);
      const group = byKey.get(key) ?? emptyGroup(key);
      group.costUsd += Number(row.costUsd ?? 0);
      group.calls += 1;
      group.inputTokens += Number(row.inputTokens);
      group.outputTokens += Number(row.outputTokens);
      group.cacheReadTokens += Number(row.cacheReadTokens);
      byKey.set(key, group);
    }
    return [...byKey.values()];
  };
  const allDays = Array.from({ length: days }, (_, i) => addDays(from, i));
  const byCost = (a: CostGroup, b: CostGroup) => b.costUsd - a.costUsd || b.calls - a.calls;
  return {
    from,
    to,
    days: groups((row) => localDay(new Date(String(row.createdAt)), timeZone), allDays),
    slots: groups((row) => String(row.slot)).sort(byCost),
    models: groups((row) => `${String(row.provider)}/${String(row.model)}`).sort(byCost),
    unpricedCalls: rows.filter((row) => row.costUsd === null && row.error === null).length,
  };
}

function emptyGroup(key: string): CostGroup {
  return { key, costUsd: 0, calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };
}
