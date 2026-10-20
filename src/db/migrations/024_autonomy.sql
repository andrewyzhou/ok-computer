-- phase 6 t6: the trust ladder. one autonomy level for each domain, on top of the policy engine, and the history of
-- each change. src/policy/autonomy.ts lists the domains and their default levels, and src/policy/autonomy-store.ts
-- writes these tables.

-- each change of a level, with who made it and where. a change from chat names its run, its tool call and its
-- session. the history is append-only, like events: the triggers below refuse an update and a delete. domain has no
-- check, so a later phase can add a domain without a migration. the store checks each domain against its list.
CREATE TABLE autonomy_changes (
  id INTEGER PRIMARY KEY,
  domain TEXT NOT NULL,
  fromLevel TEXT NOT NULL CHECK (fromLevel IN ('ask', 'review', 'auto')),
  toLevel TEXT NOT NULL CHECK (toLevel IN ('ask', 'review', 'auto')),
  actor TEXT NOT NULL CHECK (actor IN ('owner', 'agent')),
  via TEXT NOT NULL CHECK (via IN ('dashboard', 'chat')),
  runId TEXT,
  toolCallId TEXT,
  sessionKey TEXT,
  note TEXT,
  createdAt TEXT NOT NULL,
  -- only the owner on the dashboard can raise a level. the store checks it too, and this check keeps a bug in the
  -- store from writing an agent raise.
  CHECK (actor = 'owner' OR via = 'chat'),
  CHECK (
    actor = 'owner'
    OR (fromLevel = 'auto' AND toLevel IN ('review', 'ask'))
    OR (fromLevel = 'review' AND toLevel = 'ask')
  )
);

CREATE INDEX autonomy_changes_domain ON autonomy_changes (domain, id);

CREATE TRIGGER autonomy_changes_no_update BEFORE UPDATE ON autonomy_changes
BEGIN
  SELECT RAISE(ABORT, 'autonomy changes are append-only');
END;

CREATE TRIGGER autonomy_changes_no_delete BEFORE DELETE ON autonomy_changes
BEGIN
  SELECT RAISE(ABORT, 'autonomy changes are append-only');
END;

-- the current level of each domain that was ever changed. a domain with no row has its default level. changeId is the
-- history row that set the level.
CREATE TABLE autonomy_levels (
  domain TEXT PRIMARY KEY,
  level TEXT NOT NULL CHECK (level IN ('ask', 'review', 'auto')),
  changeId INTEGER NOT NULL REFERENCES autonomy_changes (id),
  updatedAt TEXT NOT NULL
);

-- the domain of each policy decision and the level that applied to it. both are null for a call outside the ladder
-- and for the decisions from before this migration.
ALTER TABLE policy_decisions ADD COLUMN autonomyDomain TEXT;
ALTER TABLE policy_decisions ADD COLUMN autonomyLevel TEXT;
