-- the connections hub (docs/CONNECT-PLAN.md, track S2). the owner connects a service with a button, and the hub keeps
-- the connection here instead of in okc.integrations.json. src/connectors/store.ts writes these tables, and
-- src/connectors/merge.ts joins the rows with the entries of the file. no secret is stored here: a token or a client
-- secret stays in the keyring, and settings hold at most the name of its reference.

-- one managed connection. integrationId is the id in the integration layer and the first part of each tool name, so
-- it follows the id rule of src/integrations/config.ts. connectorId is the id of its ConnectorDef, for example github.
-- settings is a json object of plain values, toolsAllow a json list of the tools that are on, and risks a json object
-- from a tool name to read, write or external. this is the current state, so a disconnect deletes the row, and the
-- history below keeps what happened.
CREATE TABLE managed_connectors (
  integrationId TEXT PRIMARY KEY CHECK (integrationId GLOB '[a-z0-9]*' AND length(integrationId) <= 24),
  connectorId TEXT NOT NULL,
  settings TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(settings) AND json_type(settings) = 'object'),
  toolsAllow TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(toolsAllow) AND json_type(toolsAllow) = 'array'),
  risks TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(risks) AND json_type(risks) = 'object'),
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);

CREATE INDEX managed_connectors_connector ON managed_connectors (connectorId);

-- the history of the hub: each connect, sign-in, disconnect, tool switch, test and restart. detail is a json object of
-- plain facts, redacted before the write. integrationId is null for a connector without an integration, for example
-- google. the history is append-only, like events: the triggers below refuse an update, a delete and a replace.
CREATE TABLE connector_events (
  id INTEGER PRIMARY KEY,
  connectorId TEXT NOT NULL,
  integrationId TEXT,
  type TEXT NOT NULL CHECK (
    type IN ('connect_started', 'connected', 'connect_failed', 'disconnected', 'client_stored', 'tool_changed', 'tested', 'applied', 'restart_requested')
  ),
  detail TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(detail) AND json_type(detail) = 'object'),
  at TEXT NOT NULL
);

CREATE INDEX connector_events_connector ON connector_events (connectorId, id);

CREATE TRIGGER connector_events_no_update BEFORE UPDATE ON connector_events
BEGIN
  SELECT RAISE(ABORT, 'connector events are append-only');
END;

CREATE TRIGGER connector_events_no_delete BEFORE DELETE ON connector_events
BEGIN
  SELECT RAISE(ABORT, 'connector events are append-only');
END;

-- an insert or replace with the id of a row deletes that row, and sqlite runs no delete trigger for it while
-- recursive triggers are off, which is the default. so an insert with an id that exists is refused too.
CREATE TRIGGER connector_events_no_replace BEFORE INSERT ON connector_events
WHEN EXISTS (SELECT 1 FROM connector_events WHERE id = NEW.id)
BEGIN
  SELECT RAISE(ABORT, 'connector events are append-only');
END;
