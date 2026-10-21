import type { BankCharge, BankFrequency, BankPriceChange, BankStreamStatus, BankStreamView } from '../dashboard/plaid-types.js';
import type { Db } from '../db/index.js';
import { NOT_BUILT } from './names.js';

// the rows of plaid_streams, plaid_charges and plaid_price_changes (030_plaid.sql). the scaffold builds the reads,
// because the merge, the tools and the pages need them; the sync package builds the writes.

// one stream as the sync writes it, from plaid (recurring.ts streamsFromPlaid) or from the code (detectStreams).
// amounts are positive. charges are the transactions of the stream, which are the only transactions that are kept.
export interface StreamInput {
  streamId: string;
  origin: 'plaid' | 'local';
  accountRowId: number;
  merchant: string;
  merchantKey: string;
  description: string | null;
  amount: number | null;
  averageAmount: number | null;
  currency: string | null;
  frequency: BankFrequency;
  firstDate: string | null;
  lastDate: string | null;
  nextDate: string | null;
  status: BankStreamStatus;
  active: boolean;
  category: string | null;
  charges: Array<{ transactionId: string; date: string; amount: number; currency: string | null; pending: boolean }>;
}

// writes one stream of an item and its charges, and records a price change when the newest settled charge differs from
// the one before it by more than a cent (recurring.ts priceChangesOf). the owner's ignored flag is never written here.
// it gives the row id of the stream and the price changes that are new.
export function upsertStream(db: Db, itemRowId: number, stream: StreamInput, now: Date): { id: number; newPriceChanges: BankPriceChange[]; created: boolean } {
  void db;
  void itemRowId;
  void stream;
  void now;
  throw new Error(NOT_BUILT);
}

// marks the streams of an item that the newest answer no longer lists as not active, and a charge that
// /transactions/sync removed with removedAt.
export function retireStreams(db: Db, itemRowId: number, keep: readonly string[], removedTransactions: readonly string[], now: Date): number {
  void db;
  void itemRowId;
  void keep;
  void removedTransactions;
  void now;
  throw new Error(NOT_BUILT);
}

// the owner's choice on the subscriptions page. a sync never changes it. it gives false for an id that names no row.
export function setStreamIgnored(db: Db, id: number, ignored: boolean, now: Date): boolean {
  return Number(db.prepare('UPDATE plaid_streams SET ignored = ?, updatedAt = ? WHERE id = ?').run(ignored ? 1 : 0, now.toISOString(), id).changes) > 0;
}

const text = (value: unknown) => (value === null || value === undefined ? null : String(value));
const num = (value: unknown) => (value === null || value === undefined ? null : Number(value));

function chargesOf(db: Db, streamId: number): BankCharge[] {
  return db
    .prepare('SELECT date, amount, pending FROM plaid_charges WHERE streamId = ? AND removedAt IS NULL ORDER BY date DESC, id DESC')
    .all(streamId)
    .map((row) => ({ date: String(row.date), amount: Number(row.amount), pending: Number(row.pending) === 1 }));
}

function priceChangesOf(db: Db, streamId: number): BankPriceChange[] {
  return db
    .prepare('SELECT * FROM plaid_price_changes WHERE streamId = ? ORDER BY changedOn DESC, id DESC')
    .all(streamId)
    .map((row) => ({
      id: Number(row.id),
      fromAmount: Number(row.fromAmount),
      toAmount: Number(row.toAmount),
      currency: text(row.currency),
      changedOn: String(row.changedOn),
      detectedAt: String(row.detectedAt),
    }));
}

const STREAM_SELECT = `SELECT s.*, a.name AS accountName, a.mask AS mask, i.institutionName AS institutionName
  FROM plaid_streams s JOIN plaid_accounts a ON a.id = s.accountId JOIN plaid_items i ON i.id = s.itemId`;

function toStream(db: Db, row: Record<string, unknown>): BankStreamView {
  const id = Number(row.id);
  return {
    id,
    itemId: Number(row.itemId),
    institutionName: text(row.institutionName),
    accountName: String(row.accountName),
    mask: text(row.mask),
    origin: row.origin as BankStreamView['origin'],
    merchant: String(row.merchant),
    merchantKey: String(row.merchantKey),
    description: text(row.description),
    amount: num(row.amount),
    averageAmount: num(row.averageAmount),
    currency: text(row.currency),
    frequency: row.frequency as BankFrequency,
    firstDate: text(row.firstDate),
    lastDate: text(row.lastDate),
    nextDate: text(row.nextDate),
    status: row.status as BankStreamStatus,
    active: Number(row.active) === 1,
    category: text(row.category),
    ignored: Number(row.ignored) === 1,
    charges: chargesOf(db, id),
    priceChanges: priceChangesOf(db, id),
  };
}

export function getStream(db: Db, id: number): BankStreamView | undefined {
  const row = db.prepare(`${STREAM_SELECT} WHERE s.id = ?`).get(id);
  return row ? toStream(db, row) : undefined;
}

// the streams, the newest charge first. by default only the active streams of items that are not disconnected, with
// the ignored ones; all gives every stream.
export function listStreams(db: Db, options: { all?: boolean; itemId?: number } = {}): BankStreamView[] {
  const where: string[] = [];
  const params: number[] = [];
  if (!options.all) where.push("s.active = 1 AND i.status != 'disconnected'");
  if (options.itemId !== undefined) {
    where.push('s.itemId = ?');
    params.push(options.itemId);
  }
  return db
    .prepare(`${STREAM_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY s.lastDate IS NULL, s.lastDate DESC, s.id DESC`)
    .all(...params)
    .map((row) => toStream(db, row));
}
