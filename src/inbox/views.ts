import type {
  CalendarProposalView,
  DigestsPage,
  DraftView,
  InboxDigest,
  InboxListQuery,
  SendersPage,
  SendersQuery,
  SubscriptionsPage,
  SubscriptionState,
} from '../dashboard/types.js';
import type { Db } from '../db/index.js';
import { NotBuilt } from './context.js';

// the reads of the inbox pages. each function maps the rows of 019_inbox.sql to the shapes of src/dashboard/types.ts.
// the queries are checked by the route, so these functions get valid values. the work package "dashboard" builds
// this module.

export function listSenders(_db: Db, _query: SendersQuery & { limit: number }, _accounts: string[]): SendersPage {
  throw new NotBuilt('listSenders');
}

export function listSubscriptions(_db: Db, _query: { account?: string; state?: SubscriptionState }): SubscriptionsPage {
  throw new NotBuilt('listSubscriptions');
}

export function listDigests(_db: Db, _query: { cursor?: string; limit: number }): DigestsPage {
  throw new NotBuilt('listDigests');
}

export function getDigest(_db: Db, _id: number | 'latest'): InboxDigest | undefined {
  throw new NotBuilt('getDigest');
}

export function listDrafts(_db: Db, _query: InboxListQuery & { limit: number }): DraftView[] {
  throw new NotBuilt('listDrafts');
}

export function listProposals(_db: Db, _query: InboxListQuery & { limit: number }): CalendarProposalView[] {
  throw new NotBuilt('listProposals');
}
