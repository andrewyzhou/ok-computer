import type { Result } from '../config/load.js';
import type { Db } from '../db/index.js';

export const APPROVAL_TTL_MS = 24 * 60 * 60_000;

export type ApprovalStatus = 'pending' | 'approved' | 'denied' | 'expired';
export type Decision = 'approve' | 'deny';
// free text is not on this list. only a button, a command, or the dashboard can resolve an approval.
export type ResolvedVia = 'button' | 'command' | 'dashboard';

export const approvalButtonData = (id: number, decision: Decision) => `approval:${id}:${decision}`;

export function parseApprovalButton(data: string): { id: number; decision: Decision } | undefined {
  const match = /^approval:(\d+):(approve|deny)$/.exec(data);
  return match ? { id: Number(match[1]), decision: match[2] as Decision } : undefined;
}

export interface Approval {
  id: number;
  runId: string;
  sessionKey: string;
  toolName: string;
  input: unknown;
  summary: string;
  status: ApprovalStatus;
  requestedAt: string;
  resolvedAt: string | null;
  resolvedBy: ResolvedVia | null;
}

// the input is not redacted, because the tool runs again with this exact input after the approval. the link from the
// policy decision is written in the same transaction. the message to the owner comes after it and can take long, so
// a crash during the message leaves a decision that names a live approval.
export function createApproval(
  db: Db,
  input: { runId: string; toolName: string; input: unknown; summary: string; decisionId?: number },
  now: Date,
): Approval {
  db.exec('BEGIN');
  try {
    const row = db
      .prepare(
        `INSERT INTO approvals (runId, toolName, input, summary, status, requestedAt) VALUES (?, ?, ?, ?, 'pending', ?)
         RETURNING id`,
      )
      .get(input.runId, input.toolName, JSON.stringify(input.input), input.summary, now.toISOString());
    const id = Number(row!.id);
    if (input.decisionId !== undefined) db.prepare('UPDATE policy_decisions SET approvalId = ? WHERE id = ?').run(id, input.decisionId);
    db.exec('COMMIT');
    return getApproval(db, id)!;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function getApproval(db: Db, id: number): Approval | undefined {
  const row = db
    .prepare('SELECT approvals.*, runs.sessionKey FROM approvals JOIN runs ON runs.id = approvals.runId WHERE approvals.id = ?')
    .get(id);
  if (!row) return undefined;
  return {
    id: Number(row.id),
    runId: String(row.runId),
    sessionKey: String(row.sessionKey),
    toolName: String(row.toolName),
    input: JSON.parse(String(row.input)),
    summary: String(row.summary),
    status: row.status as ApprovalStatus,
    requestedAt: String(row.requestedAt),
    resolvedAt: row.resolvedAt === null ? null : String(row.resolvedAt),
    resolvedBy: (row.resolvedBy ?? null) as ResolvedVia | null,
  };
}

// expireApprovals gives the approvals that it expired, so their sessions can get a note.
export function expireApprovals(db: Db, now: Date): Approval[] {
  const cutoff = new Date(now.getTime() - APPROVAL_TTL_MS).toISOString();
  return db
    .prepare("UPDATE approvals SET status = 'expired', resolvedAt = ? WHERE status = 'pending' AND requestedAt <= ? RETURNING id")
    .all(now.toISOString(), cutoff)
    .map((row) => getApproval(db, Number(row.id))!);
}

// only the sweep expires approvals, because it also tells their sessions. an approval past its age cannot be resolved
// here, and it stays pending until the next sweep.
export function resolveApproval(db: Db, id: number, decision: Decision, via: ResolvedVia, now: Date): Result<Approval> {
  const approval = getApproval(db, id);
  if (!approval) return { ok: false, error: `No approval has the id ${id}.` };
  const cutoff = new Date(now.getTime() - APPROVAL_TTL_MS).toISOString();
  // the status check is part of the update, so two decisions for one approval (a button and the dashboard) cannot
  // both win.
  const changed = db
    .prepare("UPDATE approvals SET status = ?, resolvedAt = ?, resolvedBy = ? WHERE id = ? AND status = 'pending' AND requestedAt > ?")
    .run(decision === 'approve' ? 'approved' : 'denied', now.toISOString(), via, id, cutoff).changes;
  if (!changed) {
    const status = getApproval(db, id)!.status;
    if (status === 'pending') return { ok: false, error: `Approval #${id} expired after 24 hours without an answer. The tool did not run.` };
    return { ok: false, error: `Approval #${id} is already ${status}.` };
  }
  return { ok: true, value: getApproval(db, id)! };
}
