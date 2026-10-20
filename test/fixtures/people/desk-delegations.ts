// a copy of the delegations table of the desk (021_delegations.sql of track t3), so the people tests can check the
// profile against the real shape before the desk is merged. IF NOT EXISTS keeps the real table once the desk's
// migration made it, and then the test runs against that one.
export const DESK_DELEGATIONS = `
CREATE TABLE IF NOT EXISTS delegations (
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
);`;
