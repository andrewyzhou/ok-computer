import type { BriefItem } from '../dashboard/brief-types.js';
import type { SubscriptionAlert } from '../dashboard/plaid-types.js';
import type { Db } from '../db/index.js';

// the money section of the brief (track s3 of docs/CONNECT-PLAN.md): the open subscription alerts of
// src/plaid/alerts.ts. each item links to its row on the subscriptions page ({ kind: 'subscription' }). the text holds
// merchant names from the bank and the mail, so the brief run names the untrusted source plaid when the section has
// items. the section is left out when no alert is open.

// the open alerts that the brief of a day shows: the ones made since the brief before, at most 7 days back, newest
// first. it gives an empty list before migration 030 or when nothing is linked, and never throws for a missing bank.
export function moneyForBrief(db: Db, now: Date): SubscriptionAlert[] {
  void db;
  void now;
  return [];
}

// the items of the section: one for each alert, with the price or the amount in the detail. a price increase and a
// trial that turned into a charge have the tone warning; a duplicate and an unused service have info.
export function moneyItems(alerts: readonly SubscriptionAlert[]): BriefItem[] {
  void alerts;
  throw new Error('not built');
}
