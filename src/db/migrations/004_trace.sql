CREATE TABLE blobs (
  hash TEXT PRIMARY KEY,
  size INTEGER NOT NULL,
  mime TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  refCount INTEGER NOT NULL
);

CREATE TABLE tool_catalog_snapshots (
  hash TEXT PRIMARY KEY,
  tools TEXT NOT NULL,
  createdAt TEXT NOT NULL
);

ALTER TABLE model_calls ADD COLUMN toolCatalogHash TEXT;

CREATE TABLE policy_decisions (
  id INTEGER PRIMARY KEY,
  runId TEXT NOT NULL REFERENCES runs (id),
  toolCallId TEXT NOT NULL,
  toolName TEXT NOT NULL,
  decision TEXT NOT NULL,
  rule TEXT NOT NULL,
  reason TEXT NOT NULL,
  reviewerModelCallId INTEGER REFERENCES model_calls (id),
  reviewerVerdict TEXT,
  reviewerReason TEXT,
  approvalId INTEGER REFERENCES approvals (id),
  createdAt TEXT NOT NULL
);

CREATE INDEX policy_decisions_run ON policy_decisions (runId);
CREATE INDEX policy_decisions_approval ON policy_decisions (approvalId);
CREATE INDEX policy_decisions_created ON policy_decisions (createdAt);

ALTER TABLE tool_calls ADD COLUMN source TEXT NOT NULL DEFAULT 'builtin';
ALTER TABLE tool_calls ADD COLUMN serverId TEXT;
ALTER TABLE tool_calls ADD COLUMN account TEXT;
ALTER TABLE tool_calls ADD COLUMN riskLevel TEXT;
ALTER TABLE tool_calls ADD COLUMN policyDecisionId INTEGER REFERENCES policy_decisions (id);
ALTER TABLE tool_calls ADD COLUMN tainted INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tool_calls ADD COLUMN untrustedSource TEXT;
ALTER TABLE tool_calls ADD COLUMN rawResultBlob TEXT;
ALTER TABLE tool_calls ADD COLUMN modelViewBlob TEXT;
ALTER TABLE tool_calls ADD COLUMN truncated INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tool_calls ADD COLUMN resultHandle TEXT;
ALTER TABLE tool_calls ADD COLUMN costUsd REAL;

CREATE UNIQUE INDEX tool_calls_handle ON tool_calls (resultHandle) WHERE resultHandle IS NOT NULL;

CREATE TABLE mcp_messages (
  id INTEGER PRIMARY KEY,
  serverId TEXT NOT NULL,
  runId TEXT REFERENCES runs (id),
  toolCallId TEXT,
  direction TEXT NOT NULL,
  method TEXT,
  rpcId TEXT,
  payloadBlob TEXT NOT NULL,
  latencyMs INTEGER,
  createdAt TEXT NOT NULL
);

CREATE INDEX mcp_messages_server ON mcp_messages (serverId, createdAt);
CREATE INDEX mcp_messages_run ON mcp_messages (runId);

CREATE TABLE browser_steps (
  id INTEGER PRIMARY KEY,
  taskId TEXT NOT NULL,
  runId TEXT REFERENCES runs (id),
  toolCallId TEXT,
  action TEXT NOT NULL,
  target TEXT,
  urlBefore TEXT,
  urlAfter TEXT,
  snapshotBlob TEXT,
  screenshotBlob TEXT,
  consoleErrors TEXT,
  blockedRequests TEXT,
  createdAt TEXT NOT NULL
);

CREATE INDEX browser_steps_task ON browser_steps (taskId, id);
CREATE INDEX browser_steps_run ON browser_steps (runId);

CREATE TABLE sandbox_execs (
  id INTEGER PRIMARY KEY,
  runId TEXT REFERENCES runs (id),
  toolCallId TEXT,
  command TEXT NOT NULL,
  cwd TEXT NOT NULL,
  network TEXT NOT NULL,
  exitCode INTEGER,
  stdoutBlob TEXT,
  stderrBlob TEXT,
  filesChanged TEXT,
  durationMs INTEGER NOT NULL,
  createdAt TEXT NOT NULL
);

CREATE INDEX sandbox_execs_run ON sandbox_execs (runId);

CREATE TABLE integration_events (
  id INTEGER PRIMARY KEY,
  source TEXT NOT NULL,
  account TEXT,
  externalId TEXT NOT NULL,
  kind TEXT NOT NULL,
  summary TEXT NOT NULL,
  payloadBlob TEXT,
  seenAt TEXT NOT NULL
);

CREATE INDEX integration_events_seen ON integration_events (seenAt);
CREATE INDEX integration_events_external ON integration_events (source, externalId);

CREATE TABLE subagent_runs (
  id INTEGER PRIMARY KEY,
  parentRunId TEXT NOT NULL REFERENCES runs (id),
  childRunId TEXT NOT NULL REFERENCES runs (id),
  profile TEXT NOT NULL,
  task TEXT NOT NULL,
  resultSummary TEXT,
  createdAt TEXT NOT NULL
);

CREATE INDEX subagent_runs_parent ON subagent_runs (parentRunId);
