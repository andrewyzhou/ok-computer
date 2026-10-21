-- track s1: sign-in by a code over telegram, remember me, and sessions that last across a restart. the tables of
-- src/signin/. no column holds a cookie value, a dashboard token or a code: the database keeps only keyed hashes.
-- every time is an iso string in utc.

-- one row for each sign-in of a browser. id is a random public id, which the settings page and its routes use. hash is
-- the hex hmac-sha256 of the cookie value, keyed with the dashboard token, so a new token makes every row invalid
-- without a write. host is local for the loopback address and remote for dashboard.publicUrl, and a session works
-- only on its own host. via is how the owner signed in: the token, the link of /dashboard, or a code by text.
-- userAgent is cut to 300 characters. lastUsedAt moves at most once a minute. a session ends when endedAt is set or
-- when expiresAt has passed. the rows stay after the end, so the owner can see where the app was used.
CREATE TABLE signin_sessions (
  id TEXT PRIMARY KEY,
  hash TEXT NOT NULL UNIQUE,
  host TEXT NOT NULL CHECK (host IN ('local', 'remote')),
  via TEXT NOT NULL CHECK (via IN ('token', 'link', 'text')),
  remember INTEGER NOT NULL CHECK (remember IN (0, 1)),
  userAgent TEXT,
  createdAt TEXT NOT NULL,
  lastUsedAt TEXT NOT NULL,
  expiresAt TEXT NOT NULL,
  endedAt TEXT,
  endReason TEXT CHECK (endReason IN ('signed_out', 'signed_out_all'))
);
CREATE INDEX signin_sessions_live ON signin_sessions (endedAt, expiresAt);

-- a session never comes back after its end, and its hash, host and start never change.
CREATE TRIGGER signin_sessions_end_once BEFORE UPDATE ON signin_sessions
WHEN OLD.endedAt IS NOT NULL
  OR NEW.hash IS NOT OLD.hash
  OR NEW.host IS NOT OLD.host
  OR NEW.via IS NOT OLD.via
  OR NEW.createdAt IS NOT OLD.createdAt
BEGIN
  SELECT RAISE(ABORT, 'a sign-in session changes only its last use and its end');
END;

CREATE TRIGGER signin_sessions_no_delete BEFORE DELETE ON signin_sessions
BEGIN
  SELECT RAISE(ABORT, 'sign-in sessions are kept');
END;

-- one row for each code that went to the owner by text. hash is the hex sha-256 of salt and the six digits, and salt
-- is random for each row. host is the host whose login page asked for the code, and the code works only there.
-- attempts counts the wrong tries. a code is spent when usedAt is set, dead after its fifth wrong try or when a newer
-- code of the same host exists, and expired after expiresAt.
CREATE TABLE signin_codes (
  id INTEGER PRIMARY KEY,
  hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  host TEXT NOT NULL CHECK (host IN ('local', 'remote')),
  createdAt TEXT NOT NULL,
  expiresAt TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  usedAt TEXT
);
CREATE INDEX signin_codes_host ON signin_codes (host, id);

CREATE TRIGGER signin_codes_use_once BEFORE UPDATE ON signin_codes
WHEN OLD.usedAt IS NOT NULL
  OR NEW.hash IS NOT OLD.hash
  OR NEW.salt IS NOT OLD.salt
  OR NEW.host IS NOT OLD.host
  OR NEW.createdAt IS NOT OLD.createdAt
  OR NEW.expiresAt IS NOT OLD.expiresAt
  OR NEW.attempts < OLD.attempts
BEGIN
  SELECT RAISE(ABORT, 'a sign-in code changes only its tries and its use');
END;

CREATE TRIGGER signin_codes_no_delete BEFORE DELETE ON signin_codes
BEGIN
  SELECT RAISE(ABORT, 'sign-in codes are kept');
END;

-- the history of sign-in: each code sent or not sent, each sign-in and each refused one, and each sign-out. the rate
-- limits count these rows, so they hold over a restart. sessionId and codeId point to the rows above when there is
-- one. detail is a short reason in words, never a code, a token or a cookie value. append-only.
CREATE TABLE signin_events (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('code_sent', 'code_not_sent', 'code_refused', 'signed_in', 'sign_in_refused', 'signed_out')),
  host TEXT NOT NULL CHECK (host IN ('local', 'remote')),
  via TEXT CHECK (via IN ('token', 'link', 'text')),
  sessionId TEXT,
  codeId INTEGER,
  detail TEXT,
  at TEXT NOT NULL
);
CREATE INDEX signin_events_kind ON signin_events (kind, host, at);

CREATE TRIGGER signin_events_no_update BEFORE UPDATE ON signin_events
BEGIN
  SELECT RAISE(ABORT, 'sign-in events are append-only');
END;

CREATE TRIGGER signin_events_no_delete BEFORE DELETE ON signin_events
BEGIN
  SELECT RAISE(ABORT, 'sign-in events are append-only');
END;
