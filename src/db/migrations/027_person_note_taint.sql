-- taint is the json list of the untrusted sources (TaintSource of src/policy/policy.ts) that the session that wrote an
-- agent note had read, as in doc_versions. a note with taint can repeat outside text, for example of a mail, so the
-- people page and person_lookup mark it. a note of the owner and a note of phase 6 before this column have none.
ALTER TABLE person_notes ADD COLUMN taint TEXT NOT NULL DEFAULT '[]';
