import type { BriefContent, BriefDelegation, BriefSources } from '../dashboard/brief-types.js';
import type { CalendarEvent } from '../dashboard/calendar-types.js';
import type { CalendarProposalView, GoalRow, InboxDigest } from '../dashboard/types.js';
import { notBuilt } from './context.js';

// the pure builder of a brief: it turns what the sources gave into the sections of the page and the short telegram
// text. nothing here reads the database or google, so a test gives it the input and checks the output.

// the brief reads the calendar from the start of its day to the end of this many days, for the invitations and the
// deadlines of the week. the day section shows only the day itself.
export const LOOKAHEAD_DAYS = 7;

// the telegram text has at most this many characters, the link included.
export const SHORT_TEXT_LIMIT = 700;

// everything the brief of one day is built from. day is yyyy-mm-dd in timeZone, and now is the time of the build.
// events cover the day and the LOOKAHEAD_DAYS after it. digest is the digest that the brief uses (of the day, or the
// newest one of the day before), or null. delegations is null when the desk module is not there. goals are the goals
// of the day. proposals are the calendar proposals in the state proposed.
export interface BriefInput {
  day: string;
  timeZone: string;
  now: Date;
  events: CalendarEvent[];
  sources: BriefSources;
  digest: InboxDigest | null;
  proposals: CalendarProposalView[];
  delegations: BriefDelegation[] | null;
  goals: GoalRow[];
}

// buildBrief gives the sections in the order of BriefSectionKind. each item has a source, so the page links it.
export function buildBrief(input: BriefInput): BriefContent {
  return notBuilt('buildBrief');
}

// briefText is the short telegram message: plain text, no markdown, at most SHORT_TEXT_LIMIT characters, and the link
// on its last line.
export function briefText(content: BriefContent, link: string): string {
  return notBuilt('briefText');
}
