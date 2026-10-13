-- the time when the card of the approval did not reach the owner, or null when it did. an approval that expires
-- after such a card was never seen by the owner, so its expiry is not the owner's answer.
ALTER TABLE approvals ADD COLUMN unsentAt TEXT;
