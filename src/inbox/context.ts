import type { RunInput, RunResult } from '../agent/loop.js';
import type { InboxActionResponse, InboxJob } from '../dashboard/types.js';
import type { Db } from '../db/index.js';
import type { GoogleConfig } from '../google/config.js';
import type { Google } from '../google/google.js';
import type { SlotRunner } from '../models/slots.js';
import type { BlobStore } from '../observability/blobs.js';
import type { Logger } from '../observability/logger.js';
import type { OwnerMessenger } from '../sessions/owner.js';
import type { RunQueue } from '../sessions/queue.js';
import type { Clock } from '../time.js';
import type { ToolCaller } from '../tools/caller.js';

// the parts of the app that the inbox jobs use. app.ts gives them to createInbox. the caller and the agent exist only
// after the tool registry, so they come as functions.
export interface InboxDeps {
  db: Db;
  clock: Clock;
  logger: Logger;
  blobs: BlobStore;
  timeZone: string;
  google: Pick<Google, 'accounts' | 'oneClick'>;
  googleConfig: GoogleConfig;
  slots: SlotRunner;
  caller: () => ToolCaller;
  owner: Pick<OwnerMessenger, 'send' | 'chat'>;
  // the agent runs a browser task that helps with a cancellation or an https unsubscribe, after the owner approved it.
  agent: (input: RunInput) => Promise<RunResult>;
  queue: RunQueue;
  signal: AbortSignal;
  // the live runs of the app. a job run is in it while it works, so the sweep of stale runs leaves it alone.
  activeRuns?: Set<string>;
  newId?: () => string;
  // the read-only quality check sees each digest batch here: the inputs as the code built them and the items of the
  // model as it gave them, before any check. the app sets none.
  observeDigest?: (batch: DigestBatch) => void;
}

// one batch of the digest model. items are the raw items of the tool call, which the quality check checks again.
export interface DigestBatch {
  account: string;
  inputs: ReadonlyArray<{ id: number; text: string; sentAt: string }>;
  items: unknown[];
}

// the same parts with a fixed id function. every module of src/inbox gets this.
export interface InboxContext extends Omit<InboxDeps, 'newId'> {
  newId: () => string;
}

// the run of one job or of one dashboard action. the session key holds the run id, so each run has its own session,
// and the taint of the mail that one run read never reaches another run.
export interface JobRun {
  job: InboxJob | 'action';
  runId: string;
  sessionKey: string;
}

// the answer of an action on a sender or a subscription. the dashboard turns an error into its status and its text.
export type ActionResult = { ok: true; response: InboxActionResponse } | { ok: false; status: 404 | 409 | 503; error: string };
