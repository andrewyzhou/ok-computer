import type { SubscriptionAlert } from '../dashboard/plaid-types.js';
import type { SubscriptionRow } from '../dashboard/types.js';
import type { Db } from '../db/index.js';
import { NOT_BUILT } from './names.js';

// the alerts about subscriptions (subscription_alerts of 030_plaid.sql): a new subscription, a price increase, a free
// trial that turned into a charge, a duplicate service, and a charge for a service that shows no use. they come from
// the merged rows of src/inbox/subscriptions.ts (mergeSubscriptions), so a subscription that both the bank and the
// receipts show gives one alert. each alert has a dedupe key, so a second sync never writes it again. the brief (money
// section, src/brief/money.ts) and the subscriptions page show the open ones.

// the facts that the rules read besides the merged rows: the receipts of a merchant key that mention a trial, and the
// last mail from the domain of a merchant that is not a receipt (a sign of use). the merge package reads them from
// inbox_receipts and the mail tables, and an app without google gives empty maps.
export interface AlertFacts {
  trialMentions: ReadonlyMap<string, string[]>;
  lastUseAt: ReadonlyMap<string, string>;
}

// writes the alerts that the rows show now and that do not exist yet. it gives the new alerts. runId is the run of the
// sync or of the receipt scan.
export function computeAlerts(db: Db, rows: readonly SubscriptionRow[], facts: AlertFacts, now: Date, runId: string | null): SubscriptionAlert[] {
  void db;
  void rows;
  void facts;
  void now;
  void runId;
  throw new Error(NOT_BUILT);
}

// the open alerts, newest first, or every alert with all.
export function listAlerts(db: Db, options: { all?: boolean; since?: string } = {}): SubscriptionAlert[] {
  void db;
  void options;
  throw new Error(NOT_BUILT);
}

// the owner dismisses an alert on the page. it gives false for an id that names no open alert.
export function dismissAlert(db: Db, id: number, now: Date): boolean {
  void db;
  void id;
  void now;
  throw new Error(NOT_BUILT);
}
