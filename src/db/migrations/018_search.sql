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

-- the text of each event type that a person can read. a context event repeats the system prompt in each run, and a
-- session_reset has no text, so the index leaves both out.
CREATE TRIGGER events_fts_insert AFTER INSERT ON events
WHEN NEW.type IN ('user_message', 'assistant_message', 'tool_result', 'system_event', 'note', 'compaction')
BEGIN
  INSERT INTO events_fts (rowid, text, sessionKey, runId, type, eventId, createdAt)
  SELECT NEW.id, value, NEW.sessionKey, NEW.runId, NEW.type, NEW.id, NEW.createdAt
  FROM (
    SELECT json_extract(
      NEW.payload,
      CASE NEW.type WHEN 'tool_result' THEN '$.content' WHEN 'compaction' THEN '$.summary' ELSE '$.text' END
    ) AS value
  )
  WHERE value IS NOT NULL AND value != '';
END;

-- the events from before this migration go into the index one time, with the same rule as the trigger.
INSERT INTO events_fts (rowid, text, sessionKey, runId, type, eventId, createdAt)
SELECT id, value, sessionKey, runId, type, id, createdAt
FROM (
  SELECT id, sessionKey, runId, type, createdAt, json_extract(
    payload,
    CASE type WHEN 'tool_result' THEN '$.content' WHEN 'compaction' THEN '$.summary' ELSE '$.text' END
  ) AS value
  FROM events
  WHERE type IN ('user_message', 'assistant_message', 'tool_result', 'system_event', 'note', 'compaction')
)
WHERE value IS NOT NULL AND value != ''
ORDER BY id;

-- the chat list, the messages of a chat and the spans of a run read events by run. the runs list pages by start time.
CREATE INDEX events_run ON events (runId);
CREATE INDEX runs_started ON runs (startedAt);
