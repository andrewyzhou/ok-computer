import type { Db } from '../db/index.js';
import { outcomeOf } from './outcome.js';
import type { LogLine, PolicyDecisionRow, StreamApproval, StreamMessage, StreamPolicy } from './types.js';
import { getRun, toDecision, toEventRow } from './queries.js';

// the feed reads the database and the log file again on each poll. it needs no hooks in the code that writes them,
// so it also sees rows from another process.
export function createFeed(db: Db, tail: () => LogLine[]): () => StreamMessage[] {
  let lastEventId = Number(db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM events').get()!.id);
  let lastRunRow = Number(db.prepare('SELECT COALESCE(MAX(rowid), 0) AS id FROM runs').get()!.id);
  const running = new Set(
    db
      .prepare("SELECT id FROM runs WHERE status = 'running'")
      .all()
      .map((row) => String(row.id)),
  );
  const trace = createTraceFeed(db);

  return () => {
    const messages: StreamMessage[] = [];
    const changed = new Set<string>();
    for (const row of db.prepare('SELECT rowid AS rowNumber, id FROM runs WHERE rowid > ? ORDER BY rowid').all(lastRunRow)) {
      lastRunRow = Number(row.rowNumber);
      changed.add(String(row.id));
    }
    for (const id of running) changed.add(id);
    for (const id of changed) {
      const run = getRun(db, id);
      if (!run) continue;
      const known = running.has(id);
      if (run.status === 'running') running.add(id);
      else running.delete(id);
      // a known run that still runs did not change, so the feed does not send it again.
      if (!(known && run.status === 'running')) messages.push({ kind: 'run', run });
    }
    for (const row of db.prepare('SELECT * FROM events WHERE id > ? ORDER BY id').all(lastEventId)) {
      const event = toEventRow(row);
      lastEventId = event.id;
      messages.push({ kind: 'event', event });
    }
    messages.push(...trace());
    for (const line of tail()) messages.push({ kind: 'log', line });
    return messages;
  };
}

type Row = Record<string, unknown>;

// one poll reads at most this many rows of each table. a larger burst drains over the next polls.
const TRACE_BATCH = 500;

const str = (value: unknown) => (value === null || value === undefined ? null : String(value));
const num = (value: unknown) => (value === null || value === undefined ? null : Number(value));

const APPROVAL_COLUMNS = `approvals.id, approvals.runId, runs.sessionKey, approvals.toolName, approvals.summary, approvals.status,
  approvals.requestedAt, approvals.resolvedAt FROM approvals JOIN runs ON runs.id = approvals.runId`;

function toStreamApproval(row: Row): StreamApproval {
  return {
    id: Number(row.id),
    runId: String(row.runId),
    sessionKey: String(row.sessionKey),
    toolName: String(row.toolName),
    summary: String(row.summary),
    status: String(row.status),
    requestedAt: String(row.requestedAt),
    resolvedAt: str(row.resolvedAt),
  };
}

const DECISION_COLUMNS = `policy_decisions.id, policy_decisions.runId, policy_decisions.toolCallId, policy_decisions.toolName,
  policy_decisions.decision, policy_decisions.rule, policy_decisions.reviewerVerdict, policy_decisions.approvalId, policy_decisions.createdAt`;

function toStreamPolicy(row: Row): StreamPolicy {
  return {
    id: Number(row.id),
    runId: String(row.runId),
    toolCallId: String(row.toolCallId),
    toolName: String(row.toolName),
    decision: String(row.decision),
    rule: String(row.rule),
    reviewerVerdict: str(row.reviewerVerdict),
    approvalId: num(row.approvalId),
    createdAt: String(row.createdAt),
  };
}

// a review decision gets its verdict and an approve or review decision gets its approval after the row is written,
// so the feed watches these decisions while their run runs.
const WATCHED_DECISIONS = ['review', 'approve'];
const decisionState = (decision: StreamPolicy) => `${decision.reviewerVerdict ?? ''}|${decision.approvalId ?? ''}`;

// the feed of the trace rows. it gives the new model calls, tool calls, policy decisions, approvals and browser steps
// since the last call as the stream kinds model_call, tool_call, policy, approval and browser_step, with ids and
// summaries only. each table has its own id cursor, which starts at the newest row when the feed is made, so the rows
// that exist then are never sent. an approval goes out when it is asked for and again when it is resolved. approvals
// are not append-only, so the feed keeps the ids of the pending ones and reads them again on each call. a review or
// approve decision goes out when it is written and again when its verdict or its approval id changes, until its run
// ends.
export function createTraceFeed(db: Db): () => StreamMessage[] {
  const newest = (table: string) => Number(db.prepare(`SELECT COALESCE(MAX(id), 0) AS id FROM ${table}`).get()!.id);
  const cursor = {
    model_calls: newest('model_calls'),
    tool_calls: newest('tool_calls'),
    policy_decisions: newest('policy_decisions'),
    approvals: newest('approvals'),
    browser_steps: newest('browser_steps'),
  };
  const pending = new Set(
    db
      .prepare("SELECT id FROM approvals WHERE status = 'pending'")
      .all()
      .map((row) => Number(row.id)),
  );
  // the state that was last sent of each watched decision, by id.
  const watched = new Map<number, string>(
    db
      .prepare(
        `SELECT ${DECISION_COLUMNS} FROM policy_decisions JOIN runs ON runs.id = policy_decisions.runId
         WHERE runs.status = 'running' AND policy_decisions.decision IN (${WATCHED_DECISIONS.map(() => '?').join(', ')})`,
      )
      .all(...WATCHED_DECISIONS)
      .map((row) => [Number(row.id), decisionState(toStreamPolicy(row))]),
  );
  // the queries select the summary columns only, so a request, a response, an input, an output or a payload never
  // leaves the database.
  const modelCalls = db.prepare(
    'SELECT id, runId, slot, model, costUsd, latencyMs, error, createdAt FROM model_calls WHERE id > ? ORDER BY id LIMIT ?',
  );
  const toolCalls = db.prepare(
    `SELECT id, runId, toolCallId, name, isError, durationMs, createdAt, outcome, riskLevel, policyDecisionId
     FROM tool_calls WHERE id > ? ORDER BY id LIMIT ?`,
  );
  const decisions = db.prepare(`SELECT ${DECISION_COLUMNS} FROM policy_decisions WHERE id > ? ORDER BY id LIMIT ?`);
  const approvals = db.prepare(`SELECT ${APPROVAL_COLUMNS} WHERE approvals.id > ? ORDER BY approvals.id LIMIT ?`);
  const steps = db.prepare(
    'SELECT id, taskId, runId, action, urlAfter, screenshotBlob, error, createdAt FROM browser_steps WHERE id > ? ORDER BY id LIMIT ?',
  );

  // the decisions of the tool calls in one batch, with the status of their approvals, as toToolCall in queries.ts
  // reads them.
  const decisionsOf = (rows: Row[]): Map<number, PolicyDecisionRow> => {
    const ids = [...new Set(rows.flatMap((row) => (row.policyDecisionId === null ? [] : [Number(row.policyDecisionId)])))];
    if (ids.length === 0) return new Map();
    return new Map(
      db
        .prepare(
          `SELECT policy_decisions.*, approvals.status AS approvalStatus FROM policy_decisions
           LEFT JOIN approvals ON approvals.id = policy_decisions.approvalId
           WHERE policy_decisions.id IN (${ids.map(() => '?').join(', ')})`,
        )
        .all(...ids)
        .map((row) => [Number(row.id), toDecision(row)]),
    );
  };

  return () => {
    const messages: StreamMessage[] = [];

    for (const row of modelCalls.all(cursor.model_calls, TRACE_BATCH)) {
      cursor.model_calls = Number(row.id);
      messages.push({
        kind: 'model_call',
        call: {
          id: Number(row.id),
          runId: str(row.runId),
          slot: String(row.slot),
          model: String(row.model),
          costUsd: num(row.costUsd),
          latencyMs: Number(row.latencyMs),
          error: str(row.error),
          createdAt: String(row.createdAt),
        },
      });
    }

    const toolRows = toolCalls.all(cursor.tool_calls, TRACE_BATCH);
    const toolDecisions = decisionsOf(toolRows);
    for (const row of toolRows) {
      cursor.tool_calls = Number(row.id);
      const decision = row.policyDecisionId === null ? null : (toolDecisions.get(Number(row.policyDecisionId)) ?? null);
      messages.push({
        kind: 'tool_call',
        call: {
          id: Number(row.id),
          runId: String(row.runId),
          toolCallId: String(row.toolCallId),
          name: String(row.name),
          outcome: outcomeOf({
            toolCallId: String(row.toolCallId),
            isError: row.isError === 1,
            stored: str(row.outcome),
            riskLevel: str(row.riskLevel),
            decision,
          }),
          durationMs: Number(row.durationMs),
          createdAt: String(row.createdAt),
        },
      });
    }

    const freshDecisions = new Set<number>();
    for (const row of decisions.all(cursor.policy_decisions, TRACE_BATCH)) {
      const decision = toStreamPolicy(row);
      cursor.policy_decisions = decision.id;
      if (WATCHED_DECISIONS.includes(decision.decision)) {
        watched.set(decision.id, decisionState(decision));
        freshDecisions.add(decision.id);
      }
      messages.push({ kind: 'policy', decision });
    }
    const followed = [...watched.keys()].filter((id) => !freshDecisions.has(id));
    if (followed.length > 0) {
      const rows = db
        .prepare(
          `SELECT ${DECISION_COLUMNS}, runs.status AS runStatus FROM policy_decisions LEFT JOIN runs ON runs.id = policy_decisions.runId
           WHERE policy_decisions.id IN (${followed.map(() => '?').join(', ')}) ORDER BY policy_decisions.id`,
        )
        .all(...followed);
      const found = new Set(rows.map((row) => Number(row.id)));
      for (const id of followed) if (!found.has(id)) watched.delete(id);
      for (const row of rows) {
        const decision = toStreamPolicy(row);
        const state = decisionState(decision);
        if (state !== watched.get(decision.id)) messages.push({ kind: 'policy', decision });
        // a decision of a run that ended does not change again, so it leaves the map after its last state went out.
        if (row.runStatus !== 'running') watched.delete(decision.id);
        else watched.set(decision.id, state);
      }
    }

    // a new approval that is already resolved goes out one time, with its final status, and is not kept.
    const fresh = new Set<number>();
    for (const row of approvals.all(cursor.approvals, TRACE_BATCH)) {
      const approval = toStreamApproval(row);
      cursor.approvals = approval.id;
      if (approval.status === 'pending') {
        pending.add(approval.id);
        fresh.add(approval.id);
      }
      messages.push({ kind: 'approval', approval });
    }
    const known = [...pending].filter((id) => !fresh.has(id));
    if (known.length > 0) {
      const rows = db.prepare(`SELECT ${APPROVAL_COLUMNS} WHERE approvals.id IN (${known.map(() => '?').join(', ')}) ORDER BY approvals.id`).all(...known);
      // a pending approval whose row is gone has nothing left to send, so it leaves the set.
      const found = new Set(rows.map((row) => Number(row.id)));
      for (const id of known) if (!found.has(id)) pending.delete(id);
      for (const row of rows) {
        const approval = toStreamApproval(row);
        if (approval.status === 'pending') continue;
        pending.delete(approval.id);
        messages.push({ kind: 'approval', approval });
      }
    }

    for (const row of steps.all(cursor.browser_steps, TRACE_BATCH)) {
      cursor.browser_steps = Number(row.id);
      messages.push({
        kind: 'browser_step',
        step: {
          id: Number(row.id),
          taskId: String(row.taskId),
          runId: str(row.runId),
          action: String(row.action),
          urlAfter: str(row.urlAfter),
          screenshotBlob: str(row.screenshotBlob),
          error: str(row.error),
          createdAt: String(row.createdAt),
        },
      });
    }

    return messages;
  };
}
