-- phase 6 t3: the desk. a delegation is a job that the owner hands off to the agent: "can you handle X". the agent
-- tools, the follow-up job and the dashboard write these tables through src/desk/store.ts, and the desk view reads
-- them. docs/API.md (T3) gives the shapes.

-- one delegation. status: open (the agent works on it), waiting (it waits on a person or an email), blocked (it needs
-- the owner, nextStep says what), done, or dropped. nextStep is the next step in words for the owner.
-- waitingOnName and waitingOnEmail name who it waits on; waitingOnKey is the lower case email, or the lower case name
-- when there is no email, so the desk can filter by person. waitingSince is the time the wait started: the follow-up
-- job looks for a reply in the linked thread after it.
-- dueAt is when the owner needs it done. nextFollowUpAt is when the follow-up job checks it next, and null means no
-- follow-up. lastCheckedAt is the last check of the follow-up job, and nudges counts the nudge drafts it saved.
-- createdBy is agent or owner. sessionKey and runId are the session and run that created it, when the agent did.
-- closedAt is set when the status becomes done or dropped, and cleared when it opens again.
CREATE TABLE delegations (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  details TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'waiting', 'blocked', 'done', 'dropped')),
  nextStep TEXT,
  waitingOnName TEXT,
  waitingOnEmail TEXT,
  waitingOnKey TEXT,
  waitingSince TEXT,
  dueAt TEXT,
  nextFollowUpAt TEXT,
  lastCheckedAt TEXT,
  nudges INTEGER NOT NULL DEFAULT 0,
  createdBy TEXT NOT NULL CHECK (createdBy IN ('agent', 'owner')),
  sessionKey TEXT,
  runId TEXT,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  closedAt TEXT
);
CREATE INDEX delegations_status ON delegations (status, updatedAt, id);
CREATE INDEX delegations_follow_up ON delegations (nextFollowUpAt) WHERE nextFollowUpAt IS NOT NULL;
CREATE INDEX delegations_due ON delegations (dueAt) WHERE dueAt IS NOT NULL;
CREATE INDEX delegations_person ON delegations (waitingOnKey) WHERE waitingOnKey IS NOT NULL;

-- the links of a delegation. kind: run (a runs id), doc (a docs id of t4), thread (a gmail thread id in account), or
-- event (a calendar event id in account). account is the google alias for a thread or an event, and '' otherwise, so
-- the unique key works. label is a short text for the desk. a removed link leaves the table, and the history keeps
-- the record of it.
CREATE TABLE delegation_links (
  id INTEGER PRIMARY KEY,
  delegationId INTEGER NOT NULL REFERENCES delegations (id),
  kind TEXT NOT NULL CHECK (kind IN ('run', 'doc', 'thread', 'event')),
  ref TEXT NOT NULL,
  account TEXT NOT NULL DEFAULT '',
  label TEXT,
  createdAt TEXT NOT NULL,
  UNIQUE (delegationId, kind, account, ref)
);
CREATE INDEX delegation_links_ref ON delegation_links (kind, account, ref);

-- the history of a delegation, oldest first. it is append-only, like events: a change of a delegation writes its row
-- here in the same transaction. kind names what happened (DelegationEventKind in src/dashboard/desk-types.ts). actor
-- is agent, owner or system (the follow-up job). text is a short line for the owner, and data is json with the
-- fields of the change, for example { "from": "open", "to": "waiting" }. runId and toolCallId point to the trace.
CREATE TABLE delegation_events (
  id INTEGER PRIMARY KEY,
  delegationId INTEGER NOT NULL REFERENCES delegations (id),
  kind TEXT NOT NULL,
  actor TEXT NOT NULL CHECK (actor IN ('agent', 'owner', 'system')),
  text TEXT,
  data TEXT NOT NULL DEFAULT '{}',
  runId TEXT,
  toolCallId TEXT,
  createdAt TEXT NOT NULL
);
CREATE INDEX delegation_events_of ON delegation_events (delegationId, id);

CREATE TRIGGER delegation_events_no_update BEFORE UPDATE ON delegation_events
BEGIN
  SELECT RAISE(ABORT, 'delegation events are append-only');
END;

CREATE TRIGGER delegation_events_no_delete BEFORE DELETE ON delegation_events
BEGIN
  SELECT RAISE(ABORT, 'delegation events are append-only');
END;

-- a nudge that the follow-up job saved as a gmail draft. the app never sends it. followUpAt is the follow-up time
-- that made it, so one follow-up gives one draft. a row with an empty gmailDraftId is a claim: a call saves the draft
-- now, so a second call at the same time makes no second draft. sourceMessageId is the mail that the draft answers.
CREATE TABLE delegation_nudges (
  id INTEGER PRIMARY KEY,
  delegationId INTEGER NOT NULL REFERENCES delegations (id),
  account TEXT NOT NULL,
  threadId TEXT NOT NULL,
  sourceMessageId TEXT,
  gmailDraftId TEXT NOT NULL DEFAULT '',
  toAddress TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  followUpAt TEXT NOT NULL,
  runId TEXT,
  toolCallId TEXT,
  createdAt TEXT NOT NULL,
  UNIQUE (delegationId, followUpAt)
);
