import type { gmail_v1 } from '@googleapis/gmail';
import type { Db } from '../db/index.js';
import type { GoogleAccounts } from '../google/accounts.js';
import { fromSdk, GoogleError, toGoogleError } from '../google/errors.js';
import { getMessages, listMessages } from '../inbox/gmail.js';
import type { Logger } from '../observability/logger.js';
import { headOf } from '../text.js';
import { normalizeEmail } from './address.js';
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
// the messages that one step reads. the poll gives each account one step. gmail limits the reads of one user per
// minute, and a step that hits the limit reads its page again at the next poll, so a step stays small.
export const BACKFILL_STEP_MESSAGES = 150;
// the sent sweep of one poll reads at most this many new sent messages, the oldest first.
export const SENT_SWEEP_MAX = 50;
// the sent sweep lists at most this many ids in one poll. listing is cheap, and only the oldest SENT_SWEEP_MAX of
// them are read, so mail sent while the agent was off is read over the next polls. more sent mail than this since the
// last sweep loses its oldest part, and the sweep logs it.
export const SENT_LIST_MAX = 2_000;

// the search of the mail phase: inbox, sent and archived mail together, without chats, spam and the trash. the bulk
// tabs of gmail are left out too: mailNoise drops their mail anyway, so leaving them out changes no person, and the
// cap of the backfill then goes to mail that can make one.
export const MAIL_QUERY = `newer_than:${BACKFILL_DAYS}d -in:chats -in:spam -in:trash -category:promotions -category:social -category:updates -category:forums`;
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
  | { phase: 'mail'; pageToken?: string; read?: string[] }
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
// - first the send-as addresses of the account (users.settings.sendAs.list), one time, so mail from an alias of the
//   owner is the owner's. a failure of this read leaves them for the next step and does not stop the backfill.
// - then the mail: messages.list with MAIL_QUERY (inbox, sent and archived mail together, without the bulk tabs), at
//   most budget ids per step and BACKFILL_MAX_MESSAGES in all, then messages.get in the metadata format with
//   PEOPLE_HEADERS (getMessages of src/inbox/gmail.ts) and builder.observeMail.
// - then the events: events.list of the primary calendar with singleEvents, from BACKFILL_DAYS back to
//   BACKFILL_AHEAD_DAYS ahead, page by page, and builder.observeEvents. the poll reads the primary calendar too, so
//   the meetings of a profile do not depend on which of the two read an event first.
// - the position (a json { phase: 'mail' | 'events', pageToken }, and for mail the ids of the page that are read) and the
//   counts are saved after each page and each chunk of READ_CHUNK messages, and the
//   state is done after the last page, with backfilledAt. the first step sets sentAfter to the time it started, so
//   the sent sweep reads the mail that the owner sends while the backfill runs.
// - an account in done does nothing and gives state done with zero counts. an error is saved as failed with the
//   error text, and the next step starts again from the saved position. so is a page whose people the store could
//   not write, so the page is read again. a GoogleError of kind auth stops it without a retry until the account works
//   again. a GoogleError of kind rate (the reads per minute of gmail) ends the step as running, without a failure,
//   and the next step reads the same page.
// - every request goes through accounts.run, so it is in the request trace of the poll run.
export async function backfillStep(deps: BackfillDeps, account: string, budget = BACKFILL_STEP_MESSAGES): Promise<BackfillResult> {
  const store = deps.store ?? peopleStore;
  const state = store.backfillStateOf(deps.db, account, deps.clock());
  if (state.backfill === 'done') return { account, state: 'done', messages: 0, events: 0 };
  let position = positionOf(state);
  let totalMessages = state.backfillMessages;
  let totalEvents = state.backfillEvents;
  const sentAfter = state.sentAfter ?? deps.clock().toISOString();
  let messages = 0;
  let events = 0;
  const save = (change: Partial<Omit<BackfillState, 'account'>>) =>
    store.saveBackfillState(deps.db, account, { backfillPage: JSON.stringify(position), backfillMessages: totalMessages, backfillEvents: totalEvents, sentAfter, ...change }, deps.clock());
  try {
    save({ backfill: 'running', error: null });
    if (state.aliases === null) await readAliases(deps, store, account);
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
        return { ids, next: data.nextPageToken ?? null };
      });
      // the page is read in chunks, and the position keeps the ids that are done, so a rate limit in the middle of a
      // page does not throw away the reads that finished.
      const done = new Set(position.read ?? []);
      const todo = page.ids.filter((id) => !done.has(id));
      for (let start = 0; start < todo.length; start += READ_CHUNK) {
        const chunk = todo.slice(start, start + READ_CHUNK);
        const read = await deps.accounts.run(account, (apis) => getMessages(apis, chunk, { format: 'metadata', headers: PEOPLE_HEADERS }));
        if (deps.builder.observeMail(account, read).failed) throw new StoreFailed();
        for (const id of chunk) done.add(id);
        position = { phase: 'mail', ...(pageToken ? { pageToken } : {}), read: [...done] };
        save({});
      }
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
      if (deps.builder.observeEvents(account, page.items).failed) throw new StoreFailed();
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
    if (err instanceof GoogleError && err.kind === 'rate') {
      // the limit is per minute, so the next poll goes on from the saved position, and nothing has failed.
      save({ backfill: 'running', error: null });
      deps.logger.info('people backfill step waits for the gmail rate limit', { account, messages, events });
      return { account, state: 'running', messages, events };
    }
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

// sweepSent reads the sent mail of an account that is newer than sentAfter ("in:sent after:<unix seconds>"). it lists
// up to SENT_LIST_MAX ids, newest first as gmail gives them, and reads the oldest SENT_SWEEP_MAX that it did not read
// yet. it gives them to builder.observeMail and moves sentAfter to the newest internal date among them. so after a
// pause with more sent mail than one sweep reads, each poll goes on from where the last one stopped, and no mail is
// skipped. "after:" counts whole seconds and gives the mail of that second again, so the position keeps the ids that
// it read. a write of the store that failed keeps the old position, so the next poll reads the mail again. it does
// nothing before the backfill is done, because the backfill reads the sent mail itself. it gives the number of
// messages that it read.
export async function sweepSent(deps: BackfillDeps, account: string): Promise<number> {
  const store = deps.store ?? peopleStore;
  const state = store.backfillStateOf(deps.db, account, deps.clock());
  if (state.backfill !== 'done') return 0;
  const position = positionOf(state);
  const seen = new Set(position.phase === 'sent' ? position.seen : []);
  // a backfill row from before sentAfter was set at its start begins the sweep at the end of the backfill.
  const since = Date.parse(state.sentAfter ?? state.backfilledAt ?? '');
  const after = Math.floor((Number.isFinite(since) ? since : deps.clock().getTime()) / 1000);
  try {
    if (state.aliases === null) await readAliases(deps, store, account);
    const page = await deps.accounts.run(account, async (apis) => {
      const refs = await listMessages(apis, `in:sent after:${after}`, SENT_LIST_MAX);
      const ids = refs.map((ref) => ref.id);
      const fresh = ids.filter((id) => !seen.has(id));
      const batch = fresh.slice(-SENT_SWEEP_MAX);
      const read = batch.length > 0 ? await getMessages(apis, batch, { format: 'metadata', headers: PEOPLE_HEADERS }) : [];
      return { ids, batch, read, more: fresh.length - batch.length, full: refs.length >= SENT_LIST_MAX };
    });
    if (page.read.length > 0 && deps.builder.observeMail(account, page.read).failed) {
      deps.logger.warn('people sent sweep could not write, so the next poll reads the mail again', { account, messages: page.read.length });
      return 0;
    }
    if (page.full) deps.logger.warn('people sent sweep found more sent mail than it lists, so the oldest part is not read', { account, listed: page.ids.length });
    const sentAfter = newestSent(page.read, state.sentAfter);
    // the ids that the next sweep can list again: those of this sweep, and the ones read before that are still in the
    // list, which are in the same second as sentAfter.
    const listed = new Set(page.ids);
    const keep = [...[...seen].filter((id) => listed.has(id)), ...page.batch].slice(-SEEN_MAX);
    store.saveBackfillState(deps.db, account, { sentAfter, backfillPage: JSON.stringify({ phase: 'sent', seen: keep } satisfies Position) }, deps.clock());
    if (page.read.length > 0) deps.logger.info('people sent sweep', { account, messages: page.read.length, ...(page.more > 0 ? { left: page.more } : {}) });
    return page.read.length;
  } catch (err) {
    deps.logger.warn('people sent sweep failed', { account, kind: err instanceof GoogleError ? err.kind : undefined, error: errorText(err) });
    return 0;
  }
}

// the messages of a page of the mail phase that one request batch reads before the position is saved.
const READ_CHUNK = 50;

// the most ids that the position of the sent sweep keeps.
const SEEN_MAX = 200;

// the store could not write the people of a page. the step fails, and the next one reads the page again.
class StoreFailed extends Error {
  constructor() {
    super('the people store could not write a page');
  }
}

// readAliases saves the send-as addresses of an account (the owner's own other addresses, for example a work alias),
// so ownerAddresses of the builder counts them as the owner's. it saves them only when gmail answered. an auth error
// stops the caller, because every other read of the account fails too, and any other failure leaves them for the
// next poll.
async function readAliases(deps: BackfillDeps, store: Pick<PeopleStore, 'saveBackfillState'>, account: string): Promise<void> {
  try {
    const aliases = await deps.accounts.run(account, async (apis) => {
      const { data } = await apis.gmail.users.settings.sendAs.list({ userId: 'me' });
      return (data.sendAs ?? []).flatMap((each) => {
        const email = each.sendAsEmail ? normalizeEmail(each.sendAsEmail) : null;
        return email ? [email] : [];
      });
    });
    store.saveBackfillState(deps.db, account, { aliases }, deps.clock());
  } catch (err) {
    if (err instanceof GoogleError && (err.kind === 'auth' || err.kind === 'client')) throw err;
    deps.logger.debug('people could not read the send-as addresses', { account, kind: err instanceof GoogleError ? err.kind : undefined });
  }
}

// newestSent gives the newest internal date of the messages and the time before, as an iso string.
function newestSent(messages: readonly gmail_v1.Schema$Message[], before: string | null): string | null {
  let newest = before ? Date.parse(before) : NaN;
  for (const message of messages) {
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
