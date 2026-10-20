import type { gmail_v1 } from '@googleapis/gmail';
import { z } from 'zod';
import type { SenderState, UnsubscribeMethod } from '../dashboard/types.js';
import type { Db } from '../db/index.js';
import { toGoogleError } from '../google/errors.js';
import { fromAddress as parseFrom, header } from '../google/mime.js';
import { failed } from '../google/failed.js';
import { requestContext } from '../google/trace.js';
import { planUnsubscribe, unsubscribeTargets, verifyUnsubscribeHeaders } from '../google/unsubscribe.js';
import { defineTool, type Tool, type ToolOutput } from '../tools/registry.js';
import { httpsLink, requestAction, settleApprovals, startBrowserHelp } from './actions.js';
import type { ActionResult, InboxContext, JobRun } from './context.js';
import { getMessages, inInbox, isUnread, listMessages, readError, receivedAt } from './gmail.js';
import { mailSource, markRead } from './run.js';
import { phase5KeyOf, registrableDomain, senderIdentityOf, unsubscribeChoiceOf, type SenderIdentity } from './senders.js';

// the newsletter sweep: it groups the mail of each account by List-Id or From, counts what the owner read, and finds
// the unsubscribe method. the owner unsubscribes or archives a sender with an approval. see docs/API.md (m8)
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

// the sweep reads the dkim headers too, so it takes the link of a sender from a message whose link is signed.
export const SWEEP_HEADERS = ['From', 'List-Id', 'List-Unsubscribe', 'List-Unsubscribe-Post', 'Date', 'Authentication-Results', 'DKIM-Signature'];
const CHECK_HEADERS = ['From', 'List-Unsubscribe', 'List-Unsubscribe-Post', 'Authentication-Results', 'DKIM-Signature'];

// the system labels of gmail. an archive must not add one, because the trash and spam hide mail, and the others
// change what gmail shows to the owner.
const RESERVED_LABELS = new Set(['INBOX', 'SPAM', 'TRASH', 'UNREAD', 'STARRED', 'IMPORTANT', 'SENT', 'DRAFT', 'CHAT']);
export const reservedLabel = (name: string) => RESERVED_LABELS.has(name.trim().toUpperCase()) || name.trim().toUpperCase().startsWith('CATEGORY_');

// the key of the sender of one message, and the parts that the sender row keeps. undefined for a message that is not
// a list mail (no List-Id and no List-Unsubscribe header) or that has no From address. senderIdentityOf of senders.ts
// makes the key, so a shared List-Id or a shared no-reply address never puts two senders in one group.
export function senderOf(message: gmail_v1.Schema$Message): { senderKey: string; listId: string | null; fromAddress: string; displayName: string | null } | undefined {
  const identity = senderIdentityOf(message);
  if (!identity) return undefined;
  const { senderKey, listId, fromAddress, displayName } = identity;
  return { senderKey, listId, fromAddress, displayName };
}

// the method and the url of the List-Unsubscribe header of one message: one_click needs an https target and
// List-Unsubscribe-Post (rfc 8058), https is an https target without it, mailto is a mailto target only.
export function unsubscribeOf(message: gmail_v1.Schema$Message): { method: UnsubscribeMethod; url: string | null } {
  return unsubscribeChoiceOf(message);
}

// the domain of an address under its public suffix.
const domainOf = (address: string) => registrableDomain(address.slice(address.lastIndexOf('@') + 1));

// a row of phase 5 that holds a choice of the owner or an action: it is not active, or it has an approval or a browser
// help run. such a row keeps its key, so the choice keeps applying to the mail of its own sender.
const pinned = (row: { state: unknown; approvalId: unknown; helpSessionKey: unknown }) => row.state !== 'active' || row.approvalId !== null || row.helpSessionKey !== null;

// true when a message belongs to a sender row: its key is the key of the row, or the row is a pinned row with the key
// that phase 5 gave the message, and the message comes from the from domain of the row. the sweep groups by the same
// rule, so an archive moves the mail that the row counts and no other.
function belongsTo(identity: SenderIdentity, row: SenderRecord): boolean {
  if (identity.senderKey === row.senderKey) return true;
  return pinned(row) && phase5KeyOf(identity) === row.senderKey && identity.fromDomain === domainOf(row.fromAddress);
}

// the headers that a dkim signature must cover for each way to unsubscribe.
export const SIGNED: Record<'one_click' | 'https', string[]> = { one_click: ['List-Unsubscribe', 'List-Unsubscribe-Post'], https: ['List-Unsubscribe'] };

// true when the unsubscribe header of the message is signed by the domain of its sender, so a forger did not write
// it. a mailto or no link is never used, so it needs no check.
function signedLink(message: gmail_v1.Schema$Message, fromAddress: string): boolean {
  const { method } = unsubscribeOf(message);
  if (method !== 'one_click' && method !== 'https') return false;
  return verifyUnsubscribeHeaders(message, fromAddress, SIGNED[method]) === undefined;
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
  helpSessionKey: string | null;
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
    helpSessionKey: text(row.helpSessionKey),
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
  const capped: string[] = [];
  for (const alias of checked) {
    try {
      const messages = await ctx.google.accounts.run(alias, async (apis) => {
        // one more id than the limit tells whether the account has more mail than the sweep reads.
        const refs = await listMessages(apis, SWEEP_QUERY, MAX + 1, ctx.signal);
        if (refs.length > MAX) capped.push(alias);
        return getMessages(
          apis,
          refs.slice(0, MAX).map((each) => each.id),
          { format: 'metadata', headers: SWEEP_HEADERS, signal: ctx.signal },
        );
      });
      senders += saveSweep(ctx, run, alias, messages);
    } catch (err) {
      failures++;
      notes.push(`${alias}: ${readError(err)}`);
    }
  }
  if (checked.length && failures === checked.length) throw new Error(notes.join('; '));
  // the counts of an account with more mail than the limit are a lower bound, and the note says so.
  if (capped.length) notes.push(`${capped.join(', ')}: more than ${MAX} mails in 90 days, so the counts are a lower bound`);
  return { note: notes.length ? notes.join('; ') : `${senders} senders in ${checked.join(', ')}` };
}

// the most common display name of a group, with a tie going to the newest. a sender that changes its name for one
// mail keeps the name that it uses most.
function displayNameOf(byTime: Array<{ sender: SenderIdentity }>): string | null {
  const seen = new Map<string, { count: number; last: number }>();
  byTime.forEach((each, index) => {
    const name = each.sender.displayName;
    if (name === null) return;
    const before = seen.get(name);
    seen.set(name, { count: (before?.count ?? 0) + 1, last: index });
  });
  let best: { name: string; count: number; last: number } | undefined;
  for (const [name, { count, last }] of seen) {
    if (!best || count > best.count || (count === best.count && last > best.last)) best = { name, count, last };
  }
  return best?.name ?? null;
}

// saveSweep writes the senders and the messages of one account in one transaction, and gives the number of senders
// that the sweep saw.
function saveSweep(ctx: InboxContext, run: JobRun, account: string, messages: gmail_v1.Schema$Message[]): number {
  const { db } = ctx;
  const seen: Array<{ message: gmail_v1.Schema$Message; sender: SenderIdentity; at: string }> = [];
  for (const message of messages) {
    const sender = senderIdentityOf(message);
    if (!sender || !message.id) continue;
    seen.push({ message, sender, at: receivedAt(message) });
  }
  const now = ctx.clock().toISOString();
  const existing = db.prepare('SELECT id, state, unsubscribedAt FROM inbox_senders WHERE account = ? AND senderKey = ?');
  const oldRow = db.prepare('SELECT id, fromAddress, state, approvalId, helpSessionKey FROM inbox_senders WHERE account = ? AND senderKey = ?');
  // the upsert never writes the state, the approval, the unsubscribe time, the archive count, the label or the help
  // session. those belong to the actions of the owner.
  const upsert = db.prepare(
    `INSERT INTO inbox_senders (account, senderKey, listId, fromAddress, displayName, firstAt, lastAt, unsubscribeMethod, unsubscribeUrl, unsubscribeMessageId, fromDomains, runId, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (account, senderKey) DO UPDATE SET
       listId = excluded.listId, fromAddress = excluded.fromAddress, displayName = excluded.displayName,
       firstAt = MIN(firstAt, excluded.firstAt), lastAt = MAX(lastAt, excluded.lastAt),
       unsubscribeMethod = excluded.unsubscribeMethod, unsubscribeUrl = excluded.unsubscribeUrl, unsubscribeMessageId = excluded.unsubscribeMessageId,
       fromDomains = excluded.fromDomains, runId = excluded.runId, updatedAt = excluded.updatedAt
     RETURNING id`,
  );
  const saveMessage = db.prepare(
    `INSERT INTO inbox_sender_messages (account, messageId, senderId, receivedAt, unread, inInbox) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (account, messageId) DO UPDATE SET senderId = excluded.senderId, receivedAt = excluded.receivedAt, unread = excluded.unread, inInbox = excluded.inInbox`,
  );
  const stillComes = db.prepare("UPDATE inbox_senders SET state = 'failed', error = ?, updatedAt = ? WHERE id = ? AND state = 'unsubscribed'");
  const rename = db.prepare('UPDATE inbox_senders SET senderKey = ?, updatedAt = ? WHERE id = ?');
  db.exec('BEGIN');
  try {
    // the rows of phase 5 were keyed by the plain list id or the from address. a message whose key changed finds its
    // old row here. an active row that no action holds and whose mail now has one key is renamed, so its counts and
    // its history stay. a pinned row keeps its key for the mail of its own from domain. no row is ever deleted.
    const byOldKey = new Map<string, typeof seen>();
    for (const each of seen) {
      const oldKey = phase5KeyOf(each.sender);
      if (oldKey === each.sender.senderKey) continue;
      byOldKey.set(oldKey, [...(byOldKey.get(oldKey) ?? []), each]);
    }
    for (const [oldKey, group] of byOldKey) {
      const row = oldRow.get(account, oldKey);
      if (!row) continue;
      if (pinned({ state: row.state, approvalId: row.approvalId, helpSessionKey: row.helpSessionKey })) {
        const domain = domainOf(String(row.fromAddress));
        for (const each of group) if (each.sender.fromDomain === domain) each.sender = { ...each.sender, senderKey: oldKey };
        continue;
      }
      // a row whose key some mail of this sweep still has stays where it is: that mail is the sender of the row, and
      // the mail with a new key is another sender that gets a row of its own.
      if (seen.some((each) => each.sender.senderKey === oldKey)) continue;
      const keys = new Set(group.map((each) => each.sender.senderKey));
      const [newKey] = keys;
      if (keys.size === 1 && newKey !== undefined && !existing.get(account, newKey)) rename.run(newKey, now, Number(row.id));
    }
    const groups = new Map<string, typeof seen>();
    for (const each of seen) groups.set(each.sender.senderKey, [...(groups.get(each.sender.senderKey) ?? []), each]);
    for (const [senderKey, group] of groups) {
      const before = existing.get(account, senderKey);
      // a kept sender left the sweeps: its row and its counts stay as they are.
      if (before?.state === 'kept') continue;
      const byTime = [...group].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
      const newest = byTime[byTime.length - 1]!;
      // the link comes from the newest message whose link the sender signed, so a forged mail with the same List-Id
      // cannot put its own link on the row. without a signed one, the newest link is shown, and the action refuses it
      // at run time.
      const newestFirst = [...byTime].reverse();
      const withLink =
        newestFirst.find((each) => signedLink(each.message, each.sender.fromAddress)) ?? newestFirst.find((each) => header(each.message, 'List-Unsubscribe'));
      const unsubscribe = withLink ? unsubscribeOf(withLink.message) : { method: 'none' as const, url: null };
      const row = upsert.get(
        account,
        senderKey,
        newest.sender.listId,
        newest.sender.fromAddress,
        displayNameOf(byTime),
        byTime[0]!.at,
        newest.at,
        unsubscribe.method,
        unsubscribe.url,
        withLink?.message.id ?? null,
        new Set(group.map((each) => each.sender.fromDomain)).size,
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
    return groups.size;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
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
        if (row.state === 'unsubscribed') return { content: `${row.senderKey} in ${row.account} is already unsubscribed.` };
        // a refusal gives the row back, so the owner can ask again with the row as it is now.
        const giveBack = (text: string) => {
          db.prepare("UPDATE inbox_senders SET state = 'active', error = ?, updatedAt = ? WHERE id = ? AND state = 'unsubscribe_pending'").run(text, ctx.clock().toISOString(), row.id);
          return refuse(UNSUBSCRIBE_TOOL, text);
        };
        if (row.account !== input.account || row.senderKey !== input.sender || row.fromAddress !== input.fromAddress || row.unsubscribeMethod !== input.method || row.unsubscribeUrl !== input.target) {
          return giveBack('the sender row changed after the owner was asked. The owner can ask again on the dashboard');
        }
        if (!row.unsubscribeMessageId) return giveBack('the sender row names no message with the unsubscribe link');
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
        // an https link opens in a browser task. the message must still come from the sender, offer the link, and have
        // the link signed by the domain of the sender, as for a one-click. else a forger chooses the page that the
        // browser opens for the owner.
        const failWith = (text: string) => {
          setState(row.id, 'failed', text);
          return refuse(UNSUBSCRIBE_TOOL, text);
        };
        if (parseFrom(header(message, 'From')) !== row.fromAddress) return failWith('the message with the link is not from the sender any more');
        if (!unsubscribeTargets(header(message, 'List-Unsubscribe')).includes(input.target)) return failWith('the message no longer offers the approved link');
        if (httpsLink(input.target) === null) return failWith('the approved link is not a plain https link');
        const forged = verifyUnsubscribeHeaders(message, row.fromAddress, SIGNED.https);
        if (forged !== undefined) return failWith(forged);
        // the help run settles the row when it ends: unsubscribed when it completed, active again when it did not.
        const help = startBrowserHelp(ctx, {
          account: row.account,
          url: input.target,
          task: "Unsubscribe the owner from the mailing list in the block below on its page. Do not sign in or give any data other than the owner's email address when the page asks for it.",
          facts: { list: row.senderKey },
          toolName: UNSUBSCRIBE_TOOL,
          kind: 'unsubscribe',
          rowId: row.id,
        });
        db.prepare('UPDATE inbox_senders SET helpSessionKey = ?, error = NULL, updatedAt = ? WHERE id = ?').run(help.sessionKey, now, row.id);
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
            // senderIdentityOf needs List-Unsubscribe too: a sender without a List-Id is a list sender only through it.
            const messages = await getMessages(
              apis,
              refs.map((each) => each.id),
              { format: 'metadata', headers: ['From', 'List-Id', 'List-Unsubscribe'] },
            );
            // a from: search is fuzzy, so only the mail whose sender is this row moves.
            const mine = messages
              .filter((each) => {
                const identity = each.id ? senderIdentityOf(each) : undefined;
                return identity !== undefined && belongsTo(identity, row);
              })
              .map((each) => each.id!);
            if (!mine.length) return mine;
            let labelId: string | undefined;
            if (input.label !== undefined) {
              // gmail label names do not depend on case, so "newsletters" is the label "Newsletters".
              const name = input.label.toLowerCase();
              const find = async () => {
                const { data } = await apis.gmail.users.labels.list({ userId: 'me' });
                return (data.labels ?? []).find((each) => each.name?.toLowerCase() === name)?.id ?? undefined;
              };
              labelId = await find();
              if (!labelId) {
                try {
                  const created = await apis.gmail.users.labels.create({ userId: 'me', requestBody: { name: input.label, labelListVisibility: 'labelShow', messageListVisibility: 'show' } });
                  labelId = created.data.id ?? undefined;
                } catch (err) {
                  // a label that another client made a moment ago conflicts, so the list has it now.
                  if (toGoogleError(err).status !== 409) throw err;
                  labelId = await find();
                  if (!labelId) throw err;
                }
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
const HELP_WORKS = 'a browser task works on the unsubscribe of this sender';

// the senders whose archive is being asked for in this process. the check of a pending approval and the approval
// itself are apart in time, so two archives at once would both pass the check without this claim.
const archiveClaims = new WeakMap<Db, Set<number>>();

export async function requestUnsubscribe(ctx: InboxContext, senderId: number): Promise<ActionResult> {
  // a denied or expired approval gives its row back first, so the owner can ask again.
  settleApprovals(ctx.db, ctx.clock());
  const row = senderRecord(ctx.db, senderId);
  if (!row) return notFound;
  if (row.state === 'unsubscribed') return conflict('this sender is already unsubscribed');
  if (row.state === 'unsubscribe_pending') return conflict(row.helpSessionKey ? HELP_WORKS : waitsFor(row.approvalId));
  if (row.unsubscribeMethod === 'none' || !row.unsubscribeUrl) return conflict('this sender offers no unsubscribe link');
  if (row.unsubscribeMethod === 'mailto') {
    return conflict('this sender unsubscribes by mail, and ok computer never sends mail. The link is on the page, so the owner can do it by hand');
  }
  // the compare and set claims the row, so two requests at the same time ask the owner one time.
  const now = ctx.clock().toISOString();
  const claim = ctx.db
    .prepare("UPDATE inbox_senders SET state = 'unsubscribe_pending', approvalId = NULL, helpSessionKey = NULL, updatedAt = ? WHERE id = ? AND state NOT IN ('unsubscribe_pending', 'unsubscribed')")
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
  const claims = archiveClaims.get(ctx.db) ?? new Set<number>();
  archiveClaims.set(ctx.db, claims);
  if (claims.has(senderId)) return conflict('the archive of this sender already started');
  const pending = ctx.db
    .prepare("SELECT id FROM approvals WHERE status = 'pending' AND toolName = ? AND json_extract(input, '$.senderId') = ? ORDER BY id LIMIT 1")
    .get(ARCHIVE_TOOL, senderId);
  if (pending) return conflict(`the archive of this sender waits for approval #${Number(pending.id)}`);
  if (request.label !== undefined && reservedLabel(request.label)) return conflict(`${JSON.stringify(request.label)} is a system label of gmail, so the archive cannot add it`);
  // the claim and the checks above have no await between them, so a second request sees the claim.
  claims.add(senderId);
  try {
    const result = await requestAction(ctx, {
      tool: ARCHIVE_TOOL,
      input: { senderId, account: row.account, sender: row.senderKey, olderThanDays: request.olderThanDays, ...(request.label !== undefined ? { label: request.label } : {}) },
      account: row.account,
    });
    if (!result.ok) return { ok: false, status: result.status, error: result.error };
    return { ok: true, response: result.response };
  } finally {
    claims.delete(senderId);
  }
}

export function keepSender(ctx: InboxContext, senderId: number): ActionResult {
  const row = senderRecord(ctx.db, senderId);
  if (!row) return notFound;
  if (row.state === 'unsubscribe_pending') return conflict(row.helpSessionKey ? HELP_WORKS : waitsFor(row.approvalId));
  // a keep would hide the record of the unsubscribe and stop the check that the mail stopped.
  if (row.state === 'unsubscribed') return conflict('this sender is unsubscribed, so it cannot be kept');
  ctx.db.prepare("UPDATE inbox_senders SET state = 'kept', updatedAt = ? WHERE id = ?").run(ctx.clock().toISOString(), senderId);
  return { ok: true, response: { status: 'done', approvalId: null, message: `${row.senderKey} is kept and leaves the later sweeps.` } };
}
