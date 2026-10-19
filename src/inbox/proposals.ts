import type { CalendarProposalView } from '../dashboard/types.js';
import type { Tool } from '../tools/registry.js';
import { NotBuilt, type InboxContext, type JobRun } from './context.js';

// calendar proposals: the digest proposes an event for each course or bill deadline. the proposal is an approval of
// the inbox_create_event call, and the event is made only after the owner approves it. the work package
// "drafts-proposals" builds this module.

export const EVENT_TOOL = 'inbox_create_event';

// a deadline that the digest found. the times are iso with an offset. an all-day event has startAt at midnight in the
// time zone of the app, and endAt null.
export type ProposalInput = Pick<CalendarProposalView, 'account' | 'kind' | 'title' | 'startAt' | 'endAt' | 'allDay' | 'description' | 'sourceMessageId' | 'sourceSubject'>;

// proposeEvent gives the inbox_proposals row id, or null when no proposal was made (a past time, or an event of the
// same day and title on the calendar). a proposal of the same mail, kind and start gives the old row id again.
export async function proposeEvent(_ctx: InboxContext, _run: JobRun, _proposal: ProposalInput): Promise<number | null> {
  throw new NotBuilt('proposeEvent');
}

// the tool that makes an approved event: inbox_create_event.
export function createProposalTools(_ctx: InboxContext): Tool[] {
  return [];
}
