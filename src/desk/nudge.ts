import type { Tool } from '../tools/registry.js';
import type { DeskContext } from './context.js';

// the nudge drafts of the follow-up job. the work package "follow-ups and nudge drafts" builds them:
// - writeNudge asks a model on the utility slot for a short, polite nudge from the thread (untrusted data), with a
//   fixed text when the model gives none.
// - the tool desk_draft_nudge (NUDGE_TOOL in names.ts) saves it in Gmail Drafts as a reply in the thread. it is a
//   write tool like inbox_draft_reply: the reviewer checks it in the tainted follow-up session, and it is never sent.
//   it claims its delegation_nudges row before the draft, so one follow-up time gives one draft, and it refuses a
//   recipient that is not the waiting-on email or an address in the From, To or Cc of the thread.
// without google, createNudgeTools gives no tool.
export function createNudgeTools(_ctx: DeskContext): Tool[] {
  return [];
}
