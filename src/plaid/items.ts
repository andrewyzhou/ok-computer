import type { PlaidAccountView, PlaidItemStatus, PlaidItemView } from '../dashboard/plaid-types.js';
import type { Db } from '../db/index.js';
import type { PlaidAccountWire } from './client.js';

// the rows of plaid_items and plaid_accounts (030_plaid.sql). the access token is never here: tokenRef names its entry
// in the keyring. every write sets updatedAt. the scaffold builds this file, because the link flow, the sync and the
// pages all read and write it.

export interface ItemRow {
  id: number;
  itemId: string;
  environment: 'sandbox' | 'production';
  institutionId: string | null;
  institutionName: string | null;
  tokenRef: string;
  status: PlaidItemStatus;
  errorCode: string | null;
  error: string | null;
  cursor: string | null;
  recurringSource: 'plaid' | 'local' | null;
  consentExpiresAt: string | null;
  lastSyncAt: string | null;
  lastSyncError: string | null;
  createdAt: string;
  updatedAt: string;
  disconnectedAt: string | null;
}

export interface NewItem {
  itemId: string;
  environment: 'sandbox' | 'production';
  institutionId: string | null;
  institutionName: string | null;
  tokenRef: string;
}

const text = (value: unknown) => (value === null || value === undefined ? null : String(value));

function toItem(row: Record<string, unknown>): ItemRow {
  return {
    id: Number(row.id),
    itemId: String(row.itemId),
    environment: row.environment as ItemRow['environment'],
    institutionId: text(row.institutionId),
    institutionName: text(row.institutionName),
    tokenRef: String(row.tokenRef),
    status: row.status as PlaidItemStatus,
    errorCode: text(row.errorCode),
    error: text(row.error),
    cursor: text(row.cursor),
    recurringSource: text(row.recurringSource) as ItemRow['recurringSource'],
    consentExpiresAt: text(row.consentExpiresAt),
    lastSyncAt: text(row.lastSyncAt),
    lastSyncError: text(row.lastSyncError),
    createdAt: String(row.createdAt),
    updatedAt: String(row.updatedAt),
    disconnectedAt: text(row.disconnectedAt),
  };
}

// a second link of the same bank login gives the same item id. the row then becomes active again with the new
// institution name and token ref, and keeps its cursor and streams.
export function insertItem(db: Db, item: NewItem, now: Date): ItemRow {
  const at = now.toISOString();
  db.prepare(
    `INSERT INTO plaid_items (itemId, environment, institutionId, institutionName, tokenRef, status, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, ?, 'active', ?, ?)
     ON CONFLICT (itemId) DO UPDATE SET environment = excluded.environment, institutionId = excluded.institutionId,
       institutionName = COALESCE(excluded.institutionName, plaid_items.institutionName), tokenRef = excluded.tokenRef, status = 'active',
       errorCode = NULL, error = NULL, disconnectedAt = NULL, updatedAt = excluded.updatedAt`,
  ).run(item.itemId, item.environment, item.institutionId, item.institutionName, item.tokenRef, at, at);
  return toItem(db.prepare('SELECT * FROM plaid_items WHERE itemId = ?').get(item.itemId) as Record<string, unknown>);
}

export function getItem(db: Db, id: number): ItemRow | undefined {
  const row = db.prepare('SELECT * FROM plaid_items WHERE id = ?').get(id);
  return row ? toItem(row) : undefined;
}

// every item, the newest first. includeDisconnected is false by default.
export function listItems(db: Db, options: { includeDisconnected?: boolean } = {}): ItemRow[] {
  const where = options.includeDisconnected ? '' : "WHERE status != 'disconnected'";
  return db.prepare(`SELECT * FROM plaid_items ${where} ORDER BY id DESC`).all().map(toItem);
}

// the items that count against plaid.itemLimit: every item that is not disconnected.
export function countedItems(db: Db): number {
  return Number((db.prepare("SELECT COUNT(*) AS count FROM plaid_items WHERE status != 'disconnected'").get() as { count: number }).count);
}

export interface ItemPatch {
  status?: PlaidItemStatus;
  errorCode?: string | null;
  error?: string | null;
  cursor?: string | null;
  recurringSource?: 'plaid' | 'local' | null;
  consentExpiresAt?: string | null;
  lastSyncAt?: string | null;
  lastSyncError?: string | null;
  disconnectedAt?: string | null;
}

const PATCH_COLUMNS = ['status', 'errorCode', 'error', 'cursor', 'recurringSource', 'consentExpiresAt', 'lastSyncAt', 'lastSyncError', 'disconnectedAt'] as const;

// it throws for an id that names no row, because every caller read the row first.
export function updateItem(db: Db, id: number, patch: ItemPatch, now: Date): ItemRow {
  const columns = PATCH_COLUMNS.filter((column) => patch[column] !== undefined);
  const values = columns.map((column) => patch[column] ?? null);
  db.prepare(`UPDATE plaid_items SET ${[...columns.map((column) => `${column} = ?`), 'updatedAt = ?'].join(', ')} WHERE id = ?`).run(...values, now.toISOString(), id);
  const row = getItem(db, id);
  if (!row) throw new Error(`the plaid item ${id} does not exist`);
  return row;
}

// writes the accounts that plaid lists for an item. an account that plaid no longer lists gets closedAt, and keeps
// its row, so its streams still name it. it gives the row id of each account id that plaid listed.
export function upsertAccounts(db: Db, itemRowId: number, accounts: readonly PlaidAccountWire[], now: Date): Map<string, number> {
  const at = now.toISOString();
  const upsert = db.prepare(
    `INSERT INTO plaid_accounts (itemId, accountId, name, officialName, mask, type, subtype, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (accountId) DO UPDATE SET name = excluded.name, officialName = excluded.officialName, mask = excluded.mask,
       type = excluded.type, subtype = excluded.subtype, updatedAt = excluded.updatedAt, closedAt = NULL`,
  );
  const ids = new Map<string, number>();
  for (const account of accounts) {
    upsert.run(itemRowId, account.account_id, account.name, account.official_name ?? null, account.mask ?? null, account.type, account.subtype ?? null, at);
    const row = db.prepare('SELECT id FROM plaid_accounts WHERE accountId = ?').get(account.account_id) as { id: number };
    ids.set(account.account_id, Number(row.id));
  }
  db.prepare('UPDATE plaid_accounts SET closedAt = ?, updatedAt = ? WHERE itemId = ? AND closedAt IS NULL AND accountId NOT IN (SELECT value FROM json_each(?))').run(
    at,
    at,
    itemRowId,
    JSON.stringify(accounts.map((each) => each.account_id)),
  );
  return ids;
}

// the row id of each account id of an item, also of a closed account.
export function accountIdsOf(db: Db, itemRowId: number): Map<string, number> {
  const rows = db.prepare('SELECT id, accountId FROM plaid_accounts WHERE itemId = ?').all(itemRowId) as Array<{ id: number; accountId: string }>;
  return new Map(rows.map((row) => [String(row.accountId), Number(row.id)]));
}

export function accountsOf(db: Db, itemRowId: number): PlaidAccountView[] {
  return db
    .prepare('SELECT * FROM plaid_accounts WHERE itemId = ? ORDER BY closedAt IS NOT NULL, name, id')
    .all(itemRowId)
    .map((row) => ({
      id: Number(row.id),
      name: String(row.name),
      officialName: text(row.officialName),
      mask: text(row.mask),
      type: String(row.type),
      subtype: text(row.subtype),
      closed: row.closedAt !== null,
    }));
}

// the item as the page shows it, with its accounts and its count of active streams that are not ignored. the token
// ref and the cursor stay on the server.
export function itemView(db: Db, row: ItemRow): PlaidItemView {
  const streams = Number(
    (db.prepare('SELECT COUNT(*) AS count FROM plaid_streams WHERE itemId = ? AND active = 1 AND ignored = 0').get(row.id) as { count: number }).count,
  );
  return {
    id: row.id,
    institutionId: row.institutionId,
    institutionName: row.institutionName,
    status: row.status,
    errorCode: row.errorCode,
    error: row.error,
    recurringSource: row.recurringSource,
    consentExpiresAt: row.consentExpiresAt,
    lastSyncAt: row.lastSyncAt,
    lastSyncError: row.lastSyncError,
    streams,
    accounts: accountsOf(db, row.id),
    createdAt: row.createdAt,
  };
}
