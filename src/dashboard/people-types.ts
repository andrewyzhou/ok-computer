// the shapes of the people api (phase 6 t5). the web pages import this file, so it holds types only and imports
// nothing. every time is an iso string in utc.

export type PersonSort = 'recent' | 'frequent' | 'name';
export type PersonNoteKind = 'note' | 'preference';
export type PersonNoteAuthor = 'agent' | 'owner';
export type PersonContactRole = 'from' | 'to' | 'cc' | 'organizer' | 'attendee';
export type PeopleBackfillState = 'pending' | 'running' | 'done' | 'failed';

// one row of the people list, and the head of a profile.
export interface PersonSummary {
  id: number;
  // the name that the owner sees, or null when no header gave one.
  name: string | null;
  // the name, or the primary email when there is no name. a view shows this.
  displayName: string;
  primaryEmail: string;
  // every address of the person, the primary one first.
  emails: string[];
  // from the email domain, for example "Acme" and "acme.com". null for a personal domain such as gmail.com.
  organization: string | null;
  organizationDomain: string | null;
  // the mails and the meetings until now. a meeting in the future and a cancelled one do not count.
  mailCount: number;
  meetingCount: number;
  // the first and the last contact until now, or null when every contact is in the future.
  firstContactAt: string | null;
  lastContactAt: string | null;
  // the start of the next meeting that is not cancelled, or null.
  nextMeetingAt: string | null;
}

// GET /api/people. next is the cursor of the next page, or null on the last page.
export interface PeoplePage {
  people: PersonSummary[];
  next: string | null;
  // the number of people that match the query, on every page.
  total: number;
}

export interface PersonEmailView {
  email: string;
  isPrimary: boolean;
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface PersonNameView {
  name: string;
  // the number of contacts that gave this name.
  count: number;
  lastSeenAt: string;
}

export interface PersonMeetingView {
  account: string;
  eventId: string;
  // the title of the event, cut to 200 characters, or "(no title)".
  title: string;
  startAt: string;
  endAt: string | null;
  role: PersonContactRole;
}

// a mail thread with the person where the newest message is from them and the owner has not answered after it.
export interface PersonThreadView {
  account: string;
  threadId: string;
  // the subject line of the newest message, cut to 200 characters, or "(no subject)".
  subject: string;
  lastAt: string;
  // the messages of the thread that the polls saw with this person.
  messages: number;
}

export interface PersonNoteView {
  id: number;
  kind: PersonNoteKind;
  text: string;
  author: PersonNoteAuthor;
  // the run of the agent that wrote it, or null for the owner.
  runId: string | null;
  createdAt: string;
}

// a delegation of the desk that waits on this person. the list is empty until the desk (track t3) is there.
export interface PersonDelegationView {
  id: number;
  title: string;
  status: string;
  dueAt: string | null;
}

// GET /api/people/:id.
export interface PersonProfile extends PersonSummary {
  names: PersonNameView[];
  emailDetails: PersonEmailView[];
  // the next meetings that are not cancelled, soonest first, at most 10.
  upcoming: PersonMeetingView[];
  // the last meetings until now, newest first, at most 5.
  recentMeetings: PersonMeetingView[];
  // the open threads of the last 30 days, newest first, at most 10.
  openThreads: PersonThreadView[];
  // the notes and the preferences that no later note supersedes, newest first.
  notes: PersonNoteView[];
  preferences: PersonNoteView[];
  delegations: PersonDelegationView[];
}

// POST /api/people/:id/merge: the other person joins this one, which stays. the answer is the PersonProfile of the
// person that stays, and the id of the other one then gives that profile too.
export interface PersonMergeInput {
  otherId: number;
}

// POST /api/people/:id/notes.
export interface PersonNoteInput {
  kind: PersonNoteKind;
  // 1 to 2000 characters.
  text: string;
  // the id of a note of the same person that this note replaces.
  supersedes?: number;
}

export interface PeopleAccountStatus {
  account: string;
  backfill: PeopleBackfillState;
  backfillMessages: number;
  backfillEvents: number;
  backfilledAt: string | null;
  error: string | null;
}

// GET /api/people/status.
export interface PeopleStatus {
  // false when no google account is set up, so the people memory cannot fill.
  configured: boolean;
  people: number;
  accounts: PeopleAccountStatus[];
}
