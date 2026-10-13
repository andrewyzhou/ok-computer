-- a signal is one new item that a poll found, for example a slack dm. the item is outside text, so summary and the
-- blob are untrusted, and a reader wraps them with untrustedSource. the unique key makes a poll that reads an item
-- again a no-op. account is not null, because sqlite lets two rows with a null account pass the unique key.
CREATE TABLE integration_events (
  id INTEGER PRIMARY KEY,
  source TEXT NOT NULL,
  account TEXT NOT NULL,
  externalId TEXT NOT NULL,
  kind TEXT NOT NULL,
  summary TEXT NOT NULL,
  payloadBlob TEXT,
  untrustedSource TEXT NOT NULL,
  occurredAt TEXT,
  seenAt TEXT NOT NULL,
  handledAt TEXT
);

CREATE UNIQUE INDEX integration_events_external ON integration_events (source, account, externalId);
