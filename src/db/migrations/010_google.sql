-- one row for each configured google account. the refresh token stays in the credential manager.
-- status: signed_out (no token yet), ok, or needs_auth (google refused the token or the client, so the owner must act).
-- alertedAt is the time of the one message to the owner about needs_auth. a new sign-in clears it, so a restart
-- never sends the message again.
-- historyId and calendarSyncToken are the sync cursors. each cursor moves in the same transaction as the rows that
-- its changes gave, so a crash never skips a change and never repeats a signal.
-- failures counts the failed polls in a row. lastError is the error of the last failed poll or of the sign-in.
CREATE TABLE google_accounts (
  alias TEXT PRIMARY KEY,
  email TEXT,
  scopes TEXT,
  status TEXT NOT NULL DEFAULT 'signed_out' CHECK (status IN ('signed_out', 'ok', 'needs_auth')),
  authorizedAt TEXT,
  lastError TEXT,
  lastErrorAt TEXT,
  alertedAt TEXT,
  historyId TEXT,
  calendarSyncToken TEXT,
  failures INTEGER NOT NULL DEFAULT 0,
  updatedAt TEXT NOT NULL
);

-- every http request to google and every one-click unsubscribe post. the row is written before the request leaves,
-- and the answer is added after it comes back. a header is never stored. runId and toolCallId name the tool call or
-- the poll run that sent the request.
CREATE TABLE google_requests (
  id INTEGER PRIMARY KEY,
  account TEXT,
  runId TEXT,
  toolCallId TEXT,
  method TEXT NOT NULL,
  url TEXT NOT NULL,
  request TEXT,
  status INTEGER,
  response TEXT,
  responseBlob TEXT,
  error TEXT,
  latencyMs INTEGER,
  createdAt TEXT NOT NULL
);
CREATE INDEX google_requests_call ON google_requests (runId, toolCallId);
CREATE INDEX google_requests_account ON google_requests (account, id);

-- migration 008 created integration_events for the slack dm poll. the google sync needs more columns, and summary can
-- be null while only the id of a mail is known, so the table is built again with the columns of both. occurredAt of
-- 008 becomes occursAt: the time of the item, for example the time of a slack message or a mail, or the start of an
-- event. untrustedSource is the source that a reader names when it wraps the summary; a google row has none, and the
-- digest names its source and account.
-- state: new (only the id is known), ready (the summary is known), gone (deleted before the fetch), skipped (not in
-- the inbox). a slack row stays new: the digest reads only ready rows, and slack does not feed it yet.
-- detectors is null until the detectors checked the row, then a json list of hits.
-- runId is the poll run that found the row. handledAs: notified (a heartbeat told the owner), seen (a heartbeat read
-- it and stayed silent), filtered (a quiet label and no detector hit), stale (no heartbeat handled it in 3 days).
-- handledBy is the heartbeat run. the unique key makes every insert idempotent.
CREATE TABLE integration_events_next (
  id INTEGER PRIMARY KEY,
  source TEXT NOT NULL,
  account TEXT NOT NULL DEFAULT '',
  externalId TEXT NOT NULL,
  kind TEXT NOT NULL,
  summary TEXT,
  payloadBlob TEXT,
  untrustedSource TEXT,
  occursAt TEXT,
  state TEXT NOT NULL DEFAULT 'new' CHECK (state IN ('new', 'ready', 'gone', 'skipped')),
  label TEXT,
  labelAttempts INTEGER NOT NULL DEFAULT 0,
  labelModelCallId INTEGER,
  detectors TEXT,
  runId TEXT,
  seenAt TEXT NOT NULL,
  handledAt TEXT,
  handledAs TEXT CHECK (handledAs IN ('notified', 'seen', 'filtered', 'stale')),
  handledBy TEXT,
  UNIQUE (source, account, externalId)
);
INSERT INTO integration_events_next (id, source, account, externalId, kind, summary, payloadBlob, untrustedSource, occursAt, seenAt, handledAt)
  SELECT id, source, account, externalId, kind, summary, payloadBlob, untrustedSource, occurredAt, seenAt, handledAt FROM integration_events;
DROP TABLE integration_events;
ALTER TABLE integration_events_next RENAME TO integration_events;
CREATE INDEX integration_events_open ON integration_events (state, handledAt, id);
