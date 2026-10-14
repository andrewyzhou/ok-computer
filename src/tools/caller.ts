import type { Approval } from '../approvals/store.js';
import type { Db } from '../db/index.js';
import { appendEvent } from '../events/log.js';
import { integrationOf } from '../integrations/names.js';
import type { ToolCall } from '../models/types.js';
import type { BlobStore } from '../observability/blobs.js';
import type { Logger } from '../observability/logger.js';
import { redact, redactedJson } from '../observability/redact.js';
import { decide, reviewCallOf, SUBAGENT_PREFIX, type ReviewResult, type Reviewer, type Risk, type Rule, type TaintSource } from '../policy/policy.js';
import { decisionOfApproval, recordDecision, sessionTaint, updateDecision, urlSeen } from '../policy/store.js';
import type { RunQueue } from '../sessions/queue.js';
import type { Clock } from '../time.js';
import { errorText, type Attribution, type Tool, type ToolContext, type ToolOutput, type ToolRegistry } from './registry.js';
import { modelView, newHandle } from './results.js';

export interface CallContext {
  runId: string;
  sessionKey: string;
  allowed: readonly string[];
  signal: AbortSignal;
}

// why gives the owner the reason of the policy and the untrusted sources that the session read. the flow links the
// decision to the approval before it sends the message, so a crash during the send leaves a decision that names a
// live approval.
export interface ApprovalWhy {
  decisionId: number;
  reason: string;
  taint: TaintSource[];
}

// the approval flow asks the owner. its output tells the model that the call waits for the owner.
export type RequestApproval = (tool: Tool, input: unknown, ctx: ToolContext, why: ApprovalWhy) => Promise<ToolOutput>;

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
  // notRun records a call that never reaches the policy, for example a call in a reply that the token limit cut. the
  // model gets the text as an error, and the call gets a row like every other call.
  notRun(call: ToolCall, ctx: CallContext, text: string): ToolOutput;
  // callApproved runs the stored input of an approval one time. the call goes into the trace of the original run.
  // started tells whether the tool began to run, so the note to the session does not say that a skipped call ran.
  // again tells that the tool did not act, for example because its integration was not connected, so the approval
  // waits for the owner again. abandoned tells that the tool started and did not finish before the signal, so its
  // effect is unknown. onLate gets the redacted view of a result that comes after that, because the owner who approved
  // the call must learn it. a late output with the effect unknown ended without an answer.
  callApproved(
    approval: Approval,
    signal: AbortSignal,
    onLate?: (late: ToolOutput) => void,
  ): Promise<{ started: boolean; again?: boolean; abandoned?: boolean; output: ToolOutput }>;
}

interface Trace {
  risk?: Risk;
  decisionId?: number | null;
  tainted?: boolean;
  // abandoned: the run stopped while the tool ran. a later result changes it to late. the row of an output whose
  // effect is none gets unsent: its integration did not send the call, so the tool did not run.
  outcome?: 'abandoned';
  source?: string;
  serverId?: string;
}

const sourceOf = (tool: Attribution) => ({ ...(tool.source ? { source: tool.source } : {}), ...(tool.serverId ? { serverId: tool.serverId } : {}) });

// an approval can run days after its call. by then the owner can have removed the integration of its tool.
function goneText(name: string): string {
  const integration = integrationOf(name);
  return integration
    ? `${name} no longer exists, because the ${integration} integration was removed or no longer allows it for this session. The call did not run.`
    : `${name} no longer exists. The call did not run.`;
}

const STOPPED = Symbol('stopped');

// the owner's message or a reviewer model can hang. the run must not wait for them after it stops, because the run
// holds its session queue. work that fails after the stop goes to the log, so it is not an unhandled rejection.
function untilStopped<T>(work: Promise<T>, signal: AbortSignal, onLateError: (err: unknown) => void): Promise<T | typeof STOPPED> {
  if (signal.aborted) {
    work.catch(onLateError);
    return Promise.resolve(STOPPED);
  }
  let onAbort = () => {};
  const stopped = new Promise<typeof STOPPED>((resolve) => {
    onAbort = () => {
      work.catch(onLateError);
      resolve(STOPPED);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
  return Promise.race([work, stopped]).finally(() => signal.removeEventListener('abort', onAbort));
}

// a hold goes back to the agent. the text gives the way out: the reviewer reads the owner's last message, so the owner
// can confirm the action. a child cannot ask the owner, so it reports the hold to its parent.
const holdNext = (sessionKey: string) =>
  sessionKey.startsWith('sub:')
    ? 'Return to the parent agent and say which call it held.'
    : "Change course, or ask the owner. The reviewer reads the owner's last message, so if the owner confirms this exact action, you can try it again.";

const sentence = (text: string) => (/[.!?]$/.test(text.trim()) ? text.trim() : `${text.trim()}.`);

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

  // the preview cuts the text, and a secret that the cut splits no longer matches the redaction. so the redaction
  // comes first. the model sees the redacted text in each later request anyway, because the events are redacted.
  // the source goes to the row, the taint and the dashboard, and a url can hold a key, so it is redacted too.
  const viewOf = (output: ToolOutput) => {
    const clean = { ...output, content: redact(output.content), ...(output.untrustedSource ? { untrustedSource: redact(output.untrustedSource) } : {}) };
    return { clean, view: modelView(clean, deps.newHandle ?? newHandle) };
  };

  const record = (runId: string, call: ToolCall, raw: ToolOutput, started: number, trace: Trace): ToolOutput & { rowId?: number } => {
    const { clean: output, view } = viewOf(raw);
    const result: ToolOutput = {
      content: view.content,
      ...(output.isError ? { isError: true } : {}),
      ...(output.untrustedSource ? { untrustedSource: output.untrustedSource } : {}),
    };
    // a failed blob write loses only the raw text. the row with the decision, the input and the model view stays.
    let rawResultBlob: string | null = null;
    try {
      // the raw text needs a blob only when the model saw other text: a preview, or a wrapped text.
      if (view.content !== output.content) rawResultBlob = blobs.put(output.content);
    } catch (err) {
      logger.error('tool result blob write failed', { runId, toolCallId: call.id, tool: call.name, err });
    }
    try {
      const row = db
        .prepare(
          `INSERT INTO tool_calls (runId, toolCallId, name, input, output, isError, durationMs, createdAt, riskLevel,
             policyDecisionId, tainted, untrustedSource, rawResultBlob, truncated, resultHandle, outcome, source, serverId)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
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
          rawResultBlob,
          view.truncated ? 1 : 0,
          view.handle ?? null,
          trace.outcome ?? (raw.effect === 'none' ? 'unsent' : null),
          trace.source ?? 'builtin',
          trace.serverId ?? null,
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
    const { clean, view } = viewOf(late);
    // a call that ended without an answer did not finish. the row stays abandoned, because its effect is still unknown.
    const unknown = late.effect === 'unknown';
    let rawResultBlob: string | null = null;
    try {
      rawResultBlob = blobs.put(clean.content);
    } catch (err) {
      logger.error('late tool result blob write failed', { runId, toolCallId: call.id, tool: call.name, err });
    }
    try {
      if (rowId !== undefined) {
        db.prepare(
          'UPDATE tool_calls SET outcome = ?, isError = ?, rawResultBlob = ?, resultHandle = ?, untrustedSource = ? WHERE id = ?',
        ).run(unknown ? 'abandoned' : 'late', late.isError ? 1 : 0, rawResultBlob, view.handle ?? null, clean.untrustedSource ?? null, rowId);
      }
      logger.warn(unknown ? 'an abandoned tool call ended without an answer' : 'an abandoned tool call finished late', { runId, toolCallId: call.id, tool: call.name });
    } catch (err) {
      logger.error('late tool result trace write failed', { runId, toolCallId: call.id, tool: call.name, err });
    }
    const taint: TaintSource[] = clean.untrustedSource
      ? [{ source: clean.untrustedSource, toolName: call.name, runId, toolCallId: call.id, at: clock().toISOString() }]
      : [];
    const text = unknown
      ? `${call.name} (call ${call.id}) ended after its run stopped, but no answer came, so its effect is still unknown:\n${view.content}`
      : `${call.name} (call ${call.id}) finished after its run stopped.${late.isError ? ' It failed.' : ''} Result:\n${view.content}`;
    void deps.queue
      .enqueue(sessionKey, async () => {
        appendEvent(db, { sessionKey, runId: null, type: 'system_event', payload: { text, ...(taint.length ? { taint } : {}) } }, clock());
      })
      .catch((err: unknown) => logger.error('late tool result event failed', { runId, toolCallId: call.id, err }));
    return { content: view.content, ...(late.isError ? { isError: true } : {}), ...(unknown ? { effect: 'unknown' as const } : {}) };
  };

  // a tool that ignores the abort signal keeps running. the run does not wait for it, so a stuck tool cannot hold the
  // session queue.
  const run = async (
    tool: Tool,
    input: unknown,
    ctx: ToolContext,
    call: ToolCall,
    finish: (output: ToolOutput, outcome?: 'abandoned') => ToolOutput & { rowId?: number },
    onLate?: (late: ToolOutput) => void,
  ) => {
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
      .then((late) => {
        // the record must not be an argument of onLate?.(), because an optional call skips its arguments.
        const view = recordLate(ctx.runId, ctx.sessionKey, call, recorded.rowId, late);
        onLate?.(view);
      })
      .catch((err: unknown) => logger.error('late tool result failed', { runId: ctx.runId, toolCallId: call.id, err }));
    return recorded;
  };

  const strip = ({ rowId: _rowId, ...output }: ToolOutput & { rowId?: number }): ToolOutput => output;

  // a tool that did not act gives the approval back to the owner, for example when its integration was paused or not
  // connected yet. the owner can then approve it again, until it expires like every pending approval.
  const release = (approval: Approval): boolean => {
    try {
      return (
        db
          .prepare("UPDATE approvals SET status = 'pending', startedAt = NULL, resolvedAt = NULL, resolvedBy = NULL WHERE id = ? AND status = 'approved'")
          .run(approval.id).changes === 1
      );
    } catch (err) {
      logger.error('approval release failed', { runId: approval.runId, approvalId: approval.id, err });
      return false;
    }
  };

  // check decides the call and writes the decision. it ends before the tool runs, so a failure here is safe. the
  // decision row comes before the request to the owner, so an approval never exists without its decision.
  async function check(tool: Tool, input: unknown, call: ToolCall, ctx: CallContext, toolCtx: ToolContext) {
    const taint = sessionTaint(db, ctx.sessionKey);
    const sources = taint.map((each) => each.source);
    const verdict = decide(
      {
        tool: tool.name,
        risk: tool.risk,
        alwaysApprove: tool.needsApproval === true,
        input,
        sessionKey: ctx.sessionKey,
        taint: sources,
        seen: (url) => urlSeen(db, ctx.sessionKey, url),
      },
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
      // a sub-agent never asks the owner (see policy.ts). a review without a usable reviewer would ask, so it becomes a
      // hold, and the decision row says why.
      if (ctx.sessionKey.startsWith(SUBAGENT_PREFIX)) {
        const held = { verdict: 'hold' as const, reason: `${reason}. a sub-agent cannot ask the owner, so the call did not run` };
        updateDecision(db, decisionId, { review: held });
        return { content: `${tool.name} did not run: ${held.reason}. Return to the parent agent and say which call needs the owner.`, isError: true };
      }
      try {
        const asked = await untilStopped(deps.requestApproval(tool, input, toolCtx, { decisionId, reason, taint }), ctx.signal, (err) =>
          logger.error('approval request failed after its run stopped', { runId: ctx.runId, toolCallId: call.id, tool: tool.name, err }),
        );
        if (asked !== STOPPED) return asked;
        updateDecision(db, decisionId, { reason: `${reason}. the run stopped while the request for the owner's approval was sent` });
        return {
          content: `${tool.name} did not run. The run stopped while the request for the owner's approval was sent. If the request reached the owner, the decision comes back as a system event.`,
          isError: true,
        };
      } catch (err) {
        logger.error('approval request failed, so the tool did not run', { runId: ctx.runId, toolCallId: call.id, tool: tool.name, err });
        updateDecision(db, decisionId, { reason: `${reason}. the request for the owner's approval failed, so the call did not run` });
        return { content: `${tool.name} did not run, because the request for the owner's approval failed: ${errorText(err)}`, isError: true };
      }
    };

    if (verdict.decision === 'deny') {
      return { ...gate, held: { content: `the policy denied ${tool.name}, and it did not run: ${verdict.reason}`, isError: true } };
    }
    if (verdict.decision === 'approve' || (verdict.decision === 'review' && !deps.reviewer)) return { ...gate, held: await askOwner() };
    if (verdict.decision === 'review' && deps.reviewer) {
      let review: ReviewResult | typeof STOPPED;
      try {
        const request = { runId: ctx.runId, sessionKey: ctx.sessionKey, tool: tool.name, input, risk: tool.risk, reason, taint: sources, signal: ctx.signal };
        review = await untilStopped(deps.reviewer(request), ctx.signal, (err) =>
          logger.warn('reviewer failed after its run stopped', { runId: ctx.runId, toolCallId: call.id, tool: tool.name, err }),
        );
      } catch (err) {
        // a reviewer that fails must not allow the call. the owner decides instead.
        logger.warn('reviewer failed, so the owner decides', { runId: ctx.runId, toolCallId: call.id, tool: tool.name, err });
        // the error goes on the card in the chat, so it is redacted here and not only in the store.
        reason = `${reason}. the reviewer failed (${redact(errorText(err))}), so the owner decides`;
        updateDecision(db, decisionId, { reason, reviewerModelCallId: reviewCallOf(err) });
        return { ...gate, held: await askOwner() };
      }
      if (review === STOPPED) {
        updateDecision(db, decisionId, { reason: `${reason}. the run stopped before the reviewer answered` });
        return { ...gate, held: { content: `${tool.name} did not run, because the run stopped first.`, isError: true } };
      }
      updateDecision(db, decisionId, { review });
      if (review.verdict === 'hold') {
        return { ...gate, held: { content: `the reviewer held ${tool.name}, and it did not run: ${sentence(review.reason)} ${holdNext(ctx.sessionKey)}`, isError: true } };
      }
    }
    return gate;
  }

  return {
    async call(modelCall, ctx) {
      const started = performance.now();
      const toolCtx: ToolContext = {
        runId: ctx.runId,
        sessionKey: ctx.sessionKey,
        timeZone: deps.timeZone,
        clock,
        signal: ctx.signal,
        toolCallId: modelCall.id,
      };
      const resolved = tools.resolve(modelCall, ctx.allowed, ctx.sessionKey);
      // a bad input to an integration tool counts for that integration on the dashboard.
      if (!resolved.ok) return strip(record(ctx.runId, resolved.call ?? modelCall, resolved.output, started, resolved.from ? sourceOf(resolved.from) : {}));
      // for tool_call this is the integration tool that it names, with the same id.
      const { tool, input, call } = resolved;

      let gate: { decisionId: number; taint: TaintSource[]; held?: ToolOutput };
      try {
        gate = await check(tool, input, call, ctx, toolCtx);
      } catch (err) {
        logger.error('policy check failed, so the tool did not run', { runId: ctx.runId, toolCallId: call.id, tool: tool.name, err });
        const output = { content: `${tool.name} did not run, because its policy check failed: ${errorText(err)}`, isError: true };
        return strip(record(ctx.runId, call, output, started, { risk: tool.risk }));
      }
      const trace = { risk: tool.risk, decisionId: gate.decisionId, tainted: gate.taint.length > 0, ...sourceOf(tool) };
      const finish = (output: ToolOutput, outcome?: 'abandoned') =>
        record(ctx.runId, call, output, started, { ...trace, ...(outcome ? { outcome } : {}) });
      if (gate.held) return strip(finish(gate.held));
      return strip(await run(tool, input, toolCtx, call, finish));
    },

    notRun(call, ctx, text) {
      return strip(record(ctx.runId, call, { content: text, isError: true }, performance.now(), {}));
    },

    async callApproved(approval, signal, onLate) {
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
      const skipped = (content: string) => ({ started: false, output: { content, isError: true } });
      // a stop before the claim leaves the approval unclaimed. the sweep then tells the owner that it did not run.
      if (signal.aborted) return skipped(`approval #${approval.id} did not run, because the app stopped first`);
      let trace: Trace;
      try {
        // the start mark is a compare and set. a second call for the same approval never runs the tool again, and an
        // approval that expired in the meantime never runs.
        const claimed = db
          .prepare("UPDATE approvals SET startedAt = ? WHERE id = ? AND startedAt IS NULL AND status = 'approved'")
          .run(clock().toISOString(), approval.id).changes;
        if (!claimed) {
          const status = db.prepare('SELECT status FROM approvals WHERE id = ?').get(approval.id)?.status;
          return skipped(
            status === 'expired'
              ? `approval #${approval.id} expired before it could run, so it did not run`
              : `approval #${approval.id} already ran, so it did not run again`,
          );
        }
        trace = { decisionId: decisionOfApproval(db, approval.id), tainted: sessionTaint(db, approval.sessionKey).length > 0 };
      } catch (err) {
        logger.error('approved call failed before it ran', { runId: approval.runId, approvalId: approval.id, err });
        return skipped(`approval #${approval.id} did not run: ${errorText(err)}`);
      }
      // the lookup checks the current config, so a tool that the session lost since the approval does not run.
      const resolved = tools.resolve(call, [approval.toolName], approval.sessionKey);
      if (!resolved.ok) {
        const output = resolved.unknown ? { content: goneText(approval.toolName), isError: true } : resolved.output;
        return { started: false, output: strip(record(approval.runId, call, output, started, trace)) };
      }
      let abandoned = false;
      let acted = true;
      const finish = (output: ToolOutput, outcome?: 'abandoned') => {
        abandoned = outcome === 'abandoned';
        acted = output.effect !== 'none';
        return record(approval.runId, call, output, started, { ...trace, risk: resolved.tool.risk, ...sourceOf(resolved.tool), ...(outcome ? { outcome } : {}) });
      };
      // no await comes between the check of the signal and this line, so the tool starts.
      const output = strip(await run(resolved.tool, resolved.input, toolCtx, call, finish, onLate));
      if (!acted) return { started: false, ...(release(approval) ? { again: true } : {}), output };
      return { started: true, ...(abandoned ? { abandoned } : {}), output };
    },
  };
}
