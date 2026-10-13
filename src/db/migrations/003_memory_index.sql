CREATE TABLE memory_files (
  path TEXT PRIMARY KEY,
  mtimeMs REAL NOT NULL,
  size INTEGER NOT NULL,
  indexedAt TEXT NOT NULL
);

CREATE VIRTUAL TABLE memory_chunks USING fts5(
  path UNINDEXED,
  heading,
  text,
  startLine UNINDEXED,
  endLine UNINDEXED,
  tokenize = 'porter unicode61'
);
