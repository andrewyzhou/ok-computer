// the shapes of the calendar api of phase 6 t1 (the today track). the web pages and the brief import this file, so it
// holds types only and imports nothing. docs/API.md (t1) gives the routes and the errors.

// the owner's own answer to an event. null means that the event has no guest list with the owner on it, for example
// an event that the owner made alone, or an event of a shared calendar that does not invite the owner.
export type CalendarAnswer = 'needsAction' | 'accepted' | 'tentative' | 'declined' | null;

// one calendar that the owner shows in google calendar. key is `${account}/${calendarId}`, and calendarId is 'primary'
// for the primary calendar of the account. color is a css hex color: the background color that google gives the
// calendar, or a color of the fixed palette when google gives none.
export interface CalendarInfo {
  key: string;
  account: string;
  calendarId: string;
  label: string;
  color: string;
  primary: boolean;
}

// a guest of an event. answer uses the words of google (needsAction, accepted, tentative, declined).
export interface CalendarGuest {
  name: string | null;
  email: string | null;
  answer: string;
  organizer: boolean;
  optional: boolean;
  self: boolean;
}

// one event, as the grid and the brief read it. the text fields come from the person who sent the invitation, so they
// are untrusted text: the page shows them as text and never as html.
//
// key is `${account}/${calendarId}/${eventId}` and is unique in a page. uid is the iCalUID, which is the same on each
// account that got the same invitation. a timed event has startAt and endAt in utc. an all-day event has allDay true,
// startDay and endDay (the last day, inclusive) in the time zone of the app, and startAt and endAt at midnight of
// startDay and of the day after endDay in that zone. location is null when it is empty or only a link (a link is the
// video link). notes holds the first 500 characters of the description as plain text.
export interface CalendarEvent {
  key: string;
  uid: string | null;
  account: string;
  calendarId: string;
  calendarKey: string;
  eventId: string;
  title: string;
  startAt: string;
  endAt: string;
  allDay: boolean;
  startDay: string;
  endDay: string;
  location: string | null;
  videoUrl: string | null;
  status: 'confirmed' | 'tentative' | 'cancelled';
  answer: CalendarAnswer;
  organizerSelf: boolean;
  organizer: string | null;
  guests: CalendarGuest[];
  showsAsFree: boolean;
  recurring: boolean;
  notes: string | null;
  htmlLink: string | null;
}

// two events that overlap, both accepted or organized by the owner. startAt and endAt are the overlap.
export interface CalendarConflict {
  a: string;
  b: string;
  startAt: string;
  endAt: string;
}

// back-to-back events at different places with less than 15 minutes between them. from ends at at, and to starts
// gapMinutes later (0 to 14).
export interface TravelGap {
  from: string;
  to: string;
  at: string;
  gapMinutes: number;
  fromLocation: string;
  toLocation: string;
}

// a calendar event that the digest proposed and the owner did not decide yet (state proposed). the grid draws it as a
// dashed block, and the owner decides through the approval of approvalId.
export interface CalendarProposalBlock {
  proposalId: number;
  account: string;
  title: string;
  kind: 'course' | 'bill' | 'other';
  startAt: string;
  endAt: string | null;
  allDay: boolean;
  approvalId: number | null;
}

// an account that the page could not read, and why. a reason is one sentence for the owner.
export interface CalendarSkipped {
  account: string;
  reason: string;
}

// GET /api/calendar. from is a day (yyyy-mm-dd in the time zone of the app). days is 1 to 14, and the default is 7.
export interface CalendarQuery {
  from?: string;
  days?: number;
}

// the answer of GET /api/calendar. configured is false without a google block, and the lists are empty then. days
// lists each day of the range in order. events are sorted by startAt, then by key. invites are the keys of the events
// whose answer is needsAction. skipped is not empty when an account could not be read; when every account failed,
// events is empty and the page shows an error.
export interface CalendarPage {
  configured: boolean;
  timeZone: string;
  from: string;
  to: string;
  days: string[];
  startAt: string;
  endAt: string;
  calendars: CalendarInfo[];
  events: CalendarEvent[];
  proposals: CalendarProposalBlock[];
  conflicts: CalendarConflict[];
  travelGaps: TravelGap[];
  invites: string[];
  skipped: CalendarSkipped[];
}
