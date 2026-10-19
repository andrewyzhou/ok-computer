-- phase 5 m9: the code sandbox. 004 made sandbox_execs and 006 dropped it, because no code wrote it then. this
-- migration makes it again with the columns that the sandbox writes.

-- one row for each sandbox_exec call that passed its checks and got a scratch volume, also a call that then failed
-- before docker ran it. a call that the tool refuses before that (docker off, busy, a bad allowlist or path, a missing
-- blob, a volume that could not be made) appears only in tool_calls. the tool writes the row with status running
-- before the container starts, so a crash leaves a row that the start sweep closes. runId has no
-- reference to runs: the row is a record, and a missing run row must not drop it. the dashboard joins the row to its
-- tool call and its policy decision by run and call id. command is the code that ran, and language says how it ran.
-- allowlist is a json array of host names (empty when network is none). limits is a json SandboxLimits. stdoutBytes and
-- stderrBytes count every byte that the command wrote, also the bytes after the cut. taskId names the scratch volume.
-- command is redacted like every other text of the trace, while the container gets the code as the model sent it.
-- egress is a json SandboxEgress (the hosts that the proxy let through and the requests that it refused) for a call
-- with network access, and null otherwise. notCollected is a json array of the collect paths that did not come back.
CREATE TABLE sandbox_execs (
  id INTEGER PRIMARY KEY,
  runId TEXT,
  toolCallId TEXT,
  sessionKey TEXT,
  taskId TEXT,
  language TEXT NOT NULL,
  command TEXT NOT NULL,
  image TEXT NOT NULL,
  imageId TEXT,
  cwd TEXT NOT NULL,
  network TEXT NOT NULL,
  allowlist TEXT NOT NULL,
  limits TEXT NOT NULL,
  status TEXT NOT NULL,
  exitCode INTEGER,
  containerId TEXT,
  stdoutBlob TEXT,
  stderrBlob TEXT,
  stdoutBytes INTEGER NOT NULL DEFAULT 0,
  stderrBytes INTEGER NOT NULL DEFAULT 0,
  truncated INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  durationMs INTEGER NOT NULL DEFAULT 0,
  egress TEXT,
  notCollected TEXT NOT NULL DEFAULT '[]',
  createdAt TEXT NOT NULL,
  endedAt TEXT
);

CREATE INDEX sandbox_execs_call ON sandbox_execs (runId, toolCallId);
CREATE INDEX sandbox_execs_running ON sandbox_execs (status) WHERE status = 'running';

-- the files of an exec. in is a file that the call put into /work before the start, and out is a file that the call
-- collected after the end. the bytes are in the blob store. path is relative to /work.
CREATE TABLE sandbox_files (
  id INTEGER PRIMARY KEY,
  execId INTEGER NOT NULL REFERENCES sandbox_execs (id),
  direction TEXT NOT NULL,
  path TEXT NOT NULL,
  blob TEXT NOT NULL,
  size INTEGER NOT NULL,
  mime TEXT NOT NULL,
  createdAt TEXT NOT NULL
);

CREATE INDEX sandbox_files_exec ON sandbox_files (execId);

-- the scratch volume of a task. a task is one segment of a session, from a reset to the next reset, so the calls of a
-- task share /work. the start sweep and each call remove the volumes that no call used for a day, and removedAt then
-- keeps the time.
CREATE TABLE sandbox_scratch (
  id TEXT PRIMARY KEY,
  sessionKey TEXT NOT NULL,
  volume TEXT NOT NULL UNIQUE,
  createdAt TEXT NOT NULL,
  lastUsedAt TEXT NOT NULL,
  removedAt TEXT
);

CREATE INDEX sandbox_scratch_live ON sandbox_scratch (lastUsedAt) WHERE removedAt IS NULL;
