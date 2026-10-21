import type { Db } from '../db/index.js';
import type { Clock } from '../time.js';
import { notBuilt } from './not-built.js';
import type { ManagedStore } from './types.js';

// the store of 029_connectors.sql. a row of managed_connectors is the current state of one connection, and each change
// also writes a row of connector_events in the same transaction. the detail of an event is redacted before the write,
// so a value that looks like a secret never reaches the database.
export function createManagedStore(deps: { db: Db; clock: Clock }): ManagedStore {
  void deps;
  const stub = (): never => notBuilt('the managed connector store');
  return { list: stub, get: stub, save: stub, remove: stub, record: stub, events: stub };
}
