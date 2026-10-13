-- one row for each configured google account. the refresh token stays in the credential manager.
-- status: signed_out (no token yet), ok, or needs_auth (google refused the token, so the owner must sign in again).
-- alertedAt is the time of the one message to the owner about needs_auth. a new sign-in clears it, so a restart
-- never sends the message again.
CREATE TABLE google_accounts (
  alias TEXT PRIMARY KEY,
  email TEXT,
  scopes TEXT,
  status TEXT NOT NULL DEFAULT 'signed_out' CHECK (status IN ('signed_out', 'ok', 'needs_auth')),
  authorizedAt TEXT,
  lastError TEXT,
  lastErrorAt TEXT,
  alertedAt TEXT,
  updatedAt TEXT NOT NULL
);

-- the sync cursor of each account and api: the gmail historyId or the calendar syncToken. the cursor moves in the
-- same transaction as the rows that its changes gave, so a crash never skips a change and never repeats a signal.
CREATE TABLE google_sync (
  alias TEXT NOT NULL,
  api TEXT NOT NULL CHECK (api IN ('gmail', 'calendar')),
  cursor TEXT,
  lastPollAt TEXT,
  lastOkAt TEXT,
  failures INTEGER NOT NULL DEFAULT 0,
  lastError TEXT,
  PRIMARY KEY (alias, api)
);

-- migration 006 dropped the early version of this table, because no code wrote it.
-- state: new (only the id is known), ready (the summary is known), gone (deleted before the fetch), skipped (not
-- in the inbox). a detector row is ready at once. the unique key makes every insert idempotent.
CREATE TABLE integration_events (
  id INTEGER PRIMARY KEY,
  source TEXT NOT NULL,
  account TEXT NOT NULL,
  externalId TEXT NOT NULL,
  kind TEXT NOT NULL,
  summary TEXT,
  payloadBlob TEXT,
  state TEXT NOT NULL DEFAULT 'new' CHECK (state IN ('new', 'ready', 'gone', 'skipped')),
  label TEXT,
  labelAttempts INTEGER NOT NULL DEFAULT 0,
  occursAt TEXT,
  seenAt TEXT NOT NULL,
  handledAt TEXT,
  handledBy TEXT,
  UNIQUE (source, account, externalId)
);
CREATE INDEX integration_events_open ON integration_events (state, handledAt, id);

-- a copy of the primary calendar of each account. the detectors read it, so a detector makes no api call.
CREATE TABLE calendar_events (
  alias TEXT NOT NULL,
  eventId TEXT NOT NULL,
  status TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  startAt TEXT,
  endAt TEXT,
  allDay INTEGER NOT NULL DEFAULT 0,
  organizerSelf INTEGER NOT NULL DEFAULT 1,
  updated TEXT NOT NULL,
  PRIMARY KEY (alias, eventId)
);
CREATE INDEX calendar_events_start ON calendar_events (startAt);
