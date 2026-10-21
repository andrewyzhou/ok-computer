import type { PlaidSyncTrigger } from '../dashboard/plaid-types.js';
import type { JobResult } from '../scheduler/scheduler.js';
import type { PlaidContext } from './context.js';
import { NOT_BUILT } from './names.js';

// the sync of the bank. for each item that is not disconnected it reads the access token from the keyring, pages
// /transactions/sync from the stored cursor until has_more is false, writes the accounts, then reads the streams
// (/transactions/recurring/get, or detectStreams over /transactions/get of plaid.daysRequested days when the plan does
// not include it), writes them with their charges and price changes, and drops every other transaction. each sync of
// an item is a row of plaid_syncs, and the whole sync is one run with the session plaid:<runId>, whose events name the
// untrusted source plaid. after the streams it calls the alerts of the merge (src/plaid/alerts.ts).

export interface SyncOptions {
  trigger: PlaidSyncTrigger;
  // one item, or every item that is not disconnected.
  itemId?: number;
}

export interface ItemSyncResult {
  itemId: number;
  added: number;
  modified: number;
  removed: number;
  streams: number;
  error: string | null;
}

// syncs one item. a plaid error that needs a new sign-in (RECONNECT_CODES of client.ts) sets the status of the item
// to login_required or pending_expiration, keeps the cursor, and tells the owner one time with a link to the bank page.
// a cursor whose pages changed during the paging (TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION) restarts from the
// cursor of the start, at most three times.
export async function syncItem(ctx: PlaidContext, itemId: number, runId: string, trigger: PlaidSyncTrigger): Promise<ItemSyncResult> {
  void ctx;
  void itemId;
  void runId;
  void trigger;
  throw new Error(NOT_BUILT);
}

// the job of the sync automation and of sync now. skipped without credentials or without an item, completed when
// every item synced, and failed when every item failed, so the scheduler backs off. one sync runs at a time.
export async function runSync(ctx: PlaidContext, options: SyncOptions): Promise<JobResult> {
  void ctx;
  void options;
  throw new Error(NOT_BUILT);
}
