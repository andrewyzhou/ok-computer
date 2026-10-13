import type { Config } from '../config/schema.js';
import type { Db } from '../db/index.js';
import type { SecretStore } from '../integrations/secrets.js';
import type { SlotRunner } from '../models/slots.js';
import type { BlobStore } from '../observability/blobs.js';
import type { Logger } from '../observability/logger.js';
import type { JobResult } from '../scheduler/scheduler.js';
import { createAutomation, listAutomations, updateAutomation } from '../scheduler/store.js';
import type { Clock } from '../time.js';
import type { Tool } from '../tools/registry.js';
import { createGoogleAccounts, type GoogleAccounts, type GoogleEndpoints } from './accounts.js';
import { classifySignals } from './classify.js';
import type { GoogleConfig } from './config.js';
import { runDetectors } from './detectors.js';
import { markHandled, signalDigest, type Digest } from './signals.js';
import { createSync, type Sync } from './sync.js';
import { createGoogleTools, googleToolNames } from './tools.js';

export interface Google {
  accounts: GoogleAccounts;
  sync: Sync;
  tools: Tool[];
  // the google tool names of a session profile (main or auto). they depend only on the config, so the tools
  // parameter of a session never changes.
  toolNames(profile: string): string[];
  // poll is the job of the poll automation: sync every account, label the new signals, run the detectors.
  poll(): Promise<JobResult>;
  digest(now: Date): Digest | undefined;
  handled(ids: number[], by: string, now: Date): void;
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
  notifyOwner: (text: string) => void;
  endpoints?: GoogleEndpoints;
  // false in npm run chat. the background app polls, so two processes do not poll the same accounts.
  polls?: boolean;
  signal?: AbortSignal;
}

// the poll automation follows the config at each start, as the heartbeat does. a pause by the owner stays until the
// interval in the config changes. without a google block the automation is turned off, not deleted, so its history
// stays.
export function syncGooglePoll(db: Db, config: Pick<Config, 'google' | 'timeZone'>, now: Date): void {
  const existing = listAutomations(db).find((each) => each.payload.type === 'poll' && each.payload.source === 'google');
  if (!config.google) {
    if (existing?.enabled) updateAutomation(db, existing.id, { enabled: false }, now, config.timeZone);
    return;
  }
  const schedule = { kind: 'every' as const, everyMs: config.google.pollMinutes * 60_000 };
  if (!existing) {
    createAutomation(db, { name: 'google poll', schedule, payload: { type: 'poll', source: 'google' }, slot: 'utility', createdBy: 'system' }, now, config.timeZone);
  } else if (existing.schedule.kind !== 'every' || existing.schedule.everyMs !== schedule.everyMs) {
    updateAutomation(db, existing.id, { schedule, enabled: true }, now, config.timeZone);
  }
}

// after this many failed polls in a row (about three hours at 15 minutes), the owner hears one time. a long outage
// would otherwise hide every deadline without a word.
const STALL_POLLS = 12;

export function createGoogle(deps: GoogleDeps): Google {
  const { db, clock, logger, config } = deps;
  const accounts = createGoogleAccounts({
    db,
    clock,
    logger,
    secrets: deps.secrets,
    config,
    ...(deps.endpoints ? { endpoints: deps.endpoints } : {}),
    onNeedsAuth: (_alias, text) => deps.notifyOwner(text),
    onNewMailbox: (alias) => sync.reset(alias),
  });
  const sync = createSync({ db, clock, logger, blobs: deps.blobs, accounts });
  const tools = createGoogleTools({ accounts, config, logger });
  const names = googleToolNames(config);

  return {
    accounts,
    sync,
    tools,
    toolNames: (profile) => (config.sessions.includes(profile as 'main' | 'auto') ? names : []),
    async poll() {
      if (deps.polls === false) return { status: 'skipped', error: 'the google poll runs only in the background app' };
      const reports = await sync.pollAll();
      for (const report of reports.filter((each) => !each.ok)) {
        const failures = Number(db.prepare('SELECT failures FROM google_sync WHERE alias = ? AND api = ?').get(report.alias, report.api)?.failures ?? 0);
        if (failures === STALL_POLLS) deps.notifyOwner(`The ${report.api} poll of the ${report.alias} Google account has failed ${failures} times in a row: ${report.error}`);
      }
      // the labels and the detectors work on what the database has. a failed classifier leaves rows unlabeled, and
      // the detectors still run.
      try {
        await classifySignals({ db, slots: deps.slots, logger, ...(deps.signal ? { signal: deps.signal } : {}) });
      } catch (err) {
        logger.error('signal classification failed', { err });
      }
      const found = runDetectors(db, clock(), deps.timeZone);
      const failed = reports.filter((each) => !each.ok);
      logger.info('google poll done', { reports: reports.length, failed: failed.length, detected: found });
      // a poll with failed accounts still completes. a failed job backs off and is turned off after five failures,
      // and a google outage must not turn the poll off for good.
      return { status: 'completed', ...(failed.length ? { error: failed.map((each) => `${each.alias} ${each.api}: ${each.error}`).join('; ') } : {}) };
    },
    digest: (now) => signalDigest(db, now, deps.timeZone),
    handled: (ids, by, now) => markHandled(db, ids, by, now),
    close: () => accounts.close(),
  };
}
