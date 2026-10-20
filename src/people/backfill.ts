import type { gmail_v1 } from '@googleapis/gmail';
import type { Db } from '../db/index.js';
import type { GoogleAccounts } from '../google/accounts.js';
import { fromSdk, GoogleError, toGoogleError } from '../google/errors.js';
import { getMessages, listMessages } from '../inbox/gmail.js';
import type { Logger } from '../observability/logger.js';
import { headOf } from '../text.js';
import type { Clock } from '../time.js';
import { PEOPLE_HEADERS, type PeopleBuilder } from './builder.js';
import { peopleStore, type BackfillState, type PeopleStore } from './store.js';

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

// the search of the mail phase: inbox, sent and archived mail together, without chats, spam and the trash.
const MAIL_QUERY = `newer_than:${BACKFILL_DAYS}d -in:chats -in:spam -in:trash`;
// one page of events.list. a step reads events until it has read its budget.
const EVENT_PAGE = 250;
const DAY_MS = 86_400_000;

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

// the position that backfillPage keeps. the events phase keeps its time range too, because a page token of
// events.list only works with the request that gave it. after the backfill, the sent sweep keeps the ids that it read
// last, because "after:" counts whole seconds and gives the newest mail again.
type Position =
  | { phase: 'mail'; pageToken?: string }
  | { phase: 'events'; pageToken?: string; timeMin?: string; timeMax?: string }
  | { phase: 'sent'; seen: string[] };

function positionOf(state: BackfillState): Position {
  try {
    const parsed = JSON.parse(state.backfillPage ?? 'null') as Position | null;
    if (parsed && (parsed.phase === 'mail' || parsed.phase === 'events' || parsed.phase === 'sent')) return parsed;
  } catch {
    // a damaged position starts the backfill again. the store is idempotent, so a second read is harmless.
  }
  return { phase: 'mail' };
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
  const store = deps.store ?? peopleStore;
  const state = store.backfillStateOf(deps.db, account, deps.clock());
  if (state.backfill === 'done') return { account, state: 'done', messages: 0, events: 0 };
  let position = positionOf(state);
  let totalMessages = state.backfillMessages;
  let totalEvents = state.backfillEvents;
  let sentAfter = state.sentAfter;
  let messages = 0;
  let events = 0;
  const save = (change: Partial<Omit<BackfillState, 'account'>>) =>
    store.saveBackfillState(deps.db, account, { backfillPage: JSON.stringify(position), backfillMessages: totalMessages, backfillEvents: totalEvents, sentAfter, ...change }, deps.clock());
  try {
    save({ backfill: 'running', error: null });
    while (position.phase === 'mail') {
      // the cap of the whole backfill ends the mail phase, and the budget of the step ends the step.
      if (totalMessages >= BACKFILL_MAX_MESSAGES) {
        position = { phase: 'events' };
        save({});
        break;
      }
      const max = Math.min(budget - messages, BACKFILL_MAX_MESSAGES - totalMessages);
      if (max <= 0) break;
      const pageToken = position.pageToken;
      const page = await deps.accounts.run(account, async (apis) => {
        const { data } = await apis.gmail.users.messages.list({ userId: 'me', q: MAIL_QUERY, maxResults: max, ...(pageToken ? { pageToken } : {}) });
        const ids = (data.messages ?? []).flatMap((each) => (each.id ? [each.id] : [])).slice(0, max);
        const read = ids.length > 0 ? await getMessages(apis, ids, { format: 'metadata', headers: PEOPLE_HEADERS }) : [];
        return { ids, read, next: data.nextPageToken ?? null };
      });
      deps.builder.observeMail(account, page.read);
      sentAfter = newestSent(page.read, sentAfter);
      messages += page.ids.length;
      totalMessages += page.ids.length;
      position = page.next ? { phase: 'mail', pageToken: page.next } : { phase: 'events' };
      save({});
    }
    while (position.phase === 'events' && events < budget) {
      const now = deps.clock().getTime();
      const timeMin = position.timeMin ?? new Date(now - BACKFILL_DAYS * DAY_MS).toISOString();
      const timeMax = position.timeMax ?? new Date(now + BACKFILL_AHEAD_DAYS * DAY_MS).toISOString();
      const pageToken = position.pageToken;
      const page = await deps.accounts.run(account, async (apis) => {
        const { data } = await apis.calendar.events.list({
          calendarId: 'primary',
          singleEvents: true,
          timeMin,
          timeMax,
          maxResults: EVENT_PAGE,
          ...(pageToken ? { pageToken } : {}),
        });
        return { items: data.items ?? [], next: data.nextPageToken ?? null };
      });
      deps.builder.observeEvents(account, page.items);
      events += page.items.length;
      totalEvents += page.items.length;
      if (page.next) {
        position = { phase: 'events', pageToken: page.next, timeMin, timeMax };
        save({});
        continue;
      }
      position = { phase: 'sent', seen: [] };
      save({ backfill: 'done', backfilledAt: deps.clock().toISOString(), error: null });
      deps.logger.info('people backfill done', { account, messages: totalMessages, events: totalEvents });
      return { account, state: 'done', messages, events };
    }
    deps.logger.info('people backfill step', { account, messages, events });
    return { account, state: 'running', messages, events };
  } catch (err) {
    const error = errorText(err);
    // the saved position stays where the last page that worked left it, so the next step goes on from there. an auth
    // error parks the account in accounts.run, so the next step fails at once until the owner signs in again.
    try {
      save({ backfill: 'failed', error });
    } catch (saveErr) {
      deps.logger.warn('people backfill could not save its state', { account, err: saveErr });
    }
    deps.logger.warn('people backfill failed', { account, messages, events, kind: err instanceof GoogleError ? err.kind : undefined });
    return { account, state: 'failed', messages, events, error };
  }
}

// sweepSent reads the sent mail of an account that is newer than sentAfter ("in:sent after:<unix seconds>"), at most
// SENT_SWEEP_MAX messages, gives it to builder.observeMail and moves sentAfter to the newest internal date. it does
// nothing before the backfill is done, because the backfill reads the sent mail itself. it gives the number of
// messages that it read.
export async function sweepSent(deps: BackfillDeps, account: string): Promise<number> {
  const store = deps.store ?? peopleStore;
  const state = store.backfillStateOf(deps.db, account, deps.clock());
  if (state.backfill !== 'done') return 0;
  const position = positionOf(state);
  const seen = new Set(position.phase === 'sent' ? position.seen : []);
  // a backfill that read no sent mail starts the sweep at its own end.
  const since = Date.parse(state.sentAfter ?? state.backfilledAt ?? '');
  const after = Math.floor((Number.isFinite(since) ? since : deps.clock().getTime()) / 1000);
  try {
    const page = await deps.accounts.run(account, async (apis) => {
      const refs = await listMessages(apis, `in:sent after:${after}`, SENT_SWEEP_MAX);
      const fresh = refs.map((ref) => ref.id).filter((id) => !seen.has(id));
      const read = fresh.length > 0 ? await getMessages(apis, fresh, { format: 'metadata', headers: PEOPLE_HEADERS }) : [];
      return { ids: refs.map((ref) => ref.id), read };
    });
    if (page.read.length > 0) deps.builder.observeMail(account, page.read);
    const sentAfter = newestSent(page.read, state.sentAfter, false);
    store.saveBackfillState(deps.db, account, { sentAfter, backfillPage: JSON.stringify({ phase: 'sent', seen: page.ids } satisfies Position) }, deps.clock());
    if (page.read.length > 0) deps.logger.info('people sent sweep', { account, messages: page.read.length });
    return page.read.length;
  } catch (err) {
    deps.logger.warn('people sent sweep failed', { account, kind: err instanceof GoogleError ? err.kind : undefined, error: errorText(err) });
    return 0;
  }
}

// newestSent gives the newest internal date of the messages (only those in SENT unless sentOnly is false) and the
// time before, as an iso string.
function newestSent(messages: readonly gmail_v1.Schema$Message[], before: string | null, sentOnly = true): string | null {
  let newest = before ? Date.parse(before) : NaN;
  for (const message of messages) {
    if (sentOnly && !(message.labelIds ?? []).includes('SENT')) continue;
    const ms = Number(message.internalDate);
    if (Number.isFinite(ms) && ms > 0 && !(ms <= newest)) newest = ms;
  }
  return Number.isFinite(newest) ? new Date(newest).toISOString() : before;
}

// the text of an error for the people_accounts row: the short and redacted message of a google error, or the first
// part of any other message.
function errorText(err: unknown): string {
  if (fromSdk(err)) {
    const error = toGoogleError(err);
    return headOf(`${error.kind}: ${error.message}`, 300);
  }
  return headOf(err instanceof Error ? err.message : String(err), 300);
}
