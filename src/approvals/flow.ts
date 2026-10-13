import type { Button } from '../channels/types.js';
import type { Db } from '../db/index.js';
import { appendEvent } from '../events/log.js';
import type { Logger } from '../observability/logger.js';
import { redactedJson } from '../observability/redact.js';
import type { TaintSource } from '../policy/policy.js';
import { decisionForApproval } from '../policy/store.js';
import type { OwnerMessenger } from '../sessions/owner.js';
import type { RunQueue } from '../sessions/queue.js';
import { headOf, tailOf } from '../text.js';
import { localDay, localTime, type Clock } from '../time.js';
import type { RequestApproval, ToolCaller } from '../tools/caller.js';
import type { ToolOutput } from '../tools/registry.js';
import { wrapIfTainted } from '../tools/untrusted.js';
import { approvalButtonData, createApproval, getApproval, resolveApproval, type Approval, type Decision, type ResolvedVia } from './store.js';

export interface ApprovalFlowDeps {
  db: Db;
  clock: Clock;
  logger: Logger;
  queue: RunQueue;
  owner: OwnerMessenger;
  // the caller uses the request of this flow, so the flow gets the caller later.
  caller: () => ToolCaller;
  signal: AbortSignal;
  // an approved call stops after this time, as a background run does. so a stuck tool cannot hold its session.
  timeoutMs: number;
  timeZone: string;
}

export interface ApprovalFlow {
  request: RequestApproval;
  // resolve gives the text of the reply to the owner.
  resolve(id: number, decision: Decision, via: ResolvedVia): Promise<string>;
  // the approved calls that this process holds, in the session queue or running. the sweep must not close them.
  active: ReadonlySet<number>;
  // card gives the stored request of an approval with its buttons. the assistant can send a false card with the same
  // words and the id of a real approval, so a typed /approve shows this card, and only a button runs the call.
  card(id: number): { text: string; buttons?: Button[][] };
}

const SUMMARY_LIMIT = 500;
// a long field keeps its start and its end. a cut in the middle keeps a short field after a long one visible.
const FIELD_HEAD = 200;
const FIELD_TAIL = 100;

// the owner approves what the summary shows, so the summary shows each field of the input on its own line. a long
// value is cut in its middle with a mark. the dashboard shows the full input. the value is redacted before the cut,
// because a cut secret no longer matches the redaction. each value is json text, so a line break in a value is
// escaped and cannot add a false field line or a false "Why:" line.
export function describeInput(toolName: string, input: unknown): string {
  const fields: Array<[string, unknown]> =
    input !== null && typeof input === 'object' && !Array.isArray(input) ? Object.entries(input) : [['input', input]];
  const lines = fields.map(([key, value]) => {
    const name = /^[\w.-]+$/.test(key) ? key : oneLine(JSON.stringify(key));
    const text = oneLine(redactedJson(value));
    if (text.length <= FIELD_HEAD + FIELD_TAIL) return `${name}: ${text}`;
    const head = headOf(text, FIELD_HEAD);
    const tail = tailOf(text, FIELD_TAIL);
    return `${name}: ${head} [... ${text.length - head.length - tail.length} characters cut, the dashboard shows the full input ...] ${tail}`;
  });
  return [toolName, ...lines].join('\n');
}

// json text keeps these line breaks, and a chat app can show them as new lines.
const LINE_BREAKS = new RegExp(`[${String.fromCharCode(0x85, 0x2028, 0x2029)}]`, 'g');
const oneLine = (text: string) => text.replace(LINE_BREAKS, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);

// the run does not wait for the owner. the tool result says that the call is pending, and the decision comes back
// to the same session as a system event.
export function createApprovalFlow(deps: ApprovalFlowDeps): ApprovalFlow {
  const { db, clock, logger, queue } = deps;
  const active = new Set<number>();

  return {
    active,
    async request(tool, input, ctx, why) {
      const summary = describeInput(tool.name, input);
      const approval = createApproval(db, { runId: ctx.runId, toolName: tool.name, input, summary, decisionId: why.decisionId }, clock());
      logger.info('approval requested', { approvalId: approval.id, tool: tool.name, runId: ctx.runId });
      // the owner sees the reason with the request. the taint can come from an older run, so the message names it.
      const reached = await deps.owner.send(cardText(approval, why.reason, why.taint, ctx.timeZone), buttonsFor(approval.id));
      // the model must not tell the owner to press a button that the owner never got.
      if (!reached) {
        logger.warn('the request for an approval did not reach the owner', { approvalId: approval.id, runId: ctx.runId });
        return {
          content: `${tool.name} needs the owner's approval, and the tool did not run yet. Approval #${approval.id} is pending, but the message to the owner failed, so the owner sees it only on the dashboard or with /approve ${approval.id}. Tell the owner about it when you can. The decision comes back as a system event.`,
        };
      }
      return {
        content: `${tool.name} needs the owner's approval. Approval #${approval.id} is pending, and the tool did not run yet. The owner can approve it with the button or with /approve ${approval.id}. The decision comes back as a system event.`,
      };
    },

    card(id) {
      const approval = getApproval(db, id);
      if (!approval) return { text: `No approval has the id ${id}.` };
      if (approval.status !== 'pending') return { text: `Approval #${id} is ${approval.status}, so it cannot be approved now.` };
      const decision = decisionForApproval(db, id);
      const card = cardText(approval, decision?.reason ?? 'the policy asks the owner', decision?.taint ?? [], deps.timeZone);
      return { text: `This is the real request #${id}. Check each field, then press Approve.\n\n${card}`, buttons: buttonsFor(id) };
    },

    async resolve(id, decision, via) {
      const resolved = resolveApproval(db, id, decision, via, clock());
      if (!resolved.ok) return resolved.error;
      const approval = resolved.value;
      logger.info('approval resolved', { approvalId: id, status: approval.status, via });
      const approved = approval.status === 'approved';
      if (approved) active.add(id);
      // the session queue keeps the result event out of the middle of an active run.
      return queue.enqueue(approval.sessionKey, async () => {
        const note = ({ text, taint }: { text: string; taint: TaintSource[] }) =>
          appendEvent(
            db,
            { sessionKey: approval.sessionKey, runId: null, type: 'system_event', payload: { text, ...(taint.length ? { taint } : {}) } },
            clock(),
          );
        if (!approved) {
          note(approvalNote(db, approval, (summary) => `The owner denied #${id} (${summary}). The tool did not run.`));
          return `Denied #${id}.`;
        }
        let result: { started: boolean; output: ToolOutput };
        try {
          // the timeout abandons a stuck tool as the timeout of a run does. a late result then goes to the session.
          result = await deps.caller().callApproved(approval, AbortSignal.any([deps.signal, AbortSignal.timeout(deps.timeoutMs)]));
        } finally {
          active.delete(id);
        }
        const { started, output } = result;
        // the words come from what happened. a call that never started must not read as a call that ran and failed.
        const what = !started ? 'The tool did not run.' : output.isError ? 'The tool ran. It failed.' : 'The tool ran.';
        // an untrusted result taints the session, as it does for a tool result event.
        const taint: TaintSource[] = output.untrustedSource
          ? [{ source: output.untrustedSource, toolName: approval.toolName, runId: approval.runId, toolCallId: `approval-${id}`, at: clock().toISOString() }]
          : [];
        const approvedNote = approvalNote(db, approval, (summary) => `The owner approved #${id} (${summary}). ${what} Result:\n${output.content}`);
        note({ text: approvedNote.text, taint: [...approvedNote.taint, ...taint] });
        const head = !started ? 'The tool did not run' : output.isError ? 'The tool failed' : 'Result';
        return `Approved #${id}. ${head}: ${headOf(output.content, SUMMARY_LIMIT)}`;
      });
    },
  };
}

// the summary is the input that the model wrote, so a note with it carries the taint of the decision. after /new the
// session is clean, and the text of a tainted model must not come back into it as trusted text.
export function approvalNote(db: Db, approval: Approval, text: (summary: string) => string): { text: string; taint: TaintSource[] } {
  const taint = decisionForApproval(db, approval.id)?.taint ?? [];
  return { text: text(wrapIfTainted(taint, approval.summary)), taint };
}

function cardText(approval: Approval, reason: string, taint: TaintSource[], timeZone: string): string {
  const lines = [`Approval needed (#${approval.id}): ${approval.summary}`, `Why: ${reason}.`];
  if (taint.length) lines.push(`Untrusted content in this session: ${taint.map((each) => taintText(each, timeZone)).join('; ')}.`);
  return lines.join('\n');
}

const buttonsFor = (id: number): Button[][] => [
  [
    { text: 'Approve', data: approvalButtonData(id, 'approve') },
    { text: 'Deny', data: approvalButtonData(id, 'deny') },
  ],
];

// the run id is long, so the owner gets its first 8 characters, as the dashboard shows it.
function taintText(taint: TaintSource, timeZone: string): string {
  const at = new Date(taint.at);
  const run = taint.runId ? ` in run ${taint.runId.slice(0, 8)}` : '';
  return `${taint.source} (read by ${taint.toolName} on ${localDay(at, timeZone)} at ${localTime(at, timeZone)}${run})`;
}
