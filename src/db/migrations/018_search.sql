-- the dashboard search reads the text of the event log through this index. the trigram tokenizer finds a part of a
-- word, and it is case-blind. the rowid of each row is the id of its event, so a hit joins its event with no lookup.
-- the other columns are UNINDEXED: the search filters and sorts by them, but a query never matches their text.
-- the table is a copy for the search only. the event log stays the record, and it stays append-only.
CREATE VIRTUAL TABLE events_fts USING fts5(
  text,
  sessionKey UNINDEXED,
  runId UNINDEXED,
  type UNINDEXED,
  eventId UNINDEXED,
  createdAt UNINDEXED,
  tokenize = 'trigram'
);

-- the text of each event type that a person can read and that a search scope reads. a context event repeats the system
-- prompt in each run, a session_reset has no text, and no scope shows a compaction summary, so the index leaves them
-- out. a payload that is not valid json gives no text, so it never stops the migration or the insert of an event.
CREATE TRIGGER events_fts_insert AFTER INSERT ON events
WHEN NEW.type IN ('user_message', 'assistant_message', 'tool_result', 'system_event', 'note')
BEGIN
  INSERT INTO events_fts (rowid, text, sessionKey, runId, type, eventId, createdAt)
  SELECT NEW.id, value, NEW.sessionKey, NEW.runId, NEW.type, NEW.id, NEW.createdAt
  FROM (
    SELECT CASE WHEN json_valid(NEW.payload) THEN json_extract(
      NEW.payload,
      CASE NEW.type WHEN 'tool_result' THEN '$.content' ELSE '$.text' END
    ) END AS value
  )
  WHERE value IS NOT NULL AND value != '';
END;

-- the events from before this migration go into the index one time, with the same rule as the trigger.
INSERT INTO events_fts (rowid, text, sessionKey, runId, type, eventId, createdAt)
SELECT id, value, sessionKey, runId, type, id, createdAt
FROM (
  SELECT id, sessionKey, runId, type, createdAt, CASE WHEN json_valid(payload) THEN json_extract(
    payload,
    CASE type WHEN 'tool_result' THEN '$.content' ELSE '$.text' END
  ) END AS value
  FROM events
  WHERE type IN ('user_message', 'assistant_message', 'tool_result', 'system_event', 'note')
)
WHERE value IS NOT NULL AND value != ''
ORDER BY id;

-- the chat list, the messages of a chat and the spans of a run read events by run. the runs list pages by start time.
CREATE INDEX events_run ON events (runId);
CREATE INDEX runs_started ON runs (startedAt);
