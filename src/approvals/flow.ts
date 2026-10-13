import type { Db } from '../db/index.js';
import { appendEvent } from '../events/log.js';
import type { Logger } from '../observability/logger.js';
import type { TaintSource } from '../policy/policy.js';
import type { OwnerMessenger } from '../sessions/owner.js';
import type { RunQueue } from '../sessions/queue.js';
import { localDay, localTime, type Clock } from '../time.js';
import type { RequestApproval, ToolCaller } from '../tools/caller.js';
import type { ToolOutput } from '../tools/registry.js';
import { approvalButtonData, createApproval, resolveApproval, type Decision, type ResolvedVia } from './store.js';

export interface ApprovalFlowDeps {
  db: Db;
  clock: Clock;
  logger: Logger;
  queue: RunQueue;
  owner: OwnerMessenger;
  // the caller uses the request of this flow, so the flow gets the caller later.
  caller: () => ToolCaller;
  signal: AbortSignal;
}

export interface ApprovalFlow {
  request: RequestApproval;
  // resolve gives the text of the reply to the owner.
  resolve(id: number, decision: Decision, via: ResolvedVia): Promise<string>;
}

const SUMMARY_LIMIT = 500;

// the run does not wait for the owner. the tool result says that the call is pending, and the decision comes back
// to the same session as a system event.
export function createApprovalFlow(deps: ApprovalFlowDeps): ApprovalFlow {
  const { db, clock, logger, queue } = deps;

  return {
    async request(tool, input, ctx, why) {
      const summary = `${tool.name} ${JSON.stringify(input)}`.slice(0, SUMMARY_LIMIT);
      const approval = createApproval(db, { runId: ctx.runId, toolName: tool.name, input, summary }, clock());
      logger.info('approval requested', { approvalId: approval.id, tool: tool.name, runId: ctx.runId });
      // the owner sees the reason with the request. the taint can come from an older run, so the message names it.
      const lines = [`Approval needed (#${approval.id}): ${summary}`, `Why: ${why.reason}.`];
      if (why.taint.length) lines.push(`Untrusted content in this session: ${why.taint.map((each) => taintText(each, ctx.timeZone)).join('; ')}.`);
      await deps.owner.send(lines.join('\n'), [
        [
          { text: 'Approve', data: approvalButtonData(approval.id, 'approve') },
          { text: 'Deny', data: approvalButtonData(approval.id, 'deny') },
        ],
      ]);
      return {
        approvalId: approval.id,
        output: {
          content: `${tool.name} needs the owner's approval. Approval #${approval.id} is pending, and the tool did not run yet. The owner can approve it with the button or with /approve ${approval.id}. The decision comes back as a system event.`,
        },
      };
    },

    async resolve(id, decision, via) {
      const resolved = resolveApproval(db, id, decision, via, clock());
      if (!resolved.ok) return resolved.error;
      const approval = resolved.value;
      logger.info('approval resolved', { approvalId: id, status: approval.status, via });
      // the session queue keeps the result event out of the middle of an active run.
      return queue.enqueue(approval.sessionKey, async () => {
        let output: ToolOutput | undefined;
        if (approval.status === 'approved') output = await deps.caller().callApproved(approval, deps.signal);
        const text = output
          ? `The owner approved #${id} (${approval.summary}). The tool ran.${output.isError ? ' It failed.' : ''} Result:\n${output.content}`
          : `The owner denied #${id} (${approval.summary}). The tool did not run.`;
        // an untrusted result taints the session, as it does for a tool result event.
        const taint: TaintSource[] = output?.untrustedSource
          ? [{ source: output.untrustedSource, toolName: approval.toolName, runId: approval.runId, toolCallId: `approval-${id}`, at: clock().toISOString() }]
          : [];
        appendEvent(
          db,
          { sessionKey: approval.sessionKey, runId: null, type: 'system_event', payload: { text, ...(taint.length ? { taint } : {}) } },
          clock(),
        );
        if (!output) return `Denied #${id}.`;
        return `Approved #${id}. ${output.isError ? 'The tool failed' : 'Result'}: ${output.content.slice(0, SUMMARY_LIMIT)}`;
      });
    },
  };
}

// the run id is long, so the owner gets its first 8 characters, as the dashboard shows it.
function taintText(taint: TaintSource, timeZone: string): string {
  const at = new Date(taint.at);
  const run = taint.runId ? ` in run ${taint.runId.slice(0, 8)}` : '';
  return `${taint.source} (read by ${taint.toolName} on ${localDay(at, timeZone)} at ${localTime(at, timeZone)}${run})`;
}
