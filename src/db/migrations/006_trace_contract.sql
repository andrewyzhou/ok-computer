-- a table comes with the milestone that writes it. no code writes these four tables, and the first table that a
-- milestone used (mcp_messages) needed a rebuild in migration 005.
DROP TABLE browser_steps;
DROP TABLE sandbox_execs;
DROP TABLE integration_events;
DROP TABLE subagent_runs;

-- tool_calls.output is the exact model view, so the copy in a blob has no use. no paid tool exists.
ALTER TABLE tool_calls DROP COLUMN modelViewBlob;
ALTER TABLE tool_calls DROP COLUMN costUsd;

-- refCount counted puts, not references, and nothing read it. a prune finds the blobs that no row names.
ALTER TABLE blobs DROP COLUMN refCount;

-- outcome keeps the facts that a later read cannot find: null for a call that ended normally, 'abandoned' when the
-- run stopped while the tool ran, 'late' when an abandoned tool finished later, and 'interrupted' when the process
-- stopped while the tool ran.
ALTER TABLE tool_calls ADD COLUMN outcome TEXT;

-- the caller sets startedAt with a compare and set just before an approved call runs, so the call runs one time.
ALTER TABLE approvals ADD COLUMN startedAt TEXT;

-- before this migration an approved call ran right after the decision. the old rows count as started, so a start
-- of the app does not expire them.
UPDATE approvals SET startedAt = resolvedAt WHERE status = 'approved';

-- the untrusted sources that the session had read when the policy decided, as a json array of
-- { source, toolName, runId, toolCallId, at }. null means that the session was not tainted. a /new clears the taint
-- of the session, so the decision keeps its own copy.
ALTER TABLE policy_decisions ADD COLUMN taint TEXT;

-- the repair at the start of a run finds the tool calls of one run by their provider id.
CREATE INDEX tool_calls_run_call ON tool_calls (runId, toolCallId);

-- the taint check runs before each tool call. code never resets the main session, so without these indexes the
-- check reads the whole session each time.
CREATE INDEX events_reset ON events (sessionKey, seq) WHERE type = 'session_reset';
CREATE INDEX events_taint ON events (sessionKey, seq)
  WHERE type IN ('tool_result', 'system_event')
    AND (json_extract(payload, '$.untrustedSource') IS NOT NULL OR json_extract(payload, '$.taint') IS NOT NULL);
