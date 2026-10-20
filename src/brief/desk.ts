import type { BriefDelegation } from '../dashboard/brief-types.js';
import type { Db } from '../db/index.js';
import { notBuilt } from './context.js';

// the delegations of the desk track (phase 6 t3), which is built at the same time as this one. the brief reads them
// only when the desk module is there, so this file finds it at run time and never imports it by name: the build and
// the tests pass with and without it.

// the module of the desk track that lists delegations. the name is in a variable, so the type check does not look
// for the file.
export const DESK_MODULE = '../desk/store.js';

// the delegations that are due by the end of day or wait on someone (open, waiting or blocked, and either due by the
// end of the day or with a follow-up by then, or waiting on someone), or null when the desk module is not there or
// does not have the expected shape.
export async function readDelegations(db: Db, endOfDay: Date): Promise<BriefDelegation[] | null> {
  return notBuilt('readDelegations');
}
