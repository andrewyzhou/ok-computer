// the shapes of the brief api of phase 6 t1 (the today track). the web pages and the brief code import this file, so
// it holds types only and imports nothing. docs/API.md (t1) gives the routes and the errors.

// the sections of a brief, in the order of the page. a section with no items is left out, except day, which says that
// the calendar is empty.
// money is the section of the subscription alerts (track s3 of docs/CONNECT-PLAN.md).
export type BriefSectionKind = 'day' | 'conflicts' | 'travel' | 'invites' | 'deadlines' | 'inbox' | 'delegations' | 'goals' | 'money';

// the thing an item is about. the page makes a link of it (web/src/views/today/links.ts), so each item opens its source.
// an event names the key of CalendarEvent and the day of its start. a thread names the mail of a digest item.
export type BriefSource =
  | { kind: 'event'; key: string; day: string }
  | { kind: 'thread'; account: string; threadId: string; digestId: number }
  | { kind: 'digest'; digestId: number }
  | { kind: 'draft'; draftId: number }
  | { kind: 'proposal'; proposalId: number }
  | { kind: 'delegation'; delegationId: number }
  | { kind: 'goal'; goalId: number }
  // a subscription alert names the key of its merged row (SubscriptionRow.key) and the id of the alert.
  | { kind: 'subscription'; key: string; alertId: number };

// one line of a brief. title is short. detail is the second line, or null. at is the time that the item is about (the
// start of an event, a due time), or null. tone marks an item that needs the owner (warning) or is late (critical).
// the text can hold untrusted text from mail and invitations, so the page shows it as text.
export interface BriefItem {
  id: string;
  title: string;
  detail: string | null;
  at: string | null;
  account: string | null;
  tone: 'info' | 'warning' | 'critical' | null;
  source: BriefSource;
}

export interface BriefSection {
  kind: BriefSectionKind;
  title: string;
  items: BriefItem[];
  // one sentence under the title, for example "No events today." or "The calendar of school could not be read."
  note: string | null;
}

// a delegation as the brief reads it from the desk track (t3), when that module is there.
export interface BriefDelegation {
  id: number;
  title: string;
  status: 'open' | 'waiting' | 'blocked' | 'done' | 'dropped';
  nextStep: string | null;
  waitingOn: string | null;
  dueAt: string | null;
  followUpAt: string | null;
}

// what the brief could read. calendar is ok, partial (some accounts failed), failed (every account failed), or off
// (no google block). an entry of skipped with a calendarId is one calendar of an account that was read, so it makes the
// state partial and not failed. digest is the digest that the brief used, or null. desk is false when the desk could not
// be read, so the page does not claim that nothing waits.
export interface BriefSources {
  calendar: 'ok' | 'partial' | 'failed' | 'off';
  skipped: Array<{ account: string; reason: string; calendarId?: string }>;
  digest: { id: number; day: string } | null;
  desk: boolean;
}

// the stored content of one brief. day is yyyy-mm-dd in the time zone of the app.
export interface BriefContent {
  day: string;
  timeZone: string;
  generatedAt: string;
  sections: BriefSection[];
  sources: BriefSources;
}

// the telegram message of a brief and whether it reached the owner. channel is null when no chat of the owner is
// known.
export interface BriefDelivery {
  channel: string | null;
  ok: boolean;
  error: string | null;
  at: string;
}

// one stored brief. a second brief of the same day is a new row, and the newest one of a day is the brief of the day.
export interface Brief {
  id: number;
  day: string;
  runId: string | null;
  createdAt: string;
  shortText: string;
  content: BriefContent;
  delivery: BriefDelivery | null;
}

export interface BriefSummary {
  id: number;
  day: string;
  createdAt: string;
  items: number;
  sent: boolean;
}

// newest first. nextCursor is null on the last page.
export interface BriefsPage {
  briefs: BriefSummary[];
  nextCursor: string | null;
}

// the automation of the brief. time is hh:mm in the time zone of the app, or null when the automation is missing or
// its schedule is not one time each day.
export interface BriefSchedule {
  automationId: string | null;
  time: string | null;
  enabled: boolean;
  nextRunAt: string | null;
  running: boolean;
}

// PUT /api/brief/schedule. time is hh:mm, 00:00 to 23:59.
export interface BriefScheduleRequest {
  time: string;
}
