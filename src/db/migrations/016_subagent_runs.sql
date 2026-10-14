-- one row links each child run to the delegate call of its parent. the task and the result are the input and the
-- output of that tool_calls row, and the end time is the endedAt of the child run, so they are not copied here. the
-- row is written before the child run starts, so childRunId has no foreign key: a crash still leaves the link.
CREATE TABLE subagent_runs (
  id INTEGER PRIMARY KEY,
  parentRunId TEXT NOT NULL REFERENCES runs (id),
  toolCallId TEXT NOT NULL,
  childRunId TEXT NOT NULL UNIQUE,
  profile TEXT NOT NULL,
  createdAt TEXT NOT NULL
);

CREATE INDEX subagent_runs_parent ON subagent_runs (parentRunId);
