-- phase 6 t5: people memory. the google polls and a one-time backfill fill these tables from mail headers (From, To,
-- Cc) and calendar attendees. no mail body is stored: a contact row keeps only the subject line of the mail or the
-- title of the event, cut and cleaned like a signal summary. mailing lists, no-reply senders, notification addresses
-- and very large meetings never make a person. the owner's own addresses never make a person either.

-- one person. name is the name that the owner sees: the owner's own choice when nameSource is owner, else the header
-- name that was seen most often (person_names), or null when no header gave a name. organization and
-- organizationDomain come from the domain of the newest email of the person that is not a personal domain (gmail and
-- others give no organization). the counts and the first and last contact are not stored here: they are read from
-- person_contacts, so a reprocessed header can never count twice.
CREATE TABLE people (
  id INTEGER PRIMARY KEY,
  name TEXT,
  nameSource TEXT NOT NULL DEFAULT 'header' CHECK (nameSource IN ('header', 'owner')),
  organization TEXT,
  organizationDomain TEXT,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);

-- each address of a person, in lower case. an address belongs to one person. isPrimary marks the address that the
-- views show first: the first address of the person, until the owner picks another.
CREATE TABLE person_emails (
  email TEXT PRIMARY KEY,
  personId INTEGER NOT NULL REFERENCES people (id),
  isPrimary INTEGER NOT NULL DEFAULT 0,
  firstSeenAt TEXT NOT NULL,
  lastSeenAt TEXT NOT NULL
);
CREATE INDEX person_emails_person ON person_emails (personId);

-- each display name that a header or an attendee gave for a person, with the number of contacts that gave it. the
-- count grows only when a new person_contacts row is made, so a header that comes again does not count again.
CREATE TABLE person_names (
  personId INTEGER NOT NULL REFERENCES people (id),
  name TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 1,
  firstSeenAt TEXT NOT NULL,
  lastSeenAt TEXT NOT NULL,
  PRIMARY KEY (personId, name)
);

-- one contact of a person: a mail that they sent or got with the owner, or a meeting that they were invited to with
-- the owner. it is an index of what the polls saw, not history, so a later read of the same item updates its row (an
-- event moved or was cancelled). the history of the person is in person_notes and in the trace of the polls.
-- kind: mail or meeting. externalId is the gmail message id or the calendar event id, and threadId is the gmail
-- thread id (null for a meeting). direction is in (mail to the owner) or out (mail from the owner), null for a
-- meeting. role is the place of the person in the item: from, to, cc, organizer or attendee. at is the internal date
-- of the mail or the start of the event, as an iso time (an all-day event starts at midnight in the owner's zone),
-- and endAt is the end of an event. cancelled is 1 for an event that was cancelled or that the person declined.
CREATE TABLE person_contacts (
  id INTEGER PRIMARY KEY,
  personId INTEGER NOT NULL REFERENCES people (id),
  kind TEXT NOT NULL CHECK (kind IN ('mail', 'meeting')),
  account TEXT NOT NULL,
  externalId TEXT NOT NULL,
  threadId TEXT,
  direction TEXT CHECK (direction IN ('in', 'out')),
  role TEXT NOT NULL CHECK (role IN ('from', 'to', 'cc', 'organizer', 'attendee')),
  subject TEXT,
  at TEXT NOT NULL,
  endAt TEXT,
  cancelled INTEGER NOT NULL DEFAULT 0,
  seenAt TEXT NOT NULL,
  UNIQUE (personId, kind, account, externalId)
);
CREATE INDEX person_contacts_person ON person_contacts (personId, kind, at);
CREATE INDEX person_contacts_thread ON person_contacts (account, threadId, at);

-- the notes and preferences that the agent or the owner wrote about a person. kind: note, or preference (for example
-- "prefers mornings"). author: agent (person_note, with its run and tool call) or owner (the dashboard). a note is
-- never changed or deleted. a later note that replaces an earlier one names it in supersedes, and the views then
-- show only the newest one.
CREATE TABLE person_notes (
  id INTEGER PRIMARY KEY,
  personId INTEGER NOT NULL REFERENCES people (id),
  kind TEXT NOT NULL CHECK (kind IN ('note', 'preference')),
  text TEXT NOT NULL,
  author TEXT NOT NULL CHECK (author IN ('agent', 'owner')),
  supersedes INTEGER REFERENCES person_notes (id),
  runId TEXT,
  toolCallId TEXT,
  createdAt TEXT NOT NULL
);
CREATE INDEX person_notes_person ON person_notes (personId, id);

CREATE TRIGGER person_notes_no_update BEFORE UPDATE ON person_notes
BEGIN
  SELECT RAISE(ABORT, 'person notes are append-only');
END;

CREATE TRIGGER person_notes_no_delete BEFORE DELETE ON person_notes
BEGIN
  SELECT RAISE(ABORT, 'person notes are append-only');
END;

-- the state of the people sources of each google account. backfill: pending (not started), running (it read some
-- pages, and backfillPage is the json position of the next one), done, or failed (error says why; the next poll tries
-- again). the backfill reads the headers of recent mail and the events of recent weeks one time. sentAfter is the
-- internal date of the newest sent mail that the sent sweep of the polls has read, so each poll reads only newer mail.
CREATE TABLE people_accounts (
  account TEXT PRIMARY KEY,
  backfill TEXT NOT NULL DEFAULT 'pending' CHECK (backfill IN ('pending', 'running', 'done', 'failed')),
  backfillPage TEXT,
  backfillMessages INTEGER NOT NULL DEFAULT 0,
  backfillEvents INTEGER NOT NULL DEFAULT 0,
  backfilledAt TEXT,
  sentAfter TEXT,
  error TEXT,
  updatedAt TEXT NOT NULL
);
