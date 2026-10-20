import { randomUUID } from 'node:crypto';
import type { Config } from '../config/schema.js';
import type { InboxJob } from '../dashboard/types.js';
import type { Db } from '../db/index.js';
import { getSetting, setSetting } from '../db/settings.js';
import type { JobResult } from '../scheduler/scheduler.js';
import type { Logger } from '../observability/logger.js';
import { createAutomation } from '../scheduler/store.js';
import type { Tool } from '../tools/registry.js';
import { settleApprovals } from './actions.js';
import { DIGEST_EXPR, inboxAutomation } from './automations.js';
import type { ActionResult, InboxContext, InboxDeps } from './context.js';
import { runDigest } from './digest.js';
import { createDraftTools } from './drafts.js';
import { createNewsletterTools, keepSender, requestArchive, requestUnsubscribe, sweepNewsletters } from './newsletters.js';
import { createProposalTools } from './proposals.js';
import { runJob } from './run.js';
import { moveDigestBeforeBrief } from './schedule.js';
import { createSubscriptionTools, ignoreSubscription, requestCancel, scanSubscriptions } from './subscriptions.js';

// the inbox jobs of phase 5 m8 on the owner's google accounts. app.ts makes this object when the config has a google
// block. the jobs run in code from their automations, the actions come from the dashboard, and each change of mail or
// of the calendar is a tool call that the owner approves. nothing here sends mail.
export interface Inbox {
  // the tools that the approved actions run. they are in the registry, but no session lists them, so only the inbox
  // code calls them, through the tool caller. an approval finds its tool by name.
  tools: Tool[];
  // a job that runs already is skipped, so a second start gives { status: 'skipped' }.
  runJob(job: InboxJob): Promise<JobResult>;
  running(job: InboxJob): boolean;
  unsubscribe(senderId: number): Promise<ActionResult>;
  archive(senderId: number, request: { olderThanDays: number; label?: string }): Promise<ActionResult>;
  keep(senderId: number): ActionResult;
  cancel(subscriptionId: number): Promise<ActionResult>;
  ignore(subscriptionId: number): ActionResult;
}

export function createInbox(deps: InboxDeps): Inbox {
  const ctx: InboxContext = { ...deps, newId: deps.newId ?? randomUUID };
  const jobs: Record<InboxJob, () => Promise<JobResult>> = {
    newsletters: () => runJob(ctx, 'newsletters', 'utility', (run) => sweepNewsletters(ctx, run)),
    subscriptions: () => runJob(ctx, 'subscriptions', 'batch', (run) => scanSubscriptions(ctx, run)),
    digest: () => runJob(ctx, 'digest', 'utility', (run) => runDigest(ctx, run)),
  };
  const running = new Set<InboxJob>();
  return {
    tools: [...createNewsletterTools(ctx), ...createSubscriptionTools(ctx), ...createDraftTools(ctx), ...createProposalTools(ctx)],
    async runJob(job) {
      // one run of a job at a time: two digests would send the owner two messages and could save two drafts for one
      // mail, and two scans would pay for the same receipts twice.
      if (running.has(job)) return { status: 'skipped', error: `the ${job} job is already running` };
      running.add(job);
      try {
        // a denied or expired approval leaves its row pending until something settles it, so each job starts with it.
        settleApprovals(ctx.db, ctx.clock());
        return await jobs[job]();
      } finally {
        running.delete(job);
      }
    },
    running: (job) => running.has(job),
    unsubscribe: (senderId) => requestUnsubscribe(ctx, senderId),
    archive: (senderId, request) => requestArchive(ctx, senderId, request),
    keep: (senderId) => keepSender(ctx, senderId),
    cancel: (subscriptionId) => requestCancel(ctx, subscriptionId),
    ignore: (subscriptionId) => ignoreSubscription(ctx, subscriptionId),
  };
}

// the automation of each job. the owner can change the time or turn a job off on the automations page, and the app
// never puts it back. the times are in the time zone of the app. the digest runs at 07:00, before the morning brief at
// 07:30.
const JOBS: Array<{ job: InboxJob; name: string; expr: string; slot: 'utility' | 'batch' }> = [
  { job: 'digest', name: 'inbox: daily digest', expr: DIGEST_EXPR, slot: 'utility' },
  { job: 'newsletters', name: 'inbox: newsletter sweep', expr: '0 9 * * 6', slot: 'utility' },
  { job: 'subscriptions', name: 'inbox: subscription finder', expr: '0 10 * * 0', slot: 'batch' },
];

const INSTALLED = 'inbox_jobs_installed';

// installInboxJobs makes the automations one time, as the goals routine does. a job whose automation the owner
// deleted does not come back. on each start it first moves a digest of phase 5 from 07:30 to 07:00, one time. it gives
// true only when it installed the automations now. a failed move only logs, so it never stops the start.
export function installInboxJobs(db: Db, config: Pick<Config, 'timeZone'>, now: Date, logger?: Pick<Logger, 'warn'>): boolean {
  try {
    moveDigestBeforeBrief(db, config, now, logger);
  } catch (err) {
    logger?.warn('the inbox digest could not move to 07:00, so it stays at 07:30 until the next start', { err });
  }
  if (getSetting(db, INSTALLED)) return false;
  for (const each of JOBS) {
    if (inboxAutomation(db, each.job)) continue;
    const created = createAutomation(
      db,
      {
        name: each.name,
        schedule: { kind: 'cron', expr: each.expr, tz: config.timeZone },
        payload: { type: 'inbox', job: each.job },
        slot: each.slot,
        createdBy: 'system',
      },
      now,
      config.timeZone,
    );
    if (!created.ok) throw new Error(`the inbox automation "${each.name}" is invalid: ${created.error}`);
  }
  setSetting(db, INSTALLED, true, now);
  return true;
}

// the automation of a job lives in automations.ts. the dashboard and the tests import it from here.
export { inboxAutomation } from './automations.js';
