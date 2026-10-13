-- stallAlertedAt is the time of the one message to the owner about a run of failed polls. the claim is set before
-- the send and is released when the send fails, so the next poll tries again. a poll that works clears it.
ALTER TABLE google_accounts ADD COLUMN stallAlertedAt TEXT;
