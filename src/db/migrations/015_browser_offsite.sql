-- the hosts off the allowlist of the task that a step reached with a request that the gate let through: an image, a
-- script or another subresource. a page script can put text that the agent typed into such a request, so the record
-- shows where data could have gone. a json array of host names, or null when there was none.
ALTER TABLE browser_steps ADD COLUMN offsiteHosts TEXT;
