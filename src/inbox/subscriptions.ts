import type { SubscriptionCadence } from '../dashboard/types.js';
import type { Tool } from '../tools/registry.js';
import { NotBuilt, type ActionResult, type InboxContext, type JobRun } from './context.js';

// the paid subscription finder: it reads receipts, asks a model on the batch slot for the merchant, the amount, the
// currency and the date of each charge, and builds one subscription row for each merchant. a cancellation opens the
// cancel link or a browser task after the owner approves it. the work package "subscriptions" builds this module.

export const CANCEL_TOOL = 'inbox_cancel_subscription';

// the merchant key: the name in lower case, without spaces and marks, so "Stream Co." and "streamco" are one row.
export function merchantKeyOf(_merchant: string): string {
  throw new NotBuilt('merchantKeyOf');
}

// the cadence of a list of charge times (iso, any order), the next charge after the last one, and the confidence
// that the charge repeats (0 to 1).
export function cadenceOf(_charges: readonly string[]): { cadence: SubscriptionCadence; nextChargeAt: string | null; confidence: number } {
  throw new NotBuilt('cadenceOf');
}

// the job of the subscriptions automation. it writes inbox_receipts and inbox_subscriptions.
export async function scanSubscriptions(_ctx: InboxContext, _run: JobRun): Promise<{ note?: string }> {
  throw new NotBuilt('the subscription finder');
}

// the tool that an approved cancellation runs: inbox_cancel_subscription.
export function createSubscriptionTools(_ctx: InboxContext): Tool[] {
  return [];
}

export async function requestCancel(_ctx: InboxContext, _subscriptionId: number): Promise<ActionResult> {
  throw new NotBuilt('the cancel action');
}

export function ignoreSubscription(_ctx: InboxContext, _subscriptionId: number): ActionResult {
  throw new NotBuilt('the ignore action');
}
