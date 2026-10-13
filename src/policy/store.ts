import type { Db } from '../db/index.js';
import type { ReviewResult, Verdict } from './policy.js';

export interface DecisionRecord extends Verdict {
  runId: string;
  toolCallId: string;
  toolName: string;
  review?: ReviewResult;
  approvalId?: number;
}

export function recordDecision(db: Db, record: DecisionRecord, now: Date): number {
  const row = db
    .prepare(
      `INSERT INTO policy_decisions (runId, toolCallId, toolName, decision, rule, reason, reviewerModelCallId,
         reviewerVerdict, reviewerReason, approvalId, createdAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
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
      now.toISOString(),
    );
  return Number(row!.id);
}

export function decisionOfApproval(db: Db, approvalId: number): number | null {
  const row = db.prepare('SELECT id FROM policy_decisions WHERE approvalId = ? ORDER BY id LIMIT 1').get(approvalId);
  return row ? Number(row.id) : null;
}

// the model still sees untrusted text in later runs of the same session, so the taint lasts until the next /new.
// a reset and a tool call can have the same time, so a call at the time of the reset still counts.
export function sessionTaint(db: Db, sessionKey: string): string[] {
  const reset = db
    .prepare("SELECT MAX(createdAt) AS at FROM events WHERE sessionKey = ? AND type = 'session_reset'")
    .get(sessionKey);
  return db
    .prepare(
      `SELECT tool_calls.untrustedSource AS source FROM tool_calls JOIN runs ON runs.id = tool_calls.runId
       WHERE runs.sessionKey = ? AND tool_calls.untrustedSource IS NOT NULL AND tool_calls.createdAt >= ?
       GROUP BY tool_calls.untrustedSource ORDER BY MIN(tool_calls.id)`,
    )
    .all(sessionKey, String(reset?.at ?? ''))
    .map((row) => String(row.source));
}
