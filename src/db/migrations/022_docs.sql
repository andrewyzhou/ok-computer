-- phase 6 t4: docs. a doc is a markdown text that the agent writes for the owner, for example a trip plan or a
-- comparison, so a long answer goes in a doc and the chat gets a link. each change is a new version, and the versions
-- are the record: doc_versions, doc_comments and doc_comment_deliveries are append-only. the docs row is only the view
-- of the newest version, so a list reads one row for each doc.
-- kind: brief, plan, notes, comparison, meeting_prep or other. author: agent or owner.

-- one doc. title, kind, links and author are copies of the newest version. version is the number of the newest version, and
-- the first version is 1. sessionKey and runId are the session and the run that wrote the first version, or null for
-- a doc of the owner.
CREATE TABLE docs (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('brief', 'plan', 'notes', 'comparison', 'meeting_prep', 'other')),
  links TEXT NOT NULL DEFAULT '[]',
  author TEXT NOT NULL CHECK (author IN ('agent', 'owner')),
  version INTEGER NOT NULL CHECK (version >= 1),
  sessionKey TEXT,
  runId TEXT,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);
CREATE INDEX docs_updated ON docs (updatedAt, id);
CREATE INDEX docs_kind ON docs (kind, updatedAt, id);

-- each version of a doc, in full. body is markdown. links is a json list of { label, href }. note says what changed,
-- in the words of the writer. runId and toolCallId name the tool call that wrote the version, so the trace shows it.
-- taint is the json list of the untrusted sources (TaintSource) that the writing session had read. a version with
-- taint can repeat outside text, so doc_read marks its text as untrusted, as the heartbeat checklist does.
CREATE TABLE doc_versions (
  id INTEGER PRIMARY KEY,
  docId INTEGER NOT NULL REFERENCES docs (id),
  version INTEGER NOT NULL CHECK (version >= 1),
  title TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('brief', 'plan', 'notes', 'comparison', 'meeting_prep', 'other')),
  body TEXT NOT NULL,
  links TEXT NOT NULL DEFAULT '[]',
  author TEXT NOT NULL CHECK (author IN ('agent', 'owner')),
  note TEXT,
  taint TEXT NOT NULL DEFAULT '[]',
  sessionKey TEXT,
  runId TEXT,
  toolCallId TEXT,
  createdAt TEXT NOT NULL,
  UNIQUE (docId, version)
);

CREATE TRIGGER doc_versions_no_update BEFORE UPDATE ON doc_versions
BEGIN
  SELECT RAISE(ABORT, 'doc versions are append-only');
END;

CREATE TRIGGER doc_versions_no_delete BEFORE DELETE ON doc_versions
BEGIN
  SELECT RAISE(ABORT, 'doc versions are append-only');
END;

-- a doc is never deleted, because its versions and comments point at it.
CREATE TRIGGER docs_no_delete BEFORE DELETE ON docs
BEGIN
  SELECT RAISE(ABORT, 'docs are never deleted');
END;

-- a comment of the owner on one version of a doc. quote is the part of the text that the comment is about, when the
-- owner chose one. sessionKey is the session that gets the comment as a system_event.
CREATE TABLE doc_comments (
  id INTEGER PRIMARY KEY,
  docId INTEGER NOT NULL REFERENCES docs (id),
  version INTEGER NOT NULL CHECK (version >= 1),
  quote TEXT,
  text TEXT NOT NULL,
  author TEXT NOT NULL DEFAULT 'owner' CHECK (author IN ('owner')),
  sessionKey TEXT NOT NULL,
  createdAt TEXT NOT NULL
);
CREATE INDEX doc_comments_doc ON doc_comments (docId, id);

CREATE TRIGGER doc_comments_no_update BEFORE UPDATE ON doc_comments
BEGIN
  SELECT RAISE(ABORT, 'doc comments are append-only');
END;

CREATE TRIGGER doc_comments_no_delete BEFORE DELETE ON doc_comments
BEGIN
  SELECT RAISE(ABORT, 'doc comments are append-only');
END;

-- the system_event that carried a comment to its session. a comment without a row here waits for the session queue,
-- or the app stopped before it went out, and the start of the app sends it then.
CREATE TABLE doc_comment_deliveries (
  commentId INTEGER PRIMARY KEY REFERENCES doc_comments (id),
  eventId INTEGER NOT NULL REFERENCES events (id),
  deliveredAt TEXT NOT NULL
);

CREATE TRIGGER doc_comment_deliveries_no_update BEFORE UPDATE ON doc_comment_deliveries
BEGIN
  SELECT RAISE(ABORT, 'doc comment deliveries are append-only');
END;

CREATE TRIGGER doc_comment_deliveries_no_delete BEFORE DELETE ON doc_comment_deliveries
BEGIN
  SELECT RAISE(ABORT, 'doc comment deliveries are append-only');
END;

-- doc_search and the docs list read the newest version of each doc through this index. the trigram tokenizer finds a
-- part of a word, and it is case-blind, as events_fts does (migration 018). the rowid is the id of the doc. a new
-- version replaces the row of its doc, so an old version never gives a hit. the table is a copy for the search only.
CREATE VIRTUAL TABLE docs_fts USING fts5(
  title,
  body,
  kind UNINDEXED,
  tokenize = 'trigram'
);

CREATE TRIGGER docs_fts_version AFTER INSERT ON doc_versions
BEGIN
  DELETE FROM docs_fts WHERE rowid = NEW.docId;
  INSERT INTO docs_fts (rowid, title, body, kind) VALUES (NEW.docId, NEW.title, NEW.body, NEW.kind);
END;
