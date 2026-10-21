import type {
  BankStreamView,
  PlaidItemView,
  PlaidStatus,
  SubscriptionAlert,
  SubscriptionsBankSummary,
} from '../../src/dashboard/plaid-types.js';
import type { SubscriptionRow, SubscriptionsPage } from '../../src/dashboard/types.js';
import type { PlaidAccountWire, PlaidStreamWire, PlaidTransactionWire } from '../../src/plaid/client.js';
import type { FakeItem } from '../fake-plaid.js';

// the shared data of the bank track (s3): the banks of test/fake-plaid.ts, and the api answers that the pages, the
// routes and the screenshots use. test/seed-plaid.ts writes the same rows into a database. every name is made up. a
// test may depend on each value whose comment says so.

// the clock of the fixture. the brief of this day is the one with the money section.
export const PLAID_NOW = '2026-10-20T15:00:00.000Z';

// ----- the banks of the fake server -----

export const HARBOR_CHECKING: PlaidAccountWire = { account_id: 'acc-harbor-checking', name: 'Everyday Checking', official_name: 'Harbor Everyday Checking', mask: '0042', type: 'depository', subtype: 'checking' };
export const HARBOR_CARD: PlaidAccountWire = { account_id: 'acc-harbor-card', name: 'Rewards Card', official_name: null, mask: '7781', type: 'credit', subtype: 'credit card' };

const category = (primary: string, detailed: string) => ({ primary, detailed });
const SUBSCRIPTION = category('ENTERTAINMENT', 'ENTERTAINMENT_TV_AND_MOVIES');

let serial = 0;
function charge(account: PlaidAccountWire, date: string, merchant: string, amount: number, extra: Partial<PlaidTransactionWire> = {}): PlaidTransactionWire {
  serial++;
  return {
    transaction_id: `tx-${String(serial).padStart(4, '0')}`,
    account_id: account.account_id,
    amount,
    iso_currency_code: 'USD',
    unofficial_currency_code: null,
    date,
    name: merchant.toUpperCase(),
    merchant_name: merchant,
    pending: false,
    personal_finance_category: SUBSCRIPTION,
    ...extra,
  };
}

// the same day of each month from first (yyyy-mm) for count months.
function monthly(first: string, day: number, count: number): string[] {
  const [year, month] = first.split('-').map(Number) as [number, number];
  return Array.from({ length: count }, (_, i) => {
    const date = new Date(Date.UTC(year, month - 1 + i, day));
    return date.toISOString().slice(0, 10);
  });
}

// streamflix: monthly on the 14th, 13.99 until august, 15.49 from september 2026 (the price increase of the fixture).
const STREAMFLIX = monthly('2025-11', 14, 12).map((date) => charge(HARBOR_CHECKING, date, 'Streamflix', date < '2026-09-01' ? 13.99 : 15.49));
// tunely: the same plan on two accounts, 10.99 each, which is the duplicate of the fixture.
const TUNELY_CHECKING = monthly('2026-05', 3, 6).map((date) => charge(HARBOR_CHECKING, date, 'Tunely', 10.99));
const TUNELY_CARD = monthly('2026-07', 9, 4).map((date) => charge(HARBOR_CARD, date, 'Tunely', 10.99));
// daily fit gym: monthly on the 1st, 39.00, the unused service of the fixture.
const GYM = monthly('2026-01', 1, 10).map((date) => charge(HARBOR_CARD, date, 'Daily Fit Gym', 39, { personal_finance_category: category('PERSONAL_CARE', 'PERSONAL_CARE_GYMS_AND_FITNESS_CENTERS') }));
// cloudbox: yearly, 99.99 on 2025-03-02 and 2026-03-02.
const CLOUDBOX = ['2025-03-02', '2026-03-02'].map((date) => charge(HARBOR_CARD, date, 'CloudBox', 99.99, { personal_finance_category: category('GENERAL_SERVICES', 'GENERAL_SERVICES_OTHER_GENERAL_SERVICES') }));
// readly: a free trial that turned into a charge: 0.00 on 2026-09-10, then 12.99 on 2026-10-10.
const READLY = [charge(HARBOR_CARD, '2026-09-10', 'Readly', 0), charge(HARBOR_CARD, '2026-10-10', 'Readly', 12.99)];
// noise that is never a subscription: a paycheck (money in is negative), coffee, and the payment of the card.
const NOISE = [
  ...monthly('2026-06', 15, 5).map((date) => charge(HARBOR_CHECKING, date, 'Acme Payroll', -2400, { personal_finance_category: category('INCOME', 'INCOME_WAGES') })),
  ...['2026-10-02', '2026-10-05', '2026-10-11'].map((date) => charge(HARBOR_CARD, date, 'Corner Coffee', 4.75, { personal_finance_category: category('FOOD_AND_DRINK', 'FOOD_AND_DRINK_COFFEE') })),
  ...monthly('2026-06', 20, 4).map((date) => charge(HARBOR_CHECKING, date, 'Harbor Card Payment', 310, { merchant_name: null, personal_finance_category: category('LOAN_PAYMENTS', 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT') })),
];

export const HARBOR_TRANSACTIONS: PlaidTransactionWire[] = [...STREAMFLIX, ...TUNELY_CHECKING, ...TUNELY_CARD, ...GYM, ...CLOUDBOX, ...READLY, ...NOISE].sort((a, b) =>
  a.date < b.date ? -1 : a.date > b.date ? 1 : 0,
);

function stream(id: string, account: PlaidAccountWire, merchant: string, txs: PlaidTransactionWire[], frequency: string, next: string | null, status = 'MATURE'): PlaidStreamWire {
  const last = txs.at(-1)!;
  const mean = txs.reduce((sum, each) => sum + each.amount, 0) / txs.length;
  return {
    stream_id: id,
    account_id: account.account_id,
    description: merchant.toUpperCase(),
    merchant_name: merchant,
    first_date: txs[0]!.date,
    last_date: last.date,
    predicted_next_date: next,
    frequency,
    transaction_ids: txs.map((each) => each.transaction_id),
    average_amount: { amount: Math.round(mean * 100) / 100, iso_currency_code: 'USD' },
    last_amount: { amount: last.amount, iso_currency_code: 'USD' },
    is_active: true,
    status,
    personal_finance_category: last.personal_finance_category ?? null,
  };
}

// the outflow streams that /transactions/recurring/get gives for harbor. the paycheck is an inflow, so it is not here,
// and the payment of the card is a stream of plaid that the code must leave out (it is a transfer).
export const HARBOR_STREAMS: PlaidStreamWire[] = [
  stream('st-streamflix', HARBOR_CHECKING, 'Streamflix', STREAMFLIX, 'MONTHLY', '2026-11-14'),
  stream('st-tunely-checking', HARBOR_CHECKING, 'Tunely', TUNELY_CHECKING, 'MONTHLY', '2026-11-03'),
  stream('st-tunely-card', HARBOR_CARD, 'Tunely', TUNELY_CARD, 'MONTHLY', '2026-11-09'),
  stream('st-gym', HARBOR_CARD, 'Daily Fit Gym', GYM, 'MONTHLY', '2026-11-01'),
  stream('st-cloudbox', HARBOR_CARD, 'CloudBox', CLOUDBOX, 'ANNUALLY', '2027-03-02'),
  stream('st-readly', HARBOR_CARD, 'Readly', READLY, 'MONTHLY', '2026-11-10', 'EARLY_DETECTION'),
  stream('st-card-payment', HARBOR_CHECKING, 'Harbor Card Payment', NOISE.filter((each) => each.name === 'HARBOR CARD PAYMENT'), 'MONTHLY', '2026-10-20'),
];

// a fresh copy of harbor for each test, because the fake server changes its item (removed, error).
export const harborBank = (): FakeItem => ({
  itemId: 'item-harbor',
  institutionId: 'ins_harbor',
  institutionName: 'Harbor Credit Union',
  accounts: [HARBOR_CHECKING, HARBOR_CARD],
  transactions: HARBOR_TRANSACTIONS.map((each) => ({ ...each })),
  outflowStreams: HARBOR_STREAMS.map((each) => ({ ...each })),
});

// a second bank that needs a new sign-in: /item/get and /transactions/sync give ITEM_LOGIN_REQUIRED.
export const northShoreBank = (): FakeItem => ({
  itemId: 'item-northshore',
  institutionId: 'ins_northshore',
  institutionName: 'North Shore Savings',
  accounts: [{ account_id: 'acc-ns-savings', name: 'Savings', official_name: null, mask: '9910', type: 'depository', subtype: 'savings' }],
  transactions: [],
  outflowStreams: [],
  error: { error_type: 'ITEM_ERROR', error_code: 'ITEM_LOGIN_REQUIRED', error_message: 'the login details of this item have changed', display_message: null },
});

// ----- the api answers, as test/seed-plaid.ts writes them -----

// item 1 (harbor, active, two accounts, 6 streams) and item 2 (north shore, login_required).
export const ITEM_HARBOR: PlaidItemView = {
  id: 1,
  institutionId: 'ins_harbor',
  institutionName: 'Harbor Credit Union',
  status: 'active',
  errorCode: null,
  error: null,
  recurringSource: 'plaid',
  consentExpiresAt: null,
  lastSyncAt: '2026-10-20T13:30:00.000Z',
  lastSyncError: null,
  streams: 6,
  accounts: [
    { id: 1, name: 'Everyday Checking', officialName: 'Harbor Everyday Checking', mask: '0042', type: 'depository', subtype: 'checking', closed: false },
    { id: 2, name: 'Rewards Card', officialName: null, mask: '7781', type: 'credit', subtype: 'credit card', closed: false },
  ],
  createdAt: '2026-10-01T18:00:00.000Z',
};

export const ITEM_NORTHSHORE: PlaidItemView = {
  id: 2,
  institutionId: 'ins_northshore',
  institutionName: 'North Shore Savings',
  status: 'login_required',
  errorCode: 'ITEM_LOGIN_REQUIRED',
  error: 'North Shore Savings needs you to sign in again.',
  recurringSource: null,
  consentExpiresAt: null,
  lastSyncAt: '2026-10-19T13:30:00.000Z',
  lastSyncError: 'North Shore Savings needs you to sign in again.',
  streams: 0,
  accounts: [{ id: 3, name: 'Savings', officialName: null, mask: '9910', type: 'depository', subtype: 'savings', closed: false }],
  createdAt: '2026-10-05T18:00:00.000Z',
};

const SCHEDULE: PlaidStatus['schedule'] = { automationId: 'auto-plaid', time: '06:30', enabled: true, nextRunAt: '2026-10-21T13:30:00.000Z' };
const NO_SCHEDULE: PlaidStatus['schedule'] = { automationId: null, time: null, enabled: false, nextRunAt: null };

// the four states of the bank page: no credentials (first run), credentials and no bank (empty), two banks with one
// that needs reconnect (full), and a sync that failed for every bank (error).
export const STATUS_SETUP: PlaidStatus = { environment: 'production', credentials: 'none', configured: false, itemLimit: 10, items: [], syncing: false, schedule: NO_SCHEDULE, lastSync: null };
export const STATUS_EMPTY: PlaidStatus = { ...STATUS_SETUP, credentials: 'env', configured: true, schedule: SCHEDULE };
export const STATUS_FULL: PlaidStatus = {
  ...STATUS_EMPTY,
  items: [ITEM_NORTHSHORE, ITEM_HARBOR],
  lastSync: { id: 4, itemId: 1, runId: 'run-plaid-4', trigger: 'automation', startedAt: '2026-10-20T13:30:00.000Z', endedAt: '2026-10-20T13:30:04.000Z', added: 3, modified: 0, removed: 0, streams: 6, error: null },
};
export const STATUS_ERROR: PlaidStatus = {
  ...STATUS_EMPTY,
  items: [{ ...ITEM_HARBOR, status: 'error', errorCode: 'INSTITUTION_DOWN', error: 'Harbor Credit Union is not answering right now. The next sync tries again.', lastSyncError: 'Harbor Credit Union is not answering right now. The next sync tries again.' }],
  lastSync: { id: 5, itemId: 1, runId: 'run-plaid-5', trigger: 'dashboard', startedAt: '2026-10-20T14:00:00.000Z', endedAt: '2026-10-20T14:00:02.000Z', added: 0, modified: 0, removed: 0, streams: 0, error: 'Harbor Credit Union is not answering right now. The next sync tries again.' },
};

const charges = (txs: PlaidTransactionWire[]) => [...txs].reverse().map((each) => ({ date: each.date, amount: each.amount, pending: false }));

const BASE = { itemId: 1, institutionName: 'Harbor Credit Union', origin: 'plaid' as const, status: 'mature' as const, active: true, ignored: false, priceChanges: [] };
const CHECKING = { accountName: 'Everyday Checking', mask: '0042' };
const CARD = { accountName: 'Rewards Card', mask: '7781' };

// the six streams of item 1 that the sync keeps (the card payment is left out), with their ids 1 to 6.
export const STREAMS: BankStreamView[] = [
  {
    ...BASE,
    ...CHECKING,
    id: 1,
    merchant: 'Streamflix',
    merchantKey: 'streamflix',
    description: 'STREAMFLIX',
    amount: 15.49,
    averageAmount: 14.24,
    currency: 'USD',
    frequency: 'monthly',
    firstDate: '2025-11-14',
    lastDate: '2026-10-14',
    nextDate: '2026-11-14',
    category: 'ENTERTAINMENT_TV_AND_MOVIES',
    charges: charges(STREAMFLIX),
    priceChanges: [{ id: 1, fromAmount: 13.99, toAmount: 15.49, currency: 'USD', changedOn: '2026-09-14', detectedAt: '2026-09-15T13:30:00.000Z' }],
  },
  { ...BASE, ...CHECKING, id: 2, merchant: 'Tunely', merchantKey: 'tunely', description: 'TUNELY', amount: 10.99, averageAmount: 10.99, currency: 'USD', frequency: 'monthly', firstDate: '2026-05-03', lastDate: '2026-10-03', nextDate: '2026-11-03', category: 'ENTERTAINMENT_TV_AND_MOVIES', charges: charges(TUNELY_CHECKING) },
  { ...BASE, ...CARD, id: 3, merchant: 'Tunely', merchantKey: 'tunely', description: 'TUNELY', amount: 10.99, averageAmount: 10.99, currency: 'USD', frequency: 'monthly', firstDate: '2026-07-09', lastDate: '2026-10-09', nextDate: '2026-11-09', category: 'ENTERTAINMENT_TV_AND_MOVIES', charges: charges(TUNELY_CARD) },
  { ...BASE, ...CARD, id: 4, merchant: 'Daily Fit Gym', merchantKey: 'dailyfitgym', description: 'DAILY FIT GYM', amount: 39, averageAmount: 39, currency: 'USD', frequency: 'monthly', firstDate: '2026-01-01', lastDate: '2026-10-01', nextDate: '2026-11-01', category: 'PERSONAL_CARE_GYMS_AND_FITNESS_CENTERS', charges: charges(GYM) },
  { ...BASE, ...CARD, id: 5, merchant: 'CloudBox', merchantKey: 'cloudbox', description: 'CLOUDBOX', amount: 99.99, averageAmount: 99.99, currency: 'USD', frequency: 'annually', firstDate: '2025-03-02', lastDate: '2026-03-02', nextDate: '2027-03-02', category: 'GENERAL_SERVICES_OTHER_GENERAL_SERVICES', charges: charges(CLOUDBOX) },
  { ...BASE, ...CARD, id: 6, merchant: 'Readly', merchantKey: 'readly', description: 'READLY', amount: 12.99, averageAmount: 6.5, currency: 'USD', frequency: 'monthly', firstDate: '2026-09-10', lastDate: '2026-10-10', nextDate: '2026-11-10', status: 'early_detection', category: 'ENTERTAINMENT_TV_AND_MOVIES', charges: charges(READLY) },
];

// the alerts of the fixture: one of each kind, open, and one dismissed new alert. ids 1 to 6.
export const ALERTS: SubscriptionAlert[] = [
  { id: 1, kind: 'price_increase', subscriptionKey: 'receipt:1', merchant: 'Streamflix', title: 'Streamflix went up to $15.49', detail: 'It was $13.99 a month until September 14.', amount: 15.49, previousAmount: 13.99, currency: 'USD', about: '2026-09-14', createdAt: '2026-09-15T13:30:00.000Z', dismissedAt: null },
  { id: 2, kind: 'duplicate', subscriptionKey: 'bank:2', merchant: 'Tunely', title: 'Tunely is charged on two accounts', detail: '$10.99 a month on Everyday Checking ••0042 and on Rewards Card ••7781.', amount: 10.99, previousAmount: null, currency: 'USD', about: '2026-10-09', createdAt: '2026-10-09T13:30:00.000Z', dismissedAt: null },
  { id: 3, kind: 'trial_converted', subscriptionKey: 'bank:6', merchant: 'Readly', title: 'The Readly trial turned into a charge', detail: '$12.99 on October 10, after a free start on September 10.', amount: 12.99, previousAmount: 0, currency: 'USD', about: '2026-10-10', createdAt: '2026-10-11T13:30:00.000Z', dismissedAt: null },
  { id: 4, kind: 'unused', subscriptionKey: 'bank:4', merchant: 'Daily Fit Gym', title: 'Daily Fit Gym may be unused', detail: '$39.00 a month, and no mail from it besides receipts in 90 days.', amount: 39, previousAmount: null, currency: 'USD', about: '2026-10-01', createdAt: '2026-10-02T13:30:00.000Z', dismissedAt: null },
  { id: 5, kind: 'new', subscriptionKey: 'bank:6', merchant: 'Readly', title: 'New subscription: Readly', detail: '$12.99 a month on Rewards Card ••7781.', amount: 12.99, previousAmount: null, currency: 'USD', about: '2026-10-10', createdAt: '2026-10-20T13:30:00.000Z', dismissedAt: null },
  { id: 6, kind: 'new', subscriptionKey: 'bank:5', merchant: 'CloudBox', title: 'New subscription: CloudBox', detail: '$99.99 a year on Rewards Card ••7781.', amount: 99.99, previousAmount: null, currency: 'USD', about: '2026-03-02', createdAt: '2026-10-01T18:05:00.000Z', dismissedAt: '2026-10-02T09:00:00.000Z' },
];

export const OPEN_ALERTS = ALERTS.filter((each) => each.dismissedAt === null);

const bankRef = (each: BankStreamView) => ({
  streamId: each.id,
  institutionName: each.institutionName,
  accountName: each.accountName,
  mask: each.mask,
  frequency: each.frequency,
  amount: each.amount,
  currency: each.currency,
  lastDate: each.lastDate,
  nextDate: each.nextDate,
  origin: each.origin,
  ignored: each.ignored,
});

// a bank row of the merged page, in the shape that mergeSubscriptions gives: the stream id as id, no account, no
// message.
function bankRow(each: BankStreamView, cadence: SubscriptionRow['cadence'], confidence: number): SubscriptionRow {
  return {
    id: each.id,
    key: `bank:${each.id}`,
    source: 'bank',
    account: '',
    merchant: each.merchant,
    amount: each.amount,
    currency: each.currency,
    cadence,
    lastChargeAt: `${each.lastDate}T00:00:00.000Z`,
    nextChargeAt: each.nextDate ? `${each.nextDate}T00:00:00.000Z` : null,
    sourceMessageId: '',
    sourceSubject: null,
    sourceMessageIds: [],
    confidence,
    cadenceSource: 'gaps',
    reasons: ['the bank shows this charge repeating'],
    cancelUrl: null,
    state: each.ignored ? 'ignored' : 'active',
    approvalId: null,
    browserTaskId: null,
    updatedAt: '2026-10-20T13:30:00.000Z',
    bank: bankRef(each),
    alerts: OPEN_ALERTS.filter((alert) => alert.subscriptionKey === `bank:${each.id}`),
  };
}

// the merged subscriptions page: streamflix from both sources (receipt row 1 of the personal account and stream 1),
// a receipt-only row (row 2, news daily), and the bank-only rows of streams 2 to 6.
export const MERGED_SUBSCRIPTIONS: SubscriptionRow[] = [
  {
    id: 1,
    key: 'receipt:1',
    source: 'both',
    account: 'personal',
    merchant: 'Streamflix',
    amount: 15.49,
    currency: 'USD',
    cadence: 'monthly',
    lastChargeAt: '2026-10-14T00:00:00.000Z',
    nextChargeAt: '2026-11-14T00:00:00.000Z',
    sourceMessageId: 'm-streamflix-10',
    sourceSubject: 'Your Streamflix receipt',
    sourceMessageIds: ['m-streamflix-10', 'm-streamflix-09'],
    confidence: 0.95,
    cadenceSource: 'both',
    reasons: ['the receipts say monthly', 'the bank shows the same charge each month'],
    cancelUrl: 'https://streamflix.example.com/account/cancel',
    state: 'active',
    approvalId: null,
    browserTaskId: null,
    updatedAt: '2026-10-20T13:30:00.000Z',
    bank: bankRef(STREAMS[0]!),
    alerts: OPEN_ALERTS.filter((alert) => alert.subscriptionKey === 'receipt:1'),
  },
  {
    id: 2,
    key: 'receipt:2',
    source: 'receipt',
    account: 'personal',
    merchant: 'News Daily',
    amount: 4.99,
    currency: 'USD',
    cadence: 'monthly',
    lastChargeAt: '2026-10-07T00:00:00.000Z',
    nextChargeAt: '2026-11-07T00:00:00.000Z',
    sourceMessageId: 'm-news-10',
    sourceSubject: 'News Daily: payment received',
    sourceMessageIds: ['m-news-10', 'm-news-09'],
    confidence: 0.8,
    cadenceSource: 'gaps',
    reasons: ['two receipts a month apart'],
    cancelUrl: null,
    state: 'active',
    approvalId: null,
    browserTaskId: null,
    updatedAt: '2026-10-08T13:00:00.000Z',
    bank: null,
    alerts: [],
  },
  ...STREAMS.slice(1).map((each) => bankRow(each, each.frequency === 'annually' ? 'yearly' : 'monthly', each.status === 'early_detection' ? 0.6 : 0.9)),
];

export const BANK_SUMMARY: SubscriptionsBankSummary = { configured: true, items: 2, needsReconnect: 1, lastSyncAt: '2026-10-20T13:30:00.000Z', error: null };

export const MERGED_PAGE: SubscriptionsPage = {
  subscriptions: MERGED_SUBSCRIPTIONS,
  monthlyTotals: [{ currency: 'USD', amount: 102.78 }],
  lastScan: { runId: 'run-scan-3', at: '2026-10-20T12:00:00.000Z' },
  bank: BANK_SUMMARY,
  alerts: OPEN_ALERTS,
};
