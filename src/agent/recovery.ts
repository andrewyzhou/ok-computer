import { getApproval, type Approval } from '../approvals/store.js';
import { sinceLastReset } from '../context/full-history.js';
import type { Db } from '../db/index.js';
import { appendEvent, listEvents } from '../events/log.js';
import type { ToolCall } from '../models/types.js';
import { silentLogger, type Logger } from '../observability/logger.js';
import { redactedJson } from '../observability/redact.js';
import type { Clock } from '../time.js';

export const interruptedText = (name: string) =>
  `The app stopped while ${name} ran. It is unknown whether it finished. Check the result before you try it again.`;
const notRunText = (name: string) => `${name} did not run, because the app stopped first.`;
const waitsText = (name: string, approvalId: number) =>
  `${name} did not run. It waits for the owner's approval #${approvalId}, and the decision comes back as a system event.`;

// a call is dangling when the last assistant turn has no result event for it. the provider refuses a request with
// such a call, so one dangling call stops every later run of the session. only the last turn can have one, because
// each run starts with this repair.
function danglingCalls(db: Db, sessionKey: string): Array<{ runId: string | null; call: ToolCall }> {
  const open = new Map<string, { runId: string | null; call: ToolCall }>();
  for (const event of sinceLastReset(listEvents(db, sessionKey))) {
    if (event.type === 'assistant_message') {
      open.clear();
      for (const call of event.payload.toolCalls) open.set(call.id, { runId: event.runId, call });
    } else if (event.type === 'tool_result') {
      open.delete(event.payload.toolCallId);
    }
  }
  return [...open.values()];
}

// repairSession gives each dangling call a result event, chosen from the trace:
// - a tool_calls row exists: the recorded model view, with its untrusted source, so the taint stays.
// - the decision let the tool start: a note that the outcome is unknown, and a row with outcome 'interrupted'.
// - otherwise: a note that the tool did not run (or waits for the owner).
// the caller of this function holds the session queue, so no other run of the session can add a result.
export function repairSession(db: Db, sessionKey: string, clock: Clock, logger: Logger = silentLogger): number {
  const dangling = danglingCalls(db, sessionKey);
  for (const { runId, call } of dangling) {
    let payload: ResultPayload;
    try {
      payload = resultFromTrace(db, runId, call, clock);
    } catch (err) {
      // a failure for one call must not stop each later run of the session. the trace did not tell whether the
      // tool started, so the text says that its outcome is unknown.
      logger.error('repair of a tool call failed', { sessionKey, runId, toolCallId: call.id, err });
      payload = { toolCallId: call.id, name: call.name, content: interruptedText(call.name), isError: true };
    }
    appendEvent(db, { sessionKey, runId, type: 'tool_result', payload }, clock());
  }
  return dangling.length;
}

interface ResultPayload {
  toolCallId: string;
  name: string;
  content: string;
  isError: boolean;
  untrustedSource?: string;
}

function resultFromTrace(db: Db, runId: string | null, call: ToolCall, clock: Clock): ResultPayload {
  const row = db
    .prepare('SELECT output, isError, untrustedSource FROM tool_calls WHERE runId IS ? AND toolCallId = ? ORDER BY id DESC LIMIT 1')
    .get(runId, call.id);
  let payload: ResultPayload;
  if (row) {
    const output = JSON.parse(String(row.output)) as { content: string };
    payload = { toolCallId: call.id, name: call.name, content: output.content, isError: Number(row.isError) === 1 };
    if (row.untrustedSource !== null) payload.untrustedSource = String(row.untrustedSource);
  } else {
    const decision = db
      .prepare('SELECT id, decision, reviewerVerdict, approvalId FROM policy_decisions WHERE runId IS ? AND toolCallId = ? ORDER BY id DESC LIMIT 1')
      .get(runId, call.id);
    // the caller writes the decision just before the tool runs. an allowed decision without a row means that the
    // tool started, and the process stopped before the row.
    const started = decision?.decision === 'allow' || (decision?.decision === 'review' && decision.reviewerVerdict === 'allow');
    const waits = !started && decision?.approvalId != null;
    const content = started ? interruptedText(call.name) : waits ? waitsText(call.name, Number(decision!.approvalId)) : notRunText(call.name);
    payload = { toolCallId: call.id, name: call.name, content, isError: !waits };
    if (runId !== null) {
      db.prepare(
        `INSERT INTO tool_calls (runId, toolCallId, name, input, output, isError, durationMs, createdAt, policyDecisionId, outcome)
         VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
      ).run(
        runId,
        call.id,
        call.name,
        redactedJson(call.input),
        redactedJson({ content, ...(payload.isError ? { isError: true } : {}) }),
        payload.isError ? 1 : 0,
        clock().toISOString(),
        decision ? Number(decision.id) : null,
        started ? 'interrupted' : null,
      );
    }
  }
  return payload;
}

export interface StaleWork {
  // the runs that were still running long after their timeout. their process is gone.
  runs: Array<{ id: string; sessionKey: string }>;
  // the owner approved these calls, and the process stopped before they started. they expire and never run.
  expired: Approval[];
  // these approved calls started, and the process stopped while they ran. their outcome is unknown.
  interrupted: Approval[];
}

// the work that this process holds in memory. it is live, whatever its age.
export interface LiveWork {
  runs: Iterable<string>;
  approvals: Iterable<number>;
}

// a run ends at its timeout, and a stuck tool is abandoned then. so a run that is still running long after the
// longest timeout belongs to a process that stopped. the age test, and not the start of this process, decides,
// because a second process (for example npm run chat) can share the database with a live one. the age alone is not
// sufficient for the work of this process:
// - an approved call can wait in its session queue behind runs that are longer than the age limit together.
// - the clock can move forward, for example after the pc wakes from sleep.
// so the work that this process holds is never closed.
export function closeStaleWork(db: Db, now: Date, staleMs: number, live: LiveWork = { runs: [], approvals: [] }): StaleWork {
  const cutoff = new Date(now.getTime() - staleMs).toISOString();
  const at = now.toISOString();
  const liveRuns = JSON.stringify([...live.runs]);
  const liveApprovals = JSON.stringify([...live.approvals]);
  const runs = db
    .prepare(
      `UPDATE runs SET status = 'aborted', endedAt = ?, error = 'the process stopped during the run'
       WHERE status = 'running' AND startedAt < ? AND id NOT IN (SELECT value FROM json_each(?)) RETURNING id, sessionKey`,
    )
    .all(at, cutoff, liveRuns)
    .map((row) => ({ id: String(row.id), sessionKey: String(row.sessionKey) }));

  const expired = db
    .prepare(
      `UPDATE approvals SET status = 'expired' WHERE status = 'approved' AND startedAt IS NULL AND resolvedAt < ?
         AND id NOT IN (SELECT value FROM json_each(?))
       RETURNING id`,
    )
    .all(cutoff, liveApprovals)
    .map((row) => getApproval(db, Number(row.id))!);

  const candidates = db
    .prepare(
      `SELECT id FROM approvals WHERE status = 'approved' AND startedAt < ?
         AND id NOT IN (SELECT value FROM json_each(?))
         AND NOT EXISTS (SELECT 1 FROM tool_calls WHERE tool_calls.runId = approvals.runId
                         AND tool_calls.toolCallId = 'approval-' || approvals.id)
       ORDER BY id`,
    )
    .all(cutoff, liveApprovals)
    .map((row) => getApproval(db, Number(row.id))!);
  // the insert is the claim. a sweep of a second process at the same moment can insert the row after the select
  // above, so only the sweep whose insert writes the row reports the call.
  const interrupted = candidates.filter((approval) => {
    const content = interruptedText(approval.toolName);
    const callId = `approval-${approval.id}`;
    return (
      db
        .prepare(
          `INSERT INTO tool_calls (runId, toolCallId, name, input, output, isError, durationMs, createdAt, policyDecisionId, outcome)
           SELECT ?, ?, ?, ?, ?, 1, 0, ?, (SELECT id FROM policy_decisions WHERE approvalId = ? ORDER BY id LIMIT 1), 'interrupted'
           WHERE NOT EXISTS (SELECT 1 FROM tool_calls WHERE runId IS ? AND toolCallId = ?)`,
        )
        .run(
          approval.runId,
          callId,
          approval.toolName,
          redactedJson(approval.input),
          redactedJson({ content, isError: true }),
          at,
          approval.id,
          approval.runId,
          callId,
        ).changes === 1
    );
  });
  return { runs, expired, interrupted };
}
