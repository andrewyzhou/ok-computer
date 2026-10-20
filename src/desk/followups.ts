import type { gmail_v1 } from '@googleapis/gmail';
import type { Delegation, DelegationEventKind } from '../dashboard/desk-types.js';
import { appendEvent } from '../events/log.js';
import { GoogleError, toGoogleError } from '../google/errors.js';
import { bodyText, fromAddress, header } from '../google/mime.js';
import { requestContext } from '../google/trace.js';
import { mailSource } from '../inbox/run.js';
import { redact } from '../observability/redact.js';
import type { TaintSource } from '../policy/policy.js';
import type { JobResult } from '../scheduler/scheduler.js';
import { cleanLine } from '../signals/store.js';
import { headOf } from '../text.js';
import { errorText } from '../tools/registry.js';
import type { DeskContext } from './context.js';
import { NUDGE_TOOL } from './names.js';
import { addressesOf, NO_REPLY, writeNudge } from './nudge.js';
import { DESK_PREFIX, MAX_NUDGES, NUDGE_EVERY_MS } from './shared.js';
import { appendDelegationEvent, listFollowUpsDue, markChecked, updateDelegation } from './store.js';

// the follow-up job of the desk. the system automation "desk: follow-ups" (installDeskJobs in desk.ts) runs it every
// 15 minutes in code.
// - it reads listFollowUpsDue(db, now). with none due it returns { status: 'skipped' } and writes no run.
// - otherwise it writes a runs row in the session desk:followups:<runId> with a task event first, as the inbox jobs do
//   (src/inbox/run.ts), and keeps the run in activeRuns while it works.
// - for each due delegation with a thread link in a google account that works, it reads the thread (read only), marks
//   the session with the taint of that mail, and looks for a message after waitingSince that the owner did not send.
//   a reply: reply_seen in the history, status open, the next step "Read the reply from <who>", no follow-up time.
//   no reply: a nudge draft through the desk_draft_nudge tool (nudge.ts) and the caller, nudge_drafted in the history,
//   and the next follow-up NUDGE_EVERY_MS later. after MAX_NUDGES nudges the delegation becomes blocked instead.
// - a delegation without a thread, or without google, gets follow_up_due and no follow-up time, and the owner is told.
// - at the end the owner gets one short message with the changes and their desk links, and none when nothing changed.
// nothing here sends mail.

export const FOLLOW_UP_TASK =
  'The desk follow-ups of the owner. It reads the mail threads of the delegations that wait on someone, records a reply when one came, and saves a nudge to Gmail Drafts when none came. Drafts are never sent.';

const DAY_MS = 24 * 60 * 60_000;
// the owner wrote in the thread less than this long ago, so a nudge would come too soon.
const OWNER_WROTE_MS = DAY_MS;
// the thread text that the model reads for a nudge. a nudge needs only the gist of the thread.
const THREAD_LIMIT = 8000;
const SUBJECT_LIMIT = 500;
// a line of the owner message repeats the text of a tool output, which can be long.
const LINE_LIMIT = 300;

// what the job did with one delegation. a dry run gives the same list without writing anything.
export type FollowUpAction =
  | 'no_thread'
  | 'no_google'
  | 'unavailable'
  | 'thread_gone'
  | 'read_failed'
  | 'reply_seen'
  | 'owner_wrote'
  | 'blocked'
  | 'no_address'
  | 'nudged'
  | 'would_nudge'
  | 'nudge_failed'
  | 'nudge_pending'
  | 'error';

export interface FollowUpDecision {
  delegationId: number;
  action: FollowUpAction;
  // the account and the recipient of a nudge, without any text of the mail.
  account?: string;
  to?: string;
}

export interface FollowUpOptions {
  // a dry run reads the threads and reports the decisions, but it writes no row, asks no model, saves no draft and
  // sends no owner message. the check on a copy of the owner's database uses it.
  dryRun?: boolean;
}

export interface FollowUpResult extends JobResult {
  decisions: FollowUpDecision[];
}

interface Run {
  runId: string;
  sessionKey: string;
  dryRun: boolean;
}

function startRun(ctx: DeskContext): Run {
  const runId = ctx.newId();
  const sessionKey = `${DESK_PREFIX}followups:${runId}`;
  ctx.activeRuns?.add(runId);
  ctx.db
    .prepare("INSERT INTO runs (id, sessionKey, trigger, slot, status, startedAt) VALUES (?, ?, 'automation', 'utility', 'running', ?)")
    .run(runId, sessionKey, ctx.clock().toISOString());
  appendEvent(ctx.db, { sessionKey, runId, type: 'system_event', payload: { text: FOLLOW_UP_TASK } }, ctx.clock());
  return { runId, sessionKey, dryRun: false };
}

function endRun(ctx: DeskContext, run: Run, status: 'completed' | 'failed', note?: string): void {
  ctx.db.prepare('UPDATE runs SET status = ?, endedAt = ?, error = ? WHERE id = ?').run(status, ctx.clock().toISOString(), note ? redact(note) : null, run.runId);
  ctx.activeRuns?.delete(run.runId);
}

// the messages of a thread, the oldest first.
const byTime = (messages: readonly gmail_v1.Schema$Message[]) => [...messages].sort((a, b) => Number(a.internalDate ?? 0) - Number(b.internalDate ?? 0));
const labelsOf = (message: gmail_v1.Schema$Message) => message.labelIds ?? [];
const fromOwner = (message: gmail_v1.Schema$Message) => labelsOf(message).includes('SENT');
const isDraft = (message: gmail_v1.Schema$Message) => labelsOf(message).includes('DRAFT');

function threadText(messages: readonly gmail_v1.Schema$Message[]): string {
  const text = messages
    .map((message) => [...['From', 'Date', 'Subject'].map((key) => `${key}: ${cleanLine(header(message, key), 500)}`), '', bodyText(message.payload)].join('\n'))
    .join('\n\n---\n\n');
  return headOf(text, THREAD_LIMIT);
}

// the subject of the nudge: "Re: " and the subject of the thread, without a second "Re:".
function replySubject(subject: string, title: string): string {
  const line = cleanLine(subject, SUBJECT_LIMIT) || cleanLine(title, SUBJECT_LIMIT);
  return headOf(/^re:/i.test(line) ? line : `Re: ${line}`, SUBJECT_LIMIT);
}

// the recipient of a nudge: the email that the delegation waits on, else the sender of the newest mail that the owner
// did not send, else the first To address of the owner's newest mail. an address that takes no replies, or the
// address of the account itself, is skipped.
function recipientOf(delegation: Delegation, messages: readonly gmail_v1.Schema$Message[], self: string | undefined): string | undefined {
  const theirs = [...messages].reverse().find((message) => !fromOwner(message) && !isDraft(message));
  const mine = [...messages].reverse().find(fromOwner);
  const candidates = [delegation.waitingOn?.email ?? undefined, theirs ? fromAddress(header(theirs, 'From')) : undefined, mine ? addressesOf(header(mine, 'To'))[0] : undefined];
  return candidates.find((each): each is string => Boolean(each) && !NO_REPLY.test(each!) && each!.toLowerCase() !== self);
}

const whoOf = (delegation: Delegation) => delegation.waitingOn?.name || delegation.waitingOn?.email || 'them';

// runFollowUps checks each due delegation once. an error on one delegation is logged and recorded, and the others
// go on. the job fails only when every delegation that it read failed with a google error, so the scheduler backs off.
export async function runFollowUps(ctx: DeskContext, options: FollowUpOptions = {}): Promise<FollowUpResult> {
  const now = ctx.clock();
  const due = listFollowUpsDue(ctx.db, now);
  if (!due.length) return { status: 'skipped', error: 'no follow-up is due', decisions: [] };
  const dryRun = options.dryRun === true;
  const run: Run = dryRun ? { runId: `dry-${ctx.newId()}`, sessionKey: '', dryRun } : startRun(ctx);
  const decisions: FollowUpDecision[] = [];
  const lines: string[] = [];
  const tainted = new Set<string>();
  let read = 0;
  let googleFailures = 0;
  const at = (ms: number) => new Date(now.getTime() + ms).toISOString();

  // the writes of one delegation. a dry run skips each of them.
  const record = (delegation: Delegation, kind: DelegationEventKind, text: string, data: Record<string, unknown> = {}) => {
    if (!dryRun) appendDelegationEvent(ctx.db, { delegationId: delegation.id, kind, actor: 'system', runId: run.runId, text, data }, now);
  };
  const check = (delegation: Delegation, nextFollowUpAt: string | null, nudged = false) => {
    if (!dryRun) markChecked(ctx.db, delegation.id, { nextFollowUpAt, nudged }, now);
  };
  const tell = (delegation: Delegation, what: string) => {
    lines.push(`#${delegation.id} "${cleanLine(delegation.title, 200)}": ${headOf(cleanLine(what, LINE_LIMIT), LINE_LIMIT)} ${ctx.deskLink(delegation.id)}`);
  };
  const decide = (decision: FollowUpDecision) => decisions.push(decision);

  // the taint of the mail that the run read, once for each account, before any later tool call of the run.
  const markRead = (account: string) => {
    const source = mailSource(account);
    if (dryRun || tainted.has(source)) return;
    tainted.add(source);
    const stamp = ctx.clock().toISOString();
    const taint: TaintSource[] = [{ source, toolName: 'desk_followups', runId: run.runId, toolCallId: `followups-${run.runId}`, at: stamp }];
    appendEvent(ctx.db, { sessionKey: run.sessionKey, runId: run.runId, type: 'system_event', payload: { text: `The desk follow-ups read ${source}.`, taint } }, ctx.clock());
  };

  const savedNudge = (delegationId: number, followUpAt: string) =>
    Boolean(ctx.db.prepare("SELECT id FROM delegation_nudges WHERE delegationId = ? AND followUpAt = ? AND gmailDraftId != ''").get(delegationId, followUpAt));
  // the newest approval of a nudge for this follow-up time, when a call asked the owner.
  const nudgeApproval = (delegationId: number, followUpAt: string) => {
    const row = ctx.db
      .prepare(
        `SELECT id, status FROM approvals WHERE toolName = ? AND json_extract(input, '$.delegationId') = ? AND json_extract(input, '$.followUpAt') = ?
         ORDER BY id DESC LIMIT 1`,
      )
      .get(NUDGE_TOOL, delegationId, followUpAt);
    return row ? { id: Number(row.id), status: String(row.status) } : undefined;
  };
  const approvalOf = (callId: string): number | null => {
    const row = ctx.db.prepare('SELECT approvalId FROM policy_decisions WHERE runId = ? AND toolCallId = ? ORDER BY id DESC LIMIT 1').get(run.runId, callId);
    return row?.approvalId === null || row?.approvalId === undefined ? null : Number(row.approvalId);
  };

  async function followUp(delegation: Delegation): Promise<void> {
    // the newest thread link. the links come in the order that they were added.
    const link = [...delegation.links].reverse().find((each) => each.kind === 'thread' && each.account);
    const google = ctx.google;
    if (!link || !google) {
      const text = !link ? 'The follow-up came, and there is no mail thread to check.' : 'The follow-up came, and google is not set up, so no thread was checked.';
      decide({ delegationId: delegation.id, action: link ? 'no_google' : 'no_thread' });
      record(delegation, 'follow_up_due', text);
      check(delegation, null);
      tell(delegation, !link ? 'the follow-up is due, and there is no mail thread to check.' : 'the follow-up is due, and google is not set up to check the thread.');
      return;
    }
    const account = link.account!;
    const threadId = link.ref;
    const why = google.accounts.unavailable(account);
    if (why) {
      decide({ delegationId: delegation.id, action: 'unavailable', account });
      record(delegation, 'follow_up_failed', why, { threadId, account });
      // a day later, so a signed-out account does not give a row every 15 minutes.
      check(delegation, at(DAY_MS));
      tell(delegation, `the thread could not be checked: ${why}`);
      return;
    }

    read++;
    let messages: gmail_v1.Schema$Message[];
    try {
      const { data } = await google.accounts.run(account, (apis) => apis.gmail.users.threads.get({ userId: 'me', id: threadId, format: 'full' }));
      messages = byTime(data.messages ?? []);
    } catch (err) {
      const error = toGoogleError(err);
      if (error.kind === 'not_found' || error.kind === 'gone') {
        decide({ delegationId: delegation.id, action: 'thread_gone', account });
        record(delegation, 'follow_up_failed', 'the thread is gone', { threadId, account });
        check(delegation, null);
        tell(delegation, 'the mail thread is gone, so the follow-up stopped.');
        return;
      }
      googleFailures++;
      decide({ delegationId: delegation.id, action: 'read_failed', account });
      ctx.logger.warn('the desk follow-up could not read the thread', { delegationId: delegation.id, account, err: error.message });
      record(delegation, 'follow_up_failed', `the thread could not be read: ${error.message}`, { threadId, account });
      check(delegation, at(DAY_MS));
      return;
    }
    markRead(account);

    // a reply is a mail after the wait started that the owner did not send and that is not a draft.
    const since = Date.parse(delegation.waitingSince ?? delegation.createdAt);
    const reply = [...messages].reverse().find((message) => Number(message.internalDate) > since && !fromOwner(message) && !isDraft(message));
    if (reply) {
      const from = cleanLine(header(reply, 'From'), 200) || 'the thread';
      decide({ delegationId: delegation.id, action: 'reply_seen', account });
      if (!dryRun) {
        const updated = updateDelegation(
          ctx.db,
          delegation.id,
          { status: 'open', nextStep: `Read the reply from ${from}`, nextFollowUpAt: null },
          { actor: 'system', runId: run.runId },
          now,
        );
        if (!updated.ok) throw new Error(updated.error);
      }
      record(delegation, 'reply_seen', `${from} replied in the thread.`, { threadId, account, messageId: reply.id ?? null, from });
      check(delegation, null);
      tell(delegation, `${from} replied. Read the reply.`);
      return;
    }

    const mine = [...messages].reverse().find(fromOwner);
    if (mine && Number(mine.internalDate) > now.getTime() - OWNER_WROTE_MS) {
      // the owner just wrote, so a nudge waits a day.
      decide({ delegationId: delegation.id, action: 'owner_wrote', account });
      record(delegation, 'follow_up_checked', 'No reply yet, and the owner wrote in the thread less than a day ago.', { threadId, account });
      check(delegation, at(DAY_MS));
      return;
    }

    if (delegation.nudgeCount >= MAX_NUDGES) {
      const who = whoOf(delegation);
      decide({ delegationId: delegation.id, action: 'blocked', account });
      if (!dryRun) {
        const updated = updateDelegation(
          ctx.db,
          delegation.id,
          { status: 'blocked', nextStep: `No reply from ${who} after ${delegation.nudgeCount} nudges. Decide what to do next.`, nextFollowUpAt: null },
          { actor: 'system', runId: run.runId },
          now,
        );
        if (!updated.ok) throw new Error(updated.error);
      }
      check(delegation, null);
      tell(delegation, `no reply from ${who} after ${delegation.nudgeCount} nudges, so it is blocked until you decide what to do next.`);
      return;
    }

    const self = ctx.googleConfig?.accounts.find((each) => each.alias === account)?.email?.toLowerCase();
    const to = recipientOf(delegation, messages, self);
    if (!to) {
      decide({ delegationId: delegation.id, action: 'no_address', account });
      record(delegation, 'follow_up_failed', 'there is no address to nudge', { threadId, account });
      check(delegation, null);
      tell(delegation, 'no reply yet, and there is no address to nudge, so the follow-up stopped.');
      return;
    }
    const followUpAt = delegation.nextFollowUpAt!;
    // a nudge for this follow-up time can exist already: the owner approved a held call later, or a run stopped
    // between the draft and its check. the job counts it and makes no second one.
    if (savedNudge(delegation.id, followUpAt)) {
      decide({ delegationId: delegation.id, action: 'nudged', account, to });
      check(delegation, at(NUDGE_EVERY_MS), true);
      tell(delegation, `no reply from ${whoOf(delegation)} yet, so a nudge is in Gmail Drafts. It is not sent.`);
      return;
    }
    const asked = nudgeApproval(delegation.id, followUpAt);
    if (asked?.status === 'pending') {
      // the owner has the card already, so the job asks nothing again and waits.
      decide({ delegationId: delegation.id, action: 'nudge_pending', account, to });
      return;
    }
    if (asked) {
      // the owner denied the nudge, it expired, or it ran and saved nothing. the job tries again in a day.
      decide({ delegationId: delegation.id, action: 'nudge_failed', account, to });
      record(delegation, 'follow_up_failed', `the nudge of approval #${asked.id} was ${asked.status} and saved no draft`, { threadId, account });
      check(delegation, at(DAY_MS));
      return;
    }
    if (dryRun) {
      decide({ delegationId: delegation.id, action: 'would_nudge', account, to });
      return;
    }

    const newest = messages[messages.length - 1];
    const inReplyTo = newest ? cleanLine(header(newest, 'Message-ID'), SUBJECT_LIMIT) : '';
    const subject = replySubject(messages[0] ? header(messages[0], 'Subject') : '', delegation.title);
    const body = await writeNudge(ctx, run, { delegation, account, threadText: threadText(messages) });
    const input = {
      account,
      delegationId: delegation.id,
      threadId,
      followUpAt,
      to: [to],
      subject,
      ...(inReplyTo ? { inReplyTo } : {}),
      ...(newest?.id ? { sourceMessageId: newest.id } : {}),
      body,
    };
    const callId = `followups-${ctx.newId()}`;
    const output = await ctx
      .caller()
      .call({ id: callId, name: NUDGE_TOOL, input }, { runId: run.runId, sessionKey: run.sessionKey, allowed: [NUDGE_TOOL], signal: ctx.signal });
    // the row of the draft is the proof that the tool saved it. an output without an error can also be the text of an
    // approval that waits, because the reviewer failed and the owner decides.
    if (!output.isError && savedNudge(delegation.id, followUpAt)) {
      // the tool wrote the nudge_drafted row itself.
      decide({ delegationId: delegation.id, action: 'nudged', account, to });
      check(delegation, at(NUDGE_EVERY_MS), true);
      tell(delegation, `no reply from ${whoOf(delegation)} yet, so a nudge to ${to} is in Gmail Drafts. It is not sent.`);
      return;
    }
    const approvalId = approvalOf(callId);
    if (approvalId !== null && !output.isError) {
      // the follow-up time stays, so the approved call still matches it. the next runs wait for the owner.
      decide({ delegationId: delegation.id, action: 'nudge_pending', account, to });
      record(delegation, 'follow_up_checked', `No reply yet. The nudge to ${to} waits for the owner's approval #${approvalId}.`, { threadId, account });
      check(delegation, followUpAt);
      tell(delegation, `no reply yet, and the nudge to ${to} waits for your approval #${approvalId}.`);
      return;
    }
    // the reviewer held the call, or the tool refused it. the tool wrote no row, so the job tries again in a day.
    decide({ delegationId: delegation.id, action: 'nudge_failed', account, to });
    record(delegation, 'follow_up_failed', headOf(output.content, 2000), { threadId, account });
    check(delegation, at(DAY_MS));
    tell(delegation, `no reply yet, and the nudge was not saved: ${output.content}`);
  }

  try {
    await requestContext.run(dryRun ? {} : { runId: run.runId }, async () => {
      for (const delegation of due) {
        if (ctx.signal.aborted) break;
        try {
          await followUp(delegation);
        } catch (err) {
          if (err instanceof GoogleError) googleFailures++;
          ctx.logger.error('the desk follow-up of a delegation failed', { delegationId: delegation.id, runId: run.runId, err });
          decide({ delegationId: delegation.id, action: 'error' });
          if (!dryRun) {
            try {
              record(delegation, 'follow_up_failed', `the follow-up stopped: ${redact(errorText(err))}`);
              check(delegation, at(DAY_MS));
            } catch (inner) {
              ctx.logger.error('the desk follow-up could not record its failure', { delegationId: delegation.id, err: inner });
            }
          }
        }
      }
    });
    if (lines.length && !dryRun) await ctx.owner.send(['Desk follow-ups:', ...lines].join('\n'));
  } catch (err) {
    ctx.logger.error('the desk follow-ups failed', { runId: run.runId, err });
    const text = `the follow-ups job stopped: ${redact(errorText(err))}`;
    if (!dryRun) endRun(ctx, run, 'failed', text);
    return { status: 'failed', ...(dryRun ? {} : { runId: run.runId }), error: text, decisions };
  }

  const counts = new Map<FollowUpAction, number>();
  for (const each of decisions) counts.set(each.action, (counts.get(each.action) ?? 0) + 1);
  const note = `checked ${decisions.length} follow-ups: ${[...counts].map(([action, count]) => `${count} ${action}`).join(', ')}`;
  const failed = read > 0 && googleFailures >= read;
  if (dryRun) return { status: failed ? 'failed' : 'completed', error: note, decisions };
  endRun(ctx, run, failed ? 'failed' : 'completed', note);
  return { status: failed ? 'failed' : 'completed', runId: run.runId, ...(failed ? { error: `every thread read failed. ${note}` } : {}), decisions };
}
