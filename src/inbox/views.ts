import type {
  CalendarProposalView,
  DigestItem,
  DigestsPage,
  DraftView,
  InboxDigest,
  InboxListQuery,
  NewsletterSenderRow,
  SendersPage,
  SendersQuery,
  SubscriptionRow,
  SubscriptionsPage,
  SubscriptionState,
} from '../dashboard/types.js';
import type { Db } from '../db/index.js';
import { browserTaskOf } from './actions.js';
import { monthlyTotals } from './cadence.js';
import { lastJobRun } from './run.js';

// the reads of the inbox pages. each function maps the rows of 019_inbox.sql to the shapes of src/dashboard/types.ts.
// the route checks the queries, so these functions get valid values. only a cursor can still be wrong, because the
// page sends it back as it got it, and a wrong one throws InvalidCursor.

type Row = Record<string, unknown>;
const text = (value: unknown) => (value === null || value === undefined ? null : String(value));
const num = (value: unknown) => (value === null || value === undefined ? null : Number(value));

// the error of a cursor that this module did not make. the route answers 400 with its text.
export class InvalidCursor extends Error {
  constructor() {
    super('the cursor is not valid');
  }
}

// a sender cursor holds the sort value of the last row and its id, so the next page starts right after that row, also
// when rows were added since. v is a number, an iso string, or null for a read rate of a sender with no messages.
export interface SenderCursor {
  v: number | string | null;
  id: number;
}

export function encodeCursor(cursor: SenderCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url');
}

export function decodeCursor(cursor: string): SenderCursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new InvalidCursor();
  }
  if (typeof parsed !== 'object' || parsed === null) throw new InvalidCursor();
  const { v, id } = parsed as Record<string, unknown>;
  if (!Number.isSafeInteger(id) || (id as number) < 1) throw new InvalidCursor();
  if (v !== null && typeof v !== 'string' && !(typeof v === 'number' && Number.isFinite(v))) throw new InvalidCursor();
  return { v, id: id as number };
}

// each sort gives the sql value of a row, the order, and the condition of the rows after a cursor. the read rate of a
// sender with no messages is null, and those rows come last.
const RATE = 'CASE WHEN messages = 0 THEN NULL ELSE read * 1.0 / messages END';
const SORTS = {
  messages: {
    value: 'messages',
    order: 'messages DESC, id DESC',
    after: (v: SenderCursor['v']) => (typeof v === 'number' ? { sql: '(messages < ? OR (messages = ? AND id < ?))', params: [v, v] } : undefined),
  },
  readRate: {
    value: RATE,
    order: `(${RATE}) IS NULL, (${RATE}) ASC, id DESC`,
    after: (v: SenderCursor['v']) => {
      if (v === null) return { sql: `((${RATE}) IS NULL AND id < ?)`, params: [] };
      if (typeof v !== 'number') return undefined;
      return { sql: `((${RATE}) > ? OR ((${RATE}) = ? AND id < ?) OR (${RATE}) IS NULL)`, params: [v, v] };
    },
  },
  lastAt: {
    value: 'lastAt',
    order: 'lastAt DESC, id DESC',
    after: (v: SenderCursor['v']) => (typeof v === 'string' ? { sql: '(lastAt < ? OR (lastAt = ? AND id < ?))', params: [v, v] } : undefined),
  },
} as const;

function toSender(row: Row): NewsletterSenderRow {
  const messages = Number(row.messages);
  const read = Number(row.read);
  return {
    id: Number(row.id),
    account: String(row.account),
    senderKey: String(row.senderKey),
    listId: text(row.listId),
    fromAddress: String(row.fromAddress),
    displayName: text(row.displayName),
    messages,
    read,
    readRate: messages ? read / messages : null,
    firstAt: String(row.firstAt),
    lastAt: String(row.lastAt),
    unsubscribe: { method: row.unsubscribeMethod as NewsletterSenderRow['unsubscribe']['method'], url: text(row.unsubscribeUrl) },
    state: row.state as NewsletterSenderRow['state'],
    approvalId: num(row.approvalId),
    unsubscribedAt: text(row.unsubscribedAt),
    archived: Number(row.archived),
    label: text(row.label),
    error: text(row.error),
  };
}

export function listSenders(db: Db, query: SendersQuery & { limit: number }, accounts: string[]): SendersPage {
  const sort = SORTS[query.sort ?? 'messages'];
  const where: string[] = [];
  const params: Array<string | number | null> = [];
  if (query.account) {
    where.push('account = ?');
    params.push(query.account);
  }
  if (query.state) {
    where.push('state = ?');
    params.push(query.state);
  }
  if (query.cursor !== undefined) {
    const cursor = decodeCursor(query.cursor);
    const after = sort.after(cursor.v);
    // a cursor of another sort has a value of the wrong kind.
    if (!after) throw new InvalidCursor();
    where.push(after.sql);
    params.push(...after.params, cursor.id);
  }
  const rows = db
    .prepare(`SELECT *, ${sort.value} AS sortValue FROM inbox_senders ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY ${sort.order} LIMIT ?`)
    .all(...params, query.limit + 1);
  const page = rows.slice(0, query.limit);
  const last = page.at(-1);
  const nextCursor = rows.length > query.limit && last ? encodeCursor({ v: (last.sortValue ?? null) as SenderCursor['v'], id: Number(last.id) }) : null;
  return { accounts, senders: page.map(toSender), nextCursor, lastSweep: lastJobRun(db, 'newsletters') };
}

function toSubscription(db: Db, row: Row): SubscriptionRow {
  const helpSessionKey = text(row.helpSessionKey);
  return {
    id: Number(row.id),
    account: String(row.account),
    merchant: String(row.merchant),
    amount: num(row.amount),
    currency: text(row.currency),
    cadence: row.cadence as SubscriptionRow['cadence'],
    lastChargeAt: text(row.lastChargeAt),
    nextChargeAt: text(row.nextChargeAt),
    sourceMessageId: String(row.sourceMessageId),
    sourceSubject: text(row.sourceSubject),
    sourceMessageIds: JSON.parse(String(row.sourceMessageIds)) as string[],
    confidence: Number(row.confidence),
    cancelUrl: text(row.cancelUrl),
    state: row.state as SubscriptionState,
    approvalId: num(row.approvalId),
    // the help run opens its browser task after the approval, so a row without the task id looks it up in that run.
    browserTaskId: text(row.browserTaskId) ?? (helpSessionKey ? browserTaskOf(db, helpSessionKey) : null),
    updatedAt: String(row.updatedAt),
  };
}

export function listSubscriptions(db: Db, query: { account?: string; state?: SubscriptionState }): SubscriptionsPage {
  const where: string[] = [];
  const params: string[] = [];
  if (query.account) {
    where.push('account = ?');
    params.push(query.account);
  }
  if (query.state) {
    where.push('state = ?');
    params.push(query.state);
  }
  const subscriptions = db
    .prepare(`SELECT * FROM inbox_subscriptions ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY lastChargeAt IS NULL, lastChargeAt DESC, id DESC`)
    .all(...params)
    .map((row) => toSubscription(db, row));
  // a cancelled or ignored subscription costs nothing more, so the totals leave it out.
  const paying = subscriptions.filter((each) => each.state === 'active' || each.state === 'cancel_pending');
  return { subscriptions, monthlyTotals: monthlyTotals(paying), lastScan: lastJobRun(db, 'subscriptions') };
}

// a digest cursor is the id of the last digest of the page.
function digestCursor(cursor: string): number {
  const id = Buffer.from(cursor, 'base64url').toString('utf8');
  if (!/^[1-9]\d{0,15}$/.test(id)) throw new InvalidCursor();
  return Number(id);
}

export function listDigests(db: Db, query: { cursor?: string; limit: number }): DigestsPage {
  const before = query.cursor === undefined ? undefined : digestCursor(query.cursor);
  const rows = db
    .prepare(
      `SELECT id, day, runId, createdAt, json_array_length(items) AS items FROM inbox_digests ${before === undefined ? '' : 'WHERE id < ?'} ORDER BY id DESC LIMIT ?`,
    )
    .all(...(before === undefined ? [] : [before]), query.limit + 1);
  const page = rows.slice(0, query.limit);
  const last = page.at(-1);
  return {
    digests: page.map((row) => ({ id: Number(row.id), day: String(row.day), runId: text(row.runId), createdAt: String(row.createdAt), items: Number(row.items) })),
    nextCursor: rows.length > query.limit && last ? Buffer.from(String(last.id)).toString('base64url') : null,
  };
}

export function getDigest(db: Db, id: number | 'latest'): InboxDigest | undefined {
  const row = id === 'latest' ? db.prepare('SELECT * FROM inbox_digests ORDER BY id DESC LIMIT 1').get() : db.prepare('SELECT * FROM inbox_digests WHERE id = ?').get(id);
  if (!row) return undefined;
  return {
    id: Number(row.id),
    day: String(row.day),
    runId: text(row.runId),
    createdAt: String(row.createdAt),
    accounts: JSON.parse(String(row.accounts)) as string[],
    shortText: String(row.shortText),
    items: JSON.parse(String(row.items)) as DigestItem[],
  };
}

// the drafts and the proposals page by id: the rows before the given id, newest first.
function beforePage(db: Db, table: 'inbox_drafts' | 'inbox_proposals', query: InboxListQuery & { limit: number }): Row[] {
  const where: string[] = [];
  const params: Array<string | number> = [];
  if (query.account) {
    where.push('account = ?');
    params.push(query.account);
  }
  if (query.state) {
    where.push('state = ?');
    params.push(query.state);
  }
  if (query.before !== undefined) {
    where.push('id < ?');
    params.push(query.before);
  }
  return db.prepare(`SELECT * FROM ${table} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`).all(...params, query.limit);
}

export function listDrafts(db: Db, query: InboxListQuery & { limit: number }): DraftView[] {
  return beforePage(db, 'inbox_drafts', query).map((row) => ({
    id: Number(row.id),
    account: String(row.account),
    gmailDraftId: String(row.gmailDraftId),
    threadId: String(row.threadId),
    inReplyTo: text(row.inReplyTo),
    to: JSON.parse(String(row.toAddresses)) as string[],
    subject: String(row.subject),
    body: String(row.body),
    state: row.state as DraftView['state'],
    runId: text(row.runId),
    toolCallId: text(row.toolCallId),
    createdAt: String(row.createdAt),
  }));
}

export function listProposals(db: Db, query: InboxListQuery & { limit: number }): CalendarProposalView[] {
  return beforePage(db, 'inbox_proposals', query).map((row) => ({
    id: Number(row.id),
    account: String(row.account),
    calendarId: String(row.calendarId),
    kind: row.kind as CalendarProposalView['kind'],
    title: String(row.title),
    startAt: String(row.startAt),
    endAt: text(row.endAt),
    allDay: Number(row.allDay) === 1,
    description: text(row.description),
    sourceMessageId: text(row.sourceMessageId),
    sourceSubject: text(row.sourceSubject),
    state: row.state as CalendarProposalView['state'],
    approvalId: num(row.approvalId),
    eventId: text(row.eventId),
    error: text(row.error),
    runId: text(row.runId),
    createdAt: String(row.createdAt),
    resolvedAt: text(row.resolvedAt),
  }));
}
