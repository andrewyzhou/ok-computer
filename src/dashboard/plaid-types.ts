// the shapes of the bank api of track s3 (docs/CONNECT-PLAN.md): the bank through plaid, read-only, for subscriptions.
// the web pages, src/plaid and the subscription merge import this file, so it holds types only and imports nothing.
// docs/API.md (s3) gives the routes and the errors. no shape here ever holds a client secret, an access token or a
// public token.

// the plaid host that the app talks to. a free trial plan (10 items) works on production with real banks; sandbox has
// test banks only. the value comes from plaid.environment in the config.
export type PlaidEnvironment = 'sandbox' | 'production';

// where the client id and the secret come from. keyring is a pair that the owner entered on the dashboard, and it wins
// over env (PLAID_CLIENT_ID and PLAID_SECRET in .env). none means the bank cannot be linked yet.
export type PlaidCredentialSource = 'keyring' | 'env' | 'none';

// active works. login_required needs reconnect (link in update mode). pending_expiration works, but the consent ends
// at consentExpiresAt, so the page offers reconnect. error is another plaid error. disconnected is an item that the
// owner removed: plaid forgot it and the token is deleted.
export type PlaidItemStatus = 'active' | 'login_required' | 'pending_expiration' | 'error' | 'disconnected';

export interface PlaidAccountView {
  id: number;
  name: string;
  officialName: string | null;
  // the last digits of the account number, as the bank gives them.
  mask: string | null;
  type: string;
  subtype: string | null;
  closed: boolean;
}

export interface PlaidItemView {
  id: number;
  institutionId: string | null;
  institutionName: string | null;
  status: PlaidItemStatus;
  // the error_code of plaid, for example ITEM_LOGIN_REQUIRED, and one sentence that the page shows.
  errorCode: string | null;
  error: string | null;
  // plaid when /transactions/recurring/get answered, local when the plan does not include it and the code found the
  // streams in the transactions, null before the first sync.
  recurringSource: 'plaid' | 'local' | null;
  consentExpiresAt: string | null;
  lastSyncAt: string | null;
  lastSyncError: string | null;
  // the active streams of the item that the owner did not ignore.
  streams: number;
  accounts: PlaidAccountView[];
  createdAt: string;
}

export type PlaidSyncTrigger = 'automation' | 'dashboard' | 'link';

export interface PlaidSyncView {
  id: number;
  itemId: number | null;
  runId: string | null;
  trigger: PlaidSyncTrigger;
  startedAt: string;
  endedAt: string | null;
  added: number;
  modified: number;
  removed: number;
  streams: number;
  error: string | null;
}

// GET /api/plaid/status. configured is false without credentials: the page then shows the setup steps.
export interface PlaidStatus {
  environment: PlaidEnvironment;
  credentials: PlaidCredentialSource;
  configured: boolean;
  // the most items that the plan allows (plaid.itemLimit in the config), counted without the disconnected ones.
  itemLimit: number;
  items: PlaidItemView[];
  syncing: boolean;
  schedule: { automationId: string | null; time: string | null; enabled: boolean; nextRunAt: string | null };
  lastSync: PlaidSyncView | null;
}

// POST /api/plaid/link-token. without itemId it makes a token to link a new bank; with itemId it makes a token of
// update mode for that item (reconnect). the link token is meant for the browser and is short-lived.
export interface PlaidLinkTokenRequest {
  itemId?: number;
}

export interface PlaidLinkTokenResponse {
  linkToken: string;
  expiration: string;
  mode: 'create' | 'update';
  itemId: number | null;
}

// POST /api/plaid/exchange: what the onSuccess of plaid link gave. the server exchanges the public token, keeps the
// access token in the keyring, reads the item and its accounts, and starts the first sync.
export interface PlaidExchangeRequest {
  publicToken: string;
  institution?: { id: string; name: string } | null;
}

// PUT /api/plaid/credentials. both values are one word. the answer never holds them.
export interface PlaidCredentialsRequest {
  clientId: string;
  secret: string;
}

export interface PlaidCredentialsResponse {
  credentials: PlaidCredentialSource;
}

// POST /api/plaid/sync. without itemId it syncs every item that is not disconnected.
export interface PlaidSyncRequest {
  itemId?: number;
}

// the frequency of a stream: the frequency of plaid in lower case.
export type BankFrequency = 'weekly' | 'biweekly' | 'semi_monthly' | 'monthly' | 'quarterly' | 'semi_annually' | 'annually' | 'unknown';

export type BankStreamStatus = 'mature' | 'early_detection' | 'tombstoned' | 'unknown';

// one charge of a stream, newest first. amount is positive.
export interface BankCharge {
  date: string;
  amount: number;
  pending: boolean;
}

export interface BankPriceChange {
  id: number;
  fromAmount: number;
  toAmount: number;
  currency: string | null;
  changedOn: string;
  detectedAt: string;
}

// one recurring outflow of a bank account. the merchant and the description are bank text, which is untrusted, so the
// page shows them as text.
export interface BankStreamView {
  id: number;
  itemId: number;
  institutionName: string | null;
  accountName: string;
  mask: string | null;
  origin: 'plaid' | 'local';
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
  ignored: boolean;
  charges: BankCharge[];
  priceChanges: BankPriceChange[];
}

// GET /api/plaid/streams.
export interface BankStreamsPage {
  streams: BankStreamView[];
}

// where a merged subscription row comes from: the receipts in the mail, the bank, or both.
export type SubscriptionSource = 'receipt' | 'bank' | 'both';

// the bank side of a merged subscription row.
export interface SubscriptionBankRef {
  streamId: number;
  institutionName: string | null;
  accountName: string;
  mask: string | null;
  frequency: BankFrequency;
  amount: number | null;
  currency: string | null;
  lastDate: string | null;
  nextDate: string | null;
  origin: 'plaid' | 'local';
  ignored: boolean;
}

export type SubscriptionAlertKind = 'new' | 'price_increase' | 'trial_converted' | 'duplicate' | 'unused';

// one alert of the subscriptions page and of the money section of the brief. about is the date that it is about (a
// charge, a price change), yyyy-mm-dd. title and detail can hold merchant names from mail or the bank, so they are
// untrusted text.
export interface SubscriptionAlert {
  id: number;
  kind: SubscriptionAlertKind;
  subscriptionKey: string;
  merchant: string;
  title: string;
  detail: string | null;
  amount: number | null;
  previousAmount: number | null;
  currency: string | null;
  about: string;
  createdAt: string;
  dismissedAt: string | null;
}

// GET /api/plaid/alerts. open alerts only, unless the query asks for all.
export interface SubscriptionAlertsPage {
  alerts: SubscriptionAlert[];
}

// the bank part of the subscriptions page: whether a bank is linked, and its last sync.
export interface SubscriptionsBankSummary {
  configured: boolean;
  items: number;
  needsReconnect: number;
  lastSyncAt: string | null;
  error: string | null;
}
