import type { Approval } from '../approvals/store.js';
import type { Db } from '../db/index.js';
import type { ToolCall } from '../models/types.js';
import type { BlobStore } from '../observability/blobs.js';
import { redactedJson } from '../observability/redact.js';
import { decide, type ReviewResult, type Reviewer, type Risk, type Rule, type TaintSource } from '../policy/policy.js';
import { decisionOfApproval, recordDecision, sessionTaint } from '../policy/store.js';
import type { Clock } from '../time.js';
import type { Tool, ToolContext, ToolOutput, ToolRegistry } from './registry.js';
import { modelView, newHandle } from './results.js';

export interface CallContext {
  runId: string;
  sessionKey: string;
  allowed: readonly string[];
  signal: AbortSignal;
}

// why gives the owner the reason of the policy and the untrusted sources that the session read.
export interface ApprovalWhy {
  reason: string;
  taint: TaintSource[];
}

// the approval flow asks the owner. its output tells the model that the call waits for the owner.
export type RequestApproval = (
  tool: Tool,
  input: unknown,
  ctx: ToolContext,
  why: ApprovalWhy,
) => Promise<{ approvalId: number; output: ToolOutput }>;

export interface ToolCallerDeps {
  db: Db;
  blobs: BlobStore;
  tools: ToolRegistry;
  rules: readonly Rule[];
  reviewer?: Reviewer;
  requestApproval: RequestApproval;
  clock: Clock;
  timeZone: string;
  newHandle?: () => string;
}

export interface ToolCaller {
  // call gives the output that the model gets: wrapped, and cut to a preview with a handle when it is long.
  call(call: ToolCall, ctx: CallContext): Promise<ToolOutput>;
  // callApproved runs the stored input of an approval. the call goes into the trace of the original run.
  callApproved(approval: Approval, signal: AbortSignal): Promise<ToolOutput>;
}

interface Trace {
  risk?: Risk;
  decisionId?: number | null;
  tainted?: boolean;
}

// every tool call goes through the policy here, and every call leaves a tool_calls row with the model view, the raw
// result, and the decision.
export function createToolCaller(deps: ToolCallerDeps): ToolCaller {
  const { db, blobs, tools, clock } = deps;

  const finish = (runId: string, call: ToolCall, output: ToolOutput, started: number, trace: Trace): ToolOutput => {
    const view = modelView(output, deps.newHandle ?? newHandle);
    const result = { content: view.content, ...(output.isError ? { isError: true } : {}) };
    const untrusted = output.untrustedSource ? { untrustedSource: output.untrustedSource } : {};
    db.prepare(
      `INSERT INTO tool_calls (runId, toolCallId, name, input, output, isError, durationMs, createdAt, riskLevel,
         policyDecisionId, tainted, untrustedSource, rawResultBlob, truncated, resultHandle)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      runId,
      call.id,
      call.name,
      redactedJson(call.input),
      redactedJson(result),
      output.isError ? 1 : 0,
      Math.round(performance.now() - started),
      clock().toISOString(),
      trace.risk ?? null,
      trace.decisionId ?? null,
      trace.tainted ? 1 : 0,
      output.untrustedSource ?? null,
      // the raw text needs a blob only when the model saw other text: a preview, or a wrapped text.
      view.content === output.content ? null : blobs.put(output.content),
      view.truncated ? 1 : 0,
      view.handle ?? null,
    );
    return { ...result, ...untrusted };
  };

  return {
    async call(call, ctx) {
      const started = performance.now();
      const toolCtx: ToolContext = { runId: ctx.runId, sessionKey: ctx.sessionKey, timeZone: deps.timeZone, clock, signal: ctx.signal };
      const resolved = tools.resolve(call, ctx.allowed);
      if (!resolved.ok) return finish(ctx.runId, call, resolved.output, started, {});
      const { tool, input } = resolved;
      const taint = sessionTaint(db, ctx.sessionKey);
      const sources = taint.map((each) => each.source);
      const verdict = decide(
        { tool: tool.name, risk: tool.risk, alwaysApprove: tool.needsApproval === true, input, sessionKey: ctx.sessionKey, taint: sources },
        deps.rules,
      );
      // without a reviewer model the owner decides a review. the decision row and the owner both get this reason.
      const reason =
        verdict.decision === 'review' && !deps.reviewer ? `${verdict.reason}. there is no reviewer model yet, so the owner decides` : verdict.reason;

      let review: ReviewResult | undefined;
      let approvalId: number | undefined;
      let held: ToolOutput | undefined;
      const askOwner = async () => {
        const requested = await deps.requestApproval(tool, input, toolCtx, { reason, taint });
        approvalId = requested.approvalId;
        held = requested.output;
      };
      if (verdict.decision === 'deny') {
        held = { content: `the policy denied ${tool.name}, and it did not run: ${verdict.reason}`, isError: true };
      } else if (verdict.decision === 'approve') {
        await askOwner();
      } else if (verdict.decision === 'review') {
        if (deps.reviewer) {
          review = await deps.reviewer({
            runId: ctx.runId,
            sessionKey: ctx.sessionKey,
            tool: tool.name, input, risk: tool.risk,
            reason: verdict.reason,
            taint: sources,
          });
          if (review.verdict === 'hold') {
            held = { content: `the reviewer held ${tool.name}, and it did not run: ${review.reason}`, isError: true };
          }
        } else {
          await askOwner();
        }
      }
      const decisionId = recordDecision(
        db,
        {
          ...verdict,
          reason,
          taint,
          runId: ctx.runId,
          toolCallId: call.id,
          toolName: tool.name,
          ...(review ? { review } : {}),
          ...(approvalId !== undefined ? { approvalId } : {}),
        },
        clock(),
      );
      const output = held ?? (await tools.execute(tool, input, toolCtx));
      return finish(ctx.runId, call, output, started, { risk: tool.risk, decisionId, tainted: taint.length > 0 });
    },

    async callApproved(approval, signal) {
      const started = performance.now();
      const call = { id: `approval-${approval.id}`, name: approval.toolName, input: approval.input };
      const toolCtx: ToolContext = { runId: approval.runId, sessionKey: approval.sessionKey, timeZone: deps.timeZone, clock, signal };
      const resolved = tools.resolve(call, [approval.toolName]);
      const output = resolved.ok ? await tools.execute(resolved.tool, resolved.input, toolCtx) : resolved.output;
      return finish(approval.runId, call, output, started, {
        ...(resolved.ok ? { risk: resolved.tool.risk } : {}),
        decisionId: decisionOfApproval(db, approval.id),
        tainted: sessionTaint(db, approval.sessionKey).length > 0,
      });
    },
  };
}
