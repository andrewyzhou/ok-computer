// the shapes of the autonomy api and of the autonomy store. the page imports them, so this file imports nothing.
// docs/PHASE6-PLAN.md (track T6) gives the rules, and src/policy/autonomy.ts holds the list of the domains.

// ask: the owner approves each call. review: the reviewer model decides each call, and the owner sees it in the trace.
// auto: the call runs without a check, and only a domain whose maxLevel is auto allows it. the order of the list is
// the order of trust, so a higher index is more freedom.
export type AutonomyLevel = 'ask' | 'review' | 'auto';

export type AutonomyDomain =
  | 'mail_drafts'
  | 'mail_labels'
  | 'calendar_holds'
  | 'calendar_guests'
  | 'delegations'
  | 'local_writes'
  | 'browser_submits'
  | 'unsubscribes'
  | 'sandbox_network'
  | 'purchases';

// who changed a level, and where. only the owner on the dashboard can raise a level. the agent can only lower one,
// from a chat in which the owner asked for it.
export type AutonomyActor = 'owner' | 'agent';
export type AutonomyVia = 'dashboard' | 'chat';

// one domain on the autonomy page. levels lists the levels that the owner can choose, from ask up to maxLevel. a fixed
// domain has only ask in levels, and fixedReason says why in plain words.
export interface AutonomyDomainView {
  id: AutonomyDomain;
  label: string;
  // what the domain covers, in plain words for the owner.
  explanation: string;
  // the tools of the domain, for developer mode.
  tools: string[];
  level: AutonomyLevel;
  defaultLevel: AutonomyLevel;
  maxLevel: AutonomyLevel;
  levels: AutonomyLevel[];
  fixed: boolean;
  fixedReason: string | null;
  // the last change of the level, or null while the domain has its default level.
  updatedAt: string | null;
  changeId: number | null;
  // the id of an allow rule in okc.policy.json that lets the calls of the domain run without the reviewer, while the
  // domain is at its default level. the policy rule then decides, not the level. null when no rule does.
  overriddenBy: string | null;
}

// one row of the append-only history of the levels.
export interface AutonomyChangeRow {
  id: number;
  domain: AutonomyDomain;
  fromLevel: AutonomyLevel;
  toLevel: AutonomyLevel;
  actor: AutonomyActor;
  via: AutonomyVia;
  // the run, the tool call and the session of a change from chat. a change on the dashboard has null in each.
  runId: string | null;
  toolCallId: string | null;
  sessionKey: string | null;
  // the reason that the agent gave, or the note of the owner.
  note: string | null;
  // the untrusted sources, such as a mail or a page, that the session of a change from chat had read before the
  // change. the reason may then come from that content and not from the owner. empty when there were none.
  taint: string[];
  createdAt: string;
}

// GET /api/autonomy. levelText explains each level in plain words. history is the newest page of the history.
export interface AutonomyPage {
  domains: AutonomyDomainView[];
  levelText: Record<AutonomyLevel, string>;
  history: AutonomyChangeRow[];
  // the id to send as before for the next older page, or null when history holds the oldest row.
  before: number | null;
}

// GET /api/autonomy/history?domain=&before=&limit=
export interface AutonomyHistoryPage {
  changes: AutonomyChangeRow[];
  before: number | null;
}

// POST /api/autonomy/:domain. from is the level that the page showed, so a change made in another tab in the
// meantime gives 409 and not a silent overwrite.
export interface AutonomySetRequest {
  level: AutonomyLevel;
  from: AutonomyLevel;
  note?: string;
}

// change is null when the level was already the asked one.
export interface AutonomySetResponse {
  domain: AutonomyDomainView;
  change: AutonomyChangeRow | null;
}
