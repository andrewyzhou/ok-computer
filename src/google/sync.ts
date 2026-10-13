import type { calendar_v3 } from '@googleapis/calendar';
import type { gmail_v1 } from '@googleapis/gmail';
import type { Db } from '../db/index.js';
import type { BlobStore } from '../observability/blobs.js';
import type { Logger } from '../observability/logger.js';
import { redactedJson } from '../observability/redact.js';
import type { Clock } from '../time.js';
import type { GoogleAccounts } from './accounts.js';
import { GoogleError } from './errors.js';
import { addSignals, cleanLine, inTransaction, type NewSignal } from './signals.js';

export interface SyncReport {
  alias: string;
  api: 'gmail' | 'calendar';
  ok: boolean;
  added: number;
  error?: string;
  resync?: boolean;
}

export interface Sync {
  // pollAll polls every signed-in account. one account that fails does not stop the others. a second call during a
  // poll joins the running poll.
  pollAll(): Promise<SyncReport[]>;
  // reset forgets the cursors, the calendar copy and the open signals of an account, for example after it got a new
  // mailbox.
  reset(alias: string): void;
}

export interface SyncDeps {
  db: Db;
  clock: Clock;
  logger: Logger;
  blobs: BlobStore;
  accounts: GoogleAccounts;
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
const HEADERS = ['From', 'Subject', 'Date', 'List-Unsubscribe', 'List-Unsubscribe-Post'];

type Gmail = gmail_v1.Gmail;
type Calendar = calendar_v3.Calendar;

export function createSync(deps: SyncDeps): Sync {
  const { db, clock, logger, accounts } = deps;
  let running: Promise<SyncReport[]> | undefined;

  const cursorOf = (alias: string, api: string): string | null => {
    db.prepare('INSERT INTO google_sync (alias, api) VALUES (?, ?) ON CONFLICT DO NOTHING').run(alias, api);
    return (db.prepare('SELECT cursor FROM google_sync WHERE alias = ? AND api = ?').get(alias, api)?.cursor as string | null) ?? null;
  };

  // the compare and set fails when another process moved the cursor first. the transaction then rolls back the rows
  // too. they are idempotent, so nothing is lost, and the poll counts as done.
  const moveCursor = (alias: string, api: string, from: string | null, to: string) => {
    const result = db.prepare('UPDATE google_sync SET cursor = ? WHERE alias = ? AND api = ? AND cursor IS ?').run(to, alias, api, from);
    if (Number(result.changes) !== 1) throw new CursorMoved();
  };

  const record = (alias: string, api: string, error?: GoogleError | Error) => {
    const now = clock().toISOString();
    if (error) {
      db.prepare('UPDATE google_sync SET lastPollAt = ?, failures = failures + 1, lastError = ? WHERE alias = ? AND api = ?').run(now, error.message, alias, api);
    } else {
      db.prepare('UPDATE google_sync SET lastPollAt = ?, lastOkAt = ?, failures = 0, lastError = NULL WHERE alias = ? AND api = ?').run(now, now, alias, api);
    }
  };

  // phase one finds the ids of new inbox mail and moves the cursor in one transaction. it fetches no message, so its
  // work is small and a crash between pages loses nothing: the cursor did not move.
  const discoverMail = async (alias: string): Promise<{ added: number; resync?: boolean }> => {
    const cursor = cursorOf(alias, 'gmail');
    if (cursor === null) {
      // the first poll takes the current history id as its start. the mail that is already there is not news.
      const profile = await accounts.run(alias, (apis) => apis.gmail.users.getProfile({ userId: 'me' }));
      inTransaction(db, () => moveCursor(alias, 'gmail', null, String(profile.data.historyId)));
      return { added: 0 };
    }
    // the api calls run inside accounts.run, and the commit runs after it. a retry after a 401 then never repeats a
    // write, and an error of the database stays a database error.
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
    return { added: commitMail(alias, cursor, found.next, found.ids), ...(resync ? { resync } : {}) };
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
          const labels = added.message?.labelIds ?? [];
          if (added.message?.id && labels.includes('INBOX')) ids.push(added.message.id);
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

  const commitMail = (alias: string, from: string, to: string, ids: string[]) =>
    inTransaction(db, () => {
      const added = addSignals(db, ids.map((id) => ({ source: 'gmail', account: alias, externalId: id, kind: 'mail', state: 'new' })), clock());
      moveCursor(alias, 'gmail', from, to);
      return added;
    });

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
      const summary = cleanLine(`from ${fields.from}: "${fields.subject}" ${fields.snippet}`);
      const occursAt = Number(message.internalDate) ? new Date(Number(message.internalDate)).toISOString() : null;
      // the blob keeps the fields for the dashboard. a failed blob write keeps the row, as the trace does.
      let blob: string | null = null;
      try {
        blob = deps.blobs.put(redactedJson({ ...fields, listUnsubscribe: header('List-Unsubscribe'), listUnsubscribePost: header('List-Unsubscribe-Post') }), 'application/json');
      } catch (err) {
        logger.error('signal blob write failed', { alias, id: row.id, err });
      }
      db.prepare("UPDATE integration_events SET state = 'ready', summary = ?, occursAt = ?, payloadBlob = ? WHERE id = ? AND state = 'new'").run(summary, occursAt, blob, row.id);
    }
  };

  const syncCalendar = async (alias: string): Promise<{ added: number; resync?: boolean }> => {
    const cursor = cursorOf(alias, 'calendar');
    try {
      return await readCalendar(alias, cursor);
    } catch (err) {
      // a sync token that google no longer knows gives 410. the copy of the calendar starts again from nothing.
      if (!(err instanceof GoogleError) || err.kind !== 'gone' || cursor === null) throw err;
      logger.warn('calendar sync token expired, so the account syncs again', { alias });
      inTransaction(db, () => {
        db.prepare('DELETE FROM calendar_events WHERE alias = ?').run(alias);
        moveCursor(alias, 'calendar', cursor, '');
      });
      return { ...(await readCalendar(alias, '')), resync: true };
    }
  };

  // an empty cursor means a full read. a full read writes the copy of the calendar but makes no signals, because the
  // events in it are not changes.
  const readCalendar = async (alias: string, cursor: string | null) => {
    const full = !cursor;
    let pageToken: string | undefined;
    let added = 0;
    for (let page = 0; page < CALENDAR_PAGES; page++) {
      const { data } = await accounts.run(alias, (apis: { calendar: Calendar }) =>
        apis.calendar.events.list({
          calendarId: 'primary',
          singleEvents: true,
          maxResults: 250,
          ...(full ? {} : { syncToken: cursor!, showDeleted: true }),
          ...(pageToken ? { pageToken } : {}),
        }),
      );
      // each page commits its rows. the cursor moves only after the last page, and a page that comes again changes
      // nothing, because the copy keeps the newest version and the signal key holds the version.
      added += inTransaction(db, () => {
        const signals = (data.items ?? []).flatMap((event) => saveEvent(alias, event));
        return full ? 0 : addSignals(db, signals, clock());
      });
      pageToken = data.nextPageToken ?? undefined;
      if (!pageToken) {
        if (!data.nextSyncToken) throw new GoogleError('request', 'the calendar list ended without a sync token');
        inTransaction(db, () => moveCursor(alias, 'calendar', cursor, data.nextSyncToken!));
        return { added };
      }
    }
    throw new GoogleError('request', `the calendar has more than ${CALENDAR_PAGES} pages of changes. the next poll goes on.`);
  };

  const saveEvent = (alias: string, event: calendar_v3.Schema$Event): NewSignal[] => {
    if (!event.id || !event.updated) return [];
    const stored = db.prepare('SELECT summary, startAt, organizerSelf, updated FROM calendar_events WHERE alias = ? AND eventId = ?').get(alias, event.id) as
      | { summary: string; startAt: string | null; organizerSelf: number; updated: string }
      | undefined;
    if (stored && stored.updated >= event.updated) return [];
    // a cancelled event in an incremental list has only its id and status. the copy keeps what it knew before.
    const allDay = !event.start?.dateTime;
    const startText = event.start?.dateTime ?? event.start?.date;
    const endText = event.end?.dateTime ?? event.end?.date;
    const start = startText ? toIso(startText, allDay) : (stored?.startAt ?? null);
    const end = endText ? toIso(endText, allDay) : null;
    const summary = typeof event.summary === 'string' ? cleanLine(event.summary, 200) : (stored?.summary ?? '');
    const organizerSelf = event.organizer ? event.organizer.self === true : (stored?.organizerSelf ?? 1) === 1;
    db.prepare(
      `INSERT INTO calendar_events (alias, eventId, status, summary, startAt, endAt, allDay, organizerSelf, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (alias, eventId) DO UPDATE SET status = excluded.status, summary = excluded.summary, startAt = excluded.startAt,
         endAt = excluded.endAt, allDay = excluded.allDay, organizerSelf = excluded.organizerSelf, updated = excluded.updated`,
    ).run(alias, event.id, event.status ?? 'confirmed', summary, start, end, allDay ? 1 : 0, organizerSelf ? 1 : 0, event.updated);
    // a change that the owner made, for example through the agent, is not news. a change by another person is.
    if (organizerSelf) return [];
    const invite = event.attendees?.some((each) => each.self && each.responseStatus === 'needsAction');
    const kind = event.status === 'cancelled' ? 'event_cancelled' : invite ? 'invite' : 'event_change';
    return [
      {
        source: 'calendar',
        account: alias,
        externalId: `${event.id}@${event.updated}`,
        kind,
        summary: cleanLine(`${event.organizer?.email ?? 'someone'}: "${summary}"${start ? ` at ${start}` : ''}`),
        ...(start ? { occursAt: start } : {}),
      },
    ];
  };

  const pollAccount = async (alias: string): Promise<SyncReport[]> => {
    const reports: SyncReport[] = [];
    try {
      const mail = await discoverMail(alias);
      await hydrateMail(alias);
      record(alias, 'gmail');
      reports.push({ alias, api: 'gmail', ok: true, ...mail });
    } catch (err) {
      reports.push(failure(alias, 'gmail', err));
    }
    // a parked account stops here. a second call with a dead token would only repeat the error.
    if (accounts.unavailable(alias)) return reports;
    try {
      reports.push({ alias, api: 'calendar', ok: true, ...(await syncCalendar(alias)) });
      record(alias, 'calendar');
    } catch (err) {
      reports.push(failure(alias, 'calendar', err));
    }
    return reports;
  };

  const failure = (alias: string, api: 'gmail' | 'calendar', err: unknown): SyncReport => {
    if (err instanceof CursorMoved) {
      logger.info('another process moved the sync cursor first', { alias, api });
      return { alias, api, ok: true, added: 0 };
    }
    const error = err instanceof Error ? err : new Error(String(err));
    record(alias, api, error);
    logger.warn('google poll failed', { alias, api, err: error });
    return { alias, api, ok: false, added: 0, error: error.message };
  };

  return {
    pollAll() {
      running ??= Promise.all(accounts.aliases.filter((alias) => !accounts.unavailable(alias)).map(pollAccount))
        .then((each) => each.flat())
        .finally(() => (running = undefined));
      return running;
    },
    reset(alias) {
      inTransaction(db, () => {
        db.prepare('DELETE FROM google_sync WHERE alias = ?').run(alias);
        db.prepare('DELETE FROM calendar_events WHERE alias = ?').run(alias);
        db.prepare("UPDATE integration_events SET handledAt = ?, handledBy = 'reset' WHERE account = ? AND handledAt IS NULL").run(clock().toISOString(), alias);
      });
    },
  };
}

class CursorMoved extends Error {}

// an all-day event has a date only. it is stored as midnight utc of that date, which the detectors compare by day.
function toIso(value: string, allDay: boolean): string {
  return allDay ? `${value}T00:00:00.000Z` : new Date(value).toISOString();
}
