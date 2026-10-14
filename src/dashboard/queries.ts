import type { Config } from '../config/schema.js';
import type { Db } from '../db/index.js';
import { goalStats, listGoals, type Goal } from '../goals/store.js';
import { redact, redactValue } from '../observability/redact.js';
import type { Rule } from '../policy/policy.js';
import { REPLY_CALL_ID, REPLY_NOTE, REPLY_TOOL } from '../policy/reply.js';
import { REVIEW_TOOL } from '../policy/reviewer.js';
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
  McpMessageRow,
  ModelCallBody,
  ModelCallRow,
  Overview,
  PolicyDecisionRow,
  PolicyPage,
  RunDetail,
  RunRow,
  SessionRow,
  SubagentLink,
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

export function toDecision(row: Row): PolicyDecisionRow {
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

// the error is read from the payload, so the page can mark a failed message without a new column. a payload in the
// blob store is not read here, so its error shows only when the owner opens it.
export function toMcpMessage(row: Row): McpMessageRow {
  const payload = row.payload === null ? null : (JSON.parse(String(row.payload)) as Record<string, unknown>);
  const error = payload?.error as { message?: unknown } | string | undefined;
  const result = payload?.result as { isError?: unknown; content?: Array<{ type?: string; text?: unknown }> } | undefined;
  const failed =
    typeof error === 'string'
      ? error
      : typeof error?.message === 'string'
        ? error.message
        : result?.isError === true
          ? String(result.content?.find((block) => block.type === 'text')?.text ?? 'the tool gave an error')
          : null;
  return {
    id: Number(row.id),
    serverId: String(row.serverId),
    direction: row.direction === 'in' ? 'in' : row.direction === 'unsent' ? 'unsent' : 'out',
    method: str(row.method),
    rpcId: str(row.rpcId),
    runId: str(row.runId),
    toolCallId: str(row.toolCallId),
    latencyMs: num(row.latencyMs),
    createdAt: String(row.createdAt),
    payload,
    payloadBlob: str(row.payloadBlob),
    error: failed,
  };
}

export function toToolCall(row: Row, decisions: Map<number, PolicyDecisionRow>, messages: McpMessageRow[] = []): ToolCallRow {
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
    serverId: str(row.serverId),
    mcpMessages: messages.filter((message) => message.toolCallId === String(row.toolCallId) && message.serverId === row.serverId),
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
         WHERE hash = model_calls.toolCatalogHash) AS toolCount,
         EXISTS (SELECT 1 FROM tool_catalog_snapshots, json_each(tool_catalog_snapshots.tools)
           WHERE hash = model_calls.toolCatalogHash AND json_extract(json_each.value, '$.name') = ?) AS isReview
       FROM model_calls WHERE runId = ? ORDER BY id`,
    )
    .all(REVIEW_TOOL, id);
  const decisions = new Map(
    db
      .prepare(
        `SELECT policy_decisions.*, approvals.status AS approvalStatus FROM policy_decisions
         LEFT JOIN approvals ON approvals.id = policy_decisions.approvalId WHERE policy_decisions.runId = ?`,
      )
      .all(id)
      .map((row) => [Number(row.id), toDecision(row)]),
  );
  const messages = db.prepare('SELECT * FROM mcp_messages WHERE runId = ? ORDER BY id').all(id).map(toMcpMessage);
  const tools = db
    .prepare('SELECT * FROM tool_calls WHERE runId = ? ORDER BY id')
    .all(id)
    .map((row) => toToolCall(row, decisions, messages));
  // a reviewer call goes inside the tool call that it checked, not among the turns of the agent.
  const reviews = new Map([...decisions.values()].flatMap((decision) => (decision.reviewerModelCallId === null ? [] : [[decision.reviewerModelCallId, decision] as const])));
  const links = subagentLinks(db, 'subagent_runs.parentRunId = ?', id);
  // a delegate call has no tool_calls row while its child runs, so its placeholder finds its decision by the call id.
  // the decision then shows its reviewer call, which is not a turn of the agent.
  const decisionOf = (toolCallId: string) => {
    const row = db.prepare('SELECT id FROM policy_decisions WHERE runId = ? AND toolCallId = ? ORDER BY id DESC LIMIT 1').get(id, toolCallId);
    return row ? (decisions.get(Number(row.id)) ?? null) : null;
  };
  const placed = new Set<number>();
  const pending = new Set<SubagentLink>();
  const timeline: TimelineItem[] = [];
  for (const row of modelRows) {
    const reviewed = reviews.get(Number(row.id));
    if (reviewed) {
      reviewed.reviewerCall = toModelCall(row);
      continue;
    }
    const last = timeline.at(-1);
    // a reviewer call that gave no verdict (an error, a retry, or an answer that is not clear) has no link from a
    // decision. tool calls of one turn run at the same time, so it goes with the turn whose tool calls it checked.
    if (row.isReview === 1 && last?.kind === 'model') {
      (last.reviews ??= []).push(toModelCall(row));
      continue;
    }
    const response = row.response ? (JSON.parse(String(row.response)) as { toolCalls?: Array<{ id: string; input: unknown }> }) : undefined;
    const asked: ToolCallRow[] = [];
    for (const requested of response?.toolCalls ?? []) {
      const tool = tools.find((call) => call.toolCallId === requested.id && !placed.has(call.id));
      if (tool) {
        placed.add(tool.id);
        asked.push(tool);
        continue;
      }
      // the delegate row is written when the child ends. until then, the call shows as running with its child. a
      // crash can stop both runs before the row exists, and the row comes only at the next run of the session. so a
      // call of a closed run, or with a closed child, shows as interrupted.
      const link = links.find((each) => each.toolCallId === requested.id);
      const live = run.status === 'running' && (link?.status === null || link?.status === 'running');
      if (link) {
        asked.push(pendingDelegate(id, requested, link, -1 - links.indexOf(link), live, decisionOf(requested.id)));
        pending.add(link);
      }
    }
    timeline.push({ kind: 'model', call: toModelCall(row), tools: asked });
  }
  for (const tool of tools) if (!placed.has(tool.id)) timeline.push({ kind: 'tool', call: tool });
  for (const link of links) {
    const tool = tools.find((call) => call.name === 'delegate' && call.toolCallId === link.toolCallId);
    if (tool) tool.child = link;
    // an approved delegate call runs after its run ended, and no model call asked for it under its id (approval-N).
    // its row comes when the child ends, so until then it shows as a call of its own with the child. the run is
    // closed, so only the status of the child tells if it still runs.
    else if (!pending.has(link)) {
      const approval = db.prepare('SELECT input FROM approvals WHERE id = ?').get(Number(link.toolCallId.replace(/^approval-/, '')));
      const requested = { id: link.toolCallId, input: approval ? JSON.parse(String(approval.input)) : null };
      const live = link.status === null || link.status === 'running';
      timeline.push({ kind: 'tool', call: pendingDelegate(id, requested, link, -1 - links.indexOf(link), live, decisionOf(requested.id)) });
    }
  }
  const events = db.prepare('SELECT * FROM events WHERE runId = ? ORDER BY id').all(id).map(toEventRow);
  const reply = decisionOf(REPLY_CALL_ID);
  if (reply) timeline.push({ kind: 'tool', call: replyCheck(id, run.status === 'running', reply, events) });
  return { run, parent: subagentLinks(db, 'subagent_runs.childRunId = ?', id)[0] ?? null, timeline, events };
}

// the reply guard has no tool call, so its decision shows as a call of reply_to_owner. the item holds the reviewer call
// and says what went to the chat, because the log keeps the full reply.
function replyCheck(runId: string, live: boolean, policy: PolicyDecisionRow, events: EventRow[]): ToolCallRow {
  const reply = events.findLast((event) => event.type === 'assistant_message');
  const note = events.findLast((event) => event.type === 'note' && String(event.payload.text).startsWith(REPLY_NOTE));
  const allowed = policy.reviewerVerdict === 'allow';
  const content = note
    ? String(note.payload.text)
    : allowed
      ? 'The reviewer allowed the links, so the reply went to the chat as it is.'
      : live
        ? 'The reviewer checks the links in the reply. The reply goes to the chat after the check.'
        : 'The app stopped while the reviewer checked the reply, so the reply did not go to the chat.';
  return {
    id: -1_000_000,
    runId,
    toolCallId: REPLY_CALL_ID,
    name: REPLY_TOOL,
    input: { text: reply ? String(reply.payload.text) : '' },
    output: { content },
    isError: !allowed && !live && !note,
    durationMs: 0,
    createdAt: policy.createdAt,
    source: 'builtin',
    riskLevel: 'write',
    tainted: true,
    untrustedSource: null,
    truncated: false,
    resultHandle: null,
    rawResultBlob: null,
    outcome: note ? 'held' : allowed ? 'ran' : live ? 'running' : 'interrupted',
    policy,
    serverId: null,
    mcpMessages: [],
  };
}

// the call has no tool_calls row yet, so its id is negative and unique in the run.
function pendingDelegate(runId: string, requested: { id: string; input: unknown }, link: SubagentLink, rowId: number, live: boolean, policy: PolicyDecisionRow | null): ToolCallRow {
  return {
    id: rowId,
    runId,
    toolCallId: requested.id,
    name: 'delegate',
    input: requested.input,
    output: { content: live ? 'The sub-agent is still running.' : 'The app stopped while the sub-agent ran, so the call has no result.' },
    isError: !live,
    durationMs: 0,
    createdAt: '',
    source: 'builtin',
    riskLevel: null,
    tainted: false,
    untrustedSource: null,
    truncated: false,
    resultHandle: null,
    rawResultBlob: null,
    outcome: live ? 'running' : 'interrupted',
    policy,
    serverId: null,
    mcpMessages: [],
    child: link,
  };
}

function subagentLinks(db: Db, where: string, id: string): SubagentLink[] {
  return db
    .prepare(
      `SELECT subagent_runs.*, runs.status, (SELECT SUM(costUsd) FROM model_calls WHERE runId = subagent_runs.childRunId) AS costUsd
       FROM subagent_runs LEFT JOIN runs ON runs.id = subagent_runs.childRunId WHERE ${where} ORDER BY subagent_runs.id`,
    )
    .all(id)
    .map((row) => ({
      parentRunId: String(row.parentRunId),
      toolCallId: String(row.toolCallId),
      childRunId: String(row.childRunId),
      profile: String(row.profile),
      status: str(row.status),
      costUsd: num(row.costUsd),
    }));
}

export function getModelCallBody(db: Db, id: number): ModelCallBody | undefined {
  const row = db
    .prepare(
      `SELECT m.request, m.response, s.tools FROM model_calls m
       LEFT JOIN tool_catalog_snapshots s ON s.hash = m.toolCatalogHash WHERE m.id = ?`,
    )
    .get(id);
  if (!row) return undefined;
  // a new row keeps its tool list only in the snapshot. an older row has the list in the request itself.
  const request = JSON.parse(String(row.request));
  if (request.tools === undefined && row.tools) request.tools = JSON.parse(String(row.tools));
  return { request, response: row.response ? JSON.parse(String(row.response)) : null };
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
      input: redactValue(JSON.parse(String(row.input)) as unknown),
      status: String(row.status),
      requestedAt: String(row.requestedAt),
      resolvedAt: str(row.resolvedAt),
      resolvedBy: str(row.resolvedBy),
    }));
}

// the reviewer decides each write call without the owner, so this list is the one place that shows what it allowed or
// held. a reason can quote the input of the call, so it is redacted.
export function policyPage(db: Db, rules: readonly Rule[], filter: { decision?: string; verdict?: string }, limit = 200): PolicyPage {
  const where = [...(filter.decision ? ['d.decision = @decision'] : []), ...(filter.verdict ? ['d.reviewerVerdict = @verdict'] : [])];
  const decisions = db
    .prepare(
      `SELECT d.*, approvals.status AS approvalStatus, runs.sessionKey FROM policy_decisions d
       JOIN runs ON runs.id = d.runId LEFT JOIN approvals ON approvals.id = d.approvalId
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY d.id DESC LIMIT @limit`,
    )
    .all({ ...(filter.decision ? { decision: filter.decision } : {}), ...(filter.verdict ? { verdict: filter.verdict } : {}), limit })
    .map((row) => {
      const decision = toDecision(row);
      return {
        ...decision,
        reason: redact(decision.reason),
        reviewerReason: decision.reviewerReason === null ? null : redact(decision.reviewerReason),
        runId: String(row.runId),
        sessionKey: String(row.sessionKey),
        toolName: String(row.toolName),
      };
    });
  return {
    decisions,
    rules: rules.map((rule) => ({ id: rule.id, tool: rule.tool, session: rule.session ?? null, args: rule.args ?? null, effect: rule.effect, note: rule.note ?? null })),
  };
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
