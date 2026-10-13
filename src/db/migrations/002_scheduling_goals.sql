CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);

CREATE TABLE automations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  schedule TEXT NOT NULL,
  payload TEXT NOT NULL,
  sessionMode TEXT NOT NULL,
  slot TEXT NOT NULL,
  enabled INTEGER NOT NULL,
  createdBy TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  nextRunAt TEXT,
  lastRunAt TEXT,
  consecutiveFailures INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX automations_next ON automations (enabled, nextRunAt);

CREATE TABLE automation_runs (
  id INTEGER PRIMARY KEY,
  automationId TEXT NOT NULL,
  runId TEXT,
  status TEXT NOT NULL,
  startedAt TEXT NOT NULL,
  endedAt TEXT,
  error TEXT
);

CREATE INDEX automation_runs_automation ON automation_runs (automationId, startedAt);

CREATE TABLE goals (
  id INTEGER PRIMARY KEY,
  day TEXT NOT NULL,
  title TEXT NOT NULL,
  eta TEXT,
  status TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  completedAt TEXT,
  note TEXT
);

CREATE INDEX goals_day ON goals (day);

CREATE TABLE goal_checkins (
  id INTEGER PRIMARY KEY,
  goalId INTEGER NOT NULL REFERENCES goals (id),
  askedAt TEXT NOT NULL,
  answer TEXT,
  answeredAt TEXT
);

CREATE INDEX goal_checkins_goal ON goal_checkins (goalId);

CREATE TABLE approvals (
  id INTEGER PRIMARY KEY,
  runId TEXT NOT NULL REFERENCES runs (id),
  toolName TEXT NOT NULL,
  input TEXT NOT NULL,
  summary TEXT NOT NULL,
  status TEXT NOT NULL,
  requestedAt TEXT NOT NULL,
  resolvedAt TEXT,
  resolvedBy TEXT
);

CREATE INDEX approvals_status ON approvals (status, requestedAt);
