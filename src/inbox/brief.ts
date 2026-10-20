import type { BriefInbox } from '../dashboard/inbox-types.js';
import type { Db } from '../db/index.js';

// the inbox part of the morning brief. the digest runs at 07:00, before the brief at 07:30, and the brief reads the
// newest digest through this function, so src/brief needs no sql of the inbox tables. the work package "schedule"
// builds this module.

// inboxForBrief gives the newest digest of the day (yyyy-mm-dd in the time zone of the app) in the shape of the brief.
// when the day has no digest it gives the newest older one with stale true, and null when no digest exists. each
// item links to its page: a needs_reply item with a draft to #/inbox/drafts?id=<draftId>, an item with a proposal to
// #/inbox/proposals?id=<proposalId>, and any other item to #/inbox/digests/<digestId>.
export function inboxForBrief(_db: Db, _day: string): BriefInbox | null {
  throw new Error('not built: inboxForBrief (work package schedule)');
}
