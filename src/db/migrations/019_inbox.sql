-- phase 5 m8: the inbox jobs. the newsletter sweep, the paid subscription finder and the daily digest write these
-- tables, and the dashboard reads them. a run id is the runs row of the job or of the dashboard action that wrote the
-- row. an approval id is the approvals row that the action waits for. the approval and its tool call stay the record
-- of what the owner allowed; a state column here is only the view of it.

-- one sender of the newsletter sweep, per account. senderKey is the List-Id without its angle brackets, or the From
-- address when the mail has no List-Id, both in lower case. messages and read are the counts of the rows in
-- inbox_sender_messages, written again at the end of each sweep.
-- unsubscribeMethod: one_click (rfc 8058, an https link and List-Unsubscribe-Post), https (a link without the post
-- header), mailto (shown, but never used, because the app does not send mail), or none. unsubscribeMessageId is the
-- newest message whose List-Unsubscribe header gave the method and the url, so the action reads that message again.
-- state: active, kept (the owner took the sender out of the sweeps), unsubscribe_pending (an approval waits),
-- unsubscribed, or failed (the unsubscribe ran and failed; error says why).
-- archived counts the messages that an approved archive took out of the inbox, and label is the last label that it
-- added. helpSessionKey is the session of the browser help run of an https unsubscribe, when one ran.
CREATE TABLE inbox_senders (
  id INTEGER PRIMARY KEY,
  account TEXT NOT NULL,
  senderKey TEXT NOT NULL,
  listId TEXT,
  fromAddress TEXT NOT NULL,
  displayName TEXT,
  messages INTEGER NOT NULL DEFAULT 0,
  read INTEGER NOT NULL DEFAULT 0,
  firstAt TEXT NOT NULL,
  lastAt TEXT NOT NULL,
  unsubscribeMethod TEXT NOT NULL DEFAULT 'none' CHECK (unsubscribeMethod IN ('one_click', 'https', 'mailto', 'none')),
  unsubscribeUrl TEXT,
  unsubscribeMessageId TEXT,
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'kept', 'unsubscribe_pending', 'unsubscribed', 'failed')),
  approvalId INTEGER,
  unsubscribedAt TEXT,
  archived INTEGER NOT NULL DEFAULT 0,
  label TEXT,
  error TEXT,
  helpSessionKey TEXT,
  runId TEXT,
  updatedAt TEXT NOT NULL,
  UNIQUE (account, senderKey)
);
CREATE INDEX inbox_senders_list ON inbox_senders (account, state, messages);

-- each message of a sender that a sweep saw. a second sweep updates unread and does not count the message again.
-- receivedAt is the internal date of the message in gmail.
CREATE TABLE inbox_sender_messages (
  account TEXT NOT NULL,
  messageId TEXT NOT NULL,
  senderId INTEGER NOT NULL REFERENCES inbox_senders (id),
  receivedAt TEXT NOT NULL,
  unread INTEGER NOT NULL,
  inInbox INTEGER NOT NULL,
  PRIMARY KEY (account, messageId)
);
CREATE INDEX inbox_sender_messages_sender ON inbox_sender_messages (senderId, receivedAt);

-- one receipt that the subscription finder read. the finder reads each message one time, also when the model found no
-- charge in it (merchantKey null), so a later scan pays for the new mail only. recurring is 1 when the mail says that
-- the charge renews. modelCallId is the extraction call.
CREATE TABLE inbox_receipts (
  account TEXT NOT NULL,
  messageId TEXT NOT NULL,
  merchantKey TEXT,
  merchant TEXT,
  amount REAL,
  currency TEXT,
  chargedAt TEXT,
  recurring INTEGER NOT NULL DEFAULT 0,
  subject TEXT,
  cancelUrl TEXT,
  modelCallId INTEGER,
  runId TEXT,
  readAt TEXT NOT NULL,
  PRIMARY KEY (account, messageId)
);
CREATE INDEX inbox_receipts_merchant ON inbox_receipts (account, merchantKey, chargedAt);

-- one paid subscription, built from the receipts of one merchant. merchantKey is the merchant name in lower case
-- without spaces and marks. sourceMessageIds is a json list of the receipt messages, newest first, and
-- sourceMessageId is the first of them. confidence is 0 to 1: how sure the finder is that the charge repeats.
-- state: active, cancel_pending (an approval waits), cancelled, or ignored (the owner hid it).
-- helpSessionKey is the session of the browser help run of a cancellation, and browserTaskId is the browser task
-- that it opened, when it opened one.
CREATE TABLE inbox_subscriptions (
  id INTEGER PRIMARY KEY,
  account TEXT NOT NULL,
  merchantKey TEXT NOT NULL,
  merchant TEXT NOT NULL,
  amount REAL,
  currency TEXT,
  cadence TEXT NOT NULL DEFAULT 'unknown' CHECK (cadence IN ('weekly', 'monthly', 'quarterly', 'yearly', 'unknown')),
  lastChargeAt TEXT,
  nextChargeAt TEXT,
  sourceMessageId TEXT NOT NULL,
  sourceSubject TEXT,
  sourceMessageIds TEXT NOT NULL DEFAULT '[]',
  confidence REAL NOT NULL DEFAULT 0 CHECK (confidence >= 0 AND confidence <= 1),
  cancelUrl TEXT,
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'cancel_pending', 'cancelled', 'ignored')),
  approvalId INTEGER,
  browserTaskId TEXT,
  helpSessionKey TEXT,
  error TEXT,
  runId TEXT,
  updatedAt TEXT NOT NULL,
  UNIQUE (account, merchantKey)
);

-- one daily digest. day is yyyy-mm-dd in the time zone of the app. a second run on one day adds a row, and the
-- dashboard shows the newest. accounts and items are json: a list of aliases, and a list of DigestItem in the order of
-- the sections, then by dueAt. shortText is the message that went to the owner.
CREATE TABLE inbox_digests (
  id INTEGER PRIMARY KEY,
  day TEXT NOT NULL,
  runId TEXT,
  createdAt TEXT NOT NULL,
  accounts TEXT NOT NULL DEFAULT '[]',
  shortText TEXT NOT NULL,
  items TEXT NOT NULL DEFAULT '[]',
  notified INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX inbox_digests_day ON inbox_digests (day, id);

-- a draft reply that the app saved in gmail drafts. the app never sends it. sourceMessageId is the mail that the
-- draft answers, so one mail gets one draft. toAddresses is a json list. state: drafted, discarded (the draft is gone
-- and no sent mail in the thread has its text), or sent_by_owner (the owner sent it from gmail). checkedAt is the last
-- check of the state.
CREATE TABLE inbox_drafts (
  id INTEGER PRIMARY KEY,
  account TEXT NOT NULL,
  gmailDraftId TEXT NOT NULL,
  threadId TEXT NOT NULL,
  sourceMessageId TEXT NOT NULL,
  inReplyTo TEXT,
  toAddresses TEXT NOT NULL DEFAULT '[]',
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'drafted' CHECK (state IN ('drafted', 'discarded', 'sent_by_owner')),
  runId TEXT,
  toolCallId TEXT,
  createdAt TEXT NOT NULL,
  checkedAt TEXT,
  UNIQUE (account, sourceMessageId)
);

-- a calendar event that the app proposes from a course or bill deadline in mail. the owner decides through the
-- approval of the inbox_create_event call. dedupeKey is the source message, the kind and the start, so a mail that
-- comes again in a later digest gives no second proposal.
-- state: proposed (the approval waits), approved (the owner approved, the event is not made yet), created, declined,
-- expired, or failed (error says why).
CREATE TABLE inbox_proposals (
  id INTEGER PRIMARY KEY,
  account TEXT NOT NULL,
  calendarId TEXT NOT NULL DEFAULT 'primary',
  kind TEXT NOT NULL CHECK (kind IN ('course', 'bill', 'other')),
  title TEXT NOT NULL,
  startAt TEXT NOT NULL,
  endAt TEXT,
  allDay INTEGER NOT NULL DEFAULT 0,
  description TEXT,
  sourceMessageId TEXT,
  sourceSubject TEXT,
  dedupeKey TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'proposed' CHECK (state IN ('proposed', 'approved', 'created', 'declined', 'expired', 'failed')),
  approvalId INTEGER,
  eventId TEXT,
  error TEXT,
  runId TEXT,
  createdAt TEXT NOT NULL,
  resolvedAt TEXT,
  UNIQUE (account, dedupeKey)
);
CREATE INDEX inbox_proposals_state ON inbox_proposals (state, id);
