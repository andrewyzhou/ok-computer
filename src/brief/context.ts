import type { Db } from '../db/index.js';
import type { Google } from '../google/google.js';
import type { Inbox } from '../inbox/inbox.js';
import type { Logger } from '../observability/logger.js';
import type { OwnerMessenger } from '../sessions/owner.js';
import type { RunQueue } from '../sessions/queue.js';
import type { Clock } from '../time.js';

// the parts of the app that the today track (phase 6 t1) uses. app.ts gives them to createToday. google and inbox are
// there only when the config has a google block, and the brief works without them: it then has no calendar and no
// digest.
export interface BriefDeps {
  db: Db;
  clock: Clock;
  logger: Logger;
  timeZone: string;
  google?: Pick<Google, 'accounts'>;
  // the brief waits for a digest that runs, so it reads the digest of today.
  inbox?: Pick<Inbox, 'running'>;
  owner: Pick<OwnerMessenger, 'send' | 'chat'>;
  // the copy of the brief goes into the main session through the queue, so it never lands inside an active run.
  queue: RunQueue;
  // the address of the dashboard for the link in the telegram message, without a trailing slash.
  dashboardUrl: string;
  signal: AbortSignal;
  // the scheduler plans again after the brief time changes.
  replan: () => void;
  // the live runs of the app. the brief run is in it while it works, so the sweep of stale runs leaves it alone.
  activeRuns?: Set<string>;
  newId?: () => string;
}

// the same parts with a fixed id function. every module of src/brief gets this.
export interface BriefContext extends Omit<BriefDeps, 'newId'> {
  newId: () => string;
}

// a brief run has the session brief:<runId>.
export const BRIEF_PREFIX = 'brief:';
export const briefSession = (runId: string) => `${BRIEF_PREFIX}${runId}`;

export const BRIEF_AUTOMATION_NAME = 'brief: morning brief';
export const DEFAULT_BRIEF_TIME = '07:30';

// a stub of the scaffold throws this until its work package builds it.
export function notBuilt(what: string): never {
  throw new Error(`${what} is not built yet`);
}
