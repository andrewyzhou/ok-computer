import type { Db } from '../db/index.js';
import type { GoogleAccounts } from '../google/accounts.js';
import type { Logger } from '../observability/logger.js';
import type { Clock } from '../time.js';
import type { PeopleBuilder } from './builder.js';
import { notBuilt } from './not-built.js';
import type { PeopleStore } from './store.js';

// the backfill fills the people memory from recent headers one time, so the profiles are useful on the first day and
// not only after weeks of polls. it reads in steps: each poll gives it a budget of messages, and people_accounts keeps
// its position, so a long backfill spreads over a few polls and a crash loses nothing. the sent sweep then keeps the
// mail that the owner sends in view, because the poll reads only new inbox mail.

// the backfill reads the mail and the events of this many days back. the events are read up to the range of the
// poll ahead, so the upcoming meetings are there at once.
export const BACKFILL_DAYS = 90;
export const BACKFILL_AHEAD_DAYS = 61;
// the most messages that one backfill reads in all, across inbox and sent mail.
export const BACKFILL_MAX_MESSAGES = 2_000;
// the messages that one step reads. the poll gives each account one step.
export const BACKFILL_STEP_MESSAGES = 250;
// the sent sweep of one poll reads at most this many new sent messages.
export const SENT_SWEEP_MAX = 50;

export interface BackfillDeps {
  db: Db;
  clock: Clock;
  logger: Logger;
  accounts: Pick<GoogleAccounts, 'run'>;
  builder: PeopleBuilder;
  // the default is the real store. the tests give a fake.
  store?: Pick<PeopleStore, 'backfillStateOf' | 'saveBackfillState'>;
}

export interface BackfillResult {
  account: string;
  state: 'running' | 'done' | 'failed';
  // what this step read.
  messages: number;
  events: number;
  error?: string;
}

// backfillStep does one step of the backfill of an account, from the position in people_accounts:
// - first the mail: messages.list with q "newer_than:<BACKFILL_DAYS>d -in:chats -in:spam -in:trash" (inbox, sent and
//   archived mail together), at most budget ids per step and BACKFILL_MAX_MESSAGES in all, then messages.get in the
//   metadata format with PEOPLE_HEADERS (getMessages of src/inbox/gmail.ts) and builder.observeMail.
// - then the events: events.list of the primary calendar with singleEvents, from BACKFILL_DAYS back to
//   BACKFILL_AHEAD_DAYS ahead, page by page, and builder.observeEvents.
// - the position (a json { phase: 'mail' | 'events', pageToken }) and the counts are saved after each page, and the
//   state is done after the last page, with backfilledAt. sentAfter is set to the newest sent mail that it read, so
//   the sent sweep starts there.
// - an account in done does nothing and gives state done with zero counts. an error is saved as failed with the
//   error text, and the next step starts again from the saved position. a GoogleError of kind auth stops it without a
//   retry until the account works again.
// - every request goes through accounts.run, so it is in the request trace of the poll run.
export async function backfillStep(deps: BackfillDeps, account: string, budget = BACKFILL_STEP_MESSAGES): Promise<BackfillResult> {
  void deps;
  void account;
  void budget;
  return notBuilt('backfillStep');
}

// sweepSent reads the sent mail of an account that is newer than sentAfter ("in:sent after:<unix seconds>"), at most
// SENT_SWEEP_MAX messages, gives it to builder.observeMail and moves sentAfter to the newest internal date. it does
// nothing before the backfill is done, because the backfill reads the sent mail itself. it gives the number of
// messages that it read.
export async function sweepSent(deps: BackfillDeps, account: string): Promise<number> {
  void deps;
  void account;
  return notBuilt('sweepSent');
}
