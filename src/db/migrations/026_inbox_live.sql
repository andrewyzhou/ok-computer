-- phase 6 t2: the inbox jobs on the owner's real mail. the columns below hold the facts that the jobs check in code, so
-- the pages, the brief and the quality check can show why a row is there. every column is new and has a default, so
-- the rows of 019_inbox.sql stay valid, and a job that runs before its work package fills a column leaves the default.

-- the counts of one digest, as json DigestStats of src/dashboard/inbox-types.ts: the mail that the digest read in each
-- account, the mail that it hid because a machine sent it, and whether an account hit the read limit. null for a
-- digest of phase 5.
ALTER TABLE inbox_digests ADD COLUMN stats TEXT;

-- parser is the version of the receipt reading that wrote the row. a scan reads a receipt again when its version is
-- older than the version of the code, so a fix of the reading also fixes the old receipts. 0 is the reading of phase 5.
-- senderDomain is the domain of the from address in lower case, which keeps two merchants of one name apart.
-- kind: charge (a payment that was made), refund, order (an order or a shipment without a charge), or other. a refund
-- and an order never count as a charge of a subscription. null for a row of phase 5.
-- statedCadence is the cadence that the receipt text states ("per month", "annual plan"), checked in code, or null.
-- amountInText is 1 when the amount of the row was found in the text of the receipt, so the model did not invent it.
ALTER TABLE inbox_receipts ADD COLUMN parser INTEGER NOT NULL DEFAULT 0;
ALTER TABLE inbox_receipts ADD COLUMN senderDomain TEXT;
ALTER TABLE inbox_receipts ADD COLUMN kind TEXT CHECK (kind IS NULL OR kind IN ('charge', 'refund', 'order', 'other'));
ALTER TABLE inbox_receipts ADD COLUMN statedCadence TEXT CHECK (statedCadence IS NULL OR statedCadence IN ('weekly', 'monthly', 'quarterly', 'yearly'));
ALTER TABLE inbox_receipts ADD COLUMN amountInText INTEGER NOT NULL DEFAULT 0;

-- cadenceSource says where the cadence of a subscription comes from: stated (the receipts say it), gaps (the time
-- between the charges), both (they agree), or none (the cadence is unknown). reasons is a json list of short
-- sentences that explain the confidence, for the page and for the quality check.
ALTER TABLE inbox_subscriptions ADD COLUMN cadenceSource TEXT NOT NULL DEFAULT 'none' CHECK (cadenceSource IN ('stated', 'gaps', 'both', 'none'));
ALTER TABLE inbox_subscriptions ADD COLUMN reasons TEXT NOT NULL DEFAULT '[]';

-- the words of the mail that give the date of a proposal, copied from the mail and checked in code, so a proposal
-- never holds a date that the mail does not state. null for a proposal of phase 5.
ALTER TABLE inbox_proposals ADD COLUMN dueText TEXT;

-- the number of distinct from domains that a sweep saw for one sender, so the page and the quality check can find a
-- group that holds more than one sender. 1 for a row of phase 5, which the next sweep writes again.
ALTER TABLE inbox_senders ADD COLUMN fromDomains INTEGER NOT NULL DEFAULT 1;
