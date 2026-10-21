import type { IntegrationEntry } from '../integrations/config.js';
import { notBuilt } from './not-built.js';
import type { ManagedConnection } from './types.js';

// a managed row that the merge left out, and why. the page shows the reason on the card.
export interface MergeConflict {
  integrationId: string;
  connectorId: string;
  reason: string;
}

export interface MergeResult {
  entries: IntegrationEntry[];
  conflicts: MergeConflict[];
}

// mergeEntries joins the entries of okc.integrations.json with the managed connections. the file stays for advanced
// use, so an entry of the file wins over a managed row with the same id. entryOf turns a row into an entry with its
// preset, and gives undefined for a connector that has no integration (for example google). every entry that the
// merge gives passes the same schema as an entry of the file.
export function mergeEntries(
  file: readonly IntegrationEntry[],
  rows: readonly ManagedConnection[],
  entryOf: (row: ManagedConnection) => IntegrationEntry | undefined,
): MergeResult {
  void file;
  void rows;
  void entryOf;
  return notBuilt('the merge of managed connections');
}
