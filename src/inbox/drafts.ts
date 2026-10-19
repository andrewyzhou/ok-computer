import type { Tool } from '../tools/registry.js';
import { NotBuilt, type InboxContext, type JobRun } from './context.js';

// draft replies: the digest asks for a draft for each mail that needs a reply. the module writes the text with a
// model on the utility slot and saves it in gmail drafts through the inbox_draft_reply tool. the app never sends a
// draft. the work package "drafts-proposals" builds this module.

export const DRAFT_TOOL = 'inbox_draft_reply';

// the mail that a draft answers.
export interface DraftSource {
  account: string;
  messageId: string;
  threadId: string;
}

// draftReply gives the inbox_drafts row id of the draft for the source, or null when no draft was made. a source that
// has a draft already gives that row id again.
export async function draftReply(_ctx: InboxContext, _run: JobRun, _source: DraftSource): Promise<number | null> {
  throw new NotBuilt('draftReply');
}

// checkDrafts updates the state of the drafted rows: discarded when the draft is gone without a sent mail with its
// text, sent_by_owner when a sent mail in the thread has its text.
export async function checkDrafts(_ctx: InboxContext, _run: JobRun): Promise<void> {
  throw new NotBuilt('checkDrafts');
}

// the tool that saves a draft: inbox_draft_reply.
export function createDraftTools(_ctx: InboxContext): Tool[] {
  return [];
}
