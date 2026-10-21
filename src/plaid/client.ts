import type { PlaidEnvironment } from '../dashboard/plaid-types.js';
import { NOT_BUILT } from './names.js';

// the rest api of plaid, called with fetch. each call is a POST of json with client_id and secret in the body, as the
// api reference says (https://plaid.com/docs/api/). the official sdk would add axios and its own types for the eight
// calls below, and a fake server in the tests is simpler without it, so this module talks to the api directly.
//
// the client never logs a request body, because the body holds the secret and the access token. a failed call throws
// PlaidApiError with the error_type, the error_code and the display_message of plaid, never the request.

export interface PlaidCredentials {
  clientId: string;
  secret: string;
}

export interface PlaidClientOptions {
  environment: PlaidEnvironment;
  credentials: () => Promise<PlaidCredentials | undefined>;
  // tests point the client at test/fake-plaid.ts. the default is PLAID_HOSTS of config.ts.
  baseUrl?: string;
  fetch?: typeof fetch;
  // the time limit of one call. the default is 30 seconds.
  timeoutMs?: number;
  signal?: AbortSignal;
}

// the error of plaid, as its api gives it. status is the http status. requestId is the request_id of plaid, which its
// support asks for.
export class PlaidApiError extends Error {
  override name = 'PlaidApiError';
  constructor(
    readonly status: number,
    readonly errorType: string,
    readonly errorCode: string,
    message: string,
    readonly displayMessage: string | null = null,
    readonly requestId: string | null = null,
  ) {
    super(message);
  }
}

// the client has no credentials, so no call left the machine.
export class PlaidNotConfigured extends Error {
  override name = 'PlaidNotConfigured';
}

// the wire shapes that this app reads. plaid sends more fields, which the client ignores.

export interface LinkTokenCreateInput {
  clientUserId: string;
  clientName: string;
  countryCodes: string[];
  language: string;
  daysRequested: number;
  // update mode: the access token of the item to reconnect. products are then left out, as plaid asks.
  accessToken?: string;
  redirectUri?: string;
}

export interface LinkTokenCreateResult {
  link_token: string;
  expiration: string;
  request_id: string;
}

export interface ExchangeResult {
  access_token: string;
  item_id: string;
  request_id: string;
}

export interface PlaidItemWire {
  item_id: string;
  institution_id?: string | null;
  error?: { error_type: string; error_code: string; error_message: string; display_message?: string | null } | null;
  consent_expiration_time?: string | null;
}

export interface PlaidAccountWire {
  account_id: string;
  name: string;
  official_name?: string | null;
  mask?: string | null;
  type: string;
  subtype?: string | null;
}

export interface PlaidTransactionWire {
  transaction_id: string;
  account_id: string;
  // positive is money out of the account, as plaid gives it.
  amount: number;
  iso_currency_code?: string | null;
  unofficial_currency_code?: string | null;
  date: string;
  name?: string | null;
  merchant_name?: string | null;
  pending: boolean;
  personal_finance_category?: { primary: string; detailed: string } | null;
}

export interface TransactionsSyncResult {
  added: PlaidTransactionWire[];
  modified: PlaidTransactionWire[];
  removed: Array<{ transaction_id: string }>;
  next_cursor: string;
  has_more: boolean;
  accounts?: PlaidAccountWire[];
  request_id: string;
}

export interface PlaidStreamWire {
  stream_id: string;
  account_id: string;
  description: string;
  merchant_name?: string | null;
  first_date: string;
  last_date: string;
  predicted_next_date?: string | null;
  frequency: string;
  transaction_ids: string[];
  average_amount: { amount: number; iso_currency_code?: string | null; unofficial_currency_code?: string | null };
  last_amount: { amount: number; iso_currency_code?: string | null; unofficial_currency_code?: string | null };
  is_active: boolean;
  status: string;
  personal_finance_category?: { primary: string; detailed: string } | null;
}

export interface RecurringResult {
  inflow_streams: PlaidStreamWire[];
  outflow_streams: PlaidStreamWire[];
  request_id: string;
}

export interface TransactionsGetResult {
  transactions: PlaidTransactionWire[];
  total_transactions: number;
  accounts: PlaidAccountWire[];
  request_id: string;
}

// the calls of the app. none of them moves money: plaid has no such call in the transactions product, and this client
// has no call of another product.
export interface PlaidClient {
  linkTokenCreate(input: LinkTokenCreateInput): Promise<LinkTokenCreateResult>;
  exchangePublicToken(publicToken: string): Promise<ExchangeResult>;
  itemGet(accessToken: string): Promise<{ item: PlaidItemWire; request_id: string }>;
  institutionName(institutionId: string, countryCodes: string[]): Promise<string | null>;
  accountsGet(accessToken: string): Promise<{ accounts: PlaidAccountWire[]; request_id: string }>;
  transactionsSync(accessToken: string, cursor: string | null, count?: number): Promise<TransactionsSyncResult>;
  recurringGet(accessToken: string, accountIds?: string[]): Promise<RecurringResult>;
  // the fallback when the plan does not include recurring transactions: one page of /transactions/get.
  transactionsGet(accessToken: string, range: { startDate: string; endDate: string; offset: number; count: number }): Promise<TransactionsGetResult>;
  itemRemove(accessToken: string): Promise<void>;
}

export function createPlaidClient(options: PlaidClientOptions): PlaidClient {
  void options;
  const stub = (): never => {
    throw new Error(NOT_BUILT);
  };
  return {
    linkTokenCreate: async () => stub(),
    exchangePublicToken: async () => stub(),
    itemGet: async () => stub(),
    institutionName: async () => stub(),
    accountsGet: async () => stub(),
    transactionsSync: async () => stub(),
    recurringGet: async () => stub(),
    transactionsGet: async () => stub(),
    itemRemove: async () => stub(),
  };
}

// the error codes of plaid that mean the owner must sign in to the bank again, so the page offers reconnect.
export const RECONNECT_CODES: readonly string[] = ['ITEM_LOGIN_REQUIRED', 'PENDING_EXPIRATION', 'PENDING_DISCONNECT', 'ACCESS_NOT_GRANTED'];

// the error codes that mean the plan or the item does not include recurring transactions, so the sync finds the streams
// itself (recurring.ts).
export const NO_RECURRING_CODES: readonly string[] = ['PRODUCTS_NOT_SUPPORTED', 'INVALID_PRODUCT', 'PRODUCT_NOT_ENABLED', 'ADDITIONAL_CONSENT_REQUIRED'];
