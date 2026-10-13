-- the untrusted sources that the session had read when it wrote the payload of the automation, as a json array of
-- { source, toolName, runId, toolCallId, at }. null means that the session was not tainted. each run of the
-- automation starts with this taint, so a tainted session cannot remove its taint through an automation.
ALTER TABLE automations ADD COLUMN taint TEXT;
