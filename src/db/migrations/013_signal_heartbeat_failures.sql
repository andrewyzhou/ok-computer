-- heartbeatFailures counts the failed heartbeat runs that showed the signal. after two, the digest shows the signal
-- without its outside text, so one text that makes every run fail cannot stop the heartbeat.
ALTER TABLE integration_events ADD COLUMN heartbeatFailures INTEGER NOT NULL DEFAULT 0;
