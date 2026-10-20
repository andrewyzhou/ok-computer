import type { BriefSource } from '../../../../src/dashboard/brief-types';

// the links of the today track. the today page links each brief item to its source, and the calendar page reads the
// same hash, so the two pages agree on it.

export type CalendarMode = 'week' | 'day';

// the calendar page on a day. mode is week by default. event is the key of a CalendarEvent, which the page selects and
// shows in the details panel.
export function calendarHash(day: string, options: { mode?: CalendarMode; event?: string } = {}): string {
  const query = new URLSearchParams({ day });
  if (options.mode && options.mode !== 'week') query.set('mode', options.mode);
  if (options.event) query.set('event', options.event);
  return `#/calendar?${query.toString()}`;
}

// the hash of the page that holds the source of a brief item. a delegation opens the desk page of the desk track.
export function sourceHash(source: BriefSource): string {
  switch (source.kind) {
    case 'event':
      return calendarHash(source.day, { mode: 'day', event: source.key });
    case 'thread':
    case 'digest':
      return `#/inbox/digests/${source.digestId}`;
    case 'draft':
      return `#/inbox/drafts?id=${source.draftId}`;
    case 'proposal':
      return `#/inbox/proposals?id=${source.proposalId}`;
    case 'delegation':
      return `#/desk?id=${source.delegationId}`;
    case 'goal':
      return '#/goals';
  }
}
