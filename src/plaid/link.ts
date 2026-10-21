import type { PlaidExchangeRequest, PlaidItemView, PlaidLinkTokenRequest, PlaidLinkTokenResponse } from '../dashboard/plaid-types.js';
import type { PlaidContext } from './context.js';
import { NOT_BUILT } from './names.js';

// plaid link in the dashboard. the server makes the link token, exchanges the public token that the onSuccess of link
// gives, and keeps the access token in the keyring under plaidTokenRef. the browser never sees an access token.
// update mode (reconnect) makes a link token with the access token of the item, and its onSuccess needs no exchange.

// the answer of every call here. status is the http status of the route: 400 for a bad request, 404 for an item that
// does not exist, 409 for an item that is disconnected or a limit that is reached, 502 when plaid refused, and 503
// without credentials or when the keyring failed. error is one sentence that the page shows, never a secret.
export type PlaidResult<T> = { ok: true; value: T } | { ok: false; status: 400 | 404 | 409 | 502 | 503; error: string };

// a link token to link a new bank (no itemId) or to reconnect one (itemId, update mode). a new link at plaid.itemLimit
// items gives 409.
export async function createLinkToken(ctx: PlaidContext, request: PlaidLinkTokenRequest): Promise<PlaidResult<PlaidLinkTokenResponse>> {
  void ctx;
  void request;
  throw new Error(NOT_BUILT);
}

// exchanges the public token, writes the token to the keyring before the item row, reads the item, the institution
// name and the accounts, and starts the first sync without waiting for it (trigger link). a token that the keyring
// could not keep is removed at plaid again (/item/remove), so no item lives without its token.
export async function exchangePublicToken(ctx: PlaidContext, request: PlaidExchangeRequest, startSync: (itemId: number) => void): Promise<PlaidResult<PlaidItemView>> {
  void ctx;
  void request;
  void startSync;
  throw new Error(NOT_BUILT);
}

// the end of update mode: link said onSuccess for an item. the item is read again (/item/get), its status becomes
// active when plaid shows no error, and a sync starts.
export async function finishUpdate(ctx: PlaidContext, itemId: number, startSync: (itemId: number) => void): Promise<PlaidResult<PlaidItemView>> {
  void ctx;
  void itemId;
  void startSync;
  throw new Error(NOT_BUILT);
}

// the owner removes a bank on the dashboard: /item/remove at plaid, then the delete of the token in the keyring, then
// the status disconnected. the streams and charges stay for the history. an item that plaid already forgot
// (ITEM_NOT_FOUND) still loses its token. no tool calls this.
export async function disconnectItem(ctx: PlaidContext, itemId: number): Promise<PlaidResult<PlaidItemView>> {
  void ctx;
  void itemId;
  throw new Error(NOT_BUILT);
}
