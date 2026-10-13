CREATE TABLE events (
  id INTEGER PRIMARY KEY,
  sessionKey TEXT NOT NULL,
  runId TEXT,
  seq INTEGER NOT NULL,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  UNIQUE (sessionKey, seq)
);

CREATE TRIGGER events_no_update BEFORE UPDATE ON events
BEGIN
  SELECT RAISE(ABORT, 'events are append-only');
END;

CREATE TRIGGER events_no_delete BEFORE DELETE ON events
BEGIN
  SELECT RAISE(ABORT, 'events are append-only');
END;

CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  sessionKey TEXT NOT NULL,
  trigger TEXT NOT NULL,
  slot TEXT NOT NULL,
  status TEXT NOT NULL,
  startedAt TEXT NOT NULL,
  endedAt TEXT,
  error TEXT
);

CREATE INDEX runs_session ON runs (sessionKey, startedAt);

CREATE TABLE model_calls (
  id INTEGER PRIMARY KEY,
  runId TEXT REFERENCES runs (id),
  slot TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  inputTokens INTEGER NOT NULL DEFAULT 0,
  outputTokens INTEGER NOT NULL DEFAULT 0,
  cacheReadTokens INTEGER NOT NULL DEFAULT 0,
  cacheWriteTokens INTEGER NOT NULL DEFAULT 0,
  costUsd REAL,
  latencyMs INTEGER NOT NULL,
  stopReason TEXT,
  error TEXT,
  request TEXT NOT NULL,
  response TEXT,
  createdAt TEXT NOT NULL
);

CREATE INDEX model_calls_run ON model_calls (runId);
CREATE INDEX model_calls_created ON model_calls (createdAt);

CREATE TABLE tool_calls (
  id INTEGER PRIMARY KEY,
  runId TEXT NOT NULL REFERENCES runs (id),
  toolCallId TEXT NOT NULL,
  name TEXT NOT NULL,
  input TEXT NOT NULL,
  output TEXT NOT NULL,
  isError INTEGER NOT NULL,
  durationMs INTEGER NOT NULL,
  createdAt TEXT NOT NULL
);

CREATE INDEX tool_calls_run ON tool_calls (runId);
