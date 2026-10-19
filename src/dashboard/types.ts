// these are the shapes of the dashboard api. the web app imports this file too, so it has no imports.

export interface Meta {
  timeZone: string;
  now: string;
}

export interface RunRow {
  id: string;
  sessionKey: string;
  trigger: string;
  slot: string;
  status: string;
  startedAt: string;
  endedAt: string | null;
  error: string | null;
  costUsd: number | null;
  modelCalls: number;
  toolCalls: number;
}

export interface ModelCallRow {
  id: number;
  runId: string | null;
  slot: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number | null;
  latencyMs: number;
  stopReason: string | null;
  error: string | null;
  createdAt: string;
  // the hash of the tool list that the call offered, and the number of tools in it.
  toolCatalogHash: string | null;
  toolCount: number | null;
}

export interface ModelCallBody {
  request: unknown;
  response: unknown;
}

export interface PolicyDecisionRow {
  id: number;
  decision: string;
  rule: string;
  reason: string;
  reviewerModelCallId: number | null;
  reviewerVerdict: string | null;
  reviewerReason: string | null;
  approvalId: number | null;
  approvalStatus: string | null;
  // the untrusted sources that the session had read when the policy decided.
  taint: Array<{ source: string; toolName: string; runId: string | null; toolCallId: string; at: string }>;
  createdAt: string;
  // the model call of the reviewer. the run timeline shows it here, inside the tool call that it checked.
  reviewerCall?: ModelCallRow;
}

// one row of the policy page. the run link opens the call with its input and its reviewer call.
export interface PolicyListRow extends PolicyDecisionRow {
  runId: string;
  sessionKey: string;
  toolName: string;
}

export interface PolicyRuleRow {
  id: string;
  tool: string;
  session: string | null;
  args: Record<string, string> | null;
  effect: string;
  note: string | null;
}

export interface PolicyPage {
  decisions: PolicyListRow[];
  // the rules that the app uses now: the built-in rules, then the rules of okc.policy.json.
  rules: PolicyRuleRow[];
}

export interface ToolCallRow {
  id: number;
  runId: string;
  toolCallId: string;
  name: string;
  input: unknown;
  // output holds the exact text that the model got.
  output: { content: string; isError?: boolean };
  isError: boolean;
  durationMs: number;
  createdAt: string;
  source: string;
  riskLevel: string | null;
  tainted: boolean;
  untrustedSource: string | null;
  truncated: boolean;
  resultHandle: string | null;
  // the raw result is rawResultBlob ?? output.content. the blob exists only when the model saw other text: a
  // preview, a wrapped text, or a late result. such a row without a blob lost its raw text in a failed blob write.
  rawResultBlob: string | null;
  // one word from outcomeOf in outcome.ts: ran, failed, invalid, denied, held, waiting, approved, declined, expired,
  // abandoned, late, interrupted or unsent. a delegate call whose child still runs has no row yet, and is running.
  outcome: string;
  policy: PolicyDecisionRow | null;
  // the integration that ran the tool, and the json-rpc messages of the call. a built-in tool has none.
  serverId: string | null;
  mcpMessages: McpMessageRow[];
  // the child run that a delegate call started. the run page shows its timeline inside the call.
  child?: SubagentLink;
}

// the link between a child run and the delegate call of its parent. a child that never started has no status.
export interface SubagentLink {
  parentRunId: string;
  toolCallId: string;
  childRunId: string;
  profile: string;
  status: string | null;
  costUsd: number | null;
}

// a payload over 8 kb is in the blob store. payload is then null, and the page loads it on demand. unsent marks a
// request that the transport refused after its out row was written.
export interface McpMessageRow {
  id: number;
  serverId: string;
  direction: 'out' | 'in' | 'unsent';
  method: string | null;
  rpcId: string | null;
  runId: string | null;
  toolCallId: string | null;
  latencyMs: number | null;
  createdAt: string;
  payload: unknown;
  payloadBlob: string | null;
  // the message of a json-rpc error, of a tool result with isError, or of a refused send.
  error: string | null;
}

export interface IntegrationToolRow {
  name: string;
  mcpName: string;
  description: string;
  risk: string;
  // okc.integrations.json, or the default with the hint of the server.
  riskFrom: string;
  inputSchema: Record<string, unknown>;
}

// the live state of the dashboard's own process, with counts from the database.
export interface IntegrationSummary {
  id: string;
  kind: string;
  target: string;
  sessions: string[];
  untrustedOutput: boolean;
  state: { status: string; error?: string; retryAt?: string; server?: { name: string; version: string } };
  paused: boolean;
  auth: string;
  authorizedAt: string | null;
  tokenExpiresAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
  withheldScopes?: string[];
  authUrl?: string;
  oauthApp?: { redirectUrl: string; callback: 'loopback' | 'paste'; clientRef?: string };
  catalogHash?: string;
  catalogStored?: boolean;
  tools: IntegrationToolRow[];
  rejected: Array<{ mcpName: string; reason: string }>;
  // missing: tools.allow names them, and the last tool list does not have them. hidden: the server has them, and
  // tools.allow does not name them. unknown: no tool list was seen since tools.allow named them.
  missing: string[];
  hidden: string[];
  unknown: string[];
  calls24h: number;
  errors24h: number;
  lastMessageAt: string | null;
}

export interface CatalogVersion {
  hash: string;
  createdAt: string;
  toolCount: number;
  // the change from the version before. the first version has none.
  diff: { added: string[]; removed: string[]; changed: Array<{ name: string; fields: string[] }> } | null;
}

export interface IntegrationDetail extends IntegrationSummary {
  catalogs: CatalogVersion[];
  calls: ToolCallRow[];
  messages: McpMessageRow[];
}

// a model call holds the tool calls that its response asked for. a tool call that ran after an approval has no
// such model call, so it is an item of its own. reviews are the reviewer calls with no verdict that checked the tool
// calls of the turn.
export type TimelineItem = { kind: 'model'; call: ModelCallRow; tools: ToolCallRow[]; reviews?: ModelCallRow[] } | { kind: 'tool'; call: ToolCallRow };

export interface BlobBody {
  hash: string;
  size: number;
  mime: string;
  createdAt: string;
  text: string;
}

export interface ToolCatalog {
  hash: string;
  createdAt: string;
  tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>;
}

export interface EventRow {
  id: number;
  sessionKey: string;
  runId: string | null;
  seq: number;
  type: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface RunDetail {
  run: RunRow;
  // a child run names the delegate call of its parent.
  parent: SubagentLink | null;
  timeline: TimelineItem[];
  events: EventRow[];
}

export interface SessionRow {
  sessionKey: string;
  events: number;
  compactions: number;
  firstAt: string;
  lastAt: string;
}

export type ContextBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_result'; toolCallId: string; content: string; isError: boolean };

export type ContextMessage =
  | { role: 'user'; content: ContextBlock[] }
  | { role: 'assistant'; text: string; toolCalls: Array<{ id: string; name: string; input: unknown }>; content: unknown[] };

export interface ContextView {
  system: string;
  tools: Array<{ name: string; description: string }>;
  messages: ContextMessage[];
  estimatedTokens: number;
}

export interface GoalRow {
  id: number;
  day: string;
  title: string;
  eta: string | null;
  status: string;
  completedAt: string | null;
  note: string | null;
}

export interface GoalStatsRow {
  from: string;
  to: string;
  daysWithGoals: number;
  goals: number;
  done: number;
  doneOnTime: number;
  dropped: number;
  open: number;
  hitRate: number | null;
  setStreak: number;
  allDoneStreak: number;
}

export interface GoalsPage {
  today: string;
  goals: GoalRow[];
  days: Array<{ day: string; goals: number; done: number }>;
  stats7: GoalStatsRow;
  stats30: GoalStatsRow;
}

export interface AutomationRow {
  id: string;
  name: string;
  schedule: string;
  payloadType: string;
  sessionMode: string;
  slot: string;
  enabled: boolean;
  createdBy: string;
  nextRunAt: string | null;
  lastRunAt: string | null;
  consecutiveFailures: number;
}

export interface AutomationRunRow {
  id: number;
  automationId: string;
  runId: string | null;
  status: string;
  startedAt: string;
  endedAt: string | null;
  error: string | null;
}

export interface HeartbeatStatus {
  automation: AutomationRow | null;
  every: string;
  activeHours: { start: string; end: string };
  inActiveHours: boolean;
  checklist: string;
  lastRun: AutomationRunRow | null;
}

export interface Overview {
  day: string;
  costUsd: number;
  runs: number;
  failedRuns: number;
  modelErrors: number;
  openGoals: GoalRow[];
  nextAutomations: AutomationRow[];
  heartbeat: HeartbeatStatus;
  blobs: { count: number; bytes: number };
}

export interface ApprovalRow {
  id: number;
  runId: string;
  sessionKey: string;
  toolName: string;
  summary: string;
  // the full input, redacted.
  input: unknown;
  status: string;
  requestedAt: string;
  resolvedAt: string | null;
  resolvedBy: string | null;
}

export interface MemoryFile {
  path: string;
  size: number;
  modifiedAt: string;
}

export interface CostGroup {
  key: string;
  costUsd: number;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
}

export interface CostPage {
  from: string;
  to: string;
  days: CostGroup[];
  slots: CostGroup[];
  models: CostGroup[];
  // calls of a model without a price have no cost. the totals leave them out.
  unpricedCalls: number;
}

export interface LogLine {
  ts: string;
  level: string;
  msg: string;
  [field: string]: unknown;
}

// the kinds after log come from phase 5 m1. a page that does not know a kind ignores it.
export type StreamMessage =
  | { kind: 'event'; event: EventRow }
  | { kind: 'run'; run: RunRow }
  | { kind: 'log'; line: LogLine }
  | { kind: 'model_call'; call: StreamModelCall }
  | { kind: 'tool_call'; call: StreamToolCall }
  | { kind: 'browser_step'; step: StreamBrowserStep }
  | { kind: 'approval'; approval: StreamApproval }
  | { kind: 'policy'; decision: StreamPolicy };

// phase 5 contracts. each section belongs to one milestone. a team adds fields only in its own section, and
// docs/PHASE5-API.md gives the endpoint of each shape. a time is an iso string in utc, and a cost is in us dollars.

// phase 5 m1: chats, search, spans

// main is the owner's chat. each other kind is a background session, and its key starts with the kind and a colon.
// other is a session key with no known prefix.
export type ChatKind = 'main' | 'auto' | 'heartbeat' | 'sub' | 'consolidate' | 'workshop' | 'poll' | 'other';

// one chat of the nav list. the main session is split at each session_reset event, so one segment of it is one chat
// with the key main@<resetEventId>. the first segment, before any reset, has the key main@0. a background chat is one
// session, and its key is the session key.
export interface ChatRow {
  key: string;
  kind: ChatKind;
  sessionKey: string;
  // the event ids that the segment covers. toEventId is null for the segment that is still open.
  fromEventId: number;
  toEventId: number | null;
  // the start of the first owner message, or the name of the automation, the profile or the job.
  title: string;
  // the channel of the last owner message: telegram, web or cli. a background chat has none.
  channel: string | null;
  // the start of the last delivered text, at most 200 characters.
  preview: string | null;
  firstAt: string;
  lastAt: string;
  runs: number;
  costUsd: number | null;
  lastRunStatus: string | null;
  pendingApprovals: number;
}

// the kind filter takes one ChatKind, or activity for every kind except main. without it, the list has every chat.
export type ChatKindFilter = ChatKind | 'activity';

export interface ChatsQuery {
  kind?: ChatKindFilter;
  // a case-blind match on the title and the preview.
  q?: string;
  // the nextCursor of the page before.
  cursor?: string;
  // 1 to 200. the default is 50.
  limit?: number;
}

// the list is sorted by lastAt, newest first. nextCursor is null on the last page. the cursor is opaque.
export interface ChatsPage {
  chats: ChatRow[];
  nextCursor: string | null;
}

// owner is a user_message event, agent is the delivered text of an assistant_message event, note is a guard note or
// another note of the app, and system is a system_event that the chat shows, for example a session_reset.
export type ChatMessageRole = 'owner' | 'agent' | 'note' | 'system';

export interface ChatMessage {
  // the id of the event.
  id: number;
  role: ChatMessageRole;
  runId: string | null;
  channel: string | null;
  text: string;
  // true for a note of the reply guard, and for the reply that the guard changed or held.
  guarded: boolean;
  // the approval that the message asks for, so the chat can show the approval card inline.
  approvalId: number | null;
  createdAt: string;
}

export interface ChatMessagesQuery {
  // an event id. the page holds the messages before it. without it, the page holds the newest messages.
  before?: number;
  // 1 to 200. the default is 50.
  limit?: number;
}

// messages are oldest first. before is the value for the next, older page, and it is null when no older message exists.
export interface ChatMessagesPage {
  chat: ChatRow;
  messages: ChatMessage[];
  before: number | null;
}

export type SearchScope = 'messages' | 'runs' | 'tools' | 'automations' | 'memory' | 'approvals';

// a hit has a short snippet around the match. marks are the [start, end) offsets of the matches in the snippet, so the
// page never renders html from the server.
export interface SearchHit {
  scope: SearchScope;
  // the id of the row in its scope: an event id, a run id, a tool call row id, an automation id, a memory path or an
  // approval id. it is a string for each scope.
  id: string;
  title: string;
  snippet: string;
  marks: Array<[number, number]>;
  sessionKey: string | null;
  runId: string | null;
  // the chat key of a message hit, so the page can open the chat.
  chatKey: string | null;
  at: string | null;
  // the hash route that the hit opens, without the #/. for example runs/run-1 or chats/main@0.
  href: string;
}

export interface SearchGroup {
  scope: SearchScope;
  hits: SearchHit[];
  // more is true when the scope has more hits than the limit.
  more: boolean;
}

export interface SearchQuery {
  // 1 to 200 characters. the server escapes it for fts5.
  q: string;
  // one scope, or every scope when it is not given.
  scope?: SearchScope;
  // the hits per scope, 1 to 50. the default is 8 for every scope, and 30 for one scope.
  limit?: number;
}

// fts is the trigram index. like is the fallback for a query of fewer than 3 characters. the groups are in the order
// of SearchScope, and a scope with no hits has an empty group. with a scope, groups has that one group only.
export interface SearchResults {
  q: string;
  mode: 'fts' | 'like';
  groups: SearchGroup[];
}

export type SpanKind = 'run' | 'model' | 'tool' | 'review' | 'approval' | 'subagent' | 'mcp' | 'google' | 'browser' | 'sandbox';

// the row that a span opens. the inspectors of m5 load the full row through the endpoint of its kind.
export type SpanRef =
  | { kind: 'run'; runId: string }
  | { kind: 'model'; modelCallId: number }
  | { kind: 'tool'; toolCallRowId: number; toolCallId: string }
  | { kind: 'review'; modelCallId: number; toolCallId: string | null }
  | { kind: 'approval'; approvalId: number }
  | { kind: 'subagent'; childRunId: string }
  | { kind: 'mcp'; mcpMessageId: number }
  | { kind: 'google'; googleRequestId: number }
  | { kind: 'browser'; browserStepId: number; taskId: string }
  | { kind: 'sandbox'; sandboxExecId: number };

// the server computes each start and end. startMs and endMs count from the start of the run. a span that has not
// ended has endAt and endMs null, and the page draws it to now.
export interface Span {
  // a stable id in the run, for example model:12 or tool:40.
  id: string;
  parentId: string | null;
  kind: SpanKind;
  label: string;
  startAt: string;
  endAt: string | null;
  startMs: number;
  endMs: number | null;
  // a word from the row: the run status, the tool outcome (the outcomeOf word of the run detail), the approval status,
  // an http status or an exit code.
  status: string | null;
  error: string | null;
  costUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  ref: SpanRef;
}

// the spans are sorted by startMs, and the run span is first. the spans of a child run are in the list too, with the
// sub-agent span as their parent, so the waterfall nests them.
export interface RunSpans {
  runId: string;
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  costUsd: number | null;
  spans: Span[];
}

// the filters of /api/runs. sessionKey and before are new. the response stays RunRow[], newest first. before is a run
// id, and the page holds the runs that started before that run. a page with fewer rows than the limit is the last one.
export interface RunsQuery {
  trigger?: string;
  slot?: string;
  status?: string;
  day?: string;
  sessionKey?: string;
  before?: string;
  limit?: number;
}

// the filters of /api/logs. day and runId are new. day is yyyy-mm-dd in the time zone of the app, and runId keeps the
// lines with that run id.
export interface LogsQuery {
  level?: string;
  limit?: number;
  day?: string;
  runId?: string;
}

// the latest step of an open browser task, with the fields that the live view needs.
export interface BrowserLiveStep {
  id: number;
  action: string;
  target: string | null;
  urlAfter: string | null;
  screenshotBlob: string | null;
  error: string | null;
  durationMs: number;
  createdAt: string;
}

export interface BrowserLiveTask {
  id: string;
  kind: 'task' | 'search';
  sessionKey: string;
  runId: string | null;
  allowlist: string[];
  startedAt: string;
  steps: number;
  latest: BrowserLiveStep | null;
}

// the open browser tasks, newest first.
export interface BrowserLive {
  tasks: BrowserLiveTask[];
}

// the stream messages of m1 carry ids and short summaries only. the page loads the full row when it needs it.
export interface StreamModelCall {
  id: number;
  runId: string | null;
  slot: string;
  model: string;
  costUsd: number | null;
  latencyMs: number;
  error: string | null;
  createdAt: string;
}

export interface StreamToolCall {
  id: number;
  runId: string;
  toolCallId: string;
  name: string;
  outcome: string;
  durationMs: number;
  createdAt: string;
}

export interface StreamBrowserStep {
  id: number;
  taskId: string;
  runId: string | null;
  action: string;
  urlAfter: string | null;
  screenshotBlob: string | null;
  error: string | null;
  createdAt: string;
}

// the feed sends an approval when it is asked for, and again when it is resolved.
export interface StreamApproval {
  id: number;
  runId: string;
  sessionKey: string;
  toolName: string;
  summary: string;
  status: string;
  requestedAt: string;
  resolvedAt: string | null;
}

export interface StreamPolicy {
  id: number;
  runId: string;
  toolCallId: string;
  toolName: string;
  decision: string;
  rule: string;
  // the verdict of the reviewer, once it has answered. a policy message comes again when it or approvalId changes.
  reviewerVerdict: string | null;
  approvalId: number | null;
  createdAt: string;
}

// phase 5 m2: web chat

export interface ChatButton {
  text: string;
  data: string;
}

// a turn is one owner message and the work on it. its id is the messageId of the inbound message: web:<uuid> for a web
// turn, and telegram:<message id> for a turn that telegram started.
export type ChatTurnState = 'queued' | 'running' | 'done' | 'failed' | 'stopped';

// text has 1 to 16,000 characters.
export interface ChatSendRequest {
  text: string;
}

// queued means that the session runs another turn now, and this turn waits for it. a command such as /status is
// running, and it ends as done right after its answer.
export interface ChatSendResponse {
  turnId: string;
  state: 'queued' | 'running';
}

// the data of a button from a reply, as it came. it carries a mark that the server checks, so data that the page did
// not get on a button gives 400. turnId is the turn of the reply that had the button, when it had one.
export interface ChatButtonRequest {
  data: string;
  turnId?: string;
}

export interface ChatButtonResponse {
  ok: true;
}

export interface ChatStopRequest {
  turnId: string;
}

// stopped is false when the turn already ended, is not known, or still waits in the queue.
export interface ChatStopResponse {
  stopped: boolean;
}

export interface ChatTurnSnapshot {
  turnId: string;
  channel: string;
  state: ChatTurnState;
  runId: string | null;
  // the streamed text of the current model call so far.
  text: string;
  activity: string | null;
}

// the events of /api/chat/stream. snapshot is the first event of each connection, and it holds the turns that have not
// ended. text gives the new part of the streamed text. reset true means that the page drops the streamed text first,
// because a new model call started or the full text changed in another way. the reply is the guarded final text, and
// it replaces the streamed text. a reply with no turnId is not an answer to a turn: a copy of a proactive message such
// as an approval card, or the answer to a button press. the text of a reply and of a text event is model text, and it
// is not trusted: the page renders its markdown with no raw html, loads no image without a click, and makes only
// http(s) links clickable. error comes right before the failed state of a turn, with the text that the owner got.
export type ChatStreamEvent =
  | { kind: 'snapshot'; turns: ChatTurnSnapshot[] }
  | { kind: 'owner'; turnId: string; channel: string; text: string; at: string }
  | { kind: 'state'; turnId: string; state: ChatTurnState }
  | { kind: 'run'; turnId: string; runId: string }
  | { kind: 'text'; turnId: string; delta: string; reset: boolean }
  | { kind: 'activity'; turnId: string; tools: string | null }
  | {
      kind: 'reply';
      turnId: string | null;
      messageId: string;
      runId: string | null;
      text: string;
      markdown: boolean;
      details: string | null;
      buttons: ChatButton[][];
      at: string;
    }
  | { kind: 'done'; turnId: string; ok: boolean }
  | { kind: 'error'; turnId: string | null; error: string };

// phase 5 m8: inbox jobs

export type UnsubscribeMethod = 'one_click' | 'https' | 'mailto' | 'none';

export type SenderState = 'active' | 'kept' | 'unsubscribe_pending' | 'unsubscribed' | 'failed';

// one sender of the newsletter sweep. senderKey is the List-Id, or the From address when the mail has no List-Id.
export interface NewsletterSenderRow {
  id: number;
  account: string;
  senderKey: string;
  listId: string | null;
  fromAddress: string;
  displayName: string | null;
  messages: number;
  read: number;
  // read divided by messages, or null when messages is 0.
  readRate: number | null;
  firstAt: string;
  lastAt: string;
  // one_click is RFC 8058 (List-Unsubscribe-Post). url is the https or mailto link from List-Unsubscribe.
  unsubscribe: { method: UnsubscribeMethod; url: string | null };
  state: SenderState;
  approvalId: number | null;
  unsubscribedAt: string | null;
  // the mail of the sender that the job archived, and the label that it put on the mail.
  archived: number;
  label: string | null;
  error: string | null;
}

export interface SendersQuery {
  account?: string;
  state?: SenderState;
  // messages is the default.
  sort?: 'messages' | 'readRate' | 'lastAt';
  cursor?: string;
  limit?: number;
}

export interface SendersPage {
  accounts: string[];
  senders: NewsletterSenderRow[];
  nextCursor: string | null;
  lastSweep: { runId: string | null; at: string } | null;
}

export type SubscriptionCadence = 'weekly' | 'monthly' | 'quarterly' | 'yearly' | 'unknown';

export type SubscriptionState = 'active' | 'cancel_pending' | 'cancelled' | 'ignored';

// one row of the paid subscription table. the amount is in the currency of the last charge.
export interface SubscriptionRow {
  id: number;
  account: string;
  merchant: string;
  amount: number | null;
  currency: string | null;
  cadence: SubscriptionCadence;
  lastChargeAt: string | null;
  nextChargeAt: string | null;
  // the gmail message of the last receipt.
  sourceMessageId: string;
  sourceSubject: string | null;
  // every receipt of the merchant that the finder used, newest first. sourceMessageId is the first of them.
  sourceMessageIds: string[];
  // 0 to 1: how sure the finder is that the charge repeats. one receipt alone gives a low value.
  confidence: number;
  cancelUrl: string | null;
  state: SubscriptionState;
  approvalId: number | null;
  // the browser task that helps with the cancellation, when one ran.
  browserTaskId: string | null;
  updatedAt: string;
}

// the monthly totals are estimates from the cadence, one per currency. a row with an unknown cadence or no amount is
// not in them.
export interface SubscriptionsPage {
  subscriptions: SubscriptionRow[];
  monthlyTotals: Array<{ currency: string; amount: number }>;
  lastScan: { runId: string | null; at: string } | null;
}

export type DigestSection = 'needs_reply' | 'deadlines' | 'bills' | 'packages';

export interface DigestItem {
  section: DigestSection;
  account: string;
  messageId: string;
  threadId: string;
  from: string;
  subject: string;
  summary: string;
  dueAt: string | null;
  amount: number | null;
  currency: string | null;
  // the draft reply and the calendar proposal that the job made for the item.
  draftId: number | null;
  proposalId: number | null;
}

export interface DigestSummary {
  id: number;
  day: string;
  runId: string | null;
  createdAt: string;
  items: number;
}

// shortText is the telegram message. the items are in the order of DigestSection, then by dueAt.
export interface InboxDigest {
  id: number;
  day: string;
  runId: string | null;
  createdAt: string;
  accounts: string[];
  shortText: string;
  items: DigestItem[];
}

// newest first. nextCursor is null on the last page.
export interface DigestsPage {
  digests: DigestSummary[];
  nextCursor: string | null;
}

export type DraftState = 'drafted' | 'discarded' | 'sent_by_owner';

// a draft reply in gmail drafts. the app never sends it. sent_by_owner means that the draft left drafts and a sent mail
// in the thread has its text.
export interface DraftView {
  id: number;
  account: string;
  gmailDraftId: string;
  threadId: string;
  inReplyTo: string | null;
  to: string[];
  subject: string;
  body: string;
  state: DraftState;
  runId: string | null;
  toolCallId: string | null;
  createdAt: string;
}

export type ProposalState = 'proposed' | 'approved' | 'created' | 'declined' | 'expired' | 'failed';

// a calendar event that the owner approves through the approval of approvalId. eventId is the calendar event after
// the app created it.
export interface CalendarProposalView {
  id: number;
  account: string;
  calendarId: string;
  kind: 'course' | 'bill' | 'other';
  title: string;
  startAt: string;
  endAt: string | null;
  allDay: boolean;
  description: string | null;
  sourceMessageId: string | null;
  sourceSubject: string | null;
  state: ProposalState;
  approvalId: number | null;
  eventId: string | null;
  error: string | null;
  runId: string | null;
  createdAt: string;
  resolvedAt: string | null;
}

export type InboxJob = 'newsletters' | 'subscriptions' | 'digest';

export interface InboxRunRequest {
  job: InboxJob;
}

// the archive of a sender's mail. olderThanDays is 0 to 3650, and the default is 30. label is added to the mail before
// it leaves the inbox.
export interface InboxArchiveRequest {
  olderThanDays?: number;
  label?: string;
}

export interface InboxListQuery {
  account?: string;
  // a DraftState for the drafts, or a ProposalState for the proposals.
  state?: string;
  // a row id. the page holds the rows before it.
  before?: number;
  // 1 to 200. the default is 50.
  limit?: number;
}

// an action on a sender or a subscription that changes mail or an account asks the owner first, and the answer has
// the approval that it waits for. done is for an action with no approval, for example keep or ignore.
export interface InboxActionResponse {
  status: 'pending_approval' | 'done';
  approvalId: number | null;
  message: string;
}

// phase 5 m9: code sandbox

export interface SandboxLimits {
  cpus: number;
  memoryMb: number;
  timeoutMs: number;
  // the most bytes of stdout and of stderr that the app keeps. the rest is cut.
  outputBytes: number;
  pids: number;
}

// ok is exit code 0 and failed is another exit code. timeout and killed come from the limits. error is a failure of
// docker before the command ran.
export type SandboxExecStatus = 'running' | 'ok' | 'failed' | 'timeout' | 'killed' | 'error';

// bash runs the code with bash -c, python with python3 -c, and node with node -e.
export type SandboxLanguage = 'bash' | 'python' | 'node';

export interface SandboxExecRow {
  id: number;
  runId: string | null;
  toolCallId: string | null;
  sessionKey: string | null;
  language: SandboxLanguage;
  // the code that ran.
  command: string;
  image: string;
  network: 'none' | 'allowlist';
  allowlist: string[];
  limits: SandboxLimits;
  status: SandboxExecStatus;
  exitCode: number | null;
  durationMs: number;
  stdoutBytes: number;
  stderrBytes: number;
  truncated: boolean;
  fileCount: number;
  createdAt: string;
}

export interface SandboxFile {
  path: string;
  direction: 'in' | 'out';
  blob: string;
  size: number;
  mime: string;
}

// the policy decision of the tool call of an exec, with the verdict of the reviewer and the approval of a network
// call. it is null when the tool call has no decision row yet, for example while the call runs.
export interface SandboxPolicyView {
  decisionId: number;
  decision: 'allow' | 'review' | 'approve' | 'deny';
  rule: string;
  reason: string;
  reviewerVerdict: 'allow' | 'hold' | null;
  reviewerReason: string | null;
  reviewerModelCallId: number | null;
  approvalId: number | null;
  approvalStatus: string | null;
}

// the egress of a call with network access: the hosts that the proxy let through, and the requests that it refused
// with the reason.
export interface SandboxEgress {
  passed: string[];
  refused: Array<{ target: string; reason: string }>;
}

// stdout and stderr hold at most 64 kb each. the full text is in the blob.
export interface SandboxExecDetail extends SandboxExecRow {
  cwd: string;
  imageId: string | null;
  containerId: string | null;
  stdout: string | null;
  stderr: string | null;
  stdoutBlob: string | null;
  stderrBlob: string | null;
  error: string | null;
  files: SandboxFile[];
  // null for a call without network access, and for a call that ended before its network was made.
  egress: SandboxEgress | null;
  // the collect paths that did not come back, with the reason.
  notCollected: Array<{ path: string; reason: string }>;
  policy: SandboxPolicyView | null;
  endedAt: string | null;
}

// available is false when docker is missing or does not answer, or when the image is missing. reason then tells why,
// and the tool is off. network is false when the allowlist mode cannot work on this docker host, and networkReason
// then tells why. a call with an allowlist then fails, and a call without one still works.
export interface SandboxStatus {
  available: boolean;
  reason: string | null;
  engine: string | null;
  image: string;
  defaults: SandboxLimits;
  network: boolean;
  networkReason: string | null;
}

export interface SandboxQuery {
  runId?: string;
  status?: SandboxExecStatus;
  // an exec id. the page holds the execs before it.
  before?: number;
  limit?: number;
}

// newest first. before is the value for the next page, and it is null on the last page.
export interface SandboxPage {
  status: SandboxStatus;
  execs: SandboxExecRow[];
  before: number | null;
}

// phase 5 m7: deploy

// the desktop signs in, then sends the refresh token to the server. clientId is the client that the token belongs to.
// the server refuses a token of another client, because google refuses it at the next refresh.
export interface GoogleTokenImportRequest {
  refreshToken: string;
  clientId: string;
}

// the server refreshes the token one time before it stores it, so ok means that the token works.
export interface GoogleTokenImportResponse {
  alias: string;
  email: string | null;
  status: 'ok';
  scopes: string[];
  storedAt: string;
}

// the place that keeps the secrets. keyring is the os credential store of a desktop. file is a json file with mode
// 0600. aws is aws secrets manager with one secret for each ref, named prefix + ref. the default prefix is okc/.
export type SecretStoreConfig =
  | { backend: 'keyring' }
  | { backend: 'file'; path: string }
  | { backend: 'aws'; region: string; prefix?: string };

// the dashboard shows the backend and if it answers. it never shows a value or a ref.
export interface SecretStoreView {
  backend: SecretStoreConfig['backend'];
  // for example the path of the file or the region, without a secret name.
  detail: string;
  ok: boolean;
  error: string | null;
}
