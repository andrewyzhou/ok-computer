import type { Db } from '../db/index.js';
import type { ReviewResult, TaintSource, Verdict } from './policy.js';

export interface DecisionRecord extends Verdict {
  runId: string;
  toolCallId: string;
  toolName: string;
  // the taint of the session at the time of the decision. a later /new clears the taint, so the decision keeps a copy.
  taint: TaintSource[];
  review?: ReviewResult;
  approvalId?: number;
}

export function recordDecision(db: Db, record: DecisionRecord, now: Date): number {
  const row = db
    .prepare(
      `INSERT INTO policy_decisions (runId, toolCallId, toolName, decision, rule, reason, reviewerModelCallId,
         reviewerVerdict, reviewerReason, approvalId, taint, createdAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    )
    .get(
      record.runId,
      record.toolCallId,
      record.toolName,
      record.decision,
      record.rule,
      record.reason,
      record.review?.modelCallId ?? null,
      record.review?.verdict ?? null,
      record.review?.reason ?? null,
      record.approvalId ?? null,
      record.taint.length ? JSON.stringify(record.taint) : null,
      now.toISOString(),
    );
  return Number(row!.id);
}

// the caller writes the decision before it asks the reviewer or the owner, so their answers come later.
export function updateDecision(db: Db, id: number, change: { reason?: string; review?: ReviewResult; approvalId?: number }): void {
  db.prepare(
    `UPDATE policy_decisions SET reason = COALESCE(?, reason), reviewerModelCallId = COALESCE(?, reviewerModelCallId),
       reviewerVerdict = COALESCE(?, reviewerVerdict), reviewerReason = COALESCE(?, reviewerReason),
       approvalId = COALESCE(?, approvalId)
     WHERE id = ?`,
  ).run(
    change.reason ?? null,
    change.review?.modelCallId ?? null,
    change.review?.verdict ?? null,
    change.review?.reason ?? null,
    change.approvalId ?? null,
    id,
  );
}

// the decision keeps the reason and the taint that the approval card showed to the owner.
export function decisionForApproval(db: Db, approvalId: number): { reason: string; taint: TaintSource[] } | undefined {
  const row = db.prepare('SELECT reason, taint FROM policy_decisions WHERE approvalId = ? ORDER BY id LIMIT 1').get(approvalId);
  return row ? { reason: String(row.reason), taint: row.taint ? (JSON.parse(String(row.taint)) as TaintSource[]) : [] } : undefined;
}

export function decisionOfApproval(db: Db, approvalId: number): number | null {
  const row = db.prepare('SELECT id FROM policy_decisions WHERE approvalId = ? ORDER BY id LIMIT 1').get(approvalId);
  return row ? Number(row.id) : null;
}

// the taint is what the model saw: the untrusted tool results and the tainted system events of the session since its
// last reset. the order comes from seq, not from the clock, because a clock can move back. the model still sees the
// untrusted text in later runs of the session, so the taint lasts until the next /new. the where clause repeats the
// condition of the events_taint index, so the query uses that index.
export function sessionTaint(db: Db, sessionKey: string): TaintSource[] {
  const rows = db
    .prepare(
      `SELECT runId, createdAt, json_extract(payload, '$.untrustedSource') AS source, json_extract(payload, '$.name') AS name,
         json_extract(payload, '$.toolCallId') AS toolCallId, json_extract(payload, '$.taint') AS taint
       FROM events
       WHERE sessionKey = ? AND type IN ('tool_result', 'system_event')
         AND (json_extract(payload, '$.untrustedSource') IS NOT NULL OR json_extract(payload, '$.taint') IS NOT NULL)
         AND seq > (SELECT COALESCE(MAX(seq), 0) FROM events WHERE sessionKey = ? AND type = 'session_reset')
       ORDER BY seq`,
    )
    .all(sessionKey, sessionKey);
  const sources = new Map<string, TaintSource>();
  const add = (each: TaintSource) => {
    if (!sources.has(each.source)) sources.set(each.source, each);
  };
  for (const row of rows) {
    if (row.source !== null) {
      add({
        source: String(row.source),
        toolName: String(row.name),
        runId: row.runId === null ? null : String(row.runId),
        toolCallId: String(row.toolCallId),
        at: String(row.createdAt),
      });
    }
    // a system event carries the sources of another session, for example of an automation run.
    if (row.taint !== null) for (const each of JSON.parse(String(row.taint)) as TaintSource[]) add(each);
  }
  return [...sources.values()];
}
