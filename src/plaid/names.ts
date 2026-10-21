// the names of the bank track (s3 of docs/CONNECT-PLAN.md) that other modules list: the tools, the keyring refs and the
// untrusted source. src/sessions/router.ts spreads PLAID_TOOLS into MAIN_TOOLS, so this file imports nothing and makes
// no import cycle.

// the tools of the main session. each one only reads. no tool of this track can move money, start a payment, a
// transfer or a purchase, or remove a bank.
export const PLAID_TOOLS: readonly string[] = ['bank_accounts', 'bank_subscriptions'];

// the untrusted source of every text that comes from the bank: merchant names, descriptions and institution names.
export const PLAID_SOURCE = 'plaid';

// the keyring refs. the client id and the secret that the owner enters on the dashboard, and the access token of each
// item. a secret of sandbox does not work on production, so the secret has a ref of each environment.
export const PLAID_CLIENT_ID_REF = 'plaid:client_id';
export const plaidSecretRef = (environment: 'sandbox' | 'production') => `plaid:secret:${environment}`;
export const plaidTokenRef = (itemId: string) => `plaid:item:${itemId}:access_token`;

// the automation of the daily sync, with the payload { type: 'plaid', job: 'sync' }.
export const PLAID_AUTOMATION_NAME = 'bank: daily sync';

// the error text of a stub that a work package has not built yet.
export const NOT_BUILT = 'not built';
