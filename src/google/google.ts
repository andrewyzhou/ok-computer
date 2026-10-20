import { randomUUID } from 'node:crypto';
import type { Config } from '../config/schema.js';
import type { Db } from '../db/index.js';
import { getSetting, setSetting } from '../db/settings.js';
import type { SecretStore } from '../integrations/secrets.js';
import type { SlotRunner } from '../models/slots.js';
import type { BlobStore } from '../observability/blobs.js';
import type { Logger } from '../observability/logger.js';
import { redact } from '../observability/redact.js';
import { backfillStep, sweepSent } from '../people/backfill.js';
import { createPeopleBuilder, type PeopleBuilder } from '../people/builder.js';
import type { JobResult } from '../scheduler/scheduler.js';
import { createAutomation, listAutomations, updateAutomation } from '../scheduler/store.js';
import { classifySignals } from '../signals/classify.js';
import { dateHits, soonSignals, type CalendarItem, type MailItem } from '../signals/detectors.js';
import { addSignals, saveHits } from '../signals/store.js';
import type { Clock } from '../time.js';
import { errorText, type Tool } from '../tools/registry.js';
import { createGoogleAccounts, type GoogleAccounts, type GoogleEndpoints } from './accounts.js';
import type { GoogleConfig } from './config.js';
import { createSync, type AccountPoll, type Sync } from './sync.js';
import { createGoogleTools, googleToolsFor } from './tools.js';
import { createRequestTrace, requestContext } from './trace.js';
import { ONE_CLICK_BODY, oneClick, type OneClickResult } from './unsubscribe.js';

export interface Google {
  accounts: GoogleAccounts;
  sync: Sync;
  tools: Tool[];
  // the google tool names of a session profile (main or auto, which can be read only). they depend only on the
  // config, so the tools parameter of a session never changes.
  toolNames(profile: string): string[];
  // poll is the job of the poll automation: sync every account, run the detectors, then label the new mail.
  poll(): Promise<JobResult>;
  // the one-click unsubscribe post (rfc 8058), with its row in the request trace. the inbox jobs use it after an
  // approval, as gmail_unsubscribe does.
  oneClick(target: string): Promise<OneClickResult>;
  close(): Promise<void>;
}

export interface GoogleDeps {
  db: Db;
  clock: Clock;
  logger: Logger;
  blobs: BlobStore;
  secrets: SecretStore;
  slots: SlotRunner;
  config: GoogleConfig;
  timeZone: string;
  // false means that the message did not reach the owner. the alerts of the poll then try again at the next poll.
  notifyOwner: (text: string) => Promise<boolean>;
  endpoints?: GoogleEndpoints;
  // false in npm run chat. the background app polls, so two processes do not poll the same accounts.
  polls?: boolean;
  signal?: AbortSignal;
  newId?: () => string;
  // tests replace the https post of a one-click unsubscribe.
  oneClick?: (target: string) => Promise<OneClickResult>;
  // the people memory. the default builder writes the real store. backfill false leaves out the backfill and the sent
  // sweep, so a test reads only what the poll reads.
  people?: { builder?: PeopleBuilder; backfill?: boolean };
}

const POLL_SYNCED_EVERY = 'google_poll_synced_every_ms';

// the poll automation follows the config at each start, as the heartbeat does. a pause by the owner stays until the
// interval in the config changes. without a google block the automation is turned off, not deleted, so its history
// stays. the stored interval is 0 then, so a block that comes back with the same interval turns the poll on again.
export function syncGooglePoll(db: Db, config: Pick<Config, 'google' | 'timeZone'>, now: Date): void {
  const existing = listAutomations(db).find((each) => each.payload.type === 'poll' && each.payload.source === 'google');
  const everyMs = config.google ? config.google.pollMinutes * 60_000 : 0;
  const synced = getSetting<number>(db, POLL_SYNCED_EVERY) ?? (existing?.schedule.kind === 'every' ? existing.schedule.everyMs : undefined);
  setSetting(db, POLL_SYNCED_EVERY, everyMs, now);
  if (!everyMs) {
    if (existing?.enabled) updateAutomation(db, existing.id, { enabled: false }, now, config.timeZone);
    return;
  }
  const schedule = { kind: 'every' as const, everyMs };
  if (!existing) {
    createAutomation(db, { name: 'google poll', schedule, payload: { type: 'poll', source: 'google' }, slot: 'utility', createdBy: 'system' }, now, config.timeZone);
  } else if (synced !== everyMs) {
    updateAutomation(db, existing.id, { schedule, enabled: true }, now, config.timeZone);
  }
}

// after this many failed polls in a row (about three hours at 15 minutes), the owner hears one time. a long outage
// would otherwise hide every deadline without a word. the claim (stallAlertedAt) stays only after a send that reached
// the owner, so a failed send tries again at the next poll. a poll that works ends the run of failures.
const STALL_POLLS = 12;
export const POLL_SESSION = 'poll:google';
// the detectors check mail that arrived in the last three days. older mail is closed as stale anyway.
const CHECK_WINDOW_MS = 3 * 24 * 60 * 60_000;

export function createGoogle(deps: GoogleDeps): Google {
  const { db, clock, logger, config } = deps;
  const newId = deps.newId ?? randomUUID;
  const trace = createRequestTrace({ db, blobs: deps.blobs, logger, clock });
  const accounts = createGoogleAccounts({
    db,
    clock,
    logger,
    secrets: deps.secrets,
    config,
    trace,
    ...(deps.endpoints ? { endpoints: deps.endpoints } : {}),
    onNeedsAuth: (_alias, text) => deps.notifyOwner(text),
    onNewMailbox: (alias) => sync.reset(alias),
  });
  // the expected addresses of the config count as the owner's, also before the first sign-in of an account.
  const people =
    deps.people?.builder ??
    createPeopleBuilder({ db, clock, logger, timeZone: deps.timeZone, ownerEmails: config.accounts.flatMap((each) => (each.email ? [each.email] : [])) });
  const sync = createSync({ db, clock, logger, blobs: deps.blobs, accounts, timeZone: deps.timeZone, people });
  // the one-click post goes to the sender, not to google, and it is in the same trace as the read that checked it.
  const recordedOneClick = async (target: string) => {
    const done = trace('POST', target, ONE_CLICK_BODY);
    const result = await oneClick(target);
    done({ ...(result.status ? { status: result.status } : {}), ...(result.ok ? {} : { error: result.text }) });
    return result;
  };
  const postOneClick = deps.oneClick ? (target: string) => deps.oneClick!(target) : recordedOneClick;
  const tools = createGoogleTools({ accounts, config, logger, oneClick: postOneClick });

  // the detectors run before the classifier, so a label never hides a hit. the date detector uses the calendars that
  // this poll could read. a calendar that failed can then give a false hit, but never hide a deadline.
  const detect = (polls: AccountPoll[], runId: string) => {
    const events: CalendarItem[] = polls.flatMap((each) => each.events ?? []);
    addSignals(db, soonSignals(events, clock(), deps.timeZone, runId), clock());
    const rows = db
      .prepare(
        `SELECT id, summary, occursAt, payloadBlob FROM integration_events
         WHERE source = 'gmail' AND state = 'ready' AND detectors IS NULL AND handledAt IS NULL AND seenAt >= ?`,
      )
      .all(new Date(clock().getTime() - CHECK_WINDOW_MS).toISOString());
    for (const row of rows) saveHits(db, Number(row.id), dateHits(mailItem(row), events, deps.timeZone, clock()));
  };

  // the subject names the matter of a mail. it is in the payload blob. without the blob the summary stands in.
  const mailItem = (row: Record<string, unknown>): MailItem => {
    let fields: { subject?: string; snippet?: string } = {};
    try {
      fields = row.payloadBlob ? (JSON.parse(deps.blobs.read(String(row.payloadBlob)) ?? '{}') as typeof fields) : {};
    } catch (err) {
      logger.warn('signal blob read failed', { id: row.id, err });
    }
    const subject = fields.subject ?? String(row.summary ?? '');
    const arrived = row.occursAt ? new Date(String(row.occursAt)) : clock();
    return { id: Number(row.id), subject, text: `${subject} ${fields.snippet ?? ''}`, arrived };
  };

  // the poll does not wait for the messages. a send can hang for minutes, and a poll run that stays open hides the new
  // mail of every account from the heartbeat. the claim is released when the send ends without success.
  const stallAlerts = (polls: AccountPoll[]) => {
    db.prepare('UPDATE google_accounts SET stallAlertedAt = NULL WHERE failures < ?').run(STALL_POLLS);
    for (const each of polls.filter((poll) => !poll.ok && poll.failures >= STALL_POLLS)) {
      const at = clock().toISOString();
      const claimed = db.prepare('UPDATE google_accounts SET stallAlertedAt = ? WHERE alias = ? AND stallAlertedAt IS NULL').run(at, each.alias);
      if (Number(claimed.changes) !== 1) continue;
      const text = `The Google poll of the ${each.alias} account has failed ${each.failures} times in a row: ${each.error}`;
      void (async () => {
        const sent = await deps.notifyOwner(text).catch((err: unknown) => (logger.error('the google stall message failed', { alias: each.alias, err }), false));
        if (!sent) db.prepare('UPDATE google_accounts SET stallAlertedAt = NULL WHERE alias = ? AND stallAlertedAt = ?').run(each.alias, at);
        // the database can be closed when a late send ends after a stop of the app.
      })().catch((err: unknown) => logger.warn('the google stall claim was not released', { alias: each.alias, err }));
    }
  };

  // each account that the poll could read gets one step of the people backfill, then the sweep of its new sent mail.
  // the accounts run side by side, and the two reads of one account run in turn. a failure is logged and never fails
  // the poll. it gives a note only for the backfill, because the sweep tries again at the next poll anyway. two polls
  // can overlap (the scheduler has two kinds of poll jobs), and both would read the same saved position and count
  // the same pages, so a second call for an account joins the one that runs, as sync.pollAll does.
  const filling = new Map<string, Promise<string[]>>();
  const fillAccount = async (alias: string): Promise<string[]> => {
    const backfillDeps = { db, clock, logger, accounts, builder: people };
    let failed = false;
    try {
      const step = await backfillStep(backfillDeps, alias);
      if (step.state === 'failed') {
        failed = true;
        logger.warn('people backfill step failed', { alias, ...(step.error ? { error: step.error } : {}) });
      }
    } catch (err) {
      failed = true;
      logger.warn('people backfill step failed', { alias, err });
    }
    try {
      await sweepSent(backfillDeps, alias);
    } catch (err) {
      logger.warn('people sent sweep failed', { alias, err });
    }
    return failed ? [`people backfill of ${alias} failed`] : [];
  };
  const fillPeople = async (polls: AccountPoll[]): Promise<string[]> => {
    if (deps.people?.backfill === false) return [];
    const notes = await Promise.all(
      polls
        .filter((each) => each.ok && !accounts.unavailable(each.alias))
        .map(({ alias }) => {
          const running = filling.get(alias);
          if (running) return running;
          const fill = fillAccount(alias).finally(() => filling.delete(alias));
          filling.set(alias, fill);
          return fill;
        }),
    );
    return notes.flat();
  };

  const notes = (polls: AccountPoll[]) => [
    ...polls.filter((each) => each.resync).map((each) => `the gmail history of ${each.alias} was too old, so only its inbox mail of the last 2 days made signals`),
    ...polls.filter((each) => !each.ok).map((each) => `${each.alias}: ${each.error}`),
  ];

  return {
    accounts,
    sync,
    tools,
    toolNames: (profile) => googleToolsFor(config, profile),
    async poll() {
      if (deps.polls === false) return { status: 'skipped', error: 'the google poll runs only in the background app' };
      // the poll is a run of its own, so its requests and its classifier calls show in one timeline with their cost.
      const runId = newId();
      db.prepare("INSERT INTO runs (id, sessionKey, trigger, slot, status, startedAt) VALUES (?, ?, 'poll', 'utility', 'running', ?)").run(runId, POLL_SESSION, clock().toISOString());
      let note: string;
      try {
        const polls = await requestContext.run({ runId }, () => sync.pollAll(runId));
        // alertPending catches all its errors, and like the stall messages it must not hold the poll.
        void accounts.alertPending();
        stallAlerts(polls);
        detect(polls, runId);
        const peopleNotes = await requestContext.run({ runId }, () => fillPeople(polls));
        try {
          await classifySignals({ db, slots: deps.slots, logger, runId, ...(deps.signal ? { signal: deps.signal } : {}) });
        } catch (err) {
          logger.error('signal classification failed', { runId, err });
        }
        note = [...notes(polls), ...peopleNotes].join('; ');
      } catch (err) {
        logger.error('google poll failed', { runId, err });
        note = `the poll stopped: ${redact(errorText(err))}`;
      }
      db.prepare("UPDATE runs SET status = 'completed', endedAt = ?, error = ? WHERE id = ?").run(clock().toISOString(), note || null, runId);
      // a poll with failed accounts still completes. a failed job backs off, and after five failures the owner gets a
      // message. a google outage of one account must not do that.
      return { status: 'completed', runId, ...(note ? { error: note } : {}) };
    },
    oneClick: postOneClick,
    close: () => accounts.close(),
  };
}
