import type { Button } from '../channels/types.js';
import type { Db } from '../db/index.js';
import { appendEvent } from '../events/log.js';
import type { Logger } from '../observability/logger.js';
import { redactedJson } from '../observability/redact.js';
import { dataUrls, SOURCE_LIMIT, SOURCE_NAME_LIMIT, type TaintSource } from '../policy/policy.js';
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
    const json = redactedJson(value);
    const { text, found } = showInvisible(oneLine(json));
    const marks = warnings(json !== (JSON.stringify(value) ?? 'null'), found, text);
    if (text.length <= FIELD_HEAD + FIELD_TAIL) return `${name}: ${text}${marks}`;
    const head = headOf(text, FIELD_HEAD);
    const tail = tailOf(text, FIELD_TAIL);
    return `${name}: ${head} [... ${text.length - head.length - tail.length} characters cut, the dashboard shows the full input ...] ${tail}${marks}`;
  });
  return [toolName, ...lines].join('\n');
}

// the card hides a stored secret, but the tool gets the real value. the owner must know that the call sends it.
// a letter from another script looks like a latin letter, for example a cyrillic о in a domain that an allow rule does
// not match. the check is on each run of text between spaces and json marks, not on each word, because a word of
// look-alikes alone ("аррӏе" in "https://аррӏе.example") is in one script. a run without latin letters, for example
// a sentence in russian, gets no mark. the mark names the code points, so the owner can see the difference.
function warnings(redacted: boolean, invisible: boolean, text: string): string {
  const marks: string[] = [];
  if (redacted) marks.push('this field holds a secret that the card hides, and the tool gets the real value');
  if (invisible) marks.push('this field holds invisible or direction characters, shown as \\u codes');
  const mixed = [...new Set(text.split(/[\s",[\]{}]+/u).filter((run) => LATIN.test(run) && OTHER_SCRIPT.test(run)))].slice(0, 3);
  for (const run of mixed) {
    const points = [...new Set([...run].filter((char) => OTHER_SCRIPT.test(char)))].slice(0, 5).map(codePoint);
    marks.push(`"${headOf(run, 60)}" mixes scripts (${points.join(', ')})`);
  }
  return marks.length ? ` [check: ${marks.join('; ')}]` : '';
}

const LATIN = /\p{Script=Latin}/u;
const OTHER_SCRIPT = /[^\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}]/u;
const codePoint = (char: string) => `U+${char.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}`;

// a zero width space, a soft hyphen or a word joiner hides inside a look-alike address, and a direction override
// reorders the text after it in the chat. json text keeps them, so the card shows each one as a \u code. a variation
// selector and a joiner after an emoji stay, because they only form the emoji.
const INVISIBLE = /[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu;
const EMOJI_PART = /[\p{Extended_Pictographic}\p{Emoji_Modifier}️]$/u;
function showInvisible(text: string): { text: string; found: boolean } {
  let found = false;
  const shown = text.replace(INVISIBLE, (char: string, offset: number) => {
    if (char === '︎' || char === '️' || (char === '‍' && EMOJI_PART.test(text.slice(0, offset)))) return char;
    found = true;
    const point = char.codePointAt(0)!;
    return point > 0xffff ? `\\u{${point.toString(16)}}` : `\\u${point.toString(16).padStart(4, '0')}`;
  });
  return { text: shown, found };
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
        // the owner was told that the effect is unknown, so the owner also gets the result that comes later. without
        // it, the owner can approve the same send again.
        const onLate = (late: ToolOutput) => {
          const text =
            late.effect === 'unknown'
              ? `Approval #${id} (${approval.toolName}) ended without an answer, so its effect is still unknown: ${headOf(late.content, SUMMARY_LIMIT)}`
              : `Approval #${id} (${approval.toolName}) finished after all.${late.isError ? ' It failed.' : ''} Result: ${headOf(late.content, SUMMARY_LIMIT)}`;
          deps.owner.send(text).catch((err: unknown) => logger.error('late approval result did not reach the owner', { approvalId: id, err }));
        };
        let result: Awaited<ReturnType<ToolCaller['callApproved']>>;
        try {
          // the timeout abandons a stuck tool as the timeout of a run does. a late result then goes to the session.
          result = await deps.caller().callApproved(approval, AbortSignal.any([deps.signal, AbortSignal.timeout(deps.timeoutMs)]), onLate);
        } finally {
          active.delete(id);
        }
        const { started, again, abandoned, output } = result;
        // the words come from what happened. a call that never started must not read as a call that ran and failed,
        // and a call that did not finish in time can still have acted.
        if (abandoned) {
          const unknown = 'The tool started, but it did not finish in time, so its effect is unknown.';
          note(approvalNote(db, approval, (summary) => `The owner approved #${id} (${summary}). ${unknown} If it finishes later, its result comes as a system event.`));
          return `Approved #${id}. ${unknown} You get a message if it finishes later.`;
        }
        // a tool that did not act gave the approval back, so the owner can approve it again when it can run.
        const what = again
          ? `The tool did not run, so approval #${id} waits for the owner again.`
          : !started
            ? 'The tool did not run.'
            : output.isError
              ? 'The tool ran. It failed.'
              : 'The tool ran.';
        // an untrusted result taints the session, as it does for a tool result event.
        const taint: TaintSource[] = output.untrustedSource
          ? [{ source: output.untrustedSource, toolName: approval.toolName, runId: approval.runId, toolCallId: `approval-${id}`, at: clock().toISOString() }]
          : [];
        const approvedNote = approvalNote(db, approval, (summary) => `The owner approved #${id} (${summary}). ${what} Result:\n${output.content}`);
        note({ text: approvedNote.text, taint: [...approvedNote.taint, ...taint] });
        const head = !started ? 'The tool did not run' : output.isError ? 'The tool failed' : 'Result';
        const reply = `Approved #${id}. ${head}: ${headOf(output.content, SUMMARY_LIMIT)}`;
        return again ? `${reply}\nApproval #${id} waits again, so you can approve it again when it can run.` : reply;
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
  if (!taint.length) return lines.join('\n');
  const more = taint.length > SOURCE_LIMIT ? `; and ${taint.length - SOURCE_LIMIT} more` : '';
  lines.push(`Untrusted content in this session: ${taint.slice(0, SOURCE_LIMIT).map((each) => taintText(each, timeZone)).join('; ')}${more}.`);
  const card = lines.join('\n');
  const safe = withoutLiveLinks(card);
  return safe === card ? card : `${safe}\n${BROKEN_LINKS}`;
}

// in a tainted session the model can put data in a link in a field, and the reason repeats the link. a chat app
// fetches a link preview of the card before the owner decides, so the data leaves the pc also when the owner denies
// the call. so the card shows each link with data with "[.]" and "[:]", and no chat app makes a link of it.
export const BROKEN_LINKS = 'Links that can carry data show with [.] and [:], so that the chat app does not open them. The dashboard shows them as they are.';
const LINK_MARKS = /[.:．。｡：]/g;
const broken = (text: string) => text.replace(LINK_MARKS, (mark) => `[${mark}]`);

export function withoutLiveLinks(text: string): string {
  return text
    .split('\n')
    .map((line) => {
      const links = [...new Set(dataUrls(line).map((each) => each.url.split(/[\s"'<>]/)[0]!))].sort((a, b) => b.length - a.length);
      // the finder reads the nfkc form. a link that the line does not hold verbatim makes the marks break in all of it.
      if (links.some((link) => !line.includes(link))) return broken(line);
      return links.reduce((out, link) => out.split(link).join(broken(link)), line);
    })
    .join('\n');
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
  return `${headOf(taint.source, SOURCE_NAME_LIMIT)} (read by ${taint.toolName} on ${localDay(at, timeZone)} at ${localTime(at, timeZone)}${run})`;
}
