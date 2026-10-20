import type { BriefInbox, BriefInboxItem } from '../dashboard/inbox-types.js';
import type { DigestItem, InboxDigest } from '../dashboard/types.js';
import type { Db } from '../db/index.js';
import { getDigest } from './views.js';

// the inbox part of the morning brief. the digest runs at 07:00, before the brief at 07:30, and the brief reads the
// newest digest through this function, so src/brief needs no sql of the inbox tables. it only reads.

const SECTIONS: Record<DigestItem['section'], 'needsReply' | 'deadlines' | 'bills' | 'packages'> = {
  needs_reply: 'needsReply',
  deadlines: 'deadlines',
  bills: 'bills',
  packages: 'packages',
};

// the page of an item: its draft, else its calendar proposal, else the digest that holds it. an older item may lack the
// two ids.
function linkOf(digestId: number, item: DigestItem): string {
  if (item.draftId !== null && item.draftId !== undefined) return `#/inbox/drafts?id=${item.draftId}`;
  if (item.proposalId !== null && item.proposalId !== undefined) return `#/inbox/proposals?id=${item.proposalId}`;
  return `#/inbox/digests/${digestId}`;
}

function briefItem(digestId: number, item: DigestItem): BriefInboxItem {
  return {
    account: item.account,
    messageId: item.messageId,
    threadId: item.threadId,
    from: item.from,
    subject: item.subject,
    summary: item.summary,
    // an item that a digest wrote before a field existed has no value, so each one falls back to null.
    dueAt: item.dueAt ?? null,
    amount: item.amount ?? null,
    currency: item.currency ?? null,
    draftId: item.draftId ?? null,
    proposalId: item.proposalId ?? null,
    link: linkOf(digestId, item),
  };
}

// the accounts that the digest could not read. with counts, an account with an error, and a configured account that
// the counts do not name (it was added after the digest). a digest of phase 5 has no counts, so it is each configured
// account that the digest did not read.
function unreadOf(digest: InboxDigest, configured: readonly string[] | undefined): string[] {
  if (digest.stats) {
    const named = new Set(digest.stats.accounts.map((each) => each.alias));
    const failed = digest.stats.accounts.filter((each) => each.error !== null).map((each) => each.alias);
    return [...failed, ...(configured ?? []).filter((alias) => !named.has(alias))];
  }
  return (configured ?? []).filter((alias) => !digest.accounts.includes(alias));
}

// briefInboxOf gives one digest in the shape of the brief. stale says that the digest is of an earlier day than the
// brief. it reads nothing, so the brief tests give it their own digests.
export function briefInboxOf(digest: InboxDigest, options: { stale: boolean; accounts?: readonly string[] }): BriefInbox {
  const brief: BriefInbox = {
    digestId: digest.id,
    day: digest.day,
    createdAt: digest.createdAt,
    stale: options.stale,
    accounts: digest.accounts,
    unread: unreadOf(digest, options.accounts),
    needsReply: [],
    deadlines: [],
    bills: [],
    packages: [],
    hidden: digest.stats ? digest.stats.accounts.reduce((sum, each) => sum + each.hidden, 0) : 0,
  };
  // the items keep the order of the digest. an item of a section that this code does not know is left out.
  for (const item of digest.items) {
    const section = SECTIONS[item.section];
    if (section) brief[section].push(briefItem(digest.id, item));
  }
  return brief;
}

// inboxForBrief gives the newest digest of the day (yyyy-mm-dd in the time zone of the app) in the shape of the brief.
// when the day has no digest it gives the newest older one with stale true, and null when no digest exists. each
// item links to its page: an item with a draft to #/inbox/drafts?id=<draftId>, an item with a proposal to
// #/inbox/proposals?id=<proposalId>, and any other item to #/inbox/digests/<digestId>. accounts is the list of the
// configured aliases, which finds the accounts that a digest of phase 5 did not read.
export function inboxForBrief(db: Db, day: string, accounts?: readonly string[]): BriefInbox | null {
  const today = db.prepare('SELECT id FROM inbox_digests WHERE day = ? ORDER BY id DESC LIMIT 1').get(day);
  const row = today ?? db.prepare('SELECT id FROM inbox_digests WHERE day < ? ORDER BY day DESC, id DESC LIMIT 1').get(day);
  if (!row) return null;
  const digest = getDigest(db, Number(row.id));
  if (!digest) return null;
  return briefInboxOf(digest, { stale: !today, ...(accounts ? { accounts } : {}) });
}
