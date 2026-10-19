import type { InboxDigest } from '../dashboard/types.js';
import { NotBuilt, type InboxContext, type JobRun } from './context.js';

// the daily inbox digest: it reads the recent mail of each account, asks a model on the utility slot which mails need
// a reply, hold a deadline or a bill, or track a package, asks for drafts and calendar proposals, stores the digest
// for the dashboard, and sends the short text to the owner. the work package "digest" builds this module.

// the job of the digest automation. it writes inbox_digests.
export async function runDigest(_ctx: InboxContext, _run: JobRun): Promise<{ note?: string }> {
  throw new NotBuilt('the inbox digest');
}

// the short message to the owner: the counts of each section and the first items, at most 1,000 characters.
export function shortTextOf(_digest: Pick<InboxDigest, 'items' | 'day'>): string {
  throw new NotBuilt('shortTextOf');
}
