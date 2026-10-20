import type { Db } from '../db/index.js';
import type { GoogleConfig } from '../google/config.js';
import type { Google } from '../google/google.js';
import type { SlotRunner } from '../models/slots.js';
import type { Logger } from '../observability/logger.js';
import type { OwnerMessenger } from '../sessions/owner.js';
import type { Clock } from '../time.js';
import type { ToolCaller } from '../tools/caller.js';

// the parts of the app that the desk uses. app.ts gives them to createDesk. the slot runner and the caller exist only
// after the tool registry, so they come as functions or as objects that call through later.
export interface DeskDeps {
  db: Db;
  clock: Clock;
  logger: Logger;
  timeZone: string;
  // the google accounts, when the config has a google block. without them the follow-up job reads no thread and
  // saves no draft: it tells the owner that a follow-up is due.
  google?: Pick<Google, 'accounts'>;
  googleConfig?: GoogleConfig;
  slots: SlotRunner;
  caller: () => ToolCaller;
  owner: Pick<OwnerMessenger, 'send'>;
  // the full link of a delegation on the dashboard, for a chat reply or a message to the owner, for example
  // http://127.0.0.1:8787/#/desk?id=12.
  deskLink: (id: number) => string;
  signal: AbortSignal;
  // the live runs of the app. a follow-up run is in it while it works, so the sweep of stale runs leaves it alone.
  activeRuns?: Set<string>;
  newId?: () => string;
}

// the same parts with a fixed id function. every module of src/desk gets this.
export interface DeskContext extends Omit<DeskDeps, 'newId'> {
  newId: () => string;
}
