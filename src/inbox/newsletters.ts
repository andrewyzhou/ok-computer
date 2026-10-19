import type { gmail_v1 } from '@googleapis/gmail';
import { z } from 'zod';
import type { SenderState, UnsubscribeMethod } from '../dashboard/types.js';
import type { Db } from '../db/index.js';
import { toGoogleError } from '../google/errors.js';
import { fromAddress as parseFrom, header } from '../google/mime.js';
import { failed } from '../google/send.js';
import { requestContext } from '../google/trace.js';
import { planUnsubscribe, unsubscribeTargets } from '../google/unsubscribe.js';
import { redact } from '../observability/redact.js';
import { cleanLine } from '../signals/store.js';
import { defineTool, errorText, type Tool, type ToolOutput } from '../tools/registry.js';
import { requestAction, settleApprovals, startBrowserHelp } from './actions.js';
import type { ActionResult, InboxContext, JobRun } from './context.js';
import { getMessages, inInbox, isUnread, listMessages, receivedAt } from './gmail.js';
import { mailSource, markRead } from './run.js';

// the newsletter sweep: it groups the mail of each account by List-Id or From, counts what the owner read, and finds
// the unsubscribe method. the owner unsubscribes or archives a sender with an approval. see docs/PHASE5-API.md (m8)
// for the routes that call it. nothing here sends mail: a mailto unsubscribe is shown, but never used.

export const UNSUBSCRIBE_TOOL = 'inbox_unsubscribe';
export const ARCHIVE_TOOL = 'inbox_archive_sender';

// the mail that a sweep reads: the last 90 days, without the owner's own mail.
export const SWEEP_QUERY = 'newer_than:90d -in:sent -in:drafts -in:chats';
export const MAX = 2000;

// an archive reads at most this many messages of one sender, and changes them in parts of this size.
const ARCHIVE_MAX = 5000;
const BATCH = 1000;

// mail that still comes this long after an unsubscribe means that the unsubscribe did not work.
const GRACE_MS = 7 * 24 * 60 * 60 * 1000;
const STILL_COMES = 'mail still comes more than 7 days after the unsubscribe';

const SWEEP_HEADERS = ['From', 'List-Id', 'List-Unsubscribe', 'List-Unsubscribe-Post', 'Date'];
const CHECK_HEADERS = ['From', 'List-Unsubscribe', 'List-Unsubscribe-Post', 'Authentication-Results', 'DKIM-Signature'];

// the system labels of gmail. an archive must not add one, because the trash and spam hide mail, and the others
// change what gmail shows to the owner.
const RESERVED_LABELS = new Set(['INBOX', 'SPAM', 'TRASH', 'UNREAD', 'STARRED', 'IMPORTANT', 'SENT', 'DRAFT', 'CHAT']);
export const reservedLabel = (name: string) => RESERVED_LABELS.has(name.trim().toUpperCase()) || name.trim().toUpperCase().startsWith('CATEGORY_');

// the quotes of a quoted name are not part of the name.
const unquoted = (text: string) => cleanLine(text.replace(/"/g, ''), 200);

// the key of the sender of one message, and the parts that the sender row keeps. undefined for a message that is not
// a list mail (no List-Id and no List-Unsubscribe header) or that has no From address.
export function senderOf(message: gmail_v1.Schema$Message): { senderKey: string; listId: string | null; fromAddress: string; displayName: string | null } | undefined {
  const listHeader = header(message, 'List-Id');
  if (!listHeader && !header(message, 'List-Unsubscribe')) return undefined;
  const from = header(message, 'From');
  const fromAddress = parseFrom(from);
  if (!fromAddress) return undefined;
  const bracket = /<([^<>]*)>/.exec(listHeader);
  const listId = (bracket ? bracket[1]! : listHeader).trim().toLowerCase() || null;
  // the name of the from header is the text before its address. the list phrase is the text before the list id.
  const fromName = /^(.*)<[^<>]*>\s*$/.exec(from)?.[1] ?? '';
  const listName = bracket ? listHeader.slice(0, bracket.index) : '';
  const displayName = unquoted(fromName) || unquoted(listName) || null;
  return { senderKey: listId ?? fromAddress, listId, fromAddress, displayName };
}

// the method and the url of the List-Unsubscribe header of one message: one_click needs an https target and
// List-Unsubscribe-Post (rfc 8058), https is an https target without it, mailto is a mailto target only.
export function unsubscribeOf(message: gmail_v1.Schema$Message): { method: UnsubscribeMethod; url: string | null } {
  const targets = unsubscribeTargets(header(message, 'List-Unsubscribe'));
  const https = targets.find((target) => /^https:/i.test(target));
  if (https) return { method: /List-Unsubscribe=One-Click/i.test(header(message, 'List-Unsubscribe-Post')) ? 'one_click' : 'https', url: https };
  const mailto = targets.find((target) => /^mailto:/i.test(target));
  if (mailto) return { method: 'mailto', url: mailto };
  return { method: 'none', url: null };
}

// the parts of an inbox_senders row that the actions use.
interface SenderRecord {
  id: number;
  account: string;
  senderKey: string;
  listId: string | null;
  fromAddress: string;
  unsubscribeMethod: UnsubscribeMethod;
  unsubscribeUrl: string | null;
  unsubscribeMessageId: string | null;
  state: SenderState;
  approvalId: number | null;
  unsubscribedAt: string | null;
}

function senderRecord(db: Db, id: number): SenderRecord | undefined {
  const row = db.prepare('SELECT * FROM inbox_senders WHERE id = ?').get(id);
  if (!row) return undefined;
  const text = (value: unknown) => (value === null || value === undefined ? null : String(value));
  return {
    id: Number(row.id),
    account: String(row.account),
    senderKey: String(row.senderKey),
    listId: text(row.listId),
    fromAddress: String(row.fromAddress),
    unsubscribeMethod: String(row.unsubscribeMethod) as UnsubscribeMethod,
    unsubscribeUrl: text(row.unsubscribeUrl),
    unsubscribeMessageId: text(row.unsubscribeMessageId),
    state: String(row.state) as SenderState,
    approvalId: row.approvalId === null ? null : Number(row.approvalId),
    unsubscribedAt: text(row.unsubscribedAt),
  };
}

// the job of the newsletters automation. it writes inbox_senders and inbox_sender_messages. it makes no model call
// and changes no mail.
export async function sweepNewsletters(ctx: InboxContext, run: JobRun): Promise<{ note?: string }> {
  const notes: string[] = [];
  const checked: string[] = [];
  for (const { alias } of ctx.googleConfig.accounts) {
    const why = ctx.google.accounts.unavailable(alias);
    if (why) notes.push(`${alias}: ${why}`);
    else checked.push(alias);
  }
  // the senders and the links come from mail, so the run is tainted before the first read.
  markRead(ctx, run, checked.map(mailSource), 'inbox_newsletters');
  let senders = 0;
  let failures = 0;
  for (const alias of checked) {
    try {
      const messages = await ctx.google.accounts.run(alias, async (apis) => {
        const refs = await listMessages(apis, SWEEP_QUERY, MAX);
        return getMessages(
          apis,
          refs.map((each) => each.id),
          { format: 'metadata', headers: SWEEP_HEADERS },
        );
      });
      senders += saveSweep(ctx, run, alias, messages);
    } catch (err) {
      failures++;
      notes.push(`${alias}: ${redact(errorText(err))}`);
    }
  }
  if (checked.length && failures === checked.length) throw new Error(notes.join('; '));
  return { note: notes.length ? notes.join('; ') : `${senders} senders in ${checked.join(', ')}` };
}

// saveSweep writes the senders and the messages of one account in one transaction, and gives the number of senders
// that the sweep saw.
function saveSweep(ctx: InboxContext, run: JobRun, account: string, messages: gmail_v1.Schema$Message[]): number {
  const groups = new Map<string, Array<{ message: gmail_v1.Schema$Message; sender: NonNullable<ReturnType<typeof senderOf>>; at: string }>>();
  for (const message of messages) {
    const sender = senderOf(message);
    if (!sender || !message.id) continue;
    const group = groups.get(sender.senderKey) ?? [];
    group.push({ message, sender, at: receivedAt(message) });
    groups.set(sender.senderKey, group);
  }
  const { db } = ctx;
  const now = ctx.clock().toISOString();
  const existing = db.prepare('SELECT id, state, unsubscribedAt FROM inbox_senders WHERE account = ? AND senderKey = ?');
  // the upsert never writes the state, the approval, the unsubscribe time, the archive count, the label or the help
  // session. those belong to the actions of the owner.
  const upsert = db.prepare(
    `INSERT INTO inbox_senders (account, senderKey, listId, fromAddress, displayName, firstAt, lastAt, unsubscribeMethod, unsubscribeUrl, unsubscribeMessageId, runId, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (account, senderKey) DO UPDATE SET
       listId = excluded.listId, fromAddress = excluded.fromAddress, displayName = excluded.displayName,
       firstAt = MIN(firstAt, excluded.firstAt), lastAt = MAX(lastAt, excluded.lastAt),
       unsubscribeMethod = excluded.unsubscribeMethod, unsubscribeUrl = excluded.unsubscribeUrl, unsubscribeMessageId = excluded.unsubscribeMessageId,
       runId = excluded.runId, updatedAt = excluded.updatedAt
     RETURNING id`,
  );
  const saveMessage = db.prepare(
    `INSERT INTO inbox_sender_messages (account, messageId, senderId, receivedAt, unread, inInbox) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (account, messageId) DO UPDATE SET senderId = excluded.senderId, receivedAt = excluded.receivedAt, unread = excluded.unread, inInbox = excluded.inInbox`,
  );
  const stillComes = db.prepare("UPDATE inbox_senders SET state = 'failed', error = ?, updatedAt = ? WHERE id = ? AND state = 'unsubscribed'");
  db.exec('BEGIN');
  try {
    for (const [senderKey, group] of groups) {
      const before = existing.get(account, senderKey);
      // a kept sender left the sweeps: its row and its counts stay as they are.
      if (before?.state === 'kept') continue;
      const byTime = [...group].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
      const newest = byTime[byTime.length - 1]!;
      const withLink = [...byTime].reverse().find((each) => header(each.message, 'List-Unsubscribe'));
      const unsubscribe = withLink ? unsubscribeOf(withLink.message) : { method: 'none' as const, url: null };
      const row = upsert.get(
        account,
        senderKey,
        newest.sender.listId,
        newest.sender.fromAddress,
        newest.sender.displayName,
        byTime[0]!.at,
        newest.at,
        unsubscribe.method,
        unsubscribe.url,
        withLink?.message.id ?? null,
        run.runId,
        now,
      );
      const senderId = Number(row!.id);
      for (const each of group) saveMessage.run(account, each.message.id!, senderId, each.at, isUnread(each.message) ? 1 : 0, inInbox(each.message) ? 1 : 0);
      if (before?.state === 'unsubscribed' && before.unsubscribedAt) {
        const limit = Date.parse(String(before.unsubscribedAt)) + GRACE_MS;
        if (Date.parse(newest.at) > limit) stillComes.run(STILL_COMES, now, senderId);
      }
    }
    db.prepare(
      `UPDATE inbox_senders SET
         messages = (SELECT COUNT(*) FROM inbox_sender_messages WHERE senderId = inbox_senders.id),
         read = (SELECT COUNT(*) FROM inbox_sender_messages WHERE senderId = inbox_senders.id AND unread = 0)
       WHERE account = ?`,
    ).run(account);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return groups.size;
}

// a header field with a line break could add a header that the owner did not approve.
const line = (max: number) => z.string().min(1).max(max).regex(/^[^\r\n]*$/, 'a line break is not allowed');

// the tools that the approved actions run: inbox_unsubscribe and inbox_archive_sender.
export function createNewsletterTools(ctx: InboxContext): Tool[] {
  const { db } = ctx;
  const aliases = ctx.googleConfig.accounts.map((each) => each.alias) as [string, ...string[]];
  const account = z.enum(aliases).describe('the alias of the google account');

  // each tool names its account, so the trace row keeps it. the requests of a call carry the run and the call, so the
  // run timeline shows them.
  const inboxTool = <I extends { account: string }>(tool: Omit<Tool<I>, 'source' | 'serverId' | 'accountOf'>): Tool =>
    defineTool<I>({
      ...tool,
      source: 'google',
      serverId: 'google',
      accountOf: (input) => input.account,
      run: (input, toolCtx) =>
        requestContext.run({ ...requestContext.getStore(), runId: toolCtx.runId, ...(toolCtx.toolCallId ? { toolCallId: toolCtx.toolCallId } : {}) }, () => tool.run(input, toolCtx)),
    });

  const setState = (id: number, state: SenderState, error: string | null) =>
    db.prepare('UPDATE inbox_senders SET state = ?, error = ?, updatedAt = ? WHERE id = ?').run(state, error, ctx.clock().toISOString(), id);
  // a refusal has no effect field: a second approval of the same call cannot help.
  const refuse = (tool: string, text: string): ToolOutput => ({ content: `${tool} did not run: ${text}.`, isError: true });

  return [
    inboxTool({
      name: UNSUBSCRIBE_TOOL,
      description:
        'Unsubscribe the owner from a newsletter sender with its one-click link (rfc 8058), or start a browser task on its https link. The dashboard asks for each call, and the owner approves it.',
      input: z.object({
        senderId: z.number().int(),
        account,
        sender: z.string().min(1).max(500),
        fromAddress: z.string().min(1).max(320),
        method: z.enum(['one_click', 'https']),
        target: z.string().min(1).max(2000),
      }),
      risk: 'external',
      needsApproval: true,
      async run(input) {
        const row = senderRecord(db, input.senderId);
        // the card showed the input, so the row must still have the same sender, method and link.
        if (!row) return refuse(UNSUBSCRIBE_TOOL, `the sender ${input.senderId} does not exist`);
        if (row.account !== input.account || row.senderKey !== input.sender || row.fromAddress !== input.fromAddress || row.unsubscribeMethod !== input.method || row.unsubscribeUrl !== input.target) {
          return refuse(UNSUBSCRIBE_TOOL, 'the sender row changed after the owner was asked. The owner can ask again on the dashboard');
        }
        if (row.state === 'unsubscribed') return { content: `${row.senderKey} in ${row.account} is already unsubscribed.` };
        if (!row.unsubscribeMessageId) return refuse(UNSUBSCRIBE_TOOL, 'the sender row names no message with the unsubscribe link');
        // the checks read the message again at run time, so a link that the message no longer offers never runs.
        let message: gmail_v1.Schema$Message;
        try {
          message = (
            await ctx.google.accounts.run(row.account, (apis) =>
              apis.gmail.users.messages.get({ userId: 'me', id: row.unsubscribeMessageId!, format: 'metadata', metadataHeaders: CHECK_HEADERS }),
            )
          ).data;
        } catch (err) {
          const output = { ...failed(UNSUBSCRIBE_TOOL, row.account, toGoogleError(err), true), effect: 'none' as const };
          setState(row.id, 'unsubscribe_pending', output.content);
          return output;
        }
        const now = ctx.clock().toISOString();
        if (input.method === 'one_click') {
          // send is false, so a mailto target is always refused here.
          const plan = planUnsubscribe(message, row.fromAddress, input.target, false);
          if (plan.way !== 'one-click') {
            const text = plan.way === 'refused' ? plan.text : 'this sender unsubscribes by mail, and ok computer never sends mail';
            setState(row.id, 'failed', text);
            return refuse(UNSUBSCRIBE_TOOL, text);
          }
          // the post goes outside accounts.run, so the trace gets the account here.
          const result = await requestContext.run({ ...requestContext.getStore(), account: row.account }, () => ctx.google.oneClick(input.target));
          if (result.ok) {
            db.prepare("UPDATE inbox_senders SET state = 'unsubscribed', unsubscribedAt = ?, error = NULL, updatedAt = ? WHERE id = ?").run(now, now, row.id);
            return { content: `unsubscribed ${row.senderKey} in ${row.account}: ${result.text}.` };
          }
          const content = `${UNSUBSCRIBE_TOOL} did not finish: ${result.text}.`;
          if (result.refused) {
            setState(row.id, 'failed', result.text);
            return { content, isError: true };
          }
          // a post that never left gives the approval back, so the row waits for it again.
          if (!result.sent) {
            setState(row.id, 'unsubscribe_pending', result.text);
            return { content, isError: true, effect: 'none' };
          }
          setState(row.id, 'failed', result.text);
          return { content, isError: true, effect: 'unknown' };
        }
        // an https link opens in a browser task. the message must still come from the sender and offer the link.
        if (parseFrom(header(message, 'From')) !== row.fromAddress) {
          const text = 'the message with the link is not from the sender any more';
          setState(row.id, 'failed', text);
          return refuse(UNSUBSCRIBE_TOOL, text);
        }
        if (!unsubscribeTargets(header(message, 'List-Unsubscribe')).includes(input.target)) {
          const text = 'the message no longer offers the approved link';
          setState(row.id, 'failed', text);
          return refuse(UNSUBSCRIBE_TOOL, text);
        }
        const help = startBrowserHelp(ctx, {
          account: row.account,
          url: input.target,
          task: `Unsubscribe the owner from the mailing list ${row.senderKey} on this page. Do not sign in or give any data other than the owner's email address when the page asks for it.`,
          toolName: UNSUBSCRIBE_TOOL,
        });
        // the sweep checks the row again: mail that still comes after 7 days marks it failed.
        db.prepare("UPDATE inbox_senders SET state = 'unsubscribed', unsubscribedAt = ?, helpSessionKey = ?, error = NULL, updatedAt = ? WHERE id = ?").run(
          now,
          help.sessionKey,
          now,
          row.id,
        );
        return {
          content: `a browser task now helps to unsubscribe ${row.senderKey} in ${row.account} (session ${help.sessionKey}). Each form that it sends asks the owner first.`,
        };
      },
    }),
    inboxTool({
      name: ARCHIVE_TOOL,
      description: 'Take the mail of one newsletter sender out of the inbox, and add a label first when one is given. The dashboard asks for each call, and the owner approves it.',
      input: z.object({
        senderId: z.number().int(),
        account,
        sender: z.string().min(1).max(500),
        olderThanDays: z.number().int().min(0).max(3650),
        label: line(100).optional(),
      }),
      risk: 'write',
      needsApproval: true,
      async run(input) {
        const row = senderRecord(db, input.senderId);
        if (!row) return refuse(ARCHIVE_TOOL, `the sender ${input.senderId} does not exist`);
        if (row.account !== input.account || row.senderKey !== input.sender) return refuse(ARCHIVE_TOOL, 'the sender row changed after the owner was asked');
        if (input.label !== undefined && reservedLabel(input.label)) return refuse(ARCHIVE_TOOL, `${JSON.stringify(input.label)} is a system label of gmail`);
        const q = `in:inbox${input.olderThanDays > 0 ? ` older_than:${input.olderThanDays}d` : ''}${row.listId ? ` list:${row.listId}` : ` from:${row.fromAddress}`}`;
        let ids: string[];
        try {
          ids = await ctx.google.accounts.run(row.account, async (apis) => {
            const refs = await listMessages(apis, q, ARCHIVE_MAX);
            // senderOf needs List-Unsubscribe too: a sender without a List-Id is a list sender only through it.
            const messages = await getMessages(
              apis,
              refs.map((each) => each.id),
              { format: 'metadata', headers: ['From', 'List-Id', 'List-Unsubscribe'] },
            );
            // a from: search is fuzzy, so only the mail whose sender is this row moves.
            const mine = messages.filter((each) => each.id && senderOf(each)?.senderKey === row.senderKey).map((each) => each.id!);
            if (!mine.length) return mine;
            let labelId: string | undefined;
            if (input.label !== undefined) {
              const { data } = await apis.gmail.users.labels.list({ userId: 'me' });
              labelId = (data.labels ?? []).find((each) => each.name === input.label)?.id ?? undefined;
              if (!labelId) {
                const created = await apis.gmail.users.labels.create({ userId: 'me', requestBody: { name: input.label, labelListVisibility: 'labelShow', messageListVisibility: 'show' } });
                labelId = created.data.id ?? undefined;
              }
            }
            for (let at = 0; at < mine.length; at += BATCH) {
              await apis.gmail.users.messages.batchModify({
                userId: 'me',
                requestBody: { ids: mine.slice(at, at + BATCH), ...(labelId ? { addLabelIds: [labelId] } : {}), removeLabelIds: ['INBOX'] },
              });
            }
            return mine;
          });
        } catch (err) {
          // an archive that runs again does no harm, so a retry is safe.
          return failed(ARCHIVE_TOOL, row.account, toGoogleError(err), true);
        }
        const now = ctx.clock().toISOString();
        const out = db.prepare('UPDATE inbox_sender_messages SET inInbox = 0 WHERE account = ? AND messageId = ?');
        db.exec('BEGIN');
        try {
          db.prepare('UPDATE inbox_senders SET archived = archived + ?, label = COALESCE(?, label), updatedAt = ? WHERE id = ?').run(
            ids.length,
            ids.length && input.label !== undefined ? input.label : null,
            now,
            row.id,
          );
          for (const id of ids) out.run(row.account, id);
          db.exec('COMMIT');
        } catch (err) {
          db.exec('ROLLBACK');
          throw err;
        }
        return { content: `archived ${ids.length} messages of ${row.senderKey} in ${row.account}${ids.length && input.label !== undefined ? ` with the label ${input.label}` : ''}.` };
      },
    }),
  ];
}

const notFound: ActionResult = { ok: false, status: 404, error: 'sender not found' };
const conflict = (error: string): ActionResult => ({ ok: false, status: 409, error });
// a request that claimed the row a moment ago has no approval id yet.
const waitsFor = (approvalId: number | null) => `the unsubscribe of this sender waits for approval${approvalId === null ? '' : ` #${approvalId}`}`;

export async function requestUnsubscribe(ctx: InboxContext, senderId: number): Promise<ActionResult> {
  // a denied or expired approval gives its row back first, so the owner can ask again.
  settleApprovals(ctx.db, ctx.clock());
  const row = senderRecord(ctx.db, senderId);
  if (!row) return notFound;
  if (row.state === 'unsubscribed') return conflict('this sender is already unsubscribed');
  if (row.state === 'unsubscribe_pending') return conflict(waitsFor(row.approvalId));
  if (row.unsubscribeMethod === 'none' || !row.unsubscribeUrl) return conflict('this sender offers no unsubscribe link');
  if (row.unsubscribeMethod === 'mailto') {
    return conflict('this sender unsubscribes by mail, and ok computer never sends mail. The link is on the page, so the owner can do it by hand');
  }
  // the compare and set claims the row, so two requests at the same time ask the owner one time.
  const now = ctx.clock().toISOString();
  const claim = ctx.db
    .prepare("UPDATE inbox_senders SET state = 'unsubscribe_pending', approvalId = NULL, updatedAt = ? WHERE id = ? AND state NOT IN ('unsubscribe_pending', 'unsubscribed')")
    .run(now, senderId);
  if (Number(claim.changes) === 0) return conflict('the unsubscribe of this sender already started');
  const giveBack = () =>
    ctx.db.prepare("UPDATE inbox_senders SET state = ?, updatedAt = ? WHERE id = ? AND state = 'unsubscribe_pending'").run(row.state, ctx.clock().toISOString(), senderId);
  let result: Awaited<ReturnType<typeof requestAction>>;
  try {
    result = await requestAction(ctx, {
      tool: UNSUBSCRIBE_TOOL,
      input: { senderId, account: row.account, sender: row.senderKey, fromAddress: row.fromAddress, method: row.unsubscribeMethod, target: row.unsubscribeUrl },
      account: row.account,
    });
  } catch (err) {
    giveBack();
    throw err;
  }
  if (!result.ok) {
    giveBack();
    return { ok: false, status: result.status, error: result.error };
  }
  ctx.db.prepare('UPDATE inbox_senders SET approvalId = ?, error = NULL WHERE id = ?').run(result.response.approvalId, senderId);
  return { ok: true, response: result.response };
}

export async function requestArchive(ctx: InboxContext, senderId: number, request: { olderThanDays: number; label?: string }): Promise<ActionResult> {
  const row = senderRecord(ctx.db, senderId);
  if (!row) return notFound;
  const pending = ctx.db
    .prepare("SELECT id FROM approvals WHERE status = 'pending' AND toolName = ? AND json_extract(input, '$.senderId') = ? ORDER BY id LIMIT 1")
    .get(ARCHIVE_TOOL, senderId);
  if (pending) return conflict(`the archive of this sender waits for approval #${Number(pending.id)}`);
  if (request.label !== undefined && reservedLabel(request.label)) return conflict(`${JSON.stringify(request.label)} is a system label of gmail, so the archive cannot add it`);
  const result = await requestAction(ctx, {
    tool: ARCHIVE_TOOL,
    input: { senderId, account: row.account, sender: row.senderKey, olderThanDays: request.olderThanDays, ...(request.label !== undefined ? { label: request.label } : {}) },
    account: row.account,
  });
  if (!result.ok) return { ok: false, status: result.status, error: result.error };
  return { ok: true, response: result.response };
}

export function keepSender(ctx: InboxContext, senderId: number): ActionResult {
  const row = senderRecord(ctx.db, senderId);
  if (!row) return notFound;
  if (row.state === 'unsubscribe_pending') return conflict(waitsFor(row.approvalId));
  ctx.db.prepare("UPDATE inbox_senders SET state = 'kept', updatedAt = ? WHERE id = ?").run(ctx.clock().toISOString(), senderId);
  return { ok: true, response: { status: 'done', approvalId: null, message: `${row.senderKey} is kept and leaves the later sweeps.` } };
}
