-- phase 6 t1: the morning brief. the brief job writes one row for each brief it builds, and the today page reads them.
-- a run id is the runs row of the job that built the brief. both tables are history, so they are append-only: a second
-- brief of a day is a new row, and the newest row of a day is the brief of the day.

-- day is yyyy-mm-dd in the time zone of the app. content is the json of BriefContent (src/dashboard/brief-types.ts).
-- shortText is the telegram message, with the link to the today page.
CREATE TABLE briefs (
  id INTEGER PRIMARY KEY,
  day TEXT NOT NULL,
  runId TEXT,
  createdAt TEXT NOT NULL,
  shortText TEXT NOT NULL,
  content TEXT NOT NULL
);
CREATE INDEX briefs_day ON briefs (day, id);

CREATE TRIGGER briefs_no_update BEFORE UPDATE ON briefs
BEGIN
  SELECT RAISE(ABORT, 'briefs are append-only');
END;

CREATE TRIGGER briefs_no_delete BEFORE DELETE ON briefs
BEGIN
  SELECT RAISE(ABORT, 'briefs are append-only');
END;

-- each try to send a brief to the owner. channel is null when no chat of the owner was known. ok is 1 when the
-- channel took the message. the newest row of a brief is its delivery.
CREATE TABLE brief_deliveries (
  id INTEGER PRIMARY KEY,
  briefId INTEGER NOT NULL REFERENCES briefs (id),
  channel TEXT,
  ok INTEGER NOT NULL,
  error TEXT,
  at TEXT NOT NULL
);
CREATE INDEX brief_deliveries_brief ON brief_deliveries (briefId, id);

CREATE TRIGGER brief_deliveries_no_update BEFORE UPDATE ON brief_deliveries
BEGIN
  SELECT RAISE(ABORT, 'brief deliveries are append-only');
END;

CREATE TRIGGER brief_deliveries_no_delete BEFORE DELETE ON brief_deliveries
BEGIN
  SELECT RAISE(ABORT, 'brief deliveries are append-only');
END;
