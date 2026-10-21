-- the bank through plaid (track s3 of docs/CONNECT-PLAN.md), read-only, for subscriptions. the access token of an item
-- lives in the keyring under tokenRef and never in this database. single transactions are read during a sync and then
-- dropped, except the charges of a recurring stream, which are its price history.

-- one bank login that the owner linked with plaid link. itemId is the id that plaid gives. tokenRef is the keyring ref
-- of the access token (plaidTokenRef of src/plaid/names.ts), and it stays after a disconnect, so the trace can name it.
-- status is active, login_required (the bank wants a new sign-in, so the page offers reconnect), pending_expiration
-- (the consent ends soon), error (another plaid error, in error), or disconnected (the owner removed it; the token is
-- deleted). cursor is the next_cursor of /transactions/sync. recurringSource is plaid when /transactions/recurring/get
-- answered, local when the plan does not include it and the code found the streams itself, and null before the first
-- sync. a disconnected item keeps its row, its accounts and its streams, so old alerts still name them.
CREATE TABLE plaid_items (
  id INTEGER PRIMARY KEY,
  itemId TEXT NOT NULL UNIQUE,
  environment TEXT NOT NULL CHECK (environment IN ('sandbox', 'production')),
  institutionId TEXT,
  institutionName TEXT,
  tokenRef TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'login_required', 'pending_expiration', 'error', 'disconnected')),
  errorCode TEXT,
  error TEXT,
  cursor TEXT,
  recurringSource TEXT CHECK (recurringSource IN ('plaid', 'local')),
  consentExpiresAt TEXT,
  lastSyncAt TEXT,
  lastSyncError TEXT,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  disconnectedAt TEXT
);

-- the accounts of an item: the name, the last four digits (mask), the type and the subtype. no balance is kept.
-- closedAt is set when a sync no longer lists the account.
CREATE TABLE plaid_accounts (
  id INTEGER PRIMARY KEY,
  itemId INTEGER NOT NULL REFERENCES plaid_items (id),
  accountId TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  officialName TEXT,
  mask TEXT,
  type TEXT NOT NULL,
  subtype TEXT,
  updatedAt TEXT NOT NULL,
  closedAt TEXT
);
CREATE INDEX plaid_accounts_item ON plaid_accounts (itemId);

-- one recurring outflow of an account. streamId is the stream_id of plaid for origin plaid, and
-- local:<accountId>:<merchantKey> for a stream that the code found (origin local). merchantKey is merchantKeyOf of
-- src/inbox/cadence.ts, so a stream and a receipt row of one merchant share it. amount is the last charge and
-- averageAmount the mean, both positive, in currency. frequency is the frequency of plaid in lower case. status is the
-- status of plaid in lower case (mature, early_detection, tombstoned) or unknown. ignored is the owner's choice on the
-- subscriptions page, which a sync never changes.
CREATE TABLE plaid_streams (
  id INTEGER PRIMARY KEY,
  itemId INTEGER NOT NULL REFERENCES plaid_items (id),
  accountId INTEGER NOT NULL REFERENCES plaid_accounts (id),
  streamId TEXT NOT NULL UNIQUE,
  origin TEXT NOT NULL CHECK (origin IN ('plaid', 'local')),
  merchant TEXT NOT NULL,
  merchantKey TEXT NOT NULL,
  description TEXT,
  amount REAL,
  averageAmount REAL,
  currency TEXT,
  frequency TEXT NOT NULL DEFAULT 'unknown'
    CHECK (frequency IN ('weekly', 'biweekly', 'semi_monthly', 'monthly', 'quarterly', 'semi_annually', 'annually', 'unknown')),
  firstDate TEXT,
  lastDate TEXT,
  nextDate TEXT,
  status TEXT NOT NULL DEFAULT 'unknown' CHECK (status IN ('mature', 'early_detection', 'tombstoned', 'unknown')),
  active INTEGER NOT NULL DEFAULT 1,
  category TEXT,
  ignored INTEGER NOT NULL DEFAULT 0,
  firstSeenAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);
CREATE INDEX plaid_streams_merchant ON plaid_streams (merchantKey);

-- the charges of a stream, which are its price history: the only transactions that are kept. date is yyyy-mm-dd as
-- the bank gives it, amount is positive. a transaction that a later sync removes keeps its row with removedAt, so the
-- history of an alert stays readable.
CREATE TABLE plaid_charges (
  id INTEGER PRIMARY KEY,
  streamId INTEGER NOT NULL REFERENCES plaid_streams (id),
  transactionId TEXT NOT NULL UNIQUE,
  date TEXT NOT NULL,
  amount REAL NOT NULL,
  currency TEXT,
  pending INTEGER NOT NULL DEFAULT 0,
  seenAt TEXT NOT NULL,
  removedAt TEXT
);
CREATE INDEX plaid_charges_stream ON plaid_charges (streamId, date);

-- a change of the price of a stream, found by a sync: from the amount before to the new one, on the date of the first
-- charge at the new amount. it is history, so it is append-only.
CREATE TABLE plaid_price_changes (
  id INTEGER PRIMARY KEY,
  streamId INTEGER NOT NULL REFERENCES plaid_streams (id),
  fromAmount REAL NOT NULL,
  toAmount REAL NOT NULL,
  currency TEXT,
  changedOn TEXT NOT NULL,
  detectedAt TEXT NOT NULL,
  UNIQUE (streamId, changedOn)
);

CREATE TRIGGER plaid_price_changes_no_update BEFORE UPDATE ON plaid_price_changes
BEGIN
  SELECT RAISE(ABORT, 'plaid_price_changes are append-only');
END;

CREATE TRIGGER plaid_price_changes_no_delete BEFORE DELETE ON plaid_price_changes
BEGIN
  SELECT RAISE(ABORT, 'plaid_price_changes are append-only');
END;

-- each sync of an item: when it ran, what started it, the counts of /transactions/sync, the streams it wrote, and the
-- error. itemId is null for a sync that failed before it reached an item, for example without credentials. it is
-- history, so the only update is the end of the row (endedAt, the counts and the error), one time.
CREATE TABLE plaid_syncs (
  id INTEGER PRIMARY KEY,
  itemId INTEGER REFERENCES plaid_items (id),
  runId TEXT,
  trigger TEXT NOT NULL CHECK (trigger IN ('automation', 'dashboard', 'link')),
  startedAt TEXT NOT NULL,
  endedAt TEXT,
  added INTEGER NOT NULL DEFAULT 0,
  modified INTEGER NOT NULL DEFAULT 0,
  removed INTEGER NOT NULL DEFAULT 0,
  streams INTEGER NOT NULL DEFAULT 0,
  error TEXT
);
CREATE INDEX plaid_syncs_item ON plaid_syncs (itemId, id);

CREATE TRIGGER plaid_syncs_end_once BEFORE UPDATE ON plaid_syncs
WHEN OLD.endedAt IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'a plaid sync row ends one time');
END;

CREATE TRIGGER plaid_syncs_no_delete BEFORE DELETE ON plaid_syncs
BEGIN
  SELECT RAISE(ABORT, 'plaid_syncs are append-only');
END;

-- one alert about a subscription: a new one (new), a higher price (price_increase), a free trial that turned into a
-- charge (trial_converted), two subscriptions of one service (duplicate), or a charge for a service that shows no use
-- (unused). subscriptionKey is the key of the merged row (SubscriptionRow.key: receipt:<id> or bank:<id>). dedupeKey
-- makes each alert one time only, for example price_increase:bank:4:2026-10-01. the only change after the insert is
-- dismissedAt, one time, when the owner dismisses it.
CREATE TABLE subscription_alerts (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('new', 'price_increase', 'trial_converted', 'duplicate', 'unused')),
  subscriptionKey TEXT NOT NULL,
  merchant TEXT NOT NULL,
  title TEXT NOT NULL,
  detail TEXT,
  amount REAL,
  previousAmount REAL,
  currency TEXT,
  about TEXT NOT NULL,
  dedupeKey TEXT NOT NULL UNIQUE,
  runId TEXT,
  createdAt TEXT NOT NULL,
  dismissedAt TEXT
);
CREATE INDEX subscription_alerts_open ON subscription_alerts (dismissedAt, id);

CREATE TRIGGER subscription_alerts_dismiss_only BEFORE UPDATE ON subscription_alerts
WHEN OLD.dismissedAt IS NOT NULL OR NEW.kind IS NOT OLD.kind OR NEW.subscriptionKey IS NOT OLD.subscriptionKey OR NEW.merchant IS NOT OLD.merchant
  OR NEW.title IS NOT OLD.title OR NEW.detail IS NOT OLD.detail OR NEW.amount IS NOT OLD.amount OR NEW.previousAmount IS NOT OLD.previousAmount
  OR NEW.currency IS NOT OLD.currency OR NEW.about IS NOT OLD.about OR NEW.dedupeKey IS NOT OLD.dedupeKey OR NEW.runId IS NOT OLD.runId
  OR NEW.createdAt IS NOT OLD.createdAt
BEGIN
  SELECT RAISE(ABORT, 'a subscription alert changes only by its dismissal, one time');
END;

CREATE TRIGGER subscription_alerts_no_delete BEFORE DELETE ON subscription_alerts
BEGIN
  SELECT RAISE(ABORT, 'subscription_alerts are append-only');
END;
