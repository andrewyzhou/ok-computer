import type { Db } from '../db/index.js';
import { appendEvent } from '../events/log.js';
import type { Logger } from '../observability/logger.js';
import type { OwnerMessenger } from '../sessions/owner.js';
import type { RunQueue } from '../sessions/queue.js';
import type { Clock } from '../time.js';
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
    async request(tool, input, ctx) {
      const summary = `${tool.name} ${JSON.stringify(input)}`.slice(0, SUMMARY_LIMIT);
      const approval = createApproval(db, { runId: ctx.runId, toolName: tool.name, input, summary }, clock());
      logger.info('approval requested', { approvalId: approval.id, tool: tool.name, runId: ctx.runId });
      await deps.owner.send(`Approval needed (#${approval.id}): ${summary}`, [
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
        appendEvent(db, { sessionKey: approval.sessionKey, runId: null, type: 'system_event', payload: { text } }, clock());
        if (!output) return `Denied #${id}.`;
        return `Approved #${id}. ${output.isError ? 'The tool failed' : 'Result'}: ${output.content.slice(0, SUMMARY_LIMIT)}`;
      });
    },
  };
}
