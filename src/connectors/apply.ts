import type { IntegrationEntry } from '../integrations/config.js';
import type { Integrations } from '../integrations/integrations.js';
import type { Logger } from '../observability/logger.js';
import type { MergeConflict } from './merge.js';
import { notBuilt } from './not-built.js';
import type { ApplyResult, ManagedConnection, ManagedStore } from './types.js';

// the applier merges the managed connections with the file again and gives the entries to the integration layer.
// Integrations.apply starts, stops or replaces each changed entry without a restart where it can. a change that it
// cannot apply live (for example a new slack poll) is saved, pending() turns true, and the page offers one restart.
export interface Applier {
  apply(reason: string): Promise<ApplyResult>;
  pending(): boolean;
  // the managed rows that the last merge left out.
  conflicts(): MergeConflict[];
}

export interface ApplierDeps {
  store: ManagedStore;
  file: readonly IntegrationEntry[];
  integrations: Pick<Integrations, 'apply'>;
  entryOf: (row: ManagedConnection) => IntegrationEntry | undefined;
  logger: Logger;
}

export function createApplier(deps: ApplierDeps): Applier {
  void deps;
  return { apply: () => notBuilt('the hot apply of connections'), pending: () => false, conflicts: () => [] };
}
