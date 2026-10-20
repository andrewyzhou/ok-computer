// the shapes of the desk api of phase 6 t3: delegations, their links, their history and their nudge drafts. the
// server code, the agent tools and the web pages import them, so this file imports nothing. docs/API.md (T3) gives
// the routes that answer with them.

export type DelegationStatus = 'open' | 'waiting' | 'blocked' | 'done' | 'dropped';

// the jobs of the desk that the scheduler runs in code. the automation payload is { type: 'desk', job }.
export type DeskJob = 'followups';

export type DelegationLinkKind = 'run' | 'doc' | 'thread' | 'event';

export type DelegationActor = 'agent' | 'owner' | 'system';

// what one row of the history records.
// - created: the delegation was made. data has the fields it started with.
// - updated: fields changed. data.changes maps each field to { from, to }.
// - status: the status changed. data is { from, to }. a move to done or dropped is a status row too.
// - waiting_on: the person changed. data is { name, email, followUpAt }.
// - link_added and link_removed: data is the link.
// - note: a line from the agent or the owner, in text.
// - follow_up_checked: the follow-up job read the thread and found no reply. data is { threadId, account }.
// - reply_seen: the follow-up job found a reply. data is { threadId, account, messageId, from }.
// - nudge_drafted: the follow-up job saved a nudge draft. data is { nudgeId, gmailDraftId, account, threadId }.
// - follow_up_due: a follow-up came, but there was no thread to check or no google account, so the owner was told.
// - follow_up_failed: the follow-up job could not check, for example because the account is signed out. text says why.
export type DelegationEventKind =
  | 'created'
  | 'updated'
  | 'status'
  | 'waiting_on'
  | 'link_added'
  | 'link_removed'
  | 'note'
  | 'follow_up_checked'
  | 'reply_seen'
  | 'nudge_drafted'
  | 'follow_up_due'
  | 'follow_up_failed';

export interface WaitingOn {
  // at least one of the two is set.
  name: string | null;
  email: string | null;
}

export interface DelegationLink {
  kind: DelegationLinkKind;
  // a runs id, a docs id, a gmail thread id or a calendar event id.
  ref: string;
  // the google alias of a thread or an event, and null for a run or a doc.
  account: string | null;
  label: string | null;
  // the hash path of the page that shows the link, without #/, for example runs/<id> or docs/<id>. null when the web
  // app has no page for it, as for a mail thread.
  href: string | null;
}

export interface Delegation {
  id: number;
  title: string;
  details: string | null;
  status: DelegationStatus;
  nextStep: string | null;
  waitingOn: WaitingOn | null;
  waitingSince: string | null;
  dueAt: string | null;
  nextFollowUpAt: string | null;
  lastCheckedAt: string | null;
  // the nudge drafts that the follow-up job saved for the delegation.
  nudgeCount: number;
  links: DelegationLink[];
  createdBy: 'agent' | 'owner';
  sessionKey: string | null;
  runId: string | null;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

export interface DelegationEvent {
  id: number;
  delegationId: number;
  kind: DelegationEventKind;
  actor: DelegationActor;
  text: string | null;
  data: Record<string, unknown>;
  runId: string | null;
  toolCallId: string | null;
  // true when the agent wrote the row after its session read outside text, for example a mail, so the text may come
  // from that mail.
  tainted: boolean;
  createdAt: string;
}

export interface DelegationNudge {
  id: number;
  delegationId: number;
  account: string;
  threadId: string;
  sourceMessageId: string | null;
  // empty while the draft is being saved.
  gmailDraftId: string;
  toAddress: string;
  subject: string;
  body: string;
  followUpAt: string;
  runId: string | null;
  createdAt: string;
}

// GET /api/desk/delegations/:id
export interface DelegationDetail extends Delegation {
  // oldest first.
  history: DelegationEvent[];
  // newest first.
  nudges: DelegationNudge[];
}

// a person that a delegation waits on, for the person filter. key is the waitingOnKey of the rows.
export interface DeskPerson {
  key: string;
  name: string | null;
  email: string | null;
  // the delegations of the person that are open, waiting or blocked.
  active: number;
}

export interface DeskColumn {
  status: DelegationStatus;
  // the open, waiting and blocked columns hold every row, by dueAt (rows without one last), then by id. the done and
  // dropped columns hold the newest DESK_CLOSED_LIMIT rows by closedAt.
  delegations: Delegation[];
  // every row of the status that matches the filter, also the ones that the column leaves out.
  total: number;
}

// GET /api/desk
export interface DeskQuery {
  status?: DelegationStatus;
  // a DeskPerson key.
  person?: string;
  // 1 to 200 characters, matched in the title, the details and the next step.
  q?: string;
}

export interface DeskBoard {
  // the five columns in the order of DESK_STATUSES. a status filter leaves the other columns empty with total 0.
  columns: DeskColumn[];
  // every person with an active delegation, by name. the filter does not change this list.
  people: DeskPerson[];
  // the active delegations that are due before the end of today, or whose follow-up time has passed.
  dueToday: number;
  // the number of delegations of each status on the whole desk. like people, the filter does not change it, so the
  // status tabs keep the overview. an older server leaves it out.
  counts?: Record<DelegationStatus, number>;
  // the time zone of the app, so the form reads and shows the times in it and not in the zone of the browser.
  timeZone?: string;
}

// a link in a request. account is needed for a thread and an event.
export interface DelegationLinkInput {
  kind: DelegationLinkKind;
  ref: string;
  account?: string;
  label?: string;
}

// POST /api/desk/delegations. a time is an iso time with an offset, or yyyy-mm-dd (the end of that day for dueAt,
// 09:00 for nextFollowUpAt, in the time zone of the app).
export interface DelegationCreateRequest {
  title: string;
  details?: string;
  nextStep?: string;
  // a delegation with waitingOn starts as waiting.
  waitingOn?: { name?: string; email?: string };
  dueAt?: string;
  nextFollowUpAt?: string;
  links?: DelegationLinkInput[];
}

// POST /api/desk/delegations/:id. a field that is left out stays. null clears details, nextStep, waitingOn, dueAt
// and nextFollowUpAt. note adds a note row to the history.
export interface DelegationUpdateRequest {
  title?: string;
  details?: string | null;
  nextStep?: string | null;
  status?: DelegationStatus;
  waitingOn?: { name?: string; email?: string } | null;
  dueAt?: string | null;
  nextFollowUpAt?: string | null;
  addLinks?: DelegationLinkInput[];
  removeLinks?: Array<{ kind: DelegationLinkKind; ref: string; account?: string }>;
  note?: string;
}
