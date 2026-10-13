-- a small message keeps its json in the row, and a message over 8 kb goes to the blob store. no code wrote
-- mcp_messages before this migration, so the copy moves no real data.
CREATE TABLE mcp_messages_new (
  id INTEGER PRIMARY KEY,
  serverId TEXT NOT NULL,
  runId TEXT REFERENCES runs (id),
  toolCallId TEXT,
  direction TEXT NOT NULL,
  method TEXT,
  rpcId TEXT,
  payload TEXT,
  payloadBlob TEXT,
  latencyMs INTEGER,
  createdAt TEXT NOT NULL
);

INSERT INTO mcp_messages_new (id, serverId, runId, toolCallId, direction, method, rpcId, payloadBlob, latencyMs, createdAt)
  SELECT id, serverId, runId, toolCallId, direction, method, rpcId, payloadBlob, latencyMs, createdAt FROM mcp_messages;
DROP TABLE mcp_messages;
ALTER TABLE mcp_messages_new RENAME TO mcp_messages;

CREATE INDEX mcp_messages_server ON mcp_messages (serverId, id);
CREATE INDEX mcp_messages_run ON mcp_messages (runId);
CREATE INDEX mcp_messages_tool_call ON mcp_messages (toolCallId);

-- each row is a version of the tool list that a server gave. the list itself is in tool_catalog_snapshots.
CREATE TABLE integration_catalogs (
  id INTEGER PRIMARY KEY,
  integrationId TEXT NOT NULL,
  hash TEXT NOT NULL REFERENCES tool_catalog_snapshots (hash),
  createdAt TEXT NOT NULL
);

CREATE INDEX integration_catalogs_integration ON integration_catalogs (integrationId, id);

-- the owner's choices and the auth state stay over a restart. the connection status itself lives in memory.
CREATE TABLE integration_state (
  integrationId TEXT PRIMARY KEY,
  paused INTEGER NOT NULL DEFAULT 0,
  tokenExpiresAt TEXT,
  authorizedAt TEXT,
  lastError TEXT,
  lastErrorAt TEXT,
  updatedAt TEXT NOT NULL
);
