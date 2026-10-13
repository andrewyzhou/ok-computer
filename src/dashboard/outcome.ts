// the outcome of a tool call in the owner's words. the trace stores only the three facts that a later read cannot
// find (abandoned, late, interrupted). the other words come from the row, its decision and its approval, so they
// can never go out of step with them. isError stays as it is, because it controls what the model sees.
// - ran, failed: the tool ran (failed also covers a call that failed before it could run).
// - invalid: the call never reached the policy: an unknown tool, bad input, or a reply that the token limit cut.
// - denied: a policy rule said no. held: the reviewer said no.
// - waiting, approved, declined, expired: the call asked the owner. the run after an approval has its own row.
export type Outcome =
  | 'ran'
  | 'failed'
  | 'invalid'
  | 'denied'
  | 'held'
  | 'waiting'
  | 'approved'
  | 'declined'
  | 'expired'
  | 'abandoned'
  | 'late'
  | 'interrupted';

export interface OutcomeInput {
  toolCallId: string;
  isError: boolean;
  // the stored outcome: abandoned, late, interrupted, or null.
  stored: string | null;
  riskLevel: string | null;
  decision: { decision: string; reviewerVerdict: string | null; approvalId: number | null; approvalStatus: string | null } | null;
}

const APPROVAL: Record<string, Outcome> = { pending: 'waiting', approved: 'approved', denied: 'declined', expired: 'expired' };

export function outcomeOf(call: OutcomeInput): Outcome {
  if (call.stored === 'abandoned' || call.stored === 'late' || call.stored === 'interrupted') return call.stored;
  const decision = call.decision;
  // a call without a decision has no risk level when it failed to resolve. a failed policy check keeps the risk.
  if (!decision) return !call.isError ? 'ran' : call.riskLevel ? 'failed' : 'invalid';
  if (decision.decision === 'deny') return 'denied';
  if (decision.reviewerVerdict === 'hold') return 'held';
  // the run of an approved call links to the same decision, and its row id starts with approval-.
  const asked = decision.approvalId !== null && !call.toolCallId.startsWith('approval-');
  if (asked) return APPROVAL[decision.approvalStatus ?? 'pending'] ?? 'waiting';
  return call.isError ? 'failed' : 'ran';
}
