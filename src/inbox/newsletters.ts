import type { gmail_v1 } from '@googleapis/gmail';
import type { UnsubscribeMethod } from '../dashboard/types.js';
import type { Tool } from '../tools/registry.js';
import { NotBuilt, type ActionResult, type InboxContext, type JobRun } from './context.js';

// the newsletter sweep: it groups the mail of each account by List-Id or From, counts what the owner read, and finds
// the unsubscribe method. the owner unsubscribes or archives a sender with an approval. the work package
// "newsletters" builds this module. see docs/PHASE5-API.md (m8) for the routes that call it.

export const UNSUBSCRIBE_TOOL = 'inbox_unsubscribe';
export const ARCHIVE_TOOL = 'inbox_archive_sender';

// the key of the sender of one message, and the parts that the sender row keeps. undefined for a message that is not
// a list mail (no List-Id and no List-Unsubscribe header) or that has no From address.
export function senderOf(_message: gmail_v1.Schema$Message): { senderKey: string; listId: string | null; fromAddress: string; displayName: string | null } | undefined {
  throw new NotBuilt('senderOf');
}

// the method and the url of the List-Unsubscribe header of one message: one_click needs an https target and
// List-Unsubscribe-Post (rfc 8058), https is an https target without it, mailto is a mailto target only.
export function unsubscribeOf(_message: gmail_v1.Schema$Message): { method: UnsubscribeMethod; url: string | null } {
  throw new NotBuilt('unsubscribeOf');
}

// the job of the newsletters automation. it writes inbox_senders and inbox_sender_messages.
export async function sweepNewsletters(_ctx: InboxContext, _run: JobRun): Promise<{ note?: string }> {
  throw new NotBuilt('the newsletter sweep');
}

// the tools that the approved actions run: inbox_unsubscribe and inbox_archive_sender.
export function createNewsletterTools(_ctx: InboxContext): Tool[] {
  return [];
}

export async function requestUnsubscribe(_ctx: InboxContext, _senderId: number): Promise<ActionResult> {
  throw new NotBuilt('the unsubscribe action');
}

export async function requestArchive(_ctx: InboxContext, _senderId: number, _request: { olderThanDays: number; label?: string }): Promise<ActionResult> {
  throw new NotBuilt('the archive action');
}

export function keepSender(_ctx: InboxContext, _senderId: number): ActionResult {
  throw new NotBuilt('the keep action');
}
