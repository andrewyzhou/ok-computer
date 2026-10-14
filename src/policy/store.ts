import type { Db } from '../db/index.js';
import { redact } from '../observability/redact.js';
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

// each text of a decision can hold a provider error or a reviewer answer, and a provider can echo a key in an error.
// so the store redacts every text here, in one place.
const redacted = (text: string | undefined) => (text === undefined ? null : redact(text));

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
      redact(record.reason),
      record.review?.modelCallId ?? null,
      record.review?.verdict ?? null,
      redacted(record.review?.reason),
      record.approvalId ?? null,
      record.taint.length ? JSON.stringify(record.taint) : null,
      now.toISOString(),
    );
  return Number(row!.id);
}

// the caller writes the decision before it asks the reviewer or the owner, so their answers come later. a reviewer that
// fails gives no review, but its model call is linked too, so the run page shows it.
export function updateDecision(db: Db, id: number, change: { reason?: string; review?: ReviewResult; approvalId?: number; reviewerModelCallId?: number | undefined }): void {
  db.prepare(
    `UPDATE policy_decisions SET reason = COALESCE(?, reason), reviewerModelCallId = COALESCE(?, reviewerModelCallId),
       reviewerVerdict = COALESCE(?, reviewerVerdict), reviewerReason = COALESCE(?, reviewerReason),
       approvalId = COALESCE(?, approvalId)
     WHERE id = ?`,
  ).run(
    redacted(change.reason),
    change.review?.modelCallId ?? change.reviewerModelCallId ?? null,
    change.review?.verdict ?? null,
    redacted(change.review?.reason),
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
    if (row.source !== null && !sources.has(String(row.source))) {
      const runId = row.runId === null ? null : String(row.runId);
      const toolCallId = String(row.toolCallId);
      add({ source: String(row.source), toolName: toolNameOf(db, String(row.name), runId, toolCallId), runId, toolCallId, at: String(row.createdAt) });
    }
    // a system event carries the sources of another session, for example of an automation run.
    if (row.taint !== null) for (const each of JSON.parse(String(row.taint)) as TaintSource[]) add(each);
  }
  return [...sources.values()];
}

// the event of an integration call names tool_call, the model's own call. the owner needs the tool that read the
// content, so the name comes from the trace row when it exists. the row gives only the name: the event alone decides
// the taint. the lookup runs one time for each source, so a long session does not make the check slow.
function toolNameOf(db: Db, name: string, runId: string | null, toolCallId: string): string {
  if (name !== 'tool_call' || runId === null) return name;
  const row = db.prepare('SELECT name FROM tool_calls WHERE runId = ? AND toolCallId = ? ORDER BY id LIMIT 1').get(runId, toolCallId);
  return row ? String(row.name) : name;
}

// a url that the session already read carries no new data. only text from outside counts: a successful tool result
// with an untrusted source. text of the agent does not count, also when it is wrapped as untrusted, because an
// injected model can put a data url in it: a hold or an error that quotes the call, an unknown tool name, or the
// answer of a sub-agent. the source of that answer starts with "sub:", and result_read copies the source, so the
// answer does not count when the model reads it again through its handle. a system event does not count, because it
// is model text too, for example the task of a sub-agent or the result of an automation. the newest 2,000 events
// bound the work of one check. the payload is
// redacted json text, so a url with a secret or an escaped character does not match, and goes to review. the url must
// end where the read url ends, so the model cannot send a part of a longer url and choose where the part ends.
export function urlSeen(db: Db, sessionKey: string, url: string): boolean {
  const rows = db
    .prepare(
      `SELECT payload FROM (
         SELECT payload FROM events
         WHERE sessionKey = ? AND type = 'tool_result'
           AND seq > (SELECT COALESCE(MAX(seq), 0) FROM events WHERE sessionKey = ? AND type = 'session_reset')
         ORDER BY seq DESC LIMIT 2000)
       WHERE json_extract(payload, '$.untrustedSource') IS NOT NULL AND json_extract(payload, '$.isError') = 0
         AND json_extract(payload, '$.untrustedSource') NOT LIKE 'sub:%' AND instr(payload, ?) > 0`,
    )
    .all(sessionKey, sessionKey, url);
  return rows.some((row) => {
    const payload = String(row.payload);
    for (let at = payload.indexOf(url); at >= 0; at = payload.indexOf(url, at + 1)) {
      if (!URL_CHAR.test(payload.charAt(at + url.length))) return true;
    }
    return false;
  });
}

// a character that can continue a url. a backslash cannot, because it starts an escape in the json text.
const URL_CHAR = /[A-Za-z0-9\-._~%!$&'()*+,;=:@/?#[\]]/;
