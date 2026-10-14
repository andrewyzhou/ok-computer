-- the first eta of a goal. a goal moved to a later eta was counted as done on time, because the statistics compared
-- with the eta after the move.
ALTER TABLE goals ADD COLUMN firstEta TEXT;
UPDATE goals SET firstEta = eta;
