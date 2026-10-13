import type { Approval } from '../approvals/store.js';
import type { Db } from '../db/index.js';
import { appendEvent } from '../events/log.js';
import type { ToolCall } from '../models/types.js';
import type { BlobStore } from '../observability/blobs.js';
import type { Logger } from '../observability/logger.js';
import { redactedJson } from '../observability/redact.js';
import { decide, type ReviewResult, type Reviewer, type Risk, type Rule, type TaintSource } from '../policy/policy.js';
import { decisionOfApproval, recordDecision, sessionTaint, updateDecision } from '../policy/store.js';
import type { RunQueue } from '../sessions/queue.js';
import type { Clock } from '../time.js';
import { errorText, type Tool, type ToolContext, type ToolOutput, type ToolRegistry } from './registry.js';
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
  // the note about a late result goes into its session through the queue, so it never lands inside an active run.
  queue: RunQueue;
  logger: Logger;
  clock: Clock;
  timeZone: string;
  newHandle?: () => string;
}

export interface ToolCaller {
  // call gives the output that the model gets: wrapped, and cut to a preview with a handle when it is long. the
  // output keeps untrustedSource, so the result event taints the session. call never throws, because a tool call
  // without a result makes every later request of the session fail.
  call(call: ToolCall, ctx: CallContext): Promise<ToolOutput>;
  // callApproved runs the stored input of an approval one time. the call goes into the trace of the original run.
  callApproved(approval: Approval, signal: AbortSignal): Promise<ToolOutput>;
}

interface Trace {
  risk?: Risk;
  decisionId?: number | null;
  tainted?: boolean;
  // abandoned: the run stopped while the tool ran. a later result changes it to late.
  outcome?: 'abandoned';
}

const STOPPED = Symbol('stopped');

export const abandonedText = (name: string) =>
  `${name} did not finish before the run stopped. It can still finish later, so its effect is unknown. Check the result before you try it again.`;

// every tool call goes through the policy here, and every call leaves a tool_calls row with the model view, the raw
// result, and the decision. the rule is: fail closed before the tool acts, and fail open after it.
// - the decision row is written before the tool runs. when the policy check or that write fails, the tool does not
//   run, and the model gets an error.
// - after the tool ran, the model always gets the output, also when the trace write fails. a gap in the trace is
//   better than a second action, which the model can try when it does not see the first result.
export function createToolCaller(deps: ToolCallerDeps): ToolCaller {
  const { db, blobs, tools, clock, logger } = deps;

  const record = (runId: string, call: ToolCall, output: ToolOutput, started: number, trace: Trace): ToolOutput & { rowId?: number } => {
    const view = modelView(output, deps.newHandle ?? newHandle);
    const result: ToolOutput = {
      content: view.content,
      ...(output.isError ? { isError: true } : {}),
      ...(output.untrustedSource ? { untrustedSource: output.untrustedSource } : {}),
    };
    try {
      const row = db
        .prepare(
          `INSERT INTO tool_calls (runId, toolCallId, name, input, output, isError, durationMs, createdAt, riskLevel,
             policyDecisionId, tainted, untrustedSource, rawResultBlob, truncated, resultHandle, outcome)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
        )
        .get(
          runId,
          call.id,
          call.name,
          redactedJson(call.input),
          redactedJson({ content: view.content, ...(output.isError ? { isError: true } : {}) }),
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
          trace.outcome ?? null,
        );
      return { ...result, rowId: Number(row!.id) };
    } catch (err) {
      // the log is the second record. a handle in the view then has no row, and result_read says so.
      logger.error('tool call trace write failed', { runId, toolCallId: call.id, tool: call.name, err });
      return result;
    }
  };

  // the model got the abandoned text. the late result goes into the same row, and a system event tells the session,
  // so the model does not repeat an action that worked.
  const recordLate = (runId: string, sessionKey: string, call: ToolCall, rowId: number | undefined, late: ToolOutput) => {
    const view = modelView(late, deps.newHandle ?? newHandle);
    try {
      if (rowId !== undefined) {
        db.prepare(
          "UPDATE tool_calls SET outcome = 'late', isError = ?, rawResultBlob = ?, resultHandle = ?, untrustedSource = ? WHERE id = ?",
        ).run(late.isError ? 1 : 0, blobs.put(late.content), view.handle ?? null, late.untrustedSource ?? null, rowId);
      }
      logger.warn('an abandoned tool call finished late', { runId, toolCallId: call.id, tool: call.name });
    } catch (err) {
      logger.error('late tool result trace write failed', { runId, toolCallId: call.id, tool: call.name, err });
    }
    const taint: TaintSource[] = late.untrustedSource
      ? [{ source: late.untrustedSource, toolName: call.name, runId, toolCallId: call.id, at: clock().toISOString() }]
      : [];
    const text = `${call.name} (call ${call.id}) finished after its run stopped.${late.isError ? ' It failed.' : ''} Result:\n${view.content}`;
    void deps.queue
      .enqueue(sessionKey, async () => {
        appendEvent(db, { sessionKey, runId: null, type: 'system_event', payload: { text, ...(taint.length ? { taint } : {}) } }, clock());
      })
      .catch((err: unknown) => logger.error('late tool result event failed', { runId, toolCallId: call.id, err }));
  };

  // a tool that ignores the abort signal keeps running. the run does not wait for it, so a stuck tool cannot hold the
  // session queue.
  const run = async (tool: Tool, input: unknown, ctx: ToolContext, call: ToolCall, finish: (output: ToolOutput, outcome?: 'abandoned') => ToolOutput & { rowId?: number }) => {
    if (ctx.signal.aborted) return finish({ content: `${tool.name} did not run, because the run stopped first.`, isError: true });
    const running = tools.execute(tool, input, ctx);
    let onAbort = () => {};
    const stopped = new Promise<typeof STOPPED>((resolve) => {
      onAbort = () => resolve(STOPPED);
      ctx.signal.addEventListener('abort', onAbort, { once: true });
    });
    const first = await Promise.race([running, stopped]).finally(() => ctx.signal.removeEventListener('abort', onAbort));
    if (first !== STOPPED) return finish(first);
    const recorded = finish({ content: abandonedText(tool.name), isError: true }, 'abandoned');
    // nobody waits for this chain, so an error in it must go to the log. an unhandled rejection stops the process.
    void running
      .then((late) => recordLate(ctx.runId, ctx.sessionKey, call, recorded.rowId, late))
      .catch((err: unknown) => logger.error('late tool result failed', { runId: ctx.runId, toolCallId: call.id, err }));
    return recorded;
  };

  const strip = ({ rowId: _rowId, ...output }: ToolOutput & { rowId?: number }): ToolOutput => output;

  // check decides the call and writes the decision. it ends before the tool runs, so a failure here is safe. the
  // decision row comes before the request to the owner, so an approval never exists without its decision.
  async function check(tool: Tool, input: unknown, call: ToolCall, ctx: CallContext, toolCtx: ToolContext) {
    const taint = sessionTaint(db, ctx.sessionKey);
    const sources = taint.map((each) => each.source);
    const verdict = decide(
      { tool: tool.name, risk: tool.risk, alwaysApprove: tool.needsApproval === true, input, sessionKey: ctx.sessionKey, taint: sources },
      deps.rules,
    );
    let reason =
      verdict.decision === 'review' && !deps.reviewer ? `${verdict.reason}. there is no reviewer model yet, so the owner decides` : verdict.reason;
    const decisionId = recordDecision(
      db,
      { ...verdict, reason, taint, runId: ctx.runId, toolCallId: call.id, toolName: tool.name },
      clock(),
    );
    const gate = { decisionId, taint };

    const askOwner = async (): Promise<ToolOutput> => {
      let requested: { approvalId: number; output: ToolOutput };
      try {
        requested = await deps.requestApproval(tool, input, toolCtx, { reason, taint });
      } catch (err) {
        logger.error('approval request failed, so the tool did not run', { runId: ctx.runId, toolCallId: call.id, tool: tool.name, err });
        updateDecision(db, decisionId, { reason: `${reason}. the request for the owner's approval failed, so the call did not run` });
        return { content: `${tool.name} did not run, because the request for the owner's approval failed: ${errorText(err)}`, isError: true };
      }
      updateDecision(db, decisionId, { approvalId: requested.approvalId });
      return requested.output;
    };

    if (verdict.decision === 'deny') {
      return { ...gate, held: { content: `the policy denied ${tool.name}, and it did not run: ${verdict.reason}`, isError: true } };
    }
    if (verdict.decision === 'approve' || (verdict.decision === 'review' && !deps.reviewer)) return { ...gate, held: await askOwner() };
    if (verdict.decision === 'review' && deps.reviewer) {
      let review: ReviewResult;
      try {
        review = await deps.reviewer({ runId: ctx.runId, sessionKey: ctx.sessionKey, tool: tool.name, input, risk: tool.risk, reason, taint: sources });
      } catch (err) {
        // a reviewer that fails must not allow the call. the owner decides instead.
        logger.warn('reviewer failed, so the owner decides', { runId: ctx.runId, toolCallId: call.id, tool: tool.name, err });
        reason = `${reason}. the reviewer failed (${errorText(err)}), so the owner decides`;
        updateDecision(db, decisionId, { reason });
        return { ...gate, held: await askOwner() };
      }
      updateDecision(db, decisionId, { review });
      if (review.verdict === 'hold') {
        return { ...gate, held: { content: `the reviewer held ${tool.name}, and it did not run: ${review.reason}`, isError: true } };
      }
    }
    return gate;
  }

  return {
    async call(call, ctx) {
      const started = performance.now();
      const toolCtx: ToolContext = {
        runId: ctx.runId,
        sessionKey: ctx.sessionKey,
        timeZone: deps.timeZone,
        clock,
        signal: ctx.signal,
        toolCallId: call.id,
      };
      const resolved = tools.resolve(call, ctx.allowed);
      if (!resolved.ok) return strip(record(ctx.runId, call, resolved.output, started, {}));
      const { tool, input } = resolved;

      let gate: { decisionId: number; taint: TaintSource[]; held?: ToolOutput };
      try {
        gate = await check(tool, input, call, ctx, toolCtx);
      } catch (err) {
        logger.error('policy check failed, so the tool did not run', { runId: ctx.runId, toolCallId: call.id, tool: tool.name, err });
        const output = { content: `${tool.name} did not run, because its policy check failed: ${errorText(err)}`, isError: true };
        return strip(record(ctx.runId, call, output, started, { risk: tool.risk }));
      }
      const trace = { risk: tool.risk, decisionId: gate.decisionId, tainted: gate.taint.length > 0 };
      const finish = (output: ToolOutput, outcome?: 'abandoned') =>
        record(ctx.runId, call, output, started, { ...trace, ...(outcome ? { outcome } : {}) });
      if (gate.held) return strip(finish(gate.held));
      return strip(await run(tool, input, toolCtx, call, finish));
    },

    async callApproved(approval, signal) {
      const started = performance.now();
      const call = { id: `approval-${approval.id}`, name: approval.toolName, input: approval.input };
      const toolCtx: ToolContext = {
        runId: approval.runId,
        sessionKey: approval.sessionKey,
        timeZone: deps.timeZone,
        clock,
        signal,
        toolCallId: call.id,
      };
      let trace: Trace;
      try {
        // the start mark is a compare and set. a second call for the same approval never runs the tool again, and an
        // approval that expired in the meantime never runs.
        const claimed = db
          .prepare("UPDATE approvals SET startedAt = ? WHERE id = ? AND startedAt IS NULL AND status = 'approved'")
          .run(clock().toISOString(), approval.id).changes;
        if (!claimed) return { content: `approval #${approval.id} already ran, so it did not run again`, isError: true };
        trace = { decisionId: decisionOfApproval(db, approval.id), tainted: sessionTaint(db, approval.sessionKey).length > 0 };
      } catch (err) {
        logger.error('approved call failed before it ran', { runId: approval.runId, approvalId: approval.id, err });
        return { content: `approval #${approval.id} did not run: ${errorText(err)}`, isError: true };
      }
      const resolved = tools.resolve(call, [approval.toolName]);
      if (!resolved.ok) return strip(record(approval.runId, call, resolved.output, started, trace));
      const finish = (output: ToolOutput, outcome?: 'abandoned') =>
        record(approval.runId, call, output, started, { ...trace, risk: resolved.tool.risk, ...(outcome ? { outcome } : {}) });
      return strip(await run(resolved.tool, resolved.input, toolCtx, call, finish));
    },
  };
}
