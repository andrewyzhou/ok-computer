-- calendarPage is the position of a calendar read that did not finish in one poll: the page token of the next page,
-- and for a first read its timeMin, as json. the next poll goes on from it, so a list of changes that is longer than
-- one poll can read still ends. it moves in the same transaction as the signals of its page.
ALTER TABLE google_accounts ADD COLUMN calendarPage TEXT;
