import type { calendar_v3 } from '@googleapis/calendar';
import type { gmail_v1 } from '@googleapis/gmail';
import type { Db } from '../db/index.js';
import type { BlobStore } from '../observability/blobs.js';
import type { Logger } from '../observability/logger.js';
import { redactedJson } from '../observability/redact.js';
import type { CalendarItem } from '../signals/detectors.js';
import { addSignals, cleanLine, inTransaction, type NewSignal } from '../signals/store.js';
import { zonedToUtc, type Clock } from '../time.js';
import type { GoogleAccounts } from './accounts.js';
import { GoogleError } from './errors.js';

// the result of one account in one poll. events is the live range of the calendar for the detectors, or undefined
// when it was not read.
export interface AccountPoll {
  alias: string;
  ok: boolean;
  error?: string;
  // the gmail history id was too old, so only the inbox mail of the last days became signals.
  resync?: boolean;
  failures: number;
  events?: CalendarItem[];
}

export interface Sync {
  // pollAll polls every signed-in account. one account that fails does not stop the others. a second call during a
  // poll joins the running poll.
  pollAll(runId: string): Promise<AccountPoll[]>;
  // reset forgets the cursors and the open signals of an account, for example after it got a new mailbox.
  reset(alias: string): void;
}

export interface SyncDeps {
  db: Db;
  clock: Clock;
  logger: Logger;
  blobs: BlobStore;
  accounts: GoogleAccounts;
  timeZone: string;
}

// a poll reads at most this many history pages. a large import of mail then moves the cursor in steps, and each
// poll ends in bounded time.
const HISTORY_PAGES = 10;
const HISTORY_PAGE_SIZE = 500;
// a resync after a lost history id looks back this far and takes at most this many messages. older mail is not news.
const RESYNC_QUERY = 'in:inbox newer_than:2d';
const RESYNC_MAX = 100;
// the details of at most this many new messages per account and poll. the rest wait for the next poll.
const HYDRATE_MAX = 50;
const CALENDAR_PAGES = 20;
const DAY_MS = 24 * 60 * 60_000;
// the first calendar read starts one day back. a full read of an old calendar with every instance of each recurring
// event can be too large to finish.
const FIRST_READ_BACK_MS = DAY_MS;
// the detectors read the calendars from yesterday to this many days ahead. the date detector looks 60 days ahead.
const RANGE_AHEAD_DAYS = 61;
const RANGE_PAGES = 4;
const HEADERS = ['From', 'Subject', 'Date', 'List-Unsubscribe', 'List-Unsubscribe-Post'];

type Gmail = gmail_v1.Gmail;

class CursorMoved extends Error {}

export function createSync(deps: SyncDeps): Sync {
  const { db, clock, logger, accounts, timeZone } = deps;
  let running: Promise<AccountPoll[]> | undefined;

  const cursorOf = (alias: string, column: 'historyId' | 'calendarSyncToken'): string | null =>
    (db.prepare(`SELECT ${column} AS cursor FROM google_accounts WHERE alias = ?`).get(alias)?.cursor as string | null | undefined) ?? null;

  // the compare and set fails when another process moved the cursor first. the transaction then rolls back the rows
  // too. they are idempotent, so nothing is lost, and the poll counts as done.
  const moveCursor = (alias: string, column: 'historyId' | 'calendarSyncToken', from: string | null, to: string | null) => {
    const result = db.prepare(`UPDATE google_accounts SET ${column} = ? WHERE alias = ? AND ${column} IS ?`).run(to, alias, from);
    if (Number(result.changes) !== 1) throw new CursorMoved();
  };

  // phase one finds the ids of new inbox mail and moves the cursor in one transaction. it fetches no message, so its
  // work is small and a crash between pages loses nothing: the cursor did not move.
  const discoverMail = async (alias: string, runId: string): Promise<{ resync?: boolean }> => {
    const cursor = cursorOf(alias, 'historyId');
    if (cursor === null) {
      // the sign-in takes the baseline. an account without one starts now: the mail that is already there is not news.
      const profile = await accounts.run(alias, (apis) => apis.gmail.users.getProfile({ userId: 'me' }));
      inTransaction(db, () => moveCursor(alias, 'historyId', null, String(profile.data.historyId)));
      return {};
    }
    // the api calls run inside accounts.run, and the commit runs after it. an error of the database then stays a
    // database error.
    let found: { ids: string[]; next: string };
    let resync = false;
    try {
      found = await accounts.run(alias, (apis) => readHistory(apis.gmail, cursor));
    } catch (err) {
      // google keeps the history for about a week. an older id gives a 404, and only a resync can go on.
      if (!(err instanceof GoogleError) || err.kind !== 'not_found') throw err;
      logger.warn('gmail history id expired, so the account syncs again', { alias });
      found = await accounts.run(alias, (apis) => resyncMail(apis.gmail));
      resync = true;
    }
    inTransaction(db, () => {
      addSignals(db, found.ids.map((id) => ({ source: 'gmail', account: alias, externalId: id, kind: 'mail', state: 'new', runId })), clock());
      moveCursor(alias, 'historyId', cursor, found.next);
    });
    return resync ? { resync } : {};
  };

  const readHistory = async (api: Gmail, cursor: string) => {
    const ids: string[] = [];
    let pageToken: string | undefined;
    let next = cursor;
    for (let page = 0; page < HISTORY_PAGES; page++) {
      const { data } = await api.users.history.list({
        userId: 'me',
        startHistoryId: cursor,
        historyTypes: ['messageAdded'],
        maxResults: HISTORY_PAGE_SIZE,
        ...(pageToken ? { pageToken } : {}),
      });
      for (const record of data.history ?? []) {
        for (const added of record.messagesAdded ?? []) {
          if (added.message?.id && (added.message.labelIds ?? []).includes('INBOX')) ids.push(added.message.id);
        }
        // a history record id is the newest point that this poll has fully read.
        if (record.id) next = record.id;
      }
      pageToken = data.nextPageToken ?? undefined;
      if (!pageToken) {
        next = data.historyId ?? next;
        break;
      }
    }
    return { ids, next };
  };

  // the start id comes first, then the list. mail that arrives between the two comes again through the history,
  // and the unique key drops the copy. the other order could miss that mail.
  const resyncMail = async (api: Gmail) => {
    const profile = await api.users.getProfile({ userId: 'me' });
    const { data } = await api.users.messages.list({ userId: 'me', q: RESYNC_QUERY, maxResults: RESYNC_MAX });
    const ids = (data.messages ?? []).map((each) => each.id).filter((id): id is string => !!id);
    return { ids, next: String(profile.data.historyId) };
  };

  // phase two fetches the headers of the new rows. each row is done on its own, so a failure in the middle keeps the
  // rows before it, and the next poll goes on from there.
  const hydrateMail = async (alias: string) => {
    const rows = db
      .prepare("SELECT id, externalId FROM integration_events WHERE source = 'gmail' AND account = ? AND state = 'new' ORDER BY id LIMIT ?")
      .all(alias, HYDRATE_MAX) as Array<{ id: number; externalId: string }>;
    for (const row of rows) {
      let message: gmail_v1.Schema$Message;
      try {
        message = (await accounts.run(alias, (apis) => apis.gmail.users.messages.get({ userId: 'me', id: row.externalId, format: 'metadata', metadataHeaders: HEADERS }))).data;
      } catch (err) {
        if (err instanceof GoogleError && err.kind === 'not_found') {
          db.prepare("UPDATE integration_events SET state = 'gone' WHERE id = ?").run(row.id);
          continue;
        }
        throw err;
      }
      const labels = message.labelIds ?? [];
      if (!labels.includes('INBOX') || labels.includes('SPAM') || labels.includes('TRASH')) {
        db.prepare("UPDATE integration_events SET state = 'skipped' WHERE id = ?").run(row.id);
        continue;
      }
      const header = (name: string) => message.payload?.headers?.find((each) => each.name?.toLowerCase() === name.toLowerCase())?.value ?? '';
      const fields = { from: header('From'), subject: header('Subject'), date: header('Date'), snippet: message.snippet ?? '', threadId: message.threadId ?? '' };
      const arrived = Number(message.internalDate) ? new Date(Number(message.internalDate)) : clock();
      // the blob keeps the fields for the dashboard. a failed blob write keeps the row, as the trace does.
      let blob: string | null = null;
      try {
        blob = deps.blobs.put(redactedJson({ ...fields, listUnsubscribe: header('List-Unsubscribe'), listUnsubscribePost: header('List-Unsubscribe-Post') }), 'application/json');
      } catch (err) {
        logger.error('signal blob write failed', { alias, id: row.id, err });
      }
      db.prepare("UPDATE integration_events SET state = 'ready', summary = ?, occursAt = ?, payloadBlob = ? WHERE id = ? AND state = 'new'").run(
        cleanLine(`from ${fields.from}: "${fields.subject}" ${fields.snippet}`),
        arrived.toISOString(),
        blob,
        row.id,
      );
    }
  };

  const syncCalendar = async (alias: string, runId: string): Promise<void> => {
    const cursor = cursorOf(alias, 'calendarSyncToken');
    try {
      await readCalendar(alias, cursor, runId);
    } catch (err) {
      // a sync token that google no longer knows gives 410. the read starts again like a first read.
      if (!(err instanceof GoogleError) || err.kind !== 'gone' || cursor === null) throw err;
      logger.warn('calendar sync token expired, so the account syncs again', { alias });
      inTransaction(db, () => moveCursor(alias, 'calendarSyncToken', cursor, null));
      await readCalendar(alias, null, runId);
    }
  };

  // a first read (no cursor) only gets the sync token, and it makes no signals, because the events in it are not
  // changes. a later read uses the same singleEvents, because google ties the token to the parameters of the first read.
  const readCalendar = async (alias: string, cursor: string | null, runId: string) => {
    const timeMin = new Date(clock().getTime() - FIRST_READ_BACK_MS).toISOString();
    let pageToken: string | undefined;
    for (let page = 0; page < CALENDAR_PAGES; page++) {
      const { data } = await accounts.run(alias, (apis) =>
        apis.calendar.events.list({
          calendarId: 'primary',
          singleEvents: true,
          maxResults: 250,
          ...(cursor === null ? { timeMin } : { syncToken: cursor, showDeleted: true }),
          ...(pageToken ? { pageToken } : {}),
        }),
      );
      // each page commits its signals. the cursor moves only after the last page, and a page that comes again adds
      // nothing, because the signal key holds the version of the event.
      if (cursor !== null) inTransaction(db, () => addSignals(db, (data.items ?? []).flatMap((event) => calendarSignal(alias, event, runId)), clock()));
      pageToken = data.nextPageToken ?? undefined;
      if (!pageToken) {
        if (!data.nextSyncToken) throw new GoogleError('request', 'the calendar list ended without a sync token');
        inTransaction(db, () => moveCursor(alias, 'calendarSyncToken', cursor, data.nextSyncToken!));
        return;
      }
    }
    throw new GoogleError('request', `the calendar has more than ${CALENDAR_PAGES} pages of changes. the next poll goes on.`);
  };

  // only a change by another person is news. a change that the owner made, for example through the agent, is not.
  // a cancelled event in an incremental list often has no organizer, and without a copy of the calendar the poll
  // cannot tell whose it was, so it makes no signal.
  const calendarSignal = (alias: string, event: calendar_v3.Schema$Event, runId: string): NewSignal[] => {
    if (!event.id || !event.updated || !event.organizer || event.organizer.self === true) return [];
    const invite = event.attendees?.some((each) => each.self && each.responseStatus === 'needsAction');
    const start = startOf(event);
    const title = typeof event.summary === 'string' ? cleanLine(event.summary, 200) : '(no title)';
    return [
      {
        source: 'calendar',
        account: alias,
        externalId: `${event.id}@${event.updated}`,
        kind: invite ? 'invite' : 'event_change',
        summary: cleanLine(`${event.organizer.email ?? 'someone'}: "${title}"${event.status === 'cancelled' ? ' (cancelled)' : ''}${start ? ` at ${start}` : ''}`),
        ...(start ? { occursAt: occursAt(start) } : {}),
        runId,
      },
    ];
  };

  // an all-day event has a date only. its time is midnight of that date in the owner's zone, so the digest shows the
  // right day.
  const occursAt = (start: string) => (start.length === 10 ? zonedToUtc(start, '00:00', timeZone) : new Date(start)).toISOString();

  // one live read of the calendar for the detectors. events that the owner declined are not on the calendar.
  const readRange = async (alias: string): Promise<CalendarItem[]> => {
    const now = clock().getTime();
    const items: CalendarItem[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < RANGE_PAGES; page++) {
      const { data } = await accounts.run(alias, (apis) =>
        apis.calendar.events.list({
          calendarId: 'primary',
          singleEvents: true,
          orderBy: 'startTime',
          maxResults: 250,
          timeMin: new Date(now - DAY_MS).toISOString(),
          timeMax: new Date(now + RANGE_AHEAD_DAYS * DAY_MS).toISOString(),
          ...(pageToken ? { pageToken } : {}),
        }),
      );
      for (const event of data.items ?? []) {
        const start = startOf(event);
        const declined = event.attendees?.some((each) => each.self && each.responseStatus === 'declined');
        if (!event.id || !start || event.status === 'cancelled' || declined) continue;
        items.push({ account: alias, id: event.id, summary: event.summary ?? '', start, allDay: start.length === 10 });
      }
      pageToken = data.nextPageToken ?? undefined;
      if (!pageToken) break;
    }
    return items;
  };

  const pollAccount = async (alias: string, runId: string): Promise<AccountPoll> => {
    let resync = false;
    try {
      resync = !!(await discoverMail(alias, runId)).resync;
      await hydrateMail(alias);
      await syncCalendar(alias, runId);
      const events = await readRange(alias);
      db.prepare("UPDATE google_accounts SET failures = 0, lastError = NULL, lastErrorAt = NULL WHERE alias = ? AND status = 'ok'").run(alias);
      return { alias, ok: true, failures: 0, events, ...(resync ? { resync } : {}) };
    } catch (err) {
      if (err instanceof CursorMoved) {
        logger.info('another process moved the sync cursor first', { alias });
        return { alias, ok: true, failures: 0, ...(resync ? { resync } : {}) };
      }
      const error = err instanceof Error ? err : new Error(String(err));
      const now = clock().toISOString();
      const row = db
        .prepare('UPDATE google_accounts SET failures = failures + 1, lastError = ?, lastErrorAt = ?, updatedAt = ? WHERE alias = ? RETURNING failures')
        .get(error.message, now, now, alias);
      logger.warn('google poll failed', { alias, err: error });
      return { alias, ok: false, error: error.message, failures: Number(row?.failures ?? 0), ...(resync ? { resync } : {}) };
    }
  };

  return {
    pollAll(runId) {
      running ??= Promise.all(accounts.aliases.filter((alias) => !accounts.unavailable(alias)).map((alias) => pollAccount(alias, runId))).finally(
        () => (running = undefined),
      );
      return running;
    },
    reset(alias) {
      inTransaction(db, () => {
        db.prepare('UPDATE google_accounts SET historyId = NULL, calendarSyncToken = NULL WHERE alias = ?').run(alias);
        db.prepare("UPDATE integration_events SET handledAt = ?, handledAs = 'stale', handledBy = 'reset' WHERE account = ? AND source IN ('gmail', 'calendar') AND handledAt IS NULL").run(
          clock().toISOString(),
          alias,
        );
      });
    },
  };
}

// the start of an event: an iso time, or a date (YYYY-MM-DD) for an all-day event.
function startOf(event: calendar_v3.Schema$Event): string | undefined {
  return event.start?.dateTime ? new Date(event.start.dateTime).toISOString() : (event.start?.date ?? undefined);
}
