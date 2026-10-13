-- a browser task is the work of one session in one tab, from its first browser_open to its end. a search is a short
-- task of its own. the allowlist is a json array of host names; a name also allows its subdomains. status is open
-- while the tab exists, then closed, crashed (chrome or the tab stopped), or interrupted (the app stopped). the trace
-- zip is a file under data/browser/traces, because it can be tens of megabytes; traceError says why a task has none.
CREATE TABLE browser_tasks (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  sessionKey TEXT NOT NULL,
  runId TEXT,
  allowlist TEXT NOT NULL,
  status TEXT NOT NULL,
  endReason TEXT,
  tracePath TEXT,
  traceBytes INTEGER,
  traceError TEXT,
  startedAt TEXT NOT NULL,
  endedAt TEXT
);

CREATE INDEX browser_tasks_started ON browser_tasks (startedAt);
CREATE INDEX browser_tasks_open ON browser_tasks (status) WHERE status = 'open';

-- one row for each action in a tab, also a failed one. runId has no reference to runs: the step is a record, and a
-- missing run row must not drop it. blockedRequests is a json array of { url, reason }. sent is a json array of
-- { method, url }: each request other than get that an approved submit let out.
CREATE TABLE browser_steps (
  id INTEGER PRIMARY KEY,
  taskId TEXT NOT NULL REFERENCES browser_tasks (id),
  runId TEXT,
  toolCallId TEXT,
  action TEXT NOT NULL,
  target TEXT,
  urlBefore TEXT,
  urlAfter TEXT,
  snapshotBlob TEXT,
  screenshotBlob TEXT,
  consoleErrors TEXT,
  blockedRequests TEXT,
  sent TEXT,
  error TEXT,
  durationMs INTEGER NOT NULL,
  createdAt TEXT NOT NULL
);

CREATE INDEX browser_steps_task ON browser_steps (taskId, id);
-- the dashboard joins a step to its tool call and its policy decision by run and call id.
CREATE INDEX browser_steps_call ON browser_steps (runId, toolCallId);
