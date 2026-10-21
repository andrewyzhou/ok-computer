// plaid link in the browser. the official script of plaid is loaded one time, from the address that plaid documents,
// only when the owner presses connect or reconnect, so a page that never links a bank loads nothing from outside. the
// server makes the link token (POST /api/plaid/link-token) and exchanges the public token (POST /api/plaid/exchange);
// the page only passes them on.

export const PLAID_LINK_SCRIPT = 'https://cdn.plaid.com/link/v2/stable/link-initialize.js';

// the parts of the metadata of onSuccess that the server takes.
export interface PlaidLinkSuccess {
  publicToken: string;
  institution: { id: string; name: string } | null;
}

// the end of link without a success. error is null when the owner closed the window.
export interface PlaidLinkExit {
  error: { code: string; message: string } | null;
}

export interface PlaidLinkHandle {
  open(): void;
  destroy(): void;
}

export interface PlaidLinkOptions {
  token: string;
  onSuccess(result: PlaidLinkSuccess): void;
  onExit(result: PlaidLinkExit): void;
}

// loads the script one time and opens link with the token. it rejects when the script cannot load, for example
// offline, with a sentence that the page shows.
export async function openPlaidLink(options: PlaidLinkOptions): Promise<PlaidLinkHandle> {
  void options;
  throw new Error('not built');
}
