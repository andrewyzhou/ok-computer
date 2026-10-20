import type { Db } from '../db/index.js';
import type { GoogleConfig } from '../google/config.js';

// the accounts that the inbox jobs read, and the owner's own addresses in each of them. the digest needs the addresses
// to tell a mail to the owner from a mail to a list, and the drafts and the newsletters leave out the owner's own mail.

export interface InboxAccount {
  alias: string;
  // the address of the last sign-in, or the address that okc.config.json expects, in lower case. null when neither is
  // known yet.
  email: string | null;
}

// inboxAccounts gives every account of the config, in the order of the config, so a job that walks this list covers
// each account. an account that cannot be read now is still in the list, and the job says why it skipped it.
export function inboxAccounts(db: Db, config: Pick<GoogleConfig, 'accounts'>): InboxAccount[] {
  const signedIn = new Map<string, string>();
  for (const row of db.prepare('SELECT alias, email FROM google_accounts').all()) {
    if (row.email !== null && row.email !== undefined && String(row.email)) signedIn.set(String(row.alias), String(row.email).toLowerCase());
  }
  return config.accounts.map((each) => ({ alias: each.alias, email: signedIn.get(each.alias) ?? each.email?.toLowerCase() ?? null }));
}

// every address of the owner across the accounts, in lower case. a mail from one of them is the owner's own mail.
export function ownerAddresses(db: Db, config: Pick<GoogleConfig, 'accounts'>): Set<string> {
  const out = new Set<string>();
  for (const each of inboxAccounts(db, config)) if (each.email) out.add(each.email);
  for (const each of config.accounts) if (each.email) out.add(each.email.toLowerCase());
  return out;
}
