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
import { cleanLine, inTransaction } from '../signals/store.js';
import { headOf } from '../text.js';
import { errorText } from '../tools/registry.js';
import type { DeskContext } from './context.js';
import { NUDGE_TOOL } from './names.js';
import { addressesOf, NO_REPLY, writeNudge } from './nudge.js';
import { DESK_PREFIX, isActive, MAX_NUDGES, NUDGE_EVERY_MS } from './shared.js';
import { appendDelegationEvent, getDelegation, listFollowUpsDue, markChecked, updateDelegation } from './store.js';

// the follow-up job of the desk. the system automation "desk: follow-ups" (installDeskJobs in desk.ts) runs it every
// 15 minutes in code.
// - it reads listFollowUpsDue(db, now). with none due it returns { status: 'skipped' } and writes no run.
// - otherwise it writes a runs row in the session desk:followups:<runId> with a task event first, as the inbox jobs do
//   (src/inbox/run.ts), and keeps the run in activeRuns while it works.
// - for each due waiting delegation with a thread link in a google account that works, it reads the thread (read
//   only), marks the session with the taint of that mail, and looks for a message after waitingSince that the owner
//   did not send and that no machine sent.
//   a reply: reply_seen in the history, status open, the next step "Read the reply from <who>", no follow-up time.
//   no reply: a nudge draft through the desk_draft_nudge tool (nudge.ts) and the caller, nudge_drafted in the history,
//   and the next follow-up NUDGE_EVERY_MS later. after MAX_NUDGES nudges the delegation becomes blocked instead, and
//   a nudge that the owner denied makes it blocked too.
// - an open or blocked delegation, one without a thread, or one without google, gets follow_up_due and no follow-up
//   time, and the owner is told.
// - the owner can change a delegation while the job waits on google or a model. the job reads the row again after
//   each wait, and each write expects the follow-up time that it read, so a changed row is left alone.
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
  | 'nudge_denied'
  | 'not_waiting'
  | 'changed'
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

// the addresses in the From, To and Cc of a thread, in lower case.
export function threadAddresses(messages: readonly gmail_v1.Schema$Message[]): Set<string> {
  const known = new Set<string>();
  for (const message of messages) for (const key of ['From', 'To', 'Cc']) for (const address of addressesOf(header(message, key))) known.add(address.toLowerCase());
  return known;
}

// the recipient of a nudge: the email that the delegation waits on when it is in the thread, else the sender of the
// newest mail that the owner did not send, else the first To address of the owner's newest mail. an address that
// takes no replies, or the address of the account itself, is skipped. a waiting-on email that is not in the thread
// could come from a mail, so it is never used.
function recipientOf(delegation: Delegation, messages: readonly gmail_v1.Schema$Message[], self: string | undefined): string | undefined {
  const theirs = [...messages].reverse().find((message) => !fromOwner(message) && !isDraft(message));
  const mine = [...messages].reverse().find(fromOwner);
  const waiting = delegation.waitingOn?.email?.toLowerCase();
  const candidates = [
    waiting && threadAddresses(messages).has(waiting) ? waiting : undefined,
    theirs ? fromAddress(header(theirs, 'From')) : undefined,
    mine ? addressesOf(header(mine, 'To'))[0] : undefined,
  ];
  return candidates.find((each): each is string => Boolean(each) && !NO_REPLY.test(each!) && each!.toLowerCase() !== self);
}

const whoOf = (delegation: Delegation) => delegation.waitingOn?.name || delegation.waitingOn?.email || 'them';

// a bounce, a delivery report or an automatic answer is no reply: the person may never have read the mail.
const AUTOMATED_SENDER = /^(mailer-daemon|postmaster|no-?reply|do-?not-?reply)@/i;
function automated(message: gmail_v1.Schema$Message): boolean {
  if (AUTOMATED_SENDER.test(fromAddress(header(message, 'From')) ?? '')) return true;
  const auto = header(message, 'Auto-Submitted').trim().toLowerCase();
  return auto !== '' && auto !== 'no';
}

// the headers that the job reads when it only looks for a reply. a nudge needs the bodies, so it reads the thread
// again in full.
const REPLY_HEADERS = ['From', 'To', 'Cc', 'Date', 'Subject', 'Message-ID', 'Auto-Submitted'];

type HistoryRow = { kind: DelegationEventKind; text: string; data?: Record<string, unknown> };

// the newest approval of a nudge for this follow-up time, when a call asked the owner.
function nudgeApproval(ctx: DeskContext, delegationId: number, followUpAt: string): { id: number; status: string } | undefined {
  const row = ctx.db
    .prepare(
      `SELECT id, status FROM approvals WHERE toolName = ? AND json_extract(input, '$.delegationId') = ? AND json_extract(input, '$.followUpAt') = ?
       ORDER BY id DESC LIMIT 1`,
    )
    .get(NUDGE_TOOL, delegationId, followUpAt);
  return row ? { id: Number(row.id), status: String(row.status) } : undefined;
}

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

  // a line of the owner message. a reason can hold the text of an error, so it is redacted.
  const tell = (delegation: Delegation, what: string) => {
    lines.push(`#${delegation.id} "${cleanLine(delegation.title, 200)}": ${headOf(cleanLine(redact(what), LINE_LIMIT), LINE_LIMIT)} ${ctx.deskLink(delegation.id)}`);
  };
  const decide = (decision: FollowUpDecision) => decisions.push(decision);

  // settle records a check: the next follow-up time, the nudge count and the history row, in one transaction. it
  // changes nothing when the owner closed the delegation or changed its follow-up time since the job read it, and the
  // decision is then changed. a dry run only records the decision.
  const settle = (delegation: Delegation, decision: FollowUpDecision, change: { next: string | null; nudged?: boolean; event?: HistoryRow; told?: string }): void => {
    if (!dryRun) {
      const written = inTransaction(ctx.db, () => {
        const checked = markChecked(ctx.db, delegation.id, { expected: delegation.nextFollowUpAt, nextFollowUpAt: change.next, nudged: change.nudged === true }, now);
        if (!checked) return false;
        if (change.event) {
          const { kind, text, data } = change.event;
          appendDelegationEvent(ctx.db, { delegationId: delegation.id, kind, actor: 'system', runId: run.runId, text: redact(text), data: data ?? {} }, now);
        }
        return true;
      });
      if (!written) {
        decide({ delegationId: delegation.id, action: 'changed' });
        return;
      }
    }
    decide(decision);
    if (change.told) tell(delegation, change.told);
  };

  // move changes the status and the next step of a delegation, only while its follow-up time is still the one that
  // the job read, and then writes the history row of the job and the time of the check.
  const move = (delegation: Delegation, decision: FollowUpDecision, patch: { status: 'open' | 'blocked'; nextStep: string }, change: { event?: HistoryRow; told: string }): void => {
    if (dryRun) {
      decide(decision);
      return;
    }
    const updated = updateDelegation(ctx.db, delegation.id, { ...patch, nextFollowUpAt: null, ifFollowUpAt: delegation.nextFollowUpAt }, { actor: 'system', runId: run.runId }, now);
    if (!updated.ok) {
      if (updated.status !== 409) throw new Error(updated.error);
      decide({ delegationId: delegation.id, action: 'changed' });
      return;
    }
    settle(updated.value, decision, { next: null, ...(change.event ? { event: change.event } : {}), told: change.told });
  };

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
  // a claim without a draft yet: another call saves the nudge of this follow-up time now.
  const claimedNudge = (delegationId: number, followUpAt: string) =>
    Boolean(ctx.db.prepare('SELECT id FROM delegation_nudges WHERE delegationId = ? AND followUpAt = ?').get(delegationId, followUpAt));
  const decisionOf = (callId: string): { id: number; approvalId: number | null } | undefined => {
    const row = ctx.db.prepare('SELECT id, approvalId FROM policy_decisions WHERE runId = ? AND toolCallId = ? ORDER BY id DESC LIMIT 1').get(run.runId, callId);
    if (!row) return undefined;
    return { id: Number(row.id), approvalId: row.approvalId === null || row.approvalId === undefined ? null : Number(row.approvalId) };
  };

  async function followUp(snapshot: Delegation): Promise<void> {
    // the owner can close or change a delegation on the dashboard while the job waits on google or a model. so the
    // job reads the row again before each step, and stops when it is closed or its follow-up time moved.
    const expected = snapshot.nextFollowUpAt;
    const fresh = (): Delegation | undefined => {
      const row = getDelegation(ctx.db, snapshot.id);
      return row && isActive(row.status) && row.nextFollowUpAt === expected ? row : undefined;
    };
    const changed = () => {
      decide({ delegationId: snapshot.id, action: 'changed' });
    };
    let delegation = fresh();
    if (!delegation) return changed();

    // the newest thread link. the links come in the order that they were added.
    const link = [...delegation.links].reverse().find((each) => each.kind === 'thread' && each.account);
    if (!link) {
      settle(
        delegation,
        { delegationId: delegation.id, action: 'no_thread' },
        { next: null, event: { kind: 'follow_up_due', text: 'The follow-up came, and there is no mail thread to check.' }, told: 'the follow-up is due, and there is no mail thread to check.' },
      );
      return;
    }
    // only a delegation that waits on someone gets nudges. an open or a blocked one waits on the agent or the owner,
    // so its follow-up time is a reminder for the owner.
    if (delegation.status !== 'waiting') {
      settle(
        delegation,
        { delegationId: delegation.id, action: 'not_waiting' },
        {
          next: null,
          event: { kind: 'follow_up_due', text: `The follow-up came. The delegation is ${delegation.status} and waits on nobody, so no nudge was drafted.` },
          told: `the follow-up is due. It is ${delegation.status === 'blocked' ? 'blocked and needs you' : 'open'}, so no nudge was drafted.`,
        },
      );
      return;
    }
    const google = ctx.google;
    if (!google) {
      settle(
        delegation,
        { delegationId: delegation.id, action: 'no_google' },
        {
          next: null,
          event: { kind: 'follow_up_due', text: 'The follow-up came, and google is not set up, so no thread was checked.' },
          told: 'the follow-up is due, and google is not set up to check the thread.',
        },
      );
      return;
    }
    const account = link.account!;
    const threadId = link.ref;
    const why = google.accounts.unavailable(account);
    if (why) {
      // a day later, so a signed-out account does not give a row every 15 minutes.
      settle(
        delegation,
        { delegationId: delegation.id, action: 'unavailable', account },
        { next: at(DAY_MS), event: { kind: 'follow_up_failed', text: why, data: { threadId, account } }, told: `the thread could not be checked: ${why}` },
      );
      return;
    }

    const followUpAt = delegation.nextFollowUpAt!;
    // while the owner has the card of a nudge, each run only looks for a reply, so it reads the headers and no body.
    const pending = !dryRun && nudgeApproval(ctx, delegation.id, followUpAt)?.status === 'pending';
    const readThread = async (format: 'full' | 'metadata') => {
      const { data } = await google.accounts.run(account, (apis) =>
        apis.gmail.users.threads.get({ userId: 'me', id: threadId, format, ...(format === 'metadata' ? { metadataHeaders: REPLY_HEADERS } : {}) }),
      );
      return byTime(data.messages ?? []);
    };

    read++;
    let messages: gmail_v1.Schema$Message[];
    try {
      messages = await readThread(pending ? 'metadata' : 'full');
    } catch (err) {
      const error = toGoogleError(err);
      delegation = fresh();
      if (!delegation) return changed();
      if (error.kind === 'not_found' || error.kind === 'gone') {
        settle(
          delegation,
          { delegationId: delegation.id, action: 'thread_gone', account },
          { next: null, event: { kind: 'follow_up_failed', text: 'the thread is gone', data: { threadId, account } }, told: 'the mail thread is gone, so the follow-up stopped.' },
        );
        return;
      }
      googleFailures++;
      ctx.logger.warn('the desk follow-up could not read the thread', { delegationId: delegation.id, account, err: error.message });
      settle(
        delegation,
        { delegationId: delegation.id, action: 'read_failed', account },
        { next: at(DAY_MS), event: { kind: 'follow_up_failed', text: `the thread could not be read: ${error.message}`, data: { threadId, account } } },
      );
      return;
    }
    markRead(account);
    delegation = fresh();
    if (!delegation) return changed();

    // a reply is a mail after the wait started that the owner did not send, that is not a draft and that no machine
    // sent.
    const since = Date.parse(delegation.waitingSince ?? delegation.createdAt);
    const reply = [...messages].reverse().find((message) => Number(message.internalDate) > since && !fromOwner(message) && !isDraft(message) && !automated(message));
    if (reply) {
      const from = cleanLine(header(reply, 'From'), 200) || 'the thread';
      move(
        delegation,
        { delegationId: delegation.id, action: 'reply_seen', account },
        { status: 'open', nextStep: `Read the reply from ${from}` },
        { event: { kind: 'reply_seen', text: `${from} replied in the thread.`, data: { threadId, account, messageId: reply.id ?? null, from } }, told: `${from} replied. Read the reply.` },
      );
      return;
    }
    if (pending) {
      // the owner has the card already, so the job asks nothing again and waits.
      const to = recipientOf(delegation, messages, undefined);
      decide({ delegationId: delegation.id, action: 'nudge_pending', account, ...(to ? { to } : {}) });
      return;
    }

    const mine = [...messages].reverse().find(fromOwner);
    if (mine && Number(mine.internalDate) > now.getTime() - OWNER_WROTE_MS) {
      // the owner just wrote, so a nudge waits a day.
      settle(
        delegation,
        { delegationId: delegation.id, action: 'owner_wrote', account },
        { next: at(DAY_MS), event: { kind: 'follow_up_checked', text: 'No reply yet, and the owner wrote in the thread less than a day ago.', data: { threadId, account } } },
      );
      return;
    }

    const who = whoOf(delegation);
    if (delegation.nudgeCount >= MAX_NUDGES) {
      move(
        delegation,
        { delegationId: delegation.id, action: 'blocked', account },
        { status: 'blocked', nextStep: `No reply from ${who} after ${delegation.nudgeCount} nudges. Decide what to do next.` },
        { told: `no reply from ${who} after ${delegation.nudgeCount} nudges, so it is blocked until you decide what to do next.` },
      );
      return;
    }

    const self = ctx.googleConfig?.accounts.find((each) => each.alias === account)?.email?.toLowerCase();
    const to = recipientOf(delegation, messages, self);
    if (!to) {
      settle(
        delegation,
        { delegationId: delegation.id, action: 'no_address', account },
        {
          next: null,
          event: { kind: 'follow_up_failed', text: 'there is no address to nudge', data: { threadId, account } },
          told: 'no reply yet, and there is no address to nudge, so the follow-up stopped.',
        },
      );
      return;
    }
    // a nudge for this follow-up time can exist already: the owner approved a held call later, or a run stopped
    // between the draft and its check. the job counts it and makes no second one.
    if (savedNudge(delegation.id, followUpAt)) {
      settle(
        delegation,
        { delegationId: delegation.id, action: 'nudged', account, to },
        { next: at(NUDGE_EVERY_MS), nudged: true, told: `no reply from ${who} yet, so a nudge is in Gmail Drafts. It is not sent.` },
      );
      return;
    }
    const asked = nudgeApproval(ctx, delegation.id, followUpAt);
    if (asked?.status === 'denied') {
      // the owner said no to the nudge. that is the owner's decision, so the job does not ask again, and the
      // delegation waits for the owner.
      move(
        delegation,
        { delegationId: delegation.id, action: 'nudge_denied', account, to },
        { status: 'blocked', nextStep: `You declined the nudge to ${who}. Decide what to do next.` },
        {
          event: { kind: 'follow_up_failed', text: `The owner declined the nudge of approval #${asked.id}.`, data: { threadId, account, approvalId: asked.id } },
          told: `you declined the nudge to ${who}, so it is blocked until you decide what to do next.`,
        },
      );
      return;
    }
    if (asked) {
      // the approval expired, or it ran and saved nothing. the job tries again in a day, and the try counts as a
      // nudge, so a card that nobody answers ends in blocked after MAX_NUDGES tries.
      settle(
        delegation,
        { delegationId: delegation.id, action: 'nudge_failed', account, to },
        {
          next: at(DAY_MS),
          nudged: true,
          event: { kind: 'follow_up_failed', text: `the nudge of approval #${asked.id} was ${asked.status} and saved no draft`, data: { threadId, account, approvalId: asked.id } },
        },
      );
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
    delegation = fresh();
    if (!delegation) return changed();
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
      settle(
        delegation,
        { delegationId: delegation.id, action: 'nudged', account, to },
        { next: at(NUDGE_EVERY_MS), nudged: true, told: `no reply from ${who} yet, so a nudge to ${to} is in Gmail Drafts. It is not sent.` },
      );
      return;
    }
    delegation = fresh();
    if (!delegation) return changed();
    // another call claimed this follow-up time and saves its draft now. the run of that call counts it.
    if (claimedNudge(delegation.id, followUpAt)) {
      decide({ delegationId: delegation.id, action: 'nudge_pending', account, to });
      return;
    }
    const policy = decisionOf(callId);
    const approvalId = policy?.approvalId ?? null;
    if (approvalId !== null && !output.isError) {
      // the follow-up time stays, so the approved call still matches it. the next runs wait for the owner.
      settle(
        delegation,
        { delegationId: delegation.id, action: 'nudge_pending', account, to },
        {
          next: followUpAt,
          event: { kind: 'follow_up_checked', text: `No reply yet. The nudge to ${to} waits for the owner's approval #${approvalId}.`, data: { threadId, account, approvalId } },
          told: `no reply yet, and the nudge to ${to} waits for your approval #${approvalId}.`,
        },
      );
      return;
    }
    // the reviewer held the call, or the tool refused it. the tool wrote no row, so the job tries again in a day. the
    // reason can quote the mail, so the history and the owner message give a fixed sentence with the policy decision,
    // and the trace keeps the full text in the row of the tool call.
    const where = policy ? `See policy decision #${policy.id} in the trace.` : 'See the tool call in the trace.';
    settle(
      delegation,
      { delegationId: delegation.id, action: 'nudge_failed', account, to },
      {
        next: at(DAY_MS),
        event: {
          kind: 'follow_up_failed',
          text: `The nudge was not saved: the reviewer held it or the tool refused it. ${where}`,
          data: { threadId, account, ...(policy ? { decisionId: policy.id } : {}) },
        },
        told: `no reply yet, and the nudge was not saved. ${where}`,
      },
    );
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
          if (dryRun) decide({ delegationId: delegation.id, action: 'error' });
          else {
            try {
              // the check expects the follow-up time that the job read, so an error never moves a time that the owner
              // set meanwhile, and never touches a delegation that the owner closed.
              const event: HistoryRow = { kind: 'follow_up_failed', text: `the follow-up stopped: ${errorText(err)}` };
              settle(delegation, { delegationId: delegation.id, action: 'error' }, { next: at(DAY_MS), event });
            } catch (inner) {
              decide({ delegationId: delegation.id, action: 'error' });
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
