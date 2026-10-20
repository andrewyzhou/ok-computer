import type { InboxDigest } from '../dashboard/types.js';
import type { Db } from '../db/index.js';
import type { BriefInput } from './build.js';
import { notBuilt, type BriefContext } from './context.js';

// the sources of a brief: the calendar, the inbox digest, the calendar proposals, the delegations and the goals.

// the digest of the brief: the newest digest of the day, else the newest digest of the day before, else null.
export function digestForBrief(db: Db, day: string): InboxDigest | null {
  return notBuilt('digestForBrief');
}

// gatherBriefInput reads every source for the day. a source that fails gives an empty part and a note in sources, so
// one broken source never stops the brief.
export async function gatherBriefInput(ctx: BriefContext, day: string): Promise<BriefInput> {
  return notBuilt('gatherBriefInput');
}
